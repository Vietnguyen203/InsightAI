import { Injectable } from '@nestjs/common';
import {
  type CreatedInvitation,
  type Invitation,
  type InvitationPreview,
  type MembershipSummary,
  SystemRole,
  systemRoleSchema,
} from '@insightai/contracts';
import { randomToken, sha256, uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors/app-error';
import type { TenantContext, UserContext } from '../../platform/http/request-context';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const INVALID_INVITATION = 'Invitation is invalid or has expired';

// Creators are loaded separately: a creator who left the organization is hidden by RLS, which a
// required Prisma relation would report as an inconsistent result.
const invitationInclude = { role: { select: { key: true } } } as const;
const userSelect = { id: true, email: true, fullName: true } as const;

/** Single-use invitation links (decision D-16). Tokens are shown once and stored hashed. */
@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    ctx: TenantContext,
    input: { role: SystemRole; expiresInHours: number },
  ): Promise<CreatedInvitation> {
    if (input.role === SystemRole.OWNER && ctx.role !== SystemRole.OWNER) {
      throw new ForbiddenError('Only an owner can invite another owner');
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + input.expiresInHours * 3600_000);

    return this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const role = await tx.role.findFirstOrThrow({
          where: { key: input.role, organizationId: null },
        });
        const invitation = await tx.invitation.create({
          data: {
            id: uuidv7(),
            organizationId: ctx.organizationId,
            roleId: role.id,
            tokenHash: sha256(token),
            createdById: ctx.userId,
            expiresAt,
          },
          include: invitationInclude,
        });
        const creator = await tx.user.findUnique({ where: { id: ctx.userId }, select: userSelect });
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invitation.created',
          resourceType: 'invitation',
          resourceId: invitation.id,
          changes: { role: input.role, expiresAt: expiresAt.toISOString() },
          meta: ctx,
        });
        return { ...toInvitation(invitation, creator), token };
      },
    );
  }

  async listActive(ctx: TenantContext): Promise<Invitation[]> {
    return this.prisma.runInTenant(ctx.organizationId, async (tx) => {
      const rows = await tx.invitation.findMany({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        include: invitationInclude,
        orderBy: { createdAt: 'desc' },
      });
      const creators = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.createdById))] } },
        select: userSelect,
      });
      const creatorById = new Map(creators.map((creator) => [creator.id, creator]));
      return rows.map((row) => toInvitation(row, creatorById.get(row.createdById) ?? null));
    });
  }

  async revoke(ctx: TenantContext, invitationId: string): Promise<void> {
    await this.prisma.runInContext(
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        const { count } = await tx.invitation.updateMany({
          where: { id: invitationId, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (count === 0) throw new NotFoundError('Invitation not found or no longer active');
        await this.audit.record(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invitation.revoked',
          resourceType: 'invitation',
          resourceId: invitationId,
          meta: ctx,
        });
      },
    );
  }

  /** Public: lets the invite page show which organization the link is for. */
  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findUsable(token);
    const organization = await this.prisma.runInTenant(invitation.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: invitation.organizationId } }),
    );
    return {
      organizationName: organization.name,
      role: systemRoleSchema.parse(invitation.role.key),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async accept(user: UserContext, token: string): Promise<MembershipSummary> {
    const invitation = await this.findUsable(token);
    const { organizationId } = invitation;

    return this.prisma.runInContext({ organizationId, userId: user.userId }, async (tx) => {
      const existing = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId: user.userId } },
      });
      if (existing) throw new ConflictError('You are already a member of this organization');

      // Conditional update: two concurrent accepts of the same link cannot both succeed.
      const { count } = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date(), acceptedById: user.userId },
      });
      if (count === 0) throw new NotFoundError(INVALID_INVITATION);

      const membership = await tx.membership.create({
        data: { id: uuidv7(), organizationId, userId: user.userId, roleId: invitation.roleId },
        include: { organization: true, role: { select: { key: true } } },
      });
      await this.audit.record(tx, {
        organizationId,
        actorUserId: user.userId,
        action: 'invitation.accepted',
        resourceType: 'membership',
        resourceId: membership.id,
        changes: { invitationId: invitation.id, role: membership.role.key },
        meta: user,
      });
      return {
        organizationId,
        organizationName: membership.organization.name,
        organizationSlug: membership.organization.slug,
        organizationStatus: membership.organization.status,
        role: systemRoleSchema.parse(membership.role.key),
      };
    });
  }

  private async findUsable(token: string) {
    const tokenHash = sha256(token);
    const invitation = await this.prisma.runInContext({ inviteTokenHash: tokenHash }, (tx) =>
      tx.invitation.findUnique({
        where: { tokenHash },
        include: { role: { select: { key: true } } },
      }),
    );
    if (
      !invitation ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt <= new Date()
    ) {
      throw new NotFoundError(INVALID_INVITATION);
    }
    return invitation;
  }
}

function toInvitation(
  row: { id: string; expiresAt: Date; createdAt: Date; role: { key: string } },
  createdBy: { id: string; email: string; fullName: string } | null,
): Invitation {
  return {
    id: row.id,
    role: systemRoleSchema.parse(row.role.key),
    createdBy,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
