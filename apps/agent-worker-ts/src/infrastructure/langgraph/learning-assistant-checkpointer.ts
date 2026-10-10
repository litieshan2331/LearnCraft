/**
 * 学习助手 LangGraph PostgreSQL Checkpointer 装配。
 *
 * 调用顺序：Worker/对话运行处理器调用 createLearningAssistantCheckpointer 创建
 * PostgresSaver → 用 createLearningAssistantThreadConfig 生成会话 thread_id 配置
 * → LangGraph 图执行读写 agent Schema → 进程关闭时调用 closeLearningAssistantCheckpointer。
 * 本文件只负责连接和配置，不执行生产迁移；表结构由 Web Drizzle 迁移维护。
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

export interface LearningAssistantCheckpointer {
  /** 供 StateGraph.compile({ checkpointer }) 使用的 PostgreSQL Checkpointer。 */
  saver: PostgresSaver;
}

/** 创建使用现有 agent Schema 的 Checkpointer；调用方必须先执行数据库迁移。 */
export function createLearningAssistantCheckpointer(
  databaseUrl: string,
): LearningAssistantCheckpointer {
  const normalizedUrl = databaseUrl.trim();
  if (normalizedUrl.length === 0) {
    throw new Error('创建学习助手 Checkpointer 时必须提供 DATABASE_URL。');
  }

  return {
    saver: PostgresSaver.fromConnString(normalizedUrl, { schema: 'agent' }),
  };
}

/** 把 Web 创建的 conversation_id 映射成 LangGraph 可恢复执行所需的 thread_id。 */
export function createLearningAssistantThreadConfig(
  conversationId: string,
): RunnableConfig {
  const normalizedConversationId = conversationId.trim();
  if (normalizedConversationId.length === 0) {
    throw new Error('学习助手 Checkpointer 配置必须提供 conversation_id。');
  }

  return {
    configurable: {
      thread_id: normalizedConversationId,
    },
  };
}

/** 关闭 Checkpointer 内部连接池；应在 Worker 优雅退出时调用。 */
export async function closeLearningAssistantCheckpointer(
  checkpointer: LearningAssistantCheckpointer,
): Promise<void> {
  await checkpointer.saver.end();
}
