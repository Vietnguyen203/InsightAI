import { Injectable, Logger } from '@nestjs/common';
import type { ColumnProfile } from '@insightai/contracts';
import type pg from 'pg';
import { uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { PrismaService } from '../../platform/prisma/prisma.service';
import {
  basicStatsQuery,
  distributionQuery,
  histogramBounds,
  histogramQuery,
  isNumeric,
  isTemporal,
  type ProfiledColumn,
  sampleSource,
  timelineQuery,
  topValuesQuery,
} from './profile-sql';

const PROFILE_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMELINE_MONTHS = 120;
const TABLE_NAME = /^v_[a-z0-9]{10}_[a-z0-9]{8}$/;
const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;

export type ProfileOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * Computes column statistics for one dataset version (docs/DATA_QUALITY_DESIGN.md §7).
 * Reads through the tenant reader role in a read-only transaction; writes only metadata.
 * Idempotent: profiles of the version are replaced as a whole.
 */
@Injectable()
export class ProfilerService {
  private readonly logger = new Logger(ProfilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
  ) {}

  async run(
    organizationId: string,
    versionId: string,
    isFinalAttempt: boolean,
  ): Promise<ProfileOutcome> {
    const target = await this.prisma.runInTenant(organizationId, async (tx) => {
      const version = await tx.datasetVersion.findUnique({
        where: { id: versionId },
        include: { columns: { orderBy: { ordinal: 'asc' } } },
      });
      if (!version) return null;
      await tx.datasetVersion.update({
        where: { id: versionId },
        data: { profileStatus: 'RUNNING' },
      });
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      return { version, dataSchema: organization.dataSchema };
    });
    if (!target) return 'skipped';
    const { version, dataSchema } = target;

    try {
      if (
        !TABLE_NAME.test(version.physicalTable) ||
        !version.columns.every((c) => PHYSICAL_NAME.test(c.physicalName))
      ) {
        throw new Error('Unexpected data-plane identifier in metadata');
      }
      const profiles = await this.dataPlane.withTenantRead(
        dataSchema,
        (client) =>
          this.profile(client, version.physicalTable, version.columns, Number(version.rowCount)),
        { statementTimeoutMs: PROFILE_STATEMENT_TIMEOUT_MS },
      );

      await this.prisma.runInTenant(organizationId, async (tx) => {
        await tx.columnProfile.deleteMany({ where: { datasetVersionId: versionId } });
        await tx.columnProfile.createMany({
          data: profiles.map(({ columnId, profile }) => ({
            id: uuidv7(),
            organizationId,
            datasetVersionId: versionId,
            datasetColumnId: columnId,
            stats: profile,
            approximate: profile.approximate,
          })),
        });
        await tx.datasetVersion.update({
          where: { id: versionId },
          data: { profileStatus: 'SUCCEEDED', profiledAt: new Date() },
        });
      });
      return 'succeeded';
    } catch (error) {
      this.logger.error({ err: error, versionId }, 'Profiling attempt failed');
      if (!isFinalAttempt) throw error;
      await this.prisma.runInTenant(organizationId, (tx) =>
        tx.datasetVersion.update({ where: { id: versionId }, data: { profileStatus: 'FAILED' } }),
      );
      return 'failed';
    }
  }

  private async profile(
    client: pg.PoolClient,
    physicalTable: string,
    columns: {
      id: string;
      name: string;
      originalName: string;
      physicalName: string;
      dataType: ColumnProfile['dataType'];
    }[],
    rowCount: number,
  ): Promise<{ columnId: string; profile: ColumnProfile }[]> {
    const table = client.escapeIdentifier(physicalTable);
    const cols: ProfiledColumn[] = columns.map((c) => ({
      ident: client.escapeIdentifier(c.physicalName),
      dataType: c.dataType,
    }));
    const { from, sampled } = sampleSource(table, rowCount);

    const basic =
      (await client.query<Record<string, string | null>>(basicStatsQuery(table, cols))).rows[0] ??
      {};
    const dist =
      (await client.query<Record<string, string | null>>(distributionQuery(from, cols))).rows[0] ??
      {};
    const total = Number(basic.total ?? 0);

    const results: { columnId: string; profile: ColumnProfile }[] = [];
    for (const [i, column] of columns.entries()) {
      const ident = cols[i]!.ident;
      const nonNull = Number(basic[`n${i}`] ?? 0);
      const top = await client.query<{ value: string; n: string }>(topValuesQuery(from, ident));

      const profile: ColumnProfile = {
        name: column.name,
        originalName: column.originalName,
        dataType: column.dataType,
        rowCount: total,
        nullCount: total - nonNull,
        // A sample sees fewer distinct values; it can never exceed the non-null count.
        distinctCount: Math.min(nonNull, Number(dist[`d${i}`] ?? 0)),
        approximate: sampled,
        min: basic[`min${i}`] ?? null,
        max: basic[`max${i}`] ?? null,
        topValues: top.rows.map((r) => ({ value: r.value, count: Number(r.n) })),
      };

      if (column.dataType === 'TEXT') {
        profile.length =
          nonNull > 0
            ? {
                min: Number(basic[`lmin${i}`]),
                max: Number(basic[`lmax${i}`]),
                avg: Number(basic[`lavg${i}`]),
              }
            : null;
      }

      if (isNumeric(column.dataType)) {
        profile.mean = basic[`mean${i}`] ?? null;
        profile.stddev = basic[`sd${i}`] ?? null;
        const p25 = dist[`p25_${i}`];
        const p50 = dist[`p50_${i}`];
        const p75 = dist[`p75_${i}`];
        profile.percentiles = p25 && p50 && p75 ? { p25, p50, p75 } : null;
        profile.histogram = [];
        if (profile.min !== null && profile.max !== null) {
          const bounds = histogramBounds(profile.min, profile.max);
          const counts = new Map<number, number>();
          if (bounds.length === 1) {
            counts.set(1, nonNull);
          } else {
            const buckets = await client.query<{ b: number; n: string }>(
              histogramQuery(from, ident),
              [profile.min, profile.max],
            );
            for (const row of buckets.rows) counts.set(Number(row.b), Number(row.n));
          }
          profile.histogram = bounds.map((b, index) => ({
            ...b,
            count: counts.get(index + 1) ?? 0,
          }));
        }
      }

      if (isTemporal(column.dataType)) {
        let timeline = await client.query<{ period: string; n: string }>(
          timelineQuery(table, ident, 'month'),
        );
        if (timeline.rows.length > MAX_TIMELINE_MONTHS) {
          timeline = await client.query(timelineQuery(table, ident, 'year'));
        }
        profile.timeline = timeline.rows.map((r) => ({ period: r.period, count: Number(r.n) }));
      }

      results.push({ columnId: column.id, profile });
    }
    return results;
  }
}
