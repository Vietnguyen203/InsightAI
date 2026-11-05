import { Injectable, Logger } from '@nestjs/common';
import {
  type CurrentOrganization,
  type Organization,
  SystemRole,
  type UpdateOrganizationRequest,
} from '@insightai/contracts';
import type { Organization as OrganizationRow } from '../../generated/prisma/client';
import { randomBase36, uuidv7 } from '../../platform/crypto/ids';
import {
  generateTenantSchemaName,
  TenantProvisioningService,
} from '../../platform/data-plane/tenant-provisioning.service';
import { ConflictError, ForbiddenError } from '../../platform/errors/app-error';
import type { TenantContext, UserContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'org'}-${randomBase36(4)}`;
}

export function toOrganizationDto(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    timezone: row.timezone,
    locale: row.locale,
    defaultCurrency: row.defaultCurrency,
    aiDataSharing: row.aiDataSharing,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: TenantProvisioningService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates an organization owned by the caller. The metadata row is committed first with
   * status PROVISIONING, then the data-plane schema and roles are created (a separate
   * connection and role, so not in the same transaction). If provisioning fails, the
   * organization stays PROVISIONING and `ensureActive` retries on the next request.
   */
  async create(user: UserContext, name: string): Promise<Organization> {
    const organizationId = uuidv7();
    const dataSchema = generateTenantSchemaName();

    const created = await this.insertWithUniqueSlug(user, organizationId, name, dataSchema);

    try {
      return toOrganizationDto(await this.provision(created));
    } catch (error) {
      this.logger.error({ err: error, organizationId }, 'Tenant provisioning failed; will retry');
      return toOrganizationDto(created);
    }
  }

  /** Called by TenantGuard: makes sure the organization can serve tenant requests. */
  async ensureActive(organizationId: string): Promise<{ dataSchema: string }> {
    const org = await this.prisma.runInTenant(organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    );
    if (org.status === 'SUSPENDED') throw new ForbiddenError('Organization is suspended');
    if (org.status === 'PROVISIONING') await this.provision(org);
    return { dataSchema: org.dataSchema };
  }

  async getCurrent(ctx: TenantContext): Promise<CurrentOrganization> {
    const org = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    );
    return { ...toOrganizationDto(org), role: ctx.role, permissions: [...ctx.permissions] };
  }

  async update(ctx: TenantContext, input: UpdateOrganizationRequest): Promise<Organization> {
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const before = await tx.organization.findUniqueOrThrow({
          where: { id: ctx.organizationId },
        });
        const after = await tx.organization.update({
          where: { id: ctx.organizationId },
          data: input,
        });
        const changes = Object.fromEntries(
          Object.keys(input).map((key) => {
            const field = key as keyof UpdateOrganizationRequest;
            return [field, { from: before[field], to: after[field] }];
          }),
        );
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'organization.updated',
          resourceType: 'organization',
          resourceId: ctx.organizationId,
          changes,
          meta: ctx,
        });
        return toOrganizationDto(after);
      },
    );
  }

  private async insertWithUniqueSlug(
    user: UserContext,
    organizationId: string,
    name: string,
    dataSchema: string,
  ): Promise<OrganizationRow> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.runInContext({ organizationId, userId: user.userId }, (tx) =>
          this.insertOrganization(tx, user, organizationId, name, dataSchema),
        );
      } catch (error) {
        // The 4-character random suffix makes collisions rare; retry a couple of times.
        if (isUniqueViolation(error, 'slug') && attempt < 2) continue;
        if (isUniqueViolation(error)) throw new ConflictError('Could not create organization');
        throw error;
      }
    }
  }

  private async insertOrganization(
    tx: DbTransaction,
    user: UserContext,
    organizationId: string,
    name: string,
    dataSchema: string,
  ): Promise<OrganizationRow> {
    const ownerRole = await tx.role.findFirstOrThrow({
      where: { key: SystemRole.OWNER, organizationId: null },
    });
    const org = await tx.organization.create({
      data: { id: organizationId, name, slug: slugify(name), dataSchema, status: 'PROVISIONING' },
    });
    const membership = await tx.membership.create({
      data: { id: uuidv7(), organizationId, userId: user.userId, roleId: ownerRole.id },
    });
    await this.audit.record(tx, {
      organizationId,
      actorUserId: user.userId,
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: organizationId,
      changes: { name, ownerMembershipId: membership.id },
      meta: user,
    });
    return org;
  }

  private async provision(org: OrganizationRow): Promise<OrganizationRow> {
    await this.provisioning.ensureTenant(org.dataSchema);
    return this.prisma.runInTenant(org.id, async (tx) => {
      await tx.organization.updateMany({
        where: { id: org.id, status: 'PROVISIONING' },
        data: { status: 'ACTIVE' },
      });
      return tx.organization.findUniqueOrThrow({ where: { id: org.id } });
    });
  }
}
