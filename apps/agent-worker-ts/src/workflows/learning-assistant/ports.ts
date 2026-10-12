/**
 * 学习助手运行时依赖端口；图通过注入的接口复用网关与业务应用服务。
 * 调用顺序：装配固定连接和持久化预算 → 取可信业务事实 → 模型/工具观测 → 校验证据 → 幂等保存。
 */
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { FileLearningSkills } from '../../application/services/learning-skills.js';
import type { TraceWriter } from '../../application/services/trace-writer.js';
import type { ModelCompletionRequest, ModelCompletionResponse, ModelProviderConnection } from '../../infrastructure/llm/model-gateway.js';
import type { ToolGatewayPort } from '../../application/services/tool-aware-generator.js';
import type { AssistantState, ConversationMessage } from './state.js';
import type { BusinessResult, BusinessToolName, Evidence, RunInput, Verification } from './schemas/index.js';

export interface ModelPort { complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> }
export interface MemoryCandidate {
  verification: Verification; evidence: Evidence[];
  diagnosis: AssistantState['diagnosis']; evaluation: 'executed' | 'model_evaluated';
}
export interface LearningAssistantDependencies {
  checkpointer: BaseCheckpointSaver;
  model: ModelPort;
  /** 运行开始选择并固定；恢复时按已保存 connection_id 读取，禁止换成新的默认连接。 */
  connection: ModelProviderConnection;
  trace: TraceWriter;
  /** 必须持久化原子预占；返回本 run 已消耗次数，超过 20 抛错。 */
  reserveModelAttempt(input: RunInput): Promise<number>;
  skills: Pick<FileLearningSkills, 'listSkills' | 'loadSkill'>;
  tavily: ToolGatewayPort;
  /** 身份、题目 ID 由服务端 input 注入；模型参数不能参与身份选取。 */
  readBusinessTool(name: BusinessToolName, input: RunInput): Promise<BusinessResult>;
  /** 只在首次缺少 Checkpoint 时使用，包含截至当前轮的完整消息和工具链。 */
  loadInitialMessages(input: RunInput): Promise<ConversationMessage[]>;
  /** 固定消息 ID，幂等落库；工具原始载荷留在内部字段。 */
  persistMessages(input: RunInput, messages: readonly ConversationMessage[]): Promise<void>;
  /** 除结构和来源检查外，服务端还需检查后续表现；不能只采信模型自评。 */
  validateLearningMemory(input: RunInput, candidate: MemoryCandidate): Promise<boolean>;
  /** 幂等键固定为 run_id；不直接更新画像或掌握度。 */
  persistLearningMemory(input: RunInput, candidate: MemoryCandidate): Promise<void>;
}
