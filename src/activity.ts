import type { Bot, InlineKeyboard } from "grammy";
import type { StreamJsonEvent } from "./types.js";

const MIN_UPDATE_INTERVAL_MS = 3_000;

const DEFAULT_LABEL = "💭 Думаю";

// Keep the message well under Telegram's 4096-char hard limit and readable.
const MAX_HISTORY_LINES = 25;
const MAX_LINE_LEN = 64;
const MAX_TEXT_LEN = 3_900;

// Built-in tools → icon + verb. File/target detail is appended when available.
const TOOL_LABELS: Record<string, string> = {
  Read: "📖 Читаю",
  Edit: "✏️ Правлю",
  Write: "📝 Пишу",
  MultiEdit: "✏️ Правлю",
  Bash: "🔧 Команда",
  Grep: "🔍 Ищу",
  Glob: "🔍 Ищу",
  WebFetch: "🌐 Открываю",
  WebSearch: "🌐 Ищу в вебе",
  Task: "🧩 Суб-агент",
  TodoWrite: "🗒 План",
};

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Short, human target from a tool's input (file name, query, url, command…). */
function toolTarget(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const raw =
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    input.command ??
    input.prompt ??
    input.description;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw.trim();
  if (s.includes("/")) s = s.split("/").pop() || s; // basename for paths
  s = s.replace(/\s+/g, " ");
  return s.length > 40 ? s.slice(0, 39) + "…" : s;
}

/**
 * Turn a tool_use block into a detailed status line, e.g.:
 *   mcp__linear__list_issues  → "🔌 Linear · list_issues"
 *   Read {file_path: .../CLAUDE.md} → "📖 Читаю CLAUDE.md"
 */
function toolLabel(name: string, input?: Record<string, unknown>): string {
  let label: string;
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] || "mcp";
    const tool = parts.slice(2).join("__");
    label = tool ? `🔌 ${capitalize(server)} · ${tool}` : `🔌 ${capitalize(server)}`;
  } else {
    const base = TOOL_LABELS[name] || `🔧 ${name}`;
    const target = toolTarget(input);
    label = target ? `${base} ${target}` : base;
  }
  return clamp(label, MAX_LINE_LEN);
}

interface Activity {
  label: string;
  /** A real tool call (goes into history) vs a transient phase (think/answer). */
  isTool: boolean;
}

/** Latest actionable activity from a stream-json event, or null if nothing new. */
function detectActivity(event: StreamJsonEvent): Activity | null {
  if (event.type !== "assistant" || !event.message?.content) return null;
  // Prefer the last tool_use in the block (most recent action).
  let toolLine: string | null = null;
  let sawText = false;
  for (const block of event.message.content) {
    if (block.type === "tool_use" && block.name) {
      toolLine = toolLabel(block.name, block.input);
    } else if (block.type === "text" && block.text?.trim()) {
      sawText = true;
    }
  }
  if (toolLine) return { label: toolLine, isTool: true };
  if (sawText) return { label: "✍️ Отвечаю", isTool: false };
  return null;
}

interface ActivityStatusOptions {
  api: Bot["api"];
  chatId: number;
  messageId: number;
  /**
   * Inline keyboard to keep attached to the status message. Telegram drops the
   * keyboard on any editMessageText that omits reply_markup, so we re-send it on
   * every update — otherwise a "stop" button would vanish on the first tick.
   */
  replyMarkup?: InlineKeyboard;
}

/**
 * Create an activity status updater that edits a Telegram message with the
 * running history of Claude's tool calls (one line each) plus the current
 * activity and elapsed time on the last line. The history accumulates instead
 * of being overwritten, so the finished message shows everything Claude did.
 */
export function createActivityStatus(options: ActivityStatusOptions) {
  const { api, chatId, messageId, replyMarkup } = options;
  const startTime = Date.now();

  // Distinct tool-call lines in order. Transient phases (think/answer) are not
  // recorded here — they only surface as the live active line.
  const history: string[] = [];
  let currentLabel = DEFAULT_LABEL;
  let lastSentText = "";
  let stopped = false;

  const timer = setInterval(sendUpdate, MIN_UPDATE_INTERVAL_MS);

  function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  }

  /** History capped to the last N lines, with a marker for anything hidden. */
  function cappedHistory(): string[] {
    if (history.length <= MAX_HISTORY_LINES) return [...history];
    const hidden = history.length - MAX_HISTORY_LINES;
    return [`⋯ ещё ${hidden} выше`, ...history.slice(-MAX_HISTORY_LINES)];
  }

  /**
   * Snapshot of the tool history, optionally with a final footer line (e.g.
   * "🛑 Остановлено") in place of the live timer. Used to finalize the message
   * on stop while keeping the history visible.
   */
  function snapshot(footer?: string): string {
    const base = history.length ? cappedHistory() : [];
    const lines = footer ? [...base, footer] : base;
    const text = lines.length ? lines.join("\n") : DEFAULT_LABEL;
    return text.slice(0, MAX_TEXT_LEN);
  }

  /** Live text: history plus the current activity + elapsed on the last line. */
  function liveText(): string {
    const elapsed = formatElapsed(Date.now() - startTime);
    const lines = cappedHistory();
    const lastHist = history[history.length - 1];
    if (currentLabel === lastHist && lines.length > 0) {
      // The active action is the last tool — put the timer on it.
      lines[lines.length - 1] = `${lines[lines.length - 1]}  ⏱ ${elapsed}`;
    } else {
      // A transient phase (think/answer) or an empty history — show it below.
      lines.push(`${currentLabel}  ⏱ ${elapsed}`);
    }
    return lines.join("\n").slice(0, MAX_TEXT_LEN);
  }

  async function edit(text: string): Promise<void> {
    try {
      await api.editMessageText(
        chatId,
        messageId,
        text,
        replyMarkup ? { reply_markup: replyMarkup } : undefined
      );
      lastSentText = text;
    } catch {
      // Silently ignore edit failures (rate limit, message deleted, etc.)
    }
  }

  async function sendUpdate() {
    if (stopped) return;
    const text = liveText();
    if (text === lastSentText) return;
    await edit(text);
  }

  function onEvent(event: StreamJsonEvent) {
    if (stopped) return;
    const act = detectActivity(event);
    if (!act) return;
    currentLabel = act.label;
    // Record tool calls (deduping only consecutive repeats of the same line).
    if (act.isTool && history[history.length - 1] !== act.label) {
      history.push(act.label);
    }
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  // Send first update immediately
  void sendUpdate();

  return { onEvent, stop, snapshot };
}
