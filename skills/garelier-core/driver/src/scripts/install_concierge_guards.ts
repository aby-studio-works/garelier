#!/usr/bin/env bun
// Install the Garelier mechanical push guard (DEC-030) into a Concierge
// worktree — TS port of install_concierge_guards.ts (W-083). Scopes the pre-push
// hook to THIS worktree only (via per-worktree config) so it never interferes
// with the user's own pushes elsewhere.
//
// Usage: install_concierge_guards <concierge-checkout-dir>
//
// Idempotent: safe to re-run at every Concierge pickup.
import { existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { requireRuntimeExecutable } from "./_lib.ts";

// The .ts's SCRIPT_DIR is garelier-core/scripts; this TS is at
// garelier-core/driver/src/scripts, so hooks/ is ../../../scripts/hooks. Emit
// forward slashes so the stored core.hooksPath matches the .ts's `cd && pwd`
// value byte-for-byte (git config value freeze).
const SCRIPT_DIR = resolve(import.meta.dir, "../../../scripts").replace(/\\/g, "/");
const HOOKS_DIR = `${SCRIPT_DIR}/hooks`;

export interface ConciergeGuardInstallResult {
  checkout: string;
  hooksPath: string;
}

/** Install the per-worktree pre-push backstop. Throws on every incomplete
 * install so callers can fail closed before issuing a Concierge record. */
export function installConciergeGuards(checkout: string): ConciergeGuardInstallResult {
  const resolvedCheckout = resolve(checkout);
  if (!existsSync(`${resolvedCheckout}/.git`)) {
    throw new Error(`install_concierge_guards: not a git worktree: ${resolvedCheckout}`);
  }
  if (!existsSync(`${HOOKS_DIR}/pre-push`)) {
    throw new Error(`install_concierge_guards: pre-push hook missing at ${HOOKS_DIR}`);
  }

  try { chmodSync(`${HOOKS_DIR}/pre-push`, 0o755); } catch {}

  // Per-worktree config so only the Concierge worktree gets this hooks path.
  const gitOrThrow = (argv: string[]): void => {
    const r = spawnSync(requireRuntimeExecutable("git"), argv, {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((r.status ?? 1) !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`install_concierge_guards: git ${argv.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
  };
  gitOrThrow(["-C", resolvedCheckout, "config", "extensions.worktreeConfig", "true"]);
  gitOrThrow(["-C", resolvedCheckout, "config", "--worktree", "core.hooksPath", HOOKS_DIR]);
  return { checkout: resolvedCheckout, hooksPath: HOOKS_DIR };
}

if (import.meta.main) {
  const checkout = process.argv[2];
  if (!checkout) {
    process.stderr.write("usage: install_concierge_guards.ts <concierge-checkout-dir>\n");
    process.exit(1);
  }
  try {
    const installed = installConciergeGuards(checkout);
    console.log(`  + Concierge push guard installed (DEC-030): ${installed.checkout} core.hooksPath -> ${installed.hooksPath}`);
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  }
}
