import { Inject, Injectable } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { UUID_PATTERN } from '../../platform/crypto/ids';
import { UnauthenticatedError } from '../../platform/errors/app-error';
import type { AuthenticatedUser } from '../../platform/http/request-context';

const ISSUER = 'insightai';
const AUDIENCE = 'insightai-api';

/**
 * Short-lived HS256 access tokens. They carry identity only (user id + session id), never
 * organization or permissions: those are resolved per request from the database, so a role
 * change or removal takes effect immediately.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  readonly accessTtlSeconds: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
    this.accessTtlSeconds = config.JWT_ACCESS_TTL_SECONDS;
  }

  async signAccessToken(user: AuthenticatedUser): Promise<string> {
    return new SignJWT({ sid: user.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const { sub, sid } = payload;
      if (typeof sub !== 'string' || !UUID_PATTERN.test(sub) || typeof sid !== 'string') {
        throw new UnauthenticatedError('Invalid access token');
      }
      return { userId: sub, sessionId: sid };
    } catch (error) {
      if (error instanceof errors.JWTExpired)
        throw new UnauthenticatedError('Access token expired');
      if (error instanceof UnauthenticatedError) throw error;
      throw new UnauthenticatedError('Invalid access token');
    }
  }
}
