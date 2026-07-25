/**
 * Identity 认证用例编排服务。
 *
 * 导出：
 * - AuthenticationService：完成注册、登录、登出与当前用户读取。
 * - AuthenticationRequestMetadata：承载已脱敏的客户端请求元数据。
 */

import { createHash, randomBytes } from "node:crypto";

import {
  type AuthenticatedUser,
  AuthenticationError,
  type AuthenticationRateLimiter,
  getInitialSessionExpiresAt,
  getRenewedSessionExpiresAt,
  getSessionAbsoluteExpiresAt,
  SESSION_RENEWAL_MIN_INTERVAL_MS,
  type IdentityRepository,
  type PasswordHasher,
  type RateLimitPolicy,
  type SessionCreation,
  shouldRenewSession,
} from "../domain/authentication";

const REGISTER_RATE_LIMIT: RateLimitPolicy = {
  name: "register",
  limit: 3,
  windowSeconds: 60 * 60,
};

const LOGIN_RATE_LIMIT: RateLimitPolicy = {
  name: "login",
  limit: 5,
  windowSeconds: 15 * 60,
};

export interface AuthenticationRequestMetadata {
  clientIpHash: string;
  userAgent: string | null;
}

export interface RegisterInput {
  email: string;
  displayName: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthenticatedSessionResult {
  user: AuthenticatedUser;
  rawSessionToken: string;
  expiresAt: Date;
}

export interface CurrentUserResult {
  user: AuthenticatedUser & { profileCompleted: boolean };
  renewedSessionExpiresAt: Date | null;
}

export class AuthenticationService {
  constructor(
    private readonly identityRepository: IdentityRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly rateLimiter: AuthenticationRateLimiter,
  ) {}

  async register(
    input: RegisterInput,
    metadata: AuthenticationRequestMetadata,
  ): Promise<AuthenticatedUser> {
    await this.assertRateLimit(REGISTER_RATE_LIMIT, metadata.clientIpHash);

    const email = normalizeEmail(input.email);
    const existingUser = await this.identityRepository.findUserByEmail(email);

    if (existingUser) {
      throw new AuthenticationError("EMAIL_ALREADY_EXISTS");
    }

    const passwordHash = await this.passwordHasher.hash(input.password);

    try {
      return await this.identityRepository.createUser({
        email,
        displayName: input.displayName.trim(),
        passwordHash,
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new AuthenticationError("EMAIL_ALREADY_EXISTS");
      }

      throw error;
    }
  }

  async login(
    input: LoginInput,
    metadata: AuthenticationRequestMetadata,
  ): Promise<AuthenticatedSessionResult> {
    const email = normalizeEmail(input.email);
    await this.assertRateLimit(LOGIN_RATE_LIMIT, `${email}:${metadata.clientIpHash}`);

    const user = await this.identityRepository.findUserByEmail(email);
    const passwordMatches = await this.passwordHasher.verify(input.password, user?.passwordHash ?? null);

    if (!user || user.status !== "active" || !passwordMatches) {
      throw new AuthenticationError("INVALID_CREDENTIALS");
    }

    const now = new Date();
    const session = createSession(now, metadata);
    await this.identityRepository.createSessionForUser(user.id, session.creation, now);

    return {
      user,
      rawSessionToken: session.rawToken,
      expiresAt: session.creation.expiresAt,
    };
  }

  async getCurrentUser(rawSessionToken: string | undefined): Promise<CurrentUserResult | null> {
    if (!rawSessionToken) {
      return null;
    }

    const now = new Date();
    const session = await this.identityRepository.findActiveSessionByTokenHash(hashSessionToken(rawSessionToken), now);

    if (!session || getSessionAbsoluteExpiresAt(session.createdAt).getTime() <= now.getTime()) {
      return null;
    }

    let renewedSessionExpiresAt: Date | null = null;
    if (shouldRenewSession(session, now)) {
      const expiresAt = getRenewedSessionExpiresAt(now, session.createdAt);
      const renewed = await this.identityRepository.renewSession({
        sessionId: session.sessionId,
        expiresAt,
        lastSeenAt: now,
        renewalAllowedBefore: new Date(now.getTime() - SESSION_RENEWAL_MIN_INTERVAL_MS),
        now,
      });

      if (renewed) {
        renewedSessionExpiresAt = expiresAt;
      }
    }

    return {
      user: {
        id: session.id,
        email: session.email,
        displayName: session.displayName,
        profileCompleted: session.profileCompleted,
      },
      renewedSessionExpiresAt,
    };
  }

  async logout(rawSessionToken: string | undefined): Promise<void> {
    if (!rawSessionToken) {
      throw new AuthenticationError("UNAUTHORIZED");
    }

    const revoked = await this.identityRepository.revokeSessionByTokenHash(
      hashSessionToken(rawSessionToken),
      new Date(),
    );

    if (!revoked) {
      throw new AuthenticationError("UNAUTHORIZED");
    }
  }

  private async assertRateLimit(policy: RateLimitPolicy, subject: string): Promise<void> {
    try {
      const decision = await this.rateLimiter.consume(policy, subject);
      if (!decision.allowed) {
        throw new AuthenticationError("RATE_LIMITED", decision.retryAfterSeconds);
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }

      throw new AuthenticationError("AUTH_RATE_LIMIT_UNAVAILABLE");
    }
  }
}

function createSession(
  now: Date,
  metadata: AuthenticationRequestMetadata,
): { rawToken: string; creation: SessionCreation } {
  const rawToken = randomBytes(32).toString("base64url");

  return {
    rawToken,
    creation: {
      tokenHash: hashSessionToken(rawToken),
      expiresAt: getInitialSessionExpiresAt(now),
      lastSeenAt: now,
      ipHash: metadata.clientIpHash,
      userAgent: metadata.userAgent,
    },
  };
}

function hashSessionToken(rawSessionToken: string): string {
  return createHash("sha256").update(rawSessionToken).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
}
