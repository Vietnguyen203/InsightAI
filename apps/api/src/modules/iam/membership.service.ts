import { Injectable } from '@nestjs/common';
import { type Member, type Permission, SystemRole, systemRoleSchema } from '@insightai/contracts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext, TenantMembership } from '../../platform/http/request-context';
import { type DbTransaction, PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrganizationService } from '../organization/organization.service';

const memberInclude = {
  user: { select: { id: true, email: true, fullName: true } },
  role: { select: { key: true } },
} as const;

@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verifies that `userId` is an active member of `organizationId` and returns the tenant
   * context. Non-members get the same error whether or not the organization exists.
   */
  async resolve(userId: string, organizationId: string): Promise<TenantMembership> {
    const membership = await this.prisma.runInContext({ userId, organizationId }, (tx) =>
      tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        include: {
          user: { select: { status: true } },
          role: { include: { permissions: { select: { permissionCode: true } } } },
        },
      }),
    );
    if (!membership || membership.status !== 'ACTIVE' || membership.user.status !== 'ACTIVE') {
      throw new ForbiddenError('Not a member of this organization');
    }

    const { dataSchema } = await this.organizations.ensureActive(organizationId);
    return {
      organizationId,
      dataSchema,
      membershipId: membership.id,
      role: systemRoleSchema.parse(membership.role.key),
      permissions: new Set(
        membership.role.permissions.map((rp) => rp.permissionCode as Permission),
      ),
    };
  }

  async list(ctx: TenantContext): Promise<Member[]> {
    const rows = await this.prisma.runInTenant(ctx.organizationId, (tx) =>
      tx.membership.findMany({ include: memberInclude, orderBy: { createdAt: 'asc' } }),
    );
    return rows.map(toMember);
  }

  async changeRole(ctx: TenantContext, membershipId: string, role: SystemRole): Promise<Member> {
    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const target = await this.findMember(tx, membershipId);
        const currentRole = systemRoleSchema.parse(target.role.key);
        if (currentRole === role) return toMember(target);

        this.assertMayChangeOwnership(ctx, currentRole, role);
        if (currentRole === SystemRole.OWNER) await this.assertNotLastOwner(tx);

        const newRole = await tx.role.findFirstOrThrow({
          where: { key: role, organizationId: null },
        });
        const updated = await tx.membership.update({
          where: { id: membershipId },
          data: { roleId: newRole.id },
          include: memberInclude,
        });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'member.role_changed',
          resourceType: 'membership',
          resourceId: membershipId,
          changes: { userId: target.userId, from: currentRole, to: role },
          meta: ctx,
        });
        return toMember(updated);
      },
    );
  }

  async remove(ctx: TenantContext, membershipId: string): Promise<void> {
    await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const target = await this.findMember(tx, membershipId);
        const currentRole = systemRoleSchema.parse(target.role.key);
        if (currentRole === SystemRole.OWNER) {
          this.assertMayChangeOwnership(ctx, currentRole, undefined);
          await this.assertNotLastOwner(tx);
        }
        await tx.membership.delete({ where: { id: membershipId } });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'member.removed',
          resourceType: 'membership',
          resourceId: membershipId,
          changes: { userId: target.userId, email: target.user.email, role: currentRole },
          meta: ctx,
        });
      },
    );
  }

  private async findMember(tx: DbTransaction, membershipId: string) {
    // RLS limits this to the current organization; other tenants' ids look like missing rows.
    const member = await tx.membership.findUnique({
      where: { id: membershipId },
      include: memberInclude,
    });
    if (!member) throw new NotFoundError('Member not found');
    return member;
  }

  /** Only an owner may grant or take away the owner role. */
  private assertMayChangeOwnership(
    ctx: TenantContext,
    from: SystemRole,
    to: SystemRole | undefined,
  ): void {
    const touchesOwner = from === SystemRole.OWNER || to === SystemRole.OWNER;
    if (touchesOwner && ctx.role !== SystemRole.OWNER) {
      throw new ForbiddenError('Only an owner can grant or revoke the owner role');
    }
  }

  private async assertNotLastOwner(tx: DbTransaction): Promise<void> {
    const owners = await tx.membership.count({
      where: { role: { key: SystemRole.OWNER, organizationId: null }, status: 'ACTIVE' },
    });
    if (owners <= 1) throw new ConflictError('An organization must keep at least one owner');
  }
}

function toMember(row: {
  id: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: Date;
  user: { id: string; email: string; fullName: string };
  role: { key: string };
}): Member {
  return {
    id: row.id,
    user: row.user,
    role: systemRoleSchema.parse(row.role.key),
    status: row.status,
    joinedAt: row.createdAt.toISOString(),
  };
}
