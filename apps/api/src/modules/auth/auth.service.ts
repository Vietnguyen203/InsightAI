import { Inject, Injectable } from '@nestjs/common';
import {
  type AuthResponse,
  type MeResponse,
  type registerRequestSchema,
  systemRoleSchema,
  type UserSummary,
} from '@insightai/contracts';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { randomToken, sha256, uuidv7 } from '../../platform/crypto/ids';
import { ConflictError, UnauthenticatedError } from '../../platform/errors/app-error';
import type { RequestMeta, UserContext } from '../../platform/http/request-context';
import { isUniqueViolation } from '../../platform/prisma/prisma-errors';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InvitationService } from '../iam/invitation.service';
import { OrganizationService } from '../organization/organization.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const INVALID_CREDENTIALS = 'Invalid email or password';
const INVALID_SESSION = 'Session expired, please sign in again';
/** A rotated token presented again within this window is a benign race (two tabs), not theft. */
const ROTATION_GRACE_MS = 10_000;

export interface Session extends AuthResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly refreshTtlMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly organizations: OrganizationService,
    private readonly invitations: InvitationService,
    private readonly audit: AuditService,
  ) {
    this.refreshTtlMs = config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600_000;
  }

  /** Creates the account, then either creates an organization or joins one via invitation. */
  async register(
    input: z.output<typeof registerRequestSchema>,
    meta: RequestMeta,
  ): Promise<Session> {
    // Validate the invitation before creating the account, so a bad link does not leave an
    // orphaned account behind.
    if (input.invitationToken !== undefined) await this.invitations.preview(input.invitationToken);

    const userId = uuidv7();
    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.prisma
      .runInContext({ userId }, async (tx) => {
        const created = await tx.user.create({
          data: { id: userId, email: input.email, passwordHash, fullName: input.fullName },
          select: { id: true, email: true, fullName: true },
        });
        await this.audit.record(tx, {
          actorUserId: userId,
          action: 'user.registered',
          resourceType: 'user',
          resourceId: userId,
          meta,
        });
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'email')) {
          throw new ConflictError('An account with this email already exists');
        }
        throw error;
      });

    const userContext: UserContext = { userId, sessionId: '', ...meta };
    if (input.invitationToken !== undefined) {
      await this.invitations.accept(userContext, input.invitationToken);
    } else if (input.organizationName !== undefined) {
      await this.organizations.create(userContext, input.organizationName);
    }

    return this.startSession(user, meta);
  }

  async login(email: string, password: string, meta: RequestMeta): Promise<Session> {
    const user = await this.prisma.runInContext({ loginEmail: email }, (tx) =>
      tx.user.findUnique({ where: { email } }),
    );
    const valid = user
      ? await this.passwords.verify(user.passwordHash, password)
      : await this.passwords.verifyAgainstDummy(password);
    if (!user || !valid || user.status !== 'ACTIVE') {
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
    return this.startSession({ id: user.id, email: user.email, fullName: user.fullName }, meta);
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session family. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<Session> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.runInContext({ refreshTokenHash: tokenHash }, (tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash } }),
    );
    if (!stored) throw new UnauthenticatedError(INVALID_SESSION);

    const now = new Date();
    if (stored.revokedAt !== null) {
      // Only a *rotated* token (one that has a successor) indicates theft when replayed; a token
      // revoked by logout or by an earlier family revocation is simply dead.
      const rotated = stored.replacedBy !== null;
      const benignRace = now.getTime() - stored.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (rotated && !benignRace) {
        await this.revokeFamily(
          stored.userId,
          stored.familyId,
          'auth.refresh_reuse_detected',
          meta,
        );
      }
      throw new UnauthenticatedError(INVALID_SESSION);
    }
    if (stored.expiresAt <= now) throw new UnauthenticatedError(INVALID_SESSION);

    const newToken = randomToken();
    const newId = uuidv7();
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTtlMs);

    const user = await this.prisma.runInContext({ userId: stored.userId }, async (tx) => {
      const account = await tx.user.findUnique({
        where: { id: stored.userId },
        select: { id: true, email: true, fullName: true, status: true },
      });
      if (!account || account.status !== 'ACTIVE') throw new UnauthenticatedError(INVALID_SESSION);

      // Conditional update: of two concurrent refreshes with the same token, only one rotates.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: now, replacedBy: newId },
      });
      if (count === 0) throw new UnauthenticatedError(INVALID_SESSION);

      await tx.refreshToken.create({
        data: {
          id: newId,
          userId: stored.userId,
          familyId: stored.familyId,
          tokenHash: sha256(newToken),
          expiresAt: refreshExpiresAt,
          userAgent: meta.userAgent ?? null,
          ip: meta.ip ?? null,
        },
      });
      return { id: account.id, email: account.email, fullName: account.fullName };
    });

    return this.issue(user, stored.familyId, newToken, refreshExpiresAt);
  }

  /** Ends the session family of the presented refresh token. Idempotent. */
  async logout(refreshToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!refreshToken) return;
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.runInContext({ refreshTokenHash: tokenHash }, (tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash } }),
    );
    if (stored) await this.revokeFamily(stored.userId, stored.familyId, 'auth.logout', meta);
  }

  async me(userId: string): Promise<MeResponse> {
    return this.prisma.runInContext({ userId }, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, fullName: true, status: true },
      });
      if (!user || user.status !== 'ACTIVE')
        throw new UnauthenticatedError('Account not available');

      const memberships = await tx.membership.findMany({
        where: { userId, status: 'ACTIVE' },
        include: { organization: true, role: { select: { key: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return {
        user: { id: user.id, email: user.email, fullName: user.fullName },
        memberships: memberships.map((m) => ({
          organizationId: m.organizationId,
          organizationName: m.organization.name,
          organizationSlug: m.organization.slug,
          organizationStatus: m.organization.status,
          role: systemRoleSchema.parse(m.role.key),
        })),
      };
    });
  }

  private async startSession(user: UserSummary, meta: RequestMeta): Promise<Session> {
    const familyId = uuidv7();
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlMs);

    await this.prisma.runInContext({ userId: user.id }, async (tx) => {
      await tx.refreshToken.create({
        data: {
          id: uuidv7(),
          userId: user.id,
          familyId,
          tokenHash: sha256(refreshToken),
          expiresAt: refreshExpiresAt,
          userAgent: meta.userAgent ?? null,
          ip: meta.ip ?? null,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await this.audit.record(tx, {
        actorUserId: user.id,
        action: 'auth.login',
        resourceType: 'session',
        resourceId: familyId,
        meta,
      });
    });

    return this.issue(user, familyId, refreshToken, refreshExpiresAt);
  }

  private async issue(
    user: UserSummary,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<Session> {
    const accessToken = await this.tokens.signAccessToken({ userId: user.id, sessionId });
    return {
      accessToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user,
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async revokeFamily(
    userId: string,
    familyId: string,
    action: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.runInContext({ userId }, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(tx, {
        actorUserId: userId,
        action,
        resourceType: 'session',
        resourceId: familyId,
        meta,
      });
    });
  }
}
