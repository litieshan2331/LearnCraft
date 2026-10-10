/**
 * 学习助手应用服务的基础设施装配入口。
 *
 * 调用顺序：Route Handler 调用 getLearningAssistantService → 复用 Repository 工厂实例
 * → LearningAssistantService 编排会话、消息和运行用例。
 */

import { LearningAssistantService } from "../application/learning-assistant-service";
import { getLearningAssistantRepository } from "./learning-assistant-repository-factory";

let service: LearningAssistantService | undefined;

/** 返回进程内共享的学习助手应用服务。 */
export function getLearningAssistantService(): LearningAssistantService {
  service ??= new LearningAssistantService(getLearningAssistantRepository());
  return service;
}
