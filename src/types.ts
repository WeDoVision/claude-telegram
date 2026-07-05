import type { ChildProcess } from "node:child_process";

export type ModuleConfig =
  | string
  | {
      import: string;
      enabled?: boolean;
      options?: Record<string, unknown>;
    };

export interface BotConfig {
  token: string;
  workspace: string;
  whitelist: number[];
  // Allow group/supergroup chats. When false (default) the bot only
  // responds in private chats. In groups the bot must be @-mentioned (or
  // replied to), and every participant is still checked against `whitelist`.
  allowGroups: boolean;
  // Access requests: when true, a message from a non-whitelisted user pings the
  // `owner` with inline approve/deny buttons instead of a silent deny. Approving
  // adds the user live and persists to whitelist.local.json. Off by default.
  accessRequests?: boolean;
  // Telegram user ID that receives access requests and may approve them. Required
  // for accessRequests to do anything; typically the first whitelist entry.
  owner?: number;
  permissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "delegate"
    | "dontAsk"
    | "plan";
  claudePath: string;
  timeout: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  addDirs?: string[];
  modules?: ModuleConfig[];

  // Security / capability controls (forwarded to Claude Code CLI).
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  disableSlashCommands?: boolean;
  settingSources?: string; // e.g. "user,project"
  strictMcpConfig?: boolean;
  mcpConfig?: string[];
  sessionNamespace?: string;
}

export interface RawConfig {
  token: string;
  workspace: string;
  whitelist?: number[];
  allow_groups?: boolean;
  access_requests?: boolean;
  owner?: number;
  permission_mode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "delegate"
    | "dontAsk"
    | "plan";
  claude_path?: string;
  timeout?: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  system_prompt?: string;
  add_dirs?: string[];
  modules?: ModuleConfig[];
  session_namespace?: string;

  tools?: string | string[];
  allowed_tools?: string[];
  disallowed_tools?: string[];
  disable_slash_commands?: boolean;
  setting_sources?: string | Array<"user" | "project" | "local">;
  strict_mcp_config?: boolean;
  mcp_config?: string[];
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs: number;
  /**
   * Assistant text captured from the stream before the run ended. Used to show
   * a partial answer when a run was stopped or killed. Empty if nothing was
   * written yet.
   */
  partialOutput?: string;
}

export interface ClaudeProcess {
  child: ChildProcess;
  userId: number;
  startTime: number;
}

export type ActivityKey =
  | "thinking"
  | "reading"
  | "editing"
  | "writing"
  | "searching"
  | "command"
  | "web"
  | "subagent"
  | "mcp";

export interface StreamJsonEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      text?: string;
      input?: Record<string, unknown>;
    }>;
  };
}
