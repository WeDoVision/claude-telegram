import type { ChildProcess } from "node:child_process";

/**
 * Kill a child together with everything it spawned (Claude and its MCP
 * servers). The child is started with `detached: true` so it leads its own
 * process group; signalling the negative PID hits the whole group. Killing only
 * `child.pid` would orphan the MCP servers — they linger, pile up as a memory
 * leak, and keep the session lock held (next `--resume` then fails with
 * "Session ID … is already in use"). Falls back to the single process if the
 * group is already gone or the platform lacks process groups (e.g. Windows).
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

/**
 * Tracks running Claude CLI processes for graceful shutdown.
 */
class ProcessTracker {
  private processes = new Map<number, ChildProcess>();

  register(child: ChildProcess): void {
    if (child.pid) {
      this.processes.set(child.pid, child);
      child.on("close", () => {
        if (child.pid) this.processes.delete(child.pid);
      });
    }
  }

  get count(): number {
    return this.processes.size;
  }

  async waitForAll(timeoutMs: number): Promise<boolean> {
    if (this.processes.size === 0) return true;

    const start = Date.now();
    while (this.processes.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.processes.size === 0;
  }

  killAll(signal: NodeJS.Signals = "SIGKILL"): void {
    for (const proc of this.processes.values()) {
      killProcessTree(proc, signal);
    }
  }
}

export const processTracker = new ProcessTracker();

/**
 * Setup graceful shutdown handlers.
 * Stops Grammy polling, waits for Claude processes, then exits.
 */
export function setupGracefulShutdown(
  botStop: () => void,
  options: { timeout?: number; beforeExit?: () => void | Promise<void> } = {}
): void {
  const { timeout = 30_000, beforeExit } = options;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[claude-telegram] ${signal} received`);

    // Stop accepting new messages
    botStop();

    const count = processTracker.count;
    if (count > 0) {
      console.log(
        `[claude-telegram] Waiting for ${count} Claude process(es)...`
      );
      const allDone = await processTracker.waitForAll(timeout);

      if (!allDone) {
        console.log("[claude-telegram] Timeout, killing remaining processes");
        processTracker.killAll();
      } else {
        console.log("[claude-telegram] All processes completed");
      }
    }

    if (beforeExit) {
      try {
        await beforeExit();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[claude-telegram] Shutdown hook error: ${msg}`);
      }
    }

    console.log("[claude-telegram] Shutdown complete");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
