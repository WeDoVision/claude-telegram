import type { ChildProcess } from "node:child_process";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { BotConfig, ClaudeResult } from "./types.js";
import { SessionStore } from "./session.js";
import { runClaude } from "./claude.js";
import { createActivityStatus } from "./activity.js";
import { sendMessage } from "./sender.js";
import { processTracker, setupGracefulShutdown } from "./shutdown.js";
import { loadModules, type BotModule, type ModuleContext } from "./modules.js";
import { addLocalWhitelist } from "./whitelist-store.js";

export interface CreateBotOptions {
  modules?: BotModule[];
  onModuleContext?: (ctx: ModuleContext) => void;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * In a group chat the bot only reacts when explicitly addressed: a reply to
 * one of its own messages, or an @-mention of its username.
 */
function isBotTriggered(ctx: Context): boolean {
  const msg = ctx.message;
  if (!msg) return false;

  // A reply to one of the bot's own messages counts as addressing it.
  if (msg.reply_to_message?.from?.id === ctx.me.id) return true;

  const text = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const username = ctx.me.username?.toLowerCase();

  for (const e of entities) {
    if (e.type === "text_mention" && e.user?.id === ctx.me.id) return true;
    if (e.type === "mention" && username) {
      const mentioned = text.slice(e.offset, e.offset + e.length).toLowerCase();
      if (mentioned === `@${username}`) return true;
    }
  }
  return false;
}

/**
 * Strip the bot's @-mention from a message before handing it to Claude,
 * so "@persona what's up?" becomes "what's up?".
 */
function stripBotMention(text: string, username?: string): string {
  if (!username) return text.trim();
  const re = new RegExp(`@${escapeRegExp(username)}(?![A-Za-z0-9_])`, "gi");
  return text.replace(re, " ").replace(/\s{2,}/g, " ").trim();
}

function sanitizeErrorForUser(text: string, workspace: string, maxLen: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const kept: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Drop Node/JS stack-trace lines and other noisy frames.
    if (/^\s*at\s+/.test(rawLine)) continue;
    if (/^\s*Node\.js v\d+/.test(rawLine)) continue;
    kept.push(line);
    if (kept.length >= 2) break;
  }

  let out = kept.length > 0 ? kept.join("\n") : lines[0]?.trim() || "";
  out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<TELEGRAM_TOKEN_REDACTED>");
  if (workspace) out = out.split(workspace).join("<WORKSPACE>");
  return out.slice(0, maxLen);
}

function buildHelpText(modules: BotModule[]): string {
  const lines: string[] = [
    "Send any message to chat with Claude Code. I'll show a live status while Claude works.\n",
    "/cancel — stop current request",
    "/clear — start a new conversation",
    "/reload — reload modules",
    "/help — show this message",
  ];

  const extra = modules
    .flatMap((m) => m.commands ?? [])
    .filter((c) => c.command.startsWith("/"));

  if (extra.length > 0) {
    lines.push("\nExtra commands:");
    for (const c of extra) lines.push(`${c.command} — ${c.description}`);
  }

  return lines.join("\n");
}

/**
 * Create and configure a Grammy bot connected to Claude CLI.
 */
export function createBot(config: BotConfig, options: CreateBotOptions = {}): Bot {
  const bot = new Bot(config.token);
  const sessionStore = new SessionStore(config.workspace, config.sessionNamespace);
  let modules = options.modules ?? [];
  let helpText = buildHelpText(modules);

  // Track which users currently have a running Claude process
  const busy = new Set<number>();

  type RunningJob = {
    child: ChildProcess;
    chatId: number;
    statusMessageId: number;
    activity: ReturnType<typeof createActivityStatus>;
    canceled: boolean;
  };

  const running = new Map<number, RunningJob>();

  // Non-whitelisted users awaiting owner approval. Dedupes owner pings and
  // remembers who to label the approve/deny card with. Process-local: a restart
  // clears it, which is fine — the next message from the user re-pings the owner.
  const pendingAccess = new Map<number, { name: string; username?: string }>();

  // Inline "stop" button attached to the live status message: lets the user
  // abort a running Claude with a tap, same effect as /cancel. The callback
  // handler is registered below alongside /cancel.
  const STOP_CALLBACK = "ct:stop";
  const stopKeyboard = new InlineKeyboard().text("🛑 Остановись", STOP_CALLBACK);

  // Avoid unhandled errors taking down the process.
  bot.catch((err) => {
    console.error("[claude-telegram] Bot error:", err.error);
  });

  // --- Middleware: allowed chat types ---
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    const type = ctx.chat.type;
    const isGroup = type === "group" || type === "supergroup";

    if (type === "private" || (isGroup && config.allowGroups)) {
      await next();
      return;
    }

    // Private-only mode (or a channel): decline, but only reply to a real
    // message so we don't react to service/non-message updates.
    try {
      if (ctx.message) {
        await ctx.reply("Please message me in a private chat.");
      }
    } catch {
      // Ignore reply failures.
    }
    return;
  });

  // --- Middleware: in groups, only react when addressed ---
  bot.use(async (ctx, next) => {
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup") {
      await next();
      return;
    }

    // A button tap on one of the bot's own messages (e.g. the stop button on a
    // status message) is inherently addressed to it — let it through. Without
    // this, callback queries carry no ctx.message and would be dropped below.
    if (ctx.callbackQuery) {
      await next();
      return;
    }

    // Let commands through to their handlers (grammy matches /cmd@botname).
    const text = ctx.message?.text ?? ctx.message?.caption;
    if (typeof text === "string" && text.startsWith("/")) {
      await next();
      return;
    }

    // Otherwise require an explicit @-mention or a reply to the bot. Untargeted
    // group chatter is ignored silently — importantly, before the whitelist
    // check, so non-whitelisted members' normal messages don't trigger the
    // "no access" reply (which would spam the group if privacy mode is off).
    if (isBotTriggered(ctx)) {
      await next();
    }
  });

  // Ping the owner that a non-whitelisted user wants in, with inline
  // approve/deny buttons. No-op unless `access_requests` is on and an `owner`
  // is set. Deduped per user so a stranger can't spam the owner.
  async function requestAccess(ctx: Context, userId: number): Promise<void> {
    // Only take requests from private chats: a stranger @-mentioning the bot in
    // a group must not be able to page the owner.
    if (ctx.chat?.type !== "private") return;
    if (pendingAccess.has(userId)) return;

    const from = ctx.from;
    const name =
      [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "Unknown";
    const username = from?.username;
    pendingAccess.set(userId, { name, username });

    const who = `${name}${username ? ` (@${username})` : ""} · id ${userId}`;
    try {
      await bot.api.sendMessage(
        config.owner as number,
        `👤 Запрос доступа к боту\n\n${who}\n\nПустить?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Пустить", callback_data: `access:ok:${userId}` },
                { text: "🚫 Отказать", callback_data: `access:no:${userId}` },
              ],
            ],
          },
        }
      );
    } catch (err) {
      // Owner unreachable — forget the pending entry so a later message retries.
      pendingAccess.delete(userId);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[claude-telegram] Failed to send access request to owner: ${msg}`);
    }
  }

  // --- Middleware: whitelist ---
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Secure by default: empty whitelist means no one can use the bot.
    if (config.whitelist.length === 0 || !config.whitelist.includes(userId)) {
      const canRequest =
        config.accessRequests === true &&
        typeof config.owner === "number" &&
        ctx.chat?.type === "private";
      if (ctx.chat) {
        try {
          await ctx.reply(
            canRequest
              ? `Заявка на доступ отправлена владельцу — подожди подтверждения.\n\nYour ID: ${userId}`
              : `Sorry, you don't have access to this bot. Ask the owner to add your user ID to the whitelist.\n\nYour ID: ${userId}`
          );
        } catch {
          // Ignore reply failures for non-message updates.
        }
      }
      if (canRequest) await requestAccess(ctx, userId);
      return;
    }

    await next();
  });

  // --- Commands ---
  bot.command("start", async (ctx) => {
    const firstName = ctx.from?.first_name || "there";
    await ctx.reply(
      `Hi ${firstName}! I'm a bridge to Claude Code — an AI that can read, write, and run code in a workspace on the server.\n\nSend any message and I'll pass it to Claude. You'll see a live status while it works.\n\nTry: "What files are in the workspace?"\n\n${helpText}`
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText);
  });

  async function runBeforeClaudeHooks(
    ctx: Context,
    message: string
  ): Promise<
    { allowed: true; message: string } | { allowed: false; reply?: string }
  > {
    let current = message;

    for (const mod of modules) {
      if (!mod.beforeClaude) continue;
      try {
        const res = await mod.beforeClaude(ctx, current);
        if (!res) continue;

        if (res.action === "deny") {
          return { allowed: false, reply: res.reply };
        }

        if (res.action === "continue" && typeof res.message === "string") {
          current = res.message;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          allowed: false,
          reply: `Module "${mod.name}" failed: ${msg.slice(0, 300)}`,
        };
      }
    }

    return { allowed: true, message: current };
  }

  async function runAfterClaudeHooks(
    ctx: Context,
    result: ClaudeResult
  ): Promise<ClaudeResult> {
    let current = result;

    for (const mod of modules) {
      if (!mod.afterClaude) continue;
      try {
        const next = await mod.afterClaude(ctx, current);
        if (next) current = next;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[claude-telegram] Module "${mod.name}" afterClaude() failed: ${msg}`
        );
      }
    }

    return current;
  }

  async function dispatchToClaude(ctx: Context, message: string): Promise<void> {
    const chatId = ctx.chat?.id;

    if (chatId === undefined) return;
    if (!message || !message.trim()) return;

    // Conversation key: private chats key by user (chat.id === user.id),
    // group chats key by chat so the whole group shares one session.
    const convKey = chatId;

    // Concurrency guard: one running Claude process per conversation.
    if (busy.has(convKey)) {
      await ctx.reply(
        "Still working on the previous message. Send /cancel to stop, or wait for the response."
      );
      return;
    }

    busy.add(convKey);

    // Give modules a chance to deny/transform the message before starting Claude.
    const before = await runBeforeClaudeHooks(ctx, message);
    if (!before.allowed) {
      if (before.reply) {
        try {
          await ctx.reply(before.reply);
        } catch {
          // Ignore
        }
      }
      busy.delete(convKey);
      return;
    }

    const finalMessage = before.message;
    if (!finalMessage || !finalMessage.trim()) {
      busy.delete(convKey);
      return;
    }

    // Send placeholder message with the stop button attached.
    let statusMsg;
    try {
      statusMsg = await ctx.reply("💭 Thinking  ⏱ 0:00", {
        reply_markup: stopKeyboard,
      });
    } catch {
      busy.delete(convKey);
      return;
    }

    const msgId = statusMsg.message_id;

    // Activity status updater — keeps the stop button on every edit.
    const activity = createActivityStatus({
      api: bot.api,
      chatId,
      messageId: msgId,
      replyMarkup: stopKeyboard,
    });

    let job: RunningJob | undefined;
    try {
      const { promise, child } = runClaude({
        config,
        sessionStore,
        sessionKey: convKey,
        message: finalMessage,
        onEvent: activity.onEvent,
      });

      job = {
        child,
        chatId,
        statusMessageId: msgId,
        activity,
        canceled: false,
      };
      running.set(convKey, job);

      processTracker.register(child);

      const result = await promise;
      if (running.get(convKey) === job) running.delete(convKey);
      activity.stop();

      // Delete the status message
      try {
        await bot.api.deleteMessage(chatId, msgId);
      } catch {
        // Ignore — message may already be deleted
      }

      if (job.canceled) {
        // Cancel was already acknowledged by /cancel or /clear.
        return;
      }

      const finalResult = await runAfterClaudeHooks(ctx, result);

      if (finalResult.success && finalResult.output) {
        const parts: string[] = [];
        const secs = Math.round(finalResult.durationMs / 1000);
        if (secs > 0) parts.push(`${secs}s`);
        if (finalResult.costUsd && finalResult.costUsd > 0)
          parts.push(`$${finalResult.costUsd.toFixed(4)}`);
        if (config.model) parts.push(config.model);
        const footer = parts.length > 0 ? parts.join(" · ") : undefined;
        await sendMessage(ctx, finalResult.output, { footer });
      } else if (finalResult.success && !finalResult.output) {
        await ctx.reply("Claude returned an empty response. Try rephrasing, or /clear to start fresh.");
      } else {
        const safeError = finalResult.error
          ? sanitizeErrorForUser(finalResult.error, config.workspace, 400)
          : undefined;
        const errorMsg = safeError
          ? `Something went wrong: ${safeError}`
          : "Something went wrong. Try again, or /clear to start fresh.";
        await ctx.reply(errorMsg);
      }
    } catch (err) {
      activity.stop();
      if (job && running.get(convKey) === job) running.delete(convKey);

      // Try to update the status message with error
      try {
        const errorText = err instanceof Error ? err.message : "Unknown error";
        const safeErrorText = sanitizeErrorForUser(
          errorText,
          config.workspace,
          400
        );
        await bot.api.editMessageText(
          chatId,
          msgId,
          safeErrorText
            ? `Something went wrong: ${safeErrorText}\n\nTry again or /clear to start fresh.`
            : "Something went wrong.\n\nTry again or /clear to start fresh."
        );
      } catch {
        // Give up on status message
      }
    } finally {
      busy.delete(convKey);
    }
  }

  const moduleCtx: ModuleContext = {
    bot,
    config,
    sessionStore,
    dispatchToClaude,
  };
  options.onModuleContext?.(moduleCtx);

  for (const mod of modules) {
    try {
      mod.register?.(moduleCtx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Module "${mod.name}" register() failed: ${msg}`);
    }
  }

  async function reloadModules(): Promise<string[]> {
    if (busy.size > 0) {
      throw new Error("Cannot reload while requests are in progress.");
    }

    // Dispose old modules (reverse order).
    for (const mod of [...modules].reverse()) {
      if (!mod.dispose) continue;
      try {
        await mod.dispose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[claude-telegram] Module "${mod.name}" dispose() failed: ${msg}`
        );
      }
    }

    // Load fresh modules.
    const fresh = await loadModules(config);

    // Init fresh modules.
    const freshCtx: ModuleContext = { bot, config, sessionStore, dispatchToClaude };
    for (const mod of fresh) {
      if (!mod.init) continue;
      await mod.init(freshCtx);
    }

    modules = fresh;
    helpText = buildHelpText(modules);

    return fresh.map((m) => m.name);
  }

  bot.command("reload", async (ctx) => {
    try {
      const names = await reloadModules();
      await ctx.reply(
        `Reloaded: ${names.join(", ") || "(none)"}\n\nNote: new commands require bot restart.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Reload failed: ${msg}`);
    }
  });

  // Stop a running job: freeze status updates, drop the stop button, and kill
  // the Claude process (SIGTERM now, SIGKILL after a grace period). Shared by
  // /cancel, /clear, and the inline stop button. Returns whether the status
  // message was successfully edited (so callers can fall back to a reply).
  async function stopJob(convKey: number, job: RunningJob): Promise<boolean> {
    job.canceled = true;
    job.activity.stop();

    // Editing without reply_markup also removes the stop button.
    let statusUpdated = false;
    try {
      await bot.api.editMessageText(
        job.chatId,
        job.statusMessageId,
        "Cancelling..."
      );
      statusUpdated = true;
    } catch {
      // Ignore
    }

    try {
      job.child.kill("SIGTERM");
    } catch {
      // Ignore
    }
    setTimeout(() => {
      try {
        if (running.get(convKey) === job) {
          job.child.kill("SIGKILL");
        }
      } catch {
        // Ignore
      }
    }, 5000);

    return statusUpdated;
  }

  bot.command("cancel", async (ctx) => {
    const convKey = ctx.chat?.id;
    if (convKey === undefined) return;

    const job = running.get(convKey);
    if (!job) {
      await ctx.reply("Nothing to cancel.");
      return;
    }

    if (job.canceled) {
      await ctx.reply("Already cancelling...");
      return;
    }

    const statusUpdated = await stopJob(convKey, job);
    if (!statusUpdated) {
      await ctx.reply("Cancelling... (may take a few seconds)");
    }
  });

  // Inline stop button on the live status message — same effect as /cancel,
  // but without typing a command.
  bot.callbackQuery(STOP_CALLBACK, async (ctx) => {
    const convKey = ctx.chat?.id;
    const job = convKey !== undefined ? running.get(convKey) : undefined;

    // The button must belong to the current job's status message. A tap on a
    // stale button (from an older message) must never kill a newer request.
    const btnMessageId = ctx.callbackQuery.message?.message_id;
    if (
      convKey === undefined ||
      !job ||
      (btnMessageId !== undefined && job.statusMessageId !== btnMessageId)
    ) {
      await ctx.answerCallbackQuery("Нечего останавливать — задача уже завершена.");
      return;
    }

    if (job.canceled) {
      await ctx.answerCallbackQuery("Уже останавливаю…");
      return;
    }

    await ctx.answerCallbackQuery("Останавливаю…");
    await stopJob(convKey, job);
  });

  bot.command("clear", async (ctx) => {
    const convKey = ctx.chat?.id;
    if (convKey === undefined) return;

    const job = running.get(convKey);
    if (job && !job.canceled) {
      await stopJob(convKey, job);
    }

    sessionStore.resetSession(convKey);
    await ctx.reply("Conversation cleared. Claude won't remember previous messages.");
  });

  // --- Text message handler ---
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text) return;

    // Skip commands (already handled above)
    if (text.startsWith("/")) return;

    // In private chats the text is passed through as-is. In groups the
    // middleware chain has already guaranteed the bot was addressed, so strip
    // its @-mention to give Claude a clean prompt.
    if (ctx.chat.type === "private") {
      await dispatchToClaude(ctx, text);
      return;
    }

    const prompt = stripBotMention(text, ctx.me.username);
    if (!prompt) {
      // Bare mention with no actual question.
      await ctx.reply("Yes? Mention me with a question, or reply to my message.");
      return;
    }
    await dispatchToClaude(ctx, prompt);
  });

  // --- Access-request approval (owner taps the inline buttons) ---
  bot.callbackQuery(/^access:(ok|no):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const targetId = Number(ctx.match[2]);

    // Only the owner may approve/deny. (A non-owner's own messages are already
    // blocked by the whitelist middleware, but guard the callback explicitly.)
    if (ctx.from?.id !== config.owner) {
      await ctx.answerCallbackQuery({ text: "Not allowed." });
      return;
    }

    const info = pendingAccess.get(targetId);
    const label = info
      ? `${info.name}${info.username ? ` (@${info.username})` : ""} · id ${targetId}`
      : `id ${targetId}`;

    if (action === "no") {
      pendingAccess.delete(targetId);
      await ctx.answerCallbackQuery({ text: "Отказано" });
      try {
        await ctx.editMessageText(`🚫 Отказано в доступе\n\n${label}`);
      } catch {
        // Ignore — the card may have changed.
      }
      return;
    }

    // action === "ok": add live (middleware reads config.whitelist), then persist.
    if (!config.whitelist.includes(targetId)) {
      config.whitelist.push(targetId);
    }
    let persisted = true;
    try {
      addLocalWhitelist(config.workspace, targetId);
    } catch (err) {
      persisted = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[claude-telegram] Failed to persist approved user ${targetId}: ${msg}`);
    }
    pendingAccess.delete(targetId);

    await ctx.answerCallbackQuery({ text: "Доступ выдан" });
    try {
      await ctx.editMessageText(
        `✅ Доступ выдан${persisted ? "" : " (не записан в файл — см. логи)"}\n\n${label}`
      );
    } catch {
      // Ignore.
    }

    // Let the approved user know they can start.
    try {
      await bot.api.sendMessage(
        targetId,
        "Доступ выдан ✅ Можешь пользоваться ботом — просто напиши сообщение."
      );
    } catch {
      // User may have no open chat with the bot yet; ignore.
    }
  });

  return bot;
}

/**
 * Start the bot with graceful shutdown handling.
 */
export async function startBot(config: BotConfig): Promise<void> {
  const modules = await loadModules(config);
  let moduleCtx: ModuleContext | undefined;

  const bot = createBot(config, {
    modules,
    onModuleContext: (ctx) => {
      moduleCtx = ctx;
    },
  });

  if (moduleCtx) {
    for (const mod of modules) {
      if (!mod.init) continue;
      console.log(`[claude-telegram] Init module: ${mod.name}`);
      await mod.init(moduleCtx);
    }
  }

  setupGracefulShutdown(() => bot.stop(), {
    timeout: 30_000,
    beforeExit: async () => {
      for (const mod of [...modules].reverse()) {
        if (!mod.dispose) continue;
        try {
          await mod.dispose();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[claude-telegram] Module "${mod.name}" dispose() failed: ${msg}`
          );
        }
      }
    },
  });

  console.log(`[claude-telegram] Starting bot...`);
  console.log(`[claude-telegram] Workspace: ${config.workspace}`);
  console.log(`[claude-telegram] Permission mode: ${config.permissionMode}`);
  console.log(
    `[claude-telegram] Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(", ") : "(empty — no one can access)"}`
  );
  console.log(
    `[claude-telegram] Group chats: ${config.allowGroups ? "allowed (must @-mention or reply to the bot)" : "disabled (private only)"}`
  );
  console.log(
    `[claude-telegram] Access requests: ${
      config.accessRequests && typeof config.owner === "number"
        ? `on (owner ${config.owner})`
        : "off"
    }`
  );
  console.log(
    `[claude-telegram] Modules: ${modules.length > 0 ? modules.map((m) => m.name).join(", ") : "(none)"}`
  );

  await bot.start({
    onStart: () => console.log("[claude-telegram] Bot is running"),
  });
}
