/**
 * Profile 应用服务的基础设施装配入口。
 *
 * 导出：
 * - getProfileService：惰性创建并复用画像与学习目标应用服务。
 */

import { ProfileService } from "../application/profile-service";
import { DrizzleProfileRepository } from "./drizzle-profile-repository";

let profileService: ProfileService | undefined;

export function getProfileService(): ProfileService {
  profileService ??= new ProfileService(new DrizzleProfileRepository());
  return profileService;
}
