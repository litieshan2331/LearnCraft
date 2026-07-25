/**
 * Identity 认证用例的基础设施装配入口。
 *
 * 导出：
 * - getAuthenticationService：在 Web 进程内复用已装配的认证应用服务。
 */

import { AuthenticationService } from "../application/authentication-service";
import { Argon2PasswordHasher } from "./argon2-password-hasher";
import { DrizzleIdentityRepository } from "./drizzle-identity-repository";
import { RedisAuthenticationRateLimiter } from "./redis-auth-rate-limiter";

let authenticationService: AuthenticationService | undefined;

export function getAuthenticationService(): AuthenticationService {
  authenticationService ??= new AuthenticationService(
    new DrizzleIdentityRepository(),
    new Argon2PasswordHasher(),
    new RedisAuthenticationRateLimiter(),
  );

  return authenticationService;
}
