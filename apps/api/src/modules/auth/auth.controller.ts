import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthResponse,
  authResponseSchema,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  loginRequestSchema,
  type MeResponse,
  meResponseSchema,
  registerRequestSchema,
} from '@insightai/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.module';
import { ForbiddenError } from '../../platform/errors/app-error';
import { Public } from '../../platform/http/decorators';
import {
  type AppRequest,
  CurrentUser,
  requestMeta,
  type UserContext,
} from '../../platform/http/request-context';
import { ApiZodBody, ApiZodResponse, zod } from '../../platform/http/zod';
import { AuthService, type Session } from './auth.service';

export const REFRESH_COOKIE = 'insightai_rt';
/** The refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Strict limit for credential endpoints (per client IP), on top of the global default. */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.secureCookies = config.NODE_ENV === 'production';
  }

  @Post('register')
  @Public()
  @Throttle(AUTH_THROTTLE)
  @ApiZodBody(registerRequestSchema)
  @ApiZodResponse(201, authResponseSchema)
  async register(
    @Body(zod(registerRequestSchema)) body: z.output<typeof registerRequestSchema>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.register(body, requestMeta(req)));
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiZodBody(loginRequestSchema)
  @ApiZodResponse(200, authResponseSchema)
  async login(
    @Body(zod(loginRequestSchema)) body: z.output<typeof loginRequestSchema>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.login(body.email, body.password, requestMeta(req)));
  }

  /** Cookie-authenticated: requires the CSRF header in addition to SameSite=Strict. */
  @Post('refresh')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiHeader({ name: CSRF_HEADER, required: true, schema: { enum: [CSRF_HEADER_VALUE] } })
  @ApiZodResponse(200, authResponseSchema)
  async refresh(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    this.assertCsrfHeader(req);
    const session = await this.auth.refresh(this.readRefreshCookie(req) ?? '', requestMeta(req));
    return this.respond(res, session);
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiHeader({ name: CSRF_HEADER, required: true, schema: { enum: [CSRF_HEADER_VALUE] } })
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.assertCsrfHeader(req);
    await this.auth.logout(this.readRefreshCookie(req), requestMeta(req));
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiZodResponse(200, meResponseSchema)
  me(@CurrentUser() user: UserContext): Promise<MeResponse> {
    return this.auth.me(user.userId);
  }

  private respond(res: Response, session: Session): AuthResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.cookieOptions(),
      expires: session.refreshExpiresAt,
    });
    return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user };
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'strict' as const,
      path: REFRESH_COOKIE_PATH,
    };
  }

  private readRefreshCookie(req: AppRequest): string | undefined {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private assertCsrfHeader(req: AppRequest): void {
    if (req.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      throw new ForbiddenError('Missing CSRF header');
    }
  }
}
