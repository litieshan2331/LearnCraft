/**
 * AgentRun 实时进度的浏览器暂存（仅本标签页、仅会话内存）。
 *
 * 职责：进度通道（Redis Pub/Sub）不重放，刷新后此前收到的思考会丢失；这里把组件状态按 runId
 * 暂存到 sessionStorage，页面重新挂载时恢复「本标签页此前已收到的」事件与思考，之后的新增量继续追加。
 *
 * 约束：
 * - 只写 sessionStorage：关闭标签页即消失，不上服务器、不落库、不写日志；
 * - 任何读写失败（隐私模式、配额、结构非法）都静默忽略，绝不影响进度展示；
 * - 读取时做结构与上限校验：事件最多 30 条、思考最多 3 轮、每轮最多 4000 字符；
 *   超过 {@link AGENT_PROGRESS_STORAGE_TTL_MS} 的快照视为过期并删除。
 *
 * 导出：
 * - StoredAgentProgressEvent / StoredAgentProgressThinkingTurn / StoredAgentProgress：暂存结构。
 * - AGENT_PROGRESS_STORAGE_PREFIX / AGENT_PROGRESS_STORAGE_TTL_MS：键前缀与有效期。
 * - readAgentProgressSnapshot：读取并校验本标签页快照（无/过期/非法时返回 null）。
 * - writeAgentProgressSnapshot：写入快照（按上限裁剪）。
 * - clearAgentProgressSnapshot：删除快照。
 */

export interface StoredAgentProgressEvent {
  v: 1;
  step: string;
  at: string;
  seq: number;
  data?: Record<string, string | number | boolean>;
}

export interface StoredAgentProgressThinkingTurn {
  turn: number;
  text: string;
}

/** 一次运行的进度快照；字段与展示层组件的 state 同构。 */
export interface StoredAgentProgress {
  events: StoredAgentProgressEvent[];
  thinkingTurns: StoredAgentProgressThinkingTurn[];
}

/** 键前缀：与进度频道前缀保持一致，便于排查。 */
export const AGENT_PROGRESS_STORAGE_PREFIX = "learncraft:agent-progress:";

/** 快照有效期：超过即视为过期（用户离开太久，继续展示旧思考没有意义）。 */
export const AGENT_PROGRESS_STORAGE_TTL_MS = 30 * 60 * 1_000;

/** 暂存上限：与展示上限对齐，避免长会话把 sessionStorage 撑大。 */
const MAX_STORED_EVENTS = 30;
const MAX_STORED_THINKING_TURNS = 3;
const MAX_STORED_TURN_CHARS = 4_000;

interface StoredRecord extends StoredAgentProgress {
  runId: string;
  savedAt: number;
}

/** 默认存储：浏览器不可用或不可访问时返回 null（例如 SSR、隐私模式）。 */
function defaultStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 结构校验：只接受组件能安全渲染的事件。 */
function isStoredEvent(value: unknown): value is StoredAgentProgressEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredAgentProgressEvent>;
  return typeof candidate.step === "string"
    && typeof candidate.at === "string"
    && typeof candidate.seq === "number"
    && Number.isFinite(candidate.seq);
}

/** 结构校验：只接受轮次号 + 文本的思考块。 */
function isStoredThinkingTurn(value: unknown): value is StoredAgentProgressThinkingTurn {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredAgentProgressThinkingTurn>;
  return typeof candidate.turn === "number"
    && Number.isFinite(candidate.turn)
    && typeof candidate.text === "string";
}

/** 读取本标签页暂存的快照；过期或结构非法时删除该条目并返回 null。 */
export function readAgentProgressSnapshot(
  runId: string,
  storage: Storage | null = defaultStorage(),
): StoredAgentProgress | null {
  if (storage === null) {
    return null;
  }
  const key = AGENT_PROGRESS_STORAGE_PREFIX + runId;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearAgentProgressSnapshot(runId, storage);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    clearAgentProgressSnapshot(runId, storage);
    return null;
  }

  const record = parsed as Partial<StoredRecord>;
  if (record.runId !== runId || typeof record.savedAt !== "number") {
    clearAgentProgressSnapshot(runId, storage);
    return null;
  }
  if (Date.now() - record.savedAt > AGENT_PROGRESS_STORAGE_TTL_MS) {
    clearAgentProgressSnapshot(runId, storage);
    return null;
  }

  const events = Array.isArray(record.events) ? record.events.filter(isStoredEvent) : [];
  const thinkingTurns = Array.isArray(record.thinkingTurns)
    ? record.thinkingTurns.filter(isStoredThinkingTurn)
    : [];
  return {
    events: events.slice(-MAX_STORED_EVENTS),
    thinkingTurns: thinkingTurns.slice(-MAX_STORED_THINKING_TURNS),
  };
}

/** 写入快照（按上限裁剪）；无内容或写入失败时什么都不做。 */
export function writeAgentProgressSnapshot(
  runId: string,
  snapshot: StoredAgentProgress,
  storage: Storage | null = defaultStorage(),
): void {
  if (storage === null) {
    return;
  }
  const events = snapshot.events.filter(isStoredEvent).slice(-MAX_STORED_EVENTS);
  const thinkingTurns = snapshot.thinkingTurns
    .filter(isStoredThinkingTurn)
    .slice(-MAX_STORED_THINKING_TURNS)
    .map((turn) => ({ turn: turn.turn, text: turn.text.slice(-MAX_STORED_TURN_CHARS) }));
  if (events.length === 0 && thinkingTurns.length === 0) {
    return;
  }

  const record: StoredRecord = { runId, savedAt: Date.now(), events, thinkingTurns };
  try {
    storage.setItem(AGENT_PROGRESS_STORAGE_PREFIX + runId, JSON.stringify(record));
  } catch {
    // 配额不足或隐私模式：忽略，进度照常展示。
  }
}

/** 删除本标签页里该运行的快照。 */
export function clearAgentProgressSnapshot(
  runId: string,
  storage: Storage | null = defaultStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(AGENT_PROGRESS_STORAGE_PREFIX + runId);
  } catch {
    // 忽略：清理失败不影响展示。
  }
}
