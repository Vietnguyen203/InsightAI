import { Injectable } from '@nestjs/common';
import type {
  SemanticModelDetail,
  SemanticValidationIssue,
  SemanticValidationReport,
} from '@insightai/contracts';
import type pg from 'pg';
import type { Prisma } from '../../generated/prisma/client';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { ConflictError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { qualifiedTable } from '../quality/version-columns';
import {
  type ModelWithMembers,
  toEntityDto,
  toModelDetail,
  toRelationshipDto,
  toSnapshot,
} from './semantic-mappers';
import { SemanticModelService } from './semantic-model.service';
import {
  checkModel,
  type EntitySource,
  type KeyCheck,
  type OrphanCheck,
  overallStatus,
} from './semantic-validation';

/** Data checks scan whole tables; keep them bounded. */
const VALIDATION_STATEMENT_TIMEOUT_MS = 60_000;
const PHYSICAL_NAME = /^c_[0-9]{1,3}$/;

/**
 * Semantic validation and publishing (docs/SEMANTIC_LAYER_DESIGN.md §7). Validation stores its
 * report on the draft; publishing re-validates and freezes the model into a snapshot.
 */
@Injectable()
export class SemanticValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    private readonly audit: AuditService,
    private readonly models: SemanticModelService,
  ) {}

  async validate(ctx: TenantContext, modelId: string): Promise<SemanticModelDetail> {
    const { model, report } = await this.run(ctx, modelId);
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      await this.store(tx, model, report);
      return toModelDetail(await this.models.findModel(tx, modelId));
    });
  }

  /** Publishes the draft when it has no validation error. */
  async publish(ctx: TenantContext, modelId: string): Promise<SemanticModelDetail> {
    const { model, report } = await this.run(ctx, modelId);
    if (report.status === 'INVALID') {
      // Keep the report so the editor can show what blocks publishing.
      await this.prisma.runInTenant(ctx.organizationId, (tx) => this.store(tx, model, report));
      throw new ConflictError('The model has validation errors and cannot be published');
    }
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM app.semantic_models WHERE id = ${modelId}::uuid FOR UPDATE`;
        const current = await this.models.findModel(tx, modelId);
        // An edit during validation would publish something that was not validated.
        if (current.updatedAt.getTime() !== model.updatedAt.getTime()) {
          throw new ConflictError('The model changed during validation; publish again');
        }
        const now = new Date();
        const revision = model.revision + 1;
        await tx.semanticModel.update({
          where: { id: modelId },
          data: {
            status: 'PUBLISHED',
            hasDraftChanges: false,
            validationStatus: report.status,
            validationReport: report,
            revision,
            publishedAt: now,
            publishedById: ctx.userId,
            publishedSnapshot: toSnapshot(
              current,
              revision,
              now,
            ) as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'semantic.model_published',
          resourceType: 'semantic_model',
          resourceId: modelId,
          changes: { revision, validationStatus: report.status },
          meta: ctx,
        });
        return toModelDetail(await this.models.findModel(tx, modelId));
      },
    );
  }

  private async run(ctx: TenantContext, modelId: string) {
    const { model, sources, dataSchema } = await this.prisma.runInTenant(
      ctx.organizationId,
      async (tx) => {
        const found = await this.models.findModel(tx, modelId);
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: ctx.organizationId },
        });
        return {
          model: found,
          sources: await this.loadSources(tx, organization.dataSchema, found),
          dataSchema: organization.dataSchema,
        };
      },
    );

    const checked = checkModel(sources, model.relationships.map(toRelationshipDto));
    const issues = [...checked.issues];
    if (checked.keyChecks.length + checked.orphanChecks.length > 0) {
      issues.push(
        ...(await this.dataPlane.withTenantRead(
          dataSchema,
          (client) => this.dataChecks(client, checked.keyChecks, checked.orphanChecks),
          { statementTimeoutMs: VALIDATION_STATEMENT_TIMEOUT_MS },
        )),
      );
    }
    const report: SemanticValidationReport = {
      status: overallStatus(issues),
      checkedAt: new Date().toISOString(),
      issues,
    };
    return { model, report };
  }

  private async loadSources(
    tx: DbTransaction,
    dataSchema: string,
    model: ModelWithMembers,
  ): Promise<EntitySource[]> {
    const sources: EntitySource[] = [];
    for (const entity of model.entities) {
      const dataset = await tx.dataset.findUnique({
        where: { id: entity.datasetId },
        include: { activeVersion: { include: { columns: { orderBy: { ordinal: 'asc' } } } } },
      });
      const version = dataset && !dataset.archivedAt ? dataset.activeVersion : null;
      if (version && !version.columns.every((c) => PHYSICAL_NAME.test(c.physicalName))) {
        throw new Error('Unexpected column identifier in metadata');
      }
      sources.push({
        entity: toEntityDto(entity),
        columns: version
          ? version.columns.map((c) => ({
              name: c.name,
              physicalName: c.physicalName,
              dataType: c.dataType,
            }))
          : null,
        table: version ? qualifiedTable(dataSchema, version.physicalTable) : null,
        datasetQualityFailed: version?.qualityStatus === 'FAILED',
      });
    }
    return sources;
  }

  /** Key uniqueness (primary keys, "one" sides) and orphan rates, each in its own savepoint. */
  private async dataChecks(
    client: pg.PoolClient,
    keyChecks: KeyCheck[],
    orphanChecks: OrphanCheck[],
  ): Promise<SemanticValidationIssue[]> {
    const issues: SemanticValidationIssue[] = [];
    const col = (alias: string, physical: string) => `${alias}."${physical}"`;

    const guarded = async (path: string, work: () => Promise<void>) => {
      try {
        await client.query('SAVEPOINT data_check');
        await work();
        await client.query('RELEASE SAVEPOINT data_check');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT data_check');
        const timeout = (error as { code?: string }).code === '57014';
        issues.push({
          severity: 'warning',
          code: 'DATA_CHECK_FAILED',
          message: timeout
            ? 'The data check took too long and was cancelled'
            : 'The data check could not run',
          path,
        });
      }
    };

    for (const check of keyChecks) {
      await guarded(check.path, async () => {
        const keys = check.columns.map((c) => col('t', c));
        const anyNull = keys.map((k) => `${k} IS NULL`).join(' OR ');
        const row = (
          await client.query<{ nulls: string; duplicates: string }>(
            `SELECT (SELECT count(*) FROM ${check.table} t WHERE ${anyNull}) AS nulls, ` +
              `(SELECT count(*) FROM (SELECT 1 FROM ${check.table} t WHERE NOT (${anyNull}) ` +
              `GROUP BY ${keys.join(', ')} HAVING count(*) > 1) d) AS duplicates`,
          )
        ).rows[0]!;
        const nulls = Number(row.nulls);
        const duplicates = Number(row.duplicates);
        if (check.kind === 'primary_key') {
          if (nulls > 0)
            issues.push({
              severity: 'error',
              code: 'PRIMARY_KEY_NULL',
              message: `${nulls} row(s) have an empty primary key`,
              path: check.path,
            });
          if (duplicates > 0)
            issues.push({
              severity: 'error',
              code: 'PRIMARY_KEY_DUPLICATE',
              message: `${duplicates} primary key value(s) occur more than once`,
              path: check.path,
            });
        } else if (duplicates > 0) {
          issues.push({
            severity: 'error',
            code: 'RELATIONSHIP_NOT_UNIQUE',
            message:
              check.kind === 'relationship_one_side'
                ? `${duplicates} join value(s) occur more than once on the "one" side`
                : `${duplicates} join value(s) occur more than once on the "from" side of a one-to-one relationship`,
            path: check.path,
          });
        }
      });
    }

    for (const check of orphanChecks) {
      await guarded(check.path, async () => {
        const present = check.pairs.map((p) => `${col('f', p.from)} IS NOT NULL`).join(' AND ');
        // Compared as text: join columns have compatible types (checked statically).
        const match = check.pairs
          .map((p) => `${col('x', p.to)}::text = ${col('f', p.from)}::text`)
          .join(' AND ');
        const row = (
          await client.query<{ evaluated: string; orphans: string }>(
            `SELECT count(*) FILTER (WHERE ${present}) AS evaluated, ` +
              `count(*) FILTER (WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${check.toTable} x WHERE ${match})) AS orphans ` +
              `FROM ${check.fromTable} f`,
          )
        ).rows[0]!;
        const orphans = Number(row.orphans);
        if (orphans > 0) {
          issues.push({
            severity: 'warning',
            code: 'RELATIONSHIP_ORPHANS',
            message: `${orphans} of ${Number(row.evaluated)} row(s) have no match on the "one" side`,
            path: check.path,
          });
        }
      });
    }
    return issues;
  }

  private store(tx: DbTransaction, model: ModelWithMembers, report: SemanticValidationReport) {
    // Only when nothing changed meanwhile: a newer edit already reset the validation.
    return tx.semanticModel.updateMany({
      where: { id: model.id, updatedAt: model.updatedAt },
      data: {
        validationStatus: report.status,
        validationReport: report,
      },
    });
  }
}
