/**
 * Identity 限界上下文的认证领域模型与端口。
 *
 * 导出：
 * - IdentityRepository：用户与不透明 Session 的持久化端口。
 * - PasswordHasher：Argon2id 密码哈希与校验端口。
 * - AuthenticationRateLimiter：认证入口的共享限流端口。
 * - AuthenticationError：应用层可映射为安全 HTTP 响应的错误。
 * - Session 时长常量与续期判断：统一实现 3 天闲置、15 天绝对上限的规则。
 */

export const SESSION_IDLE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 15 * 24 * 60 * 60 * 1000;
export const SESSION_RENEWAL_REMAINING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const SESSION_RENEWAL_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
}

export interface PasswordUser extends AuthenticatedUser {
  passwordHash: string;
  status: "active" | "suspended" | "pending_deletion";
}

export interface SessionRecord extends AuthenticatedUser {
  sessionId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  profileCompleted: boolean;
}

export interface SessionCreation {
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  ipHash: string;
  userAgent: string | null;
}

export interface IdentityRepository {
  findUserByEmail(email: string): Promise<PasswordUser | null>;
  createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<AuthenticatedUser>;
  createSessionForUser(userId: string, session: SessionCreation, now: Date): Promise<void>;
  findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  renewSession(input: {
    sessionId: string;
    expiresAt: Date;
    lastSeenAt: Date;
    renewalAllowedBefore: Date;
    now: Date;
  }): Promise<boolean>;
  revokeSessionByTokenHash(tokenHash: string, now: Date): Promise<boolean>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string | null): Promise<boolean>;
}

export interface RateLimitPolicy {
  name: "register" | "login";
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthenticationRateLimiter {
  consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision>;
}

export type AuthenticationErrorCode =
  | "EMAIL_ALREADY_EXISTS"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED"
  | "INVALID_ORIGIN"
  | "RATE_LIMITED"
  | "AUTH_RATE_LIMIT_UNAVAILABLE";

export class AuthenticationError extends Error {
  constructor(
    public readonly code: AuthenticationErrorCode,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "AuthenticationError";
  }
}

export function getSessionAbsoluteExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS);
}

export function getInitialSessionExpiresAt(now: Date): Date {
  return new Date(now.getTime() + SESSION_IDLE_TTL_MS);
}

export function getRenewedSessionExpiresAt(now: Date, createdAt: Date): Date {
  return new Date(Math.min(
    now.getTime() + SESSION_IDLE_TTL_MS,
    getSessionAbsoluteExpiresAt(createdAt).getTime(),
  ));
}

export function shouldRenewSession(session: Pick<SessionRecord, "expiresAt" | "lastSeenAt">, now: Date): boolean {
  const remainingMs = session.expiresAt.getTime() - now.getTime();
  const sinceLastRenewalMs = now.getTime() - session.lastSeenAt.getTime();

  return remainingMs < SESSION_RENEWAL_REMAINING_THRESHOLD_MS
    && sinceLastRenewalMs > SESSION_RENEWAL_MIN_INTERVAL_MS;
}
