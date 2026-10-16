/**
 * 顶部学习助手入口和可收起的对话面板。
 *
 * 调用顺序：点击入口后读取或创建会话 → 读取全部消息和 active_run_id →
 * 发送消息并轮询运行 → 运行完成后刷新消息。面板只展示用户消息和助手消息。
 */

"use client";

import {
  Bot,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createLearningAssistantConversation,
  getLearningAssistantConversation,
  getLearningAssistantRun,
  LearningAssistantApiError,
  listLearningAssistantConversations,
  listLearningAssistantMessages,
  sendLearningAssistantMessage,
  type LearningAssistantConversation,
  type LearningAssistantMessage,
  type LearningAssistantRun,
} from "../api/learning-assistant-client";
import { Button } from "@/shared/ui/primitives/button";

const CONVERSATION_STORAGE_KEY = "learncraft.learning-assistant.conversation-id";

/** 在学习区顶部渲染入口，并控制对话面板的显示状态。 */
export function LearningAssistantPanel() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        aria-controls="learning-assistant-panel"
        aria-expanded={isOpen}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        onClick={() => setIsOpen((current) => !current)}
        title={isOpen ? "收起学习助手" : "展开学习助手"}
        type="button"
      >
        <MessageCircle aria-hidden className="size-4" />
        <span>学习助手</span>
        {isOpen ? <ChevronUp aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
      </button>
      {isOpen ? <LearningAssistantDialog onClose={() => setIsOpen(false)} /> : null}
    </>
  );
}

/** 加载会话、展示历史、发送消息并恢复在途运行。 */
function LearningAssistantDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const [conversation, setConversation] = useState<LearningAssistantConversation | null>(null);
  const [messages, setMessages] = useState<LearningAssistantMessage[]>([]);
  const [activeRun, setActiveRun] = useState<LearningAssistantRun | null>(null);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async (conversationId: string): Promise<void> => {
    const loaded: LearningAssistantMessage[] = [];
    let afterSequenceNo = 0;
    let nextAfterSequenceNo: number | null = 0;

    while (nextAfterSequenceNo !== null) {
      const page = await listLearningAssistantMessages(conversationId, afterSequenceNo);
      loaded.push(...page.items);
      nextAfterSequenceNo = page.next_after_sequence_no;
      if (nextAfterSequenceNo !== null) {
        if (nextAfterSequenceNo <= afterSequenceNo) break;
        afterSequenceNo = nextAfterSequenceNo;
      }
    }

    setMessages(loaded);
  }, []);

  const resolveConversation = useCallback(async (): Promise<LearningAssistantConversation> => {
    const savedId = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (savedId) {
      try {
        const savedConversation = await getLearningAssistantConversation(savedId);
        if (savedConversation.status === "active") return savedConversation;
      } catch {
        window.localStorage.removeItem(CONVERSATION_STORAGE_KEY);
      }
    }

    const existing = await listLearningAssistantConversations(1);
    const nextConversation = existing[0] && existing[0].status === "active"
      ? existing[0]
      : await createLearningAssistantConversation();
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, nextConversation.id);
    return nextConversation;
  }, []);

  const refreshConversation = useCallback(async (conversationId: string): Promise<void> => {
    const nextConversation = await getLearningAssistantConversation(conversationId);
    setConversation(nextConversation);
    if (nextConversation.active_run_id) {
      setActiveRun(await getLearningAssistantRun(nextConversation.active_run_id));
    } else {
      setActiveRun(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextConversation = await resolveConversation();
        await loadMessages(nextConversation.id);
        await refreshConversation(nextConversation.id);
        if (active) setError(null);
      } catch (loadError) {
        if (active) setError(toDisplayError(loadError, "暂时无法打开学习助手，请稍后重试。"));
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadMessages, refreshConversation, resolveConversation]);

  useEffect(() => {
    if (!activeRun || (activeRun.status !== "queued" && activeRun.status !== "running")) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const nextRun = await getLearningAssistantRun(activeRun.id);
        if (cancelled) return;
        setActiveRun(nextRun);
        if (nextRun.status === "queued" || nextRun.status === "running") {
          timer = window.setTimeout(() => void poll(), 1500);
          return;
        }
        if (conversation) await loadMessages(conversation.id);
        if (nextRun.status === "failed") setError(nextRun.error_summary ?? "本次回复生成失败，请稍后重试。");
      } catch (pollError) {
        if (!cancelled) setError(toDisplayError(pollError, "暂时无法读取回复状态，请稍后重试。"));
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeRun, conversation, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun?.status]);

  /** 提交当前输入，接口返回的运行由状态轮询继续处理。 */
  async function handleSend(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !conversation || isSending || activeRun?.status === "queued" || activeRun?.status === "running") return;

    setIsSending(true);
    setError(null);
    try {
      const result = await sendLearningAssistantMessage(conversation.id, content);
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message]);
      setActiveRun(result.run);
      setDraft("");
    } catch (sendError) {
      setError(toDisplayError(sendError, "消息发送失败，请稍后重试。"));
    } finally {
      setIsSending(false);
    }
  }

  const isBusy = isSending || activeRun?.status === "queued" || activeRun?.status === "running";

  return (
    <aside
      aria-label="学习助手对话"
      className="fixed inset-x-3 top-[5.75rem] z-40 flex h-[min(720px,calc(100vh-6.5rem))] flex-col overflow-hidden rounded-2xl border border-border/90 bg-card/95 shadow-[0_24px_80px_-30px_rgba(23,53,58,0.45)] backdrop-blur-xl sm:inset-x-auto sm:right-5 sm:w-[min(28rem,calc(100vw-2rem))]"
      id="learning-assistant-panel"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border/80 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive"><Bot aria-hidden className="size-4" /></span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">学习助手</h2>
            <p className="truncate text-xs text-muted-foreground">{getRunStatusLabel(activeRun?.status)}</p>
          </div>
        </div>
        <Button aria-label="关闭学习助手" className="size-8 rounded-lg" onClick={onClose} size="icon" type="button" variant="ghost">
          <X aria-hidden className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {isLoading ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground"><LoaderCircle aria-hidden className="size-5 animate-spin text-primary" /></div>
        ) : error && messages.length === 0 ? (
          <div className="grid h-full place-items-center px-5 text-center"><CircleAlert aria-hidden className="size-6 text-destructive" /><p className="mt-3 text-sm text-muted-foreground">{error}</p></div>
        ) : messages.length === 0 ? (
          <div className="grid h-full place-items-center px-7 text-center"><span className="grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"><MessageCircle aria-hidden className="size-5" /></span><p className="mt-4 text-sm font-medium">从当前页面开始提问</p><p className="mt-1 text-xs leading-6 text-muted-foreground">可以让助手帮你分析错题、追问思路或回答编程问题。</p></div>
        ) : (
          <div className="space-y-3">
            {messages.filter((message) => message.role !== "tool" && message.content !== null).map((message) => <MessageBubble key={message.id} message={message} />)}
            {isBusy ? <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden className="size-3.5 animate-spin" />正在整理回复…</div> : null}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border/80 p-3">
        {error && messages.length > 0 ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
        <form className="flex items-end gap-2" onSubmit={(event) => void handleSend(event)}>
          <textarea
            aria-label="输入消息"
            className="min-h-10 max-h-32 flex-1 resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading || !conversation || Boolean(isBusy)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={isBusy ? "正在生成回复…" : "输入你想讨论的内容"}
            value={draft}
          />
          <Button aria-label="发送消息" className="size-10 rounded-xl" disabled={!draft.trim() || isLoading || !conversation || Boolean(isBusy)} size="icon" type="submit">
            {isSending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />}
          </Button>
        </form>
      </footer>
    </aside>
  );
}

/** 将公开消息转换成用户和助手可区分的气泡。 */
function MessageBubble({ message }: Readonly<{ message: LearningAssistantMessage }>) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 ${isUser ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-secondary/75 text-foreground"}`}>
        {message.content}
      </div>
    </div>
  );
}

/** 将运行状态转换成顶部状态文案。 */
function getRunStatusLabel(status: LearningAssistantRun["status"] | undefined): string {
  switch (status) {
    case "queued": return "等待处理";
    case "running": return "正在思考";
    case "succeeded": return "已准备好继续对话";
    case "failed": return "回复生成失败";
    case "cancelled": return "运行已取消";
    default: return "随时可以开始对话";
  }
}

/** 将 API 异常转换成面板可直接显示的文案。 */
function toDisplayError(error: unknown, fallback: string): string {
  if (error instanceof LearningAssistantApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}
