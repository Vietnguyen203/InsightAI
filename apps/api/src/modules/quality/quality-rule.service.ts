import { Injectable } from '@nestjs/common';
import {
  type QualityRule as QualityRuleDto,
  RULE_DIMENSION,
  type RuleDefinition,
  type ValidateExpressionResponse,
  type createRuleRequestSchema,
  type updateRuleRequestSchema,
} from '@insightai/contracts';
import type { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { uuidv7 } from '../../platform/crypto/ids';
import { DataPlaneService } from '../../platform/data-plane/data-plane.service';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { compileExpression, ExpressionError } from '../expression/expression';
import { toRuleDto } from './quality-mappers';
import {
  compileRule,
  type ForeignKeyTarget,
  RuleDefinitionError,
  VALUE_TYPE,
} from './rule-compiler';
import { qualifiedTable, versionColumns } from './version-columns';

/** Loads the column map of a version plus helpers needed to validate or run rules on it. */
export async function loadVersionContext(tx: DbTransaction, versionId: string) {
  const version = await tx.datasetVersion.findUniqueOrThrow({
    where: { id: versionId },
    include: { columns: { orderBy: { ordinal: 'asc' } } },
  });
  return { version, columns: versionColumns(version.columns, version.rawTable !== null) };
}

/** Resolves the table referenced by a foreign-key rule (active version of another dataset). */
export async function resolveForeignKey(
  tx: DbTransaction,
  dataSchema: string,
  definition: RuleDefinition,
): Promise<ForeignKeyTarget | undefined> {
  if (definition.type !== 'foreign_key') return undefined;
  const ref = await tx.dataset.findUnique({ where: { id: definition.refDatasetId } });
  if (!ref?.activeVersionId || ref.archivedAt) return undefined;
  const { version, columns } = await loadVersionContext(tx, ref.activeVersionId);
  const column = columns.get(definition.refColumn);
  if (!column)
    throw new RuleDefinitionError(
      `Column "${definition.refColumn}" does not exist in the referenced dataset`,
    );
  return {
    table: qualifiedTable(dataSchema, version.physicalTable),
    // Same quoted name, re-aliased for the reference side of the query.
    columnSql: column.typedSql.replace(/^t\./, 'x.'),
  };
}

@Injectable()
export class QualityRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataPlane: DataPlaneService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext, datasetId: string): Promise<QualityRuleDto[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      await this.findDataset(tx, datasetId);
      const rules = await tx.qualityRule.findMany({
        where: { datasetId },
        orderBy: [{ origin: 'asc' }, { createdAt: 'asc' }],
      });
      return rules.map(toRuleDto);
    });
  }

  async create(
    ctx: TenantContext,
    datasetId: string,
    input: z.output<typeof createRuleRequestSchema>,
  ): Promise<QualityRuleDto> {
    if (input.definition.type === 'type_castable' || input.definition.type === 'duplicate_rows') {
      throw new ValidationError('This rule type is created automatically for every dataset');
    }
    await this.validateDefinition(ctx, datasetId, input.definition);
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const rule = await tx.qualityRule.create({
          data: {
            id: uuidv7(),
            organizationId: ctx.organizationId,
            datasetId,
            name: input.name,
            dimension: RULE_DIMENSION[input.definition.type],
            definition: input.definition,
            ruleType: input.definition.type,
            severity: input.severity,
            weight: input.weight,
            threshold: new Prisma.Decimal(input.threshold),
            enabled: input.enabled,
            origin: 'user',
            createdById: ctx.userId,
          },
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'quality_rule.created',
          resourceType: 'quality_rule',
          resourceId: rule.id,
          changes: {
            datasetId,
            name: input.name,
            definition: input.definition as Prisma.InputJsonValue,
          },
          meta: ctx,
        });
        return toRuleDto(rule);
      },
    );
  }

  async update(
    ctx: TenantContext,
    ruleId: string,
    input: z.output<typeof updateRuleRequestSchema>,
  ): Promise<QualityRuleDto> {
    const existing = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      this.findRule(tx, ruleId),
    );
    if (input.definition) {
      if (existing.origin === 'system') {
        throw new ConflictError('The definition of a system rule cannot be changed');
      }
      if (input.definition.type === 'type_castable' || input.definition.type === 'duplicate_rows') {
        throw new ValidationError('This rule type is created automatically');
      }
      await this.validateDefinition(ctx, existing.datasetId, input.definition);
    }
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const rule = await tx.qualityRule.update({
          where: { id: ruleId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.severity !== undefined ? { severity: input.severity } : {}),
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            ...(input.threshold !== undefined
              ? { threshold: new Prisma.Decimal(input.threshold) }
              : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.definition
              ? {
                  definition: input.definition,
                  ruleType: input.definition.type,
                  dimension: RULE_DIMENSION[input.definition.type],
                }
              : {}),
          },
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'quality_rule.updated',
          resourceType: 'quality_rule',
          resourceId: ruleId,
          changes: {
            before: toRuleDto(existing),
            after: input,
          },
          meta: ctx,
        });
        return toRuleDto(rule);
      },
    );
  }

  /** User rules can be deleted (past results keep their snapshot); system rules only disabled. */
  async remove(ctx: TenantContext, ruleId: string): Promise<void> {
    await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const rule = await this.findRule(tx, ruleId);
        if (rule.origin === 'system')
          throw new ConflictError('System rules cannot be deleted; disable them instead');
        await tx.qualityRule.delete({ where: { id: ruleId } });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'quality_rule.deleted',
          resourceType: 'quality_rule',
          resourceId: ruleId,
          changes: toRuleDto(rule),
          meta: ctx,
        });
      },
    );
  }

  /** Live validation for the rule editor (no side effects). */
  async validateExpression(
    ctx: TenantContext,
    datasetId: string,
    expr: string,
  ): Promise<ValidateExpressionResponse> {
    const columns = await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const dataset = await this.findDataset(tx, datasetId);
      if (!dataset.activeVersionId) throw new NotFoundError('This dataset has no data yet');
      return (await loadVersionContext(tx, dataset.activeVersionId)).columns;
    });
    try {
      const compiled = compileExpression(expr, (name) => {
        const c = columns.get(name);
        return c ? { type: VALUE_TYPE[c.dataType], sql: c.typedSql } : undefined;
      });
      return {
        valid: compiled.type === 'boolean' || compiled.type === 'null',
        type: compiled.type,
        columns: compiled.columns,
      };
    } catch (error) {
      if (error instanceof ExpressionError) {
        return {
          valid: false,
          error: {
            message: error.message,
            ...(error.position !== undefined ? { position: error.position } : {}),
          },
        };
      }
      throw error;
    }
  }

  /**
   * Creates the automatic rules for a version, once per dataset: a value-conversion check for
   * every non-text column and a duplicate-row check. Existing ones (even disabled) are kept.
   */
  async ensureSystemRules(
    tx: DbTransaction,
    organizationId: string,
    datasetId: string,
    versionId: string,
    locale: string,
  ): Promise<void> {
    const { version, columns } = await loadVersionContext(tx, versionId);
    // Names are data shown to users; they follow the organization language.
    const vi = locale !== 'en';
    const rules: { key: string; name: string; definition: RuleDefinition }[] = [
      {
        key: 'duplicate_rows',
        name: vi ? 'Không có dòng trùng lặp hoàn toàn' : 'No fully duplicated rows',
        definition: { type: 'duplicate_rows' },
      },
    ];
    if (version.rawTable) {
      for (const column of columns.values()) {
        if (column.dataType === 'TEXT') continue;
        rules.push({
          key: `type_castable:${column.name}`,
          name: vi
            ? `Giá trị của "${column.name}" đúng kiểu dữ liệu`
            : `Values of "${column.name}" match the column type`,
          definition: { type: 'type_castable', column: column.name },
        });
      }
    }
    await tx.qualityRule.createMany({
      data: rules.map((rule) => ({
        id: uuidv7(),
        organizationId,
        datasetId,
        name: rule.name,
        dimension: RULE_DIMENSION[rule.definition.type],
        definition: rule.definition,
        ruleType: rule.definition.type,
        severity: 'warning' as const,
        origin: 'system',
        systemKey: rule.key,
      })),
      skipDuplicates: true,
    });
  }

  /** Full validation against the dataset's active version, including regex syntax in PostgreSQL. */
  private async validateDefinition(
    ctx: TenantContext,
    datasetId: string,
    definition: RuleDefinition,
  ): Promise<void> {
    try {
      await this.prisma.runInTenant(ctx.organizationId, async (tx) => {
        const dataset = await this.findDataset(tx, datasetId);
        if (!dataset.activeVersionId) throw new ValidationError('Upload data before adding rules');
        const { columns } = await loadVersionContext(tx, dataset.activeVersionId);
        const fk = await resolveForeignKey(tx, ctx.dataSchema, definition);
        if (definition.type === 'foreign_key' && !fk) {
          throw new ValidationError('The referenced dataset does not exist or has no data');
        }
        compileRule(definition, columns, fk);
      });
    } catch (error) {
      if (error instanceof RuleDefinitionError) throw new ValidationError(error.message);
      throw error;
    }
    if (definition.type === 'regex') {
      await this.dataPlane
        .withTenantRead(ctx.dataSchema, (client) =>
          client.query("SELECT '' ~ $1", [definition.pattern]),
        )
        .catch((error: unknown) => {
          throw new ValidationError(
            `Invalid pattern: ${error instanceof Error ? error.message : 'syntax error'}`,
          );
        });
    }
  }

  private async findDataset(tx: DbTransaction, datasetId: string) {
    const dataset = await tx.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new NotFoundError('Dataset not found');
    return dataset;
  }

  private async findRule(tx: DbTransaction, ruleId: string) {
    const rule = await tx.qualityRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new NotFoundError('Rule not found');
    return rule;
  }
}
