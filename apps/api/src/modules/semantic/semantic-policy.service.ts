import { Injectable } from '@nestjs/common';
import type {
  AccessPolicy,
  createAccessPolicyRequestSchema,
  updateAccessPolicyRequestSchema,
} from '@insightai/contracts';
import type { z } from 'zod';
import { Prisma, type SemanticAccessPolicy } from '../../generated/prisma/client';
import { uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors/app-error';
import type { TenantContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { compileExpression, ExpressionError } from '../expression/expression';
import { VALUE_TYPE } from '../quality/rule-compiler';

type CreateBody = z.output<typeof createAccessPolicyRequestSchema>;
type UpdateBody = z.output<typeof updateAccessPolicyRequestSchema>;

/**
 * Access policies of a semantic model (docs/SEMANTIC_LAYER_DESIGN.md §8). They take effect
 * immediately (security rules, not definitions). A row filter is checked against the entity's
 * data when saved; at query time a filter that no longer applies hides every row (fail closed).
 */
@Injectable()
export class SemanticPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext, modelId: string): Promise<AccessPolicy[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      await this.findModel(tx, modelId);
      const policies = await tx.semanticAccessPolicy.findMany({
        where: { semanticModelId: modelId },
        orderBy: { createdAt: 'asc' },
      });
      return policies.map(toPolicyDto);
    });
  }

  async create(ctx: TenantContext, modelId: string, body: CreateBody): Promise<AccessPolicy> {
    return this.write(ctx, async (tx) => {
      await this.findModel(tx, modelId);
      await this.checkRowFilter(tx, modelId, body.rowFilter ?? null);
      const policy = await tx.semanticAccessPolicy.create({
        data: {
          id: uuidv7(),
          organizationId: ctx.organizationId,
          semanticModelId: modelId,
          name: body.name,
          roles: [...new Set(body.roles)],
          memberAccess: json(body.memberAccess),
          rowFilter: json(body.rowFilter),
          enabled: body.enabled,
          createdById: ctx.userId,
        },
      });
      await this.record(tx, ctx, 'semantic.policy_created', modelId, { policy: body.name });
      return policy;
    });
  }

  async update(ctx: TenantContext, policyId: string, body: UpdateBody): Promise<AccessPolicy> {
    return this.write(ctx, async (tx) => {
      const existing = await tx.semanticAccessPolicy.findUnique({ where: { id: policyId } });
      if (!existing) throw new NotFoundError('Access policy not found');
      if (body.rowFilter !== undefined) {
        await this.checkRowFilter(tx, existing.semanticModelId, body.rowFilter);
      }
      const policy = await tx.semanticAccessPolicy.update({
        where: { id: policyId },
        data: {
          name: body.name,
          roles: body.roles ? [...new Set(body.roles)] : undefined,
          memberAccess: body.memberAccess === undefined ? undefined : json(body.memberAccess),
          rowFilter: body.rowFilter === undefined ? undefined : json(body.rowFilter),
          enabled: body.enabled,
        },
      });
      await this.record(tx, ctx, 'semantic.policy_updated', existing.semanticModelId, {
        policy: policy.name,
      });
      return policy;
    });
  }

  async remove(ctx: TenantContext, policyId: string): Promise<void> {
    await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const existing = await tx.semanticAccessPolicy.findUnique({ where: { id: policyId } });
        if (!existing) throw new NotFoundError('Access policy not found');
        await tx.semanticAccessPolicy.delete({ where: { id: policyId } });
        await this.record(tx, ctx, 'semantic.policy_deleted', existing.semanticModelId, {
          policy: existing.name,
        });
      },
    );
  }

  private async write(
    ctx: TenantContext,
    work: (tx: DbTransaction) => Promise<SemanticAccessPolicy>,
  ): Promise<AccessPolicy> {
    return this.prisma
      .runInContext({ organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) =>
        toPolicyDto(await work(tx)),
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictError('A policy with this name already exists');
        }
        throw error;
      });
  }

  private async findModel(tx: DbTransaction, modelId: string) {
    const model = await tx.semanticModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundError('Semantic model not found');
    return model;
  }

  /** The filter must name an entity of the model and type-check as a condition on its data. */
  private async checkRowFilter(
    tx: DbTransaction,
    modelId: string,
    filter: { entity: string; expr: string } | null,
  ): Promise<void> {
    if (!filter) return;
    const entity = await tx.semanticEntity.findUnique({
      where: { semanticModelId_key: { semanticModelId: modelId, key: filter.entity } },
      include: { dataset: { include: { activeVersion: { include: { columns: true } } } } },
    });
    if (!entity) {
      throw new ValidationError(`Unknown entity "${filter.entity}"`, [
        { path: 'rowFilter.entity', message: 'Unknown entity' },
      ]);
    }
    const columns = new Map(
      (entity.dataset.activeVersion?.columns ?? []).map((c) => [c.name, c.dataType]),
    );
    try {
      compileExpression(
        filter.expr,
        (name) => {
          const type = columns.get(name);
          return type ? { type: VALUE_TYPE[type], sql: 'x' } : undefined;
        },
        'boolean',
      );
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new ValidationError(error.message, [
          { path: 'rowFilter.expr', message: error.message },
        ]);
      }
      throw error;
    }
  }

  private record(
    tx: DbTransaction,
    ctx: TenantContext,
    action: string,
    modelId: string,
    changes: Prisma.InputJsonObject,
  ) {
    return this.audit.record(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'semantic_model',
      resourceId: modelId,
      changes,
      meta: ctx,
    });
  }
}

const json = (value: unknown) =>
  value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);

function toPolicyDto(p: SemanticAccessPolicy): AccessPolicy {
  return {
    id: p.id,
    semanticModelId: p.semanticModelId,
    name: p.name,
    roles: p.roles,
    memberAccess: (p.memberAccess as AccessPolicy['memberAccess']) ?? null,
    rowFilter: (p.rowFilter as AccessPolicy['rowFilter']) ?? null,
    enabled: p.enabled,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
