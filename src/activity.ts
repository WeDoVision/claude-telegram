import type { Bot, InlineKeyboard } from "grammy";
import type { StreamJsonEvent } from "./types.js";

const MIN_UPDATE_INTERVAL_MS = 3_000;

const DEFAULT_LABEL = "💭 Думаю";

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
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] || "mcp";
    const tool = parts.slice(2).join("__");
    return tool ? `🔌 ${capitalize(server)} · ${tool}` : `🔌 ${capitalize(server)}`;
  }
  const base = TOOL_LABELS[name] || `🔧 ${name}`;
  const target = toolTarget(input);
  return target ? `${base} ${target}` : base;
}

/** Latest actionable label from a stream-json event, or null if nothing new. */
function detectLabel(event: StreamJsonEvent): string | null {
  if (event.type !== "assistant" || !event.message?.content) return null;
  // Prefer the last tool_use in the block (most recent action).
  let label: string | null = null;
  let sawText = false;
  for (const block of event.message.content) {
    if (block.type === "tool_use" && block.name) {
      label = toolLabel(block.name, block.input);
    } else if (block.type === "text" && block.text?.trim()) {
      sawText = true;
    }
  }
  if (label) return label;
  if (sawText) return "✍️ Отвечаю";
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
 * Create an activity status updater that edits a Telegram message
 * with current Claude activity and elapsed time.
 */
export function createActivityStatus(options: ActivityStatusOptions) {
  const { api, chatId, messageId, replyMarkup } = options;
  const startTime = Date.now();

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

  async function sendUpdate() {
    if (stopped) return;

    const elapsed = formatElapsed(Date.now() - startTime);
    const text = `${currentLabel}  ⏱ ${elapsed}`;

    if (text === lastSentText) return;

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

  function onEvent(event: StreamJsonEvent) {
    if (stopped) return;
    const label = detectLabel(event);
    if (label) currentLabel = label;
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  // Send first update immediately
  void sendUpdate();

  return { onEvent, stop };
}
