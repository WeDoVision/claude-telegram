import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Runtime-approved Telegram IDs live in a sidecar next to the persona's config,
// separate from the hand-curated `whitelist:` in claude-telegram.yaml. This keeps
// the curated core in git while approvals granted from chat persist locally
// (gitignored) — the same hybrid split used for MCP and skills.
const FILE = "whitelist.local.json";

function sidecarPath(workspace: string): string {
  return join(workspace, FILE);
}

/**
 * Read the runtime-approved Telegram IDs for a persona. Tolerant of a missing or
 * corrupt file: always returns a (possibly empty) array of integers, never throws.
 */
export function readLocalWhitelist(workspace: string): number[] {
  const path = sidecarPath(workspace);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is number => typeof x === "number" && Number.isInteger(x)
    );
  } catch {
    // Corrupt/unreadable sidecar must not take down startup or approval.
    return [];
  }
}

/**
 * Append an approved ID to the sidecar. Idempotent — returns true only when the
 * ID was newly added, false if it was already present. Throws only on a real
 * write failure (caller decides how loudly to complain).
 */
export function addLocalWhitelist(workspace: string, id: number): boolean {
  const current = readLocalWhitelist(workspace);
  if (current.includes(id)) return false;
  const next = [...current, id];
  writeFileSync(sidecarPath(workspace), JSON.stringify(next, null, 2) + "\n", "utf-8");
  return true;
}
