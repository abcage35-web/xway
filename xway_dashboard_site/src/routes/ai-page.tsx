import { FormEvent, useMemo, useRef, useState } from "react";
import { Bot, KeyRound, LoaderCircle, RefreshCw, Send, UserRound } from "lucide-react";
import { sendAiChatMessage } from "../lib/api";
import { cn, getTodayIso, shiftIsoDate } from "../lib/format";
import type { AiChatMessage } from "../lib/types";

const AI_CHAT_TOKEN_STORAGE_KEY = "xway-ai-chat-token";

function readStoredToken() {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(AI_CHAT_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredToken(token: string) {
  try {
    window.localStorage.setItem(AI_CHAT_TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage failures.
  }
}

function defaultRange() {
  const today = getTodayIso();
  const end = shiftIsoDate(today, -1);
  return { start: shiftIsoDate(end, -13), end };
}

export function AiPage() {
  const initialRange = useMemo(() => defaultRange(), []);
  const [token, setToken] = useState(() => readStoredToken());
  const [article, setArticle] = useState("");
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([
    {
      role: "assistant",
      content: "Введите артикул или задайте вопрос по каталогу. Я соберу XWAY/MPVIBE данные на сервере и верну короткий разбор.",
    },
  ]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedMessage = message.trim();
    const trimmedToken = token.trim();
    if (!trimmedMessage || !trimmedToken || isLoading) {
      return;
    }
    writeStoredToken(trimmedToken);
    setError(null);
    setMessage("");
    const nextMessages = [...messages, { role: "user" as const, content: trimmedMessage }];
    setMessages(nextMessages);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    try {
      const response = await sendAiChatMessage({
        message: trimmedMessage,
        history: nextMessages.slice(-10),
        token: trimmedToken,
        article: article.trim() || null,
        start,
        end,
        signal: controller.signal,
      });
      setMessages((current) => [...current, { role: "assistant", content: response.answer }]);
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setError(requestError instanceof Error ? requestError.message : "AI request failed.");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  };

  return (
    <div className="ai-page min-h-screen bg-[var(--color-bg)] px-4 py-6 text-[var(--color-ink)]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
        <header className="flex flex-col gap-3 border-b border-[var(--color-line)] pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--color-muted)]">XWAY AI</p>
            <h1 className="mt-2 text-2xl font-semibold">AI ассистент</h1>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(180px,1fr)_140px_140px] lg:w-[560px]">
            <label className="ai-field">
              <span>Артикул</span>
              <input value={article} onChange={(event) => setArticle(event.target.value)} placeholder="например 524951263" />
            </label>
            <label className="ai-field">
              <span>С</span>
              <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
            </label>
            <label className="ai-field">
              <span>По</span>
              <input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
            </label>
          </div>
        </header>

        <section className="grid min-h-[calc(100vh-170px)] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="ai-sidebar">
            <div className="ai-sidebar-block">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="size-4" />
                Доступ
              </div>
              <label className="ai-field">
                <span>Bearer token</span>
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  onBlur={() => writeStoredToken(token.trim())}
                  placeholder="XWAY_AI_API_KEY"
                />
              </label>
            </div>
            <div className="ai-sidebar-block text-sm text-[var(--color-muted)]">
              Ассистент работает через Cloudflare: секреты XWAY и MPVIBE остаются на сервере, а модель получает компактный аналитический контекст.
            </div>
          </aside>

          <main className="ai-chat-shell">
            <div className="ai-chat-messages">
              {messages.map((item, index) => {
                const isUser = item.role === "user";
                return (
                  <div key={`${item.role}-${index}`} className={cn("ai-message", isUser ? "is-user" : "is-assistant")}>
                    <div className="ai-message-icon">{isUser ? <UserRound className="size-4" /> : <Bot className="size-4" />}</div>
                    <div className="ai-message-bubble whitespace-pre-wrap">{item.content}</div>
                  </div>
                );
              })}
              {isLoading ? (
                <div className="ai-message is-assistant">
                  <div className="ai-message-icon"><Bot className="size-4" /></div>
                  <div className="ai-message-bubble inline-flex items-center gap-2">
                    <LoaderCircle className="size-4 animate-spin" />
                    Собираю данные и считаю ответ
                  </div>
                </div>
              ) : null}
            </div>

            {error ? <div className="ai-error">{error}</div> : null}

            <form className="ai-composer" onSubmit={handleSubmit}>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Спросите: почему просели заказы, что делать с РК, где проблема по артикулу..."
                rows={3}
              />
              <div className="ai-composer-actions">
                {isLoading ? (
                  <button type="button" onClick={handleStop}>
                    <RefreshCw className="size-4" />
                    Стоп
                  </button>
                ) : null}
                <button type="submit" disabled={!message.trim() || !token.trim() || isLoading}>
                  <Send className="size-4" />
                  Отправить
                </button>
              </div>
            </form>
          </main>
        </section>
      </div>
    </div>
  );
}
