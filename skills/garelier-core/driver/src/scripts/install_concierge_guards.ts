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

const args = process.argv.slice(2);
const CHECKOUT = args[0];
if (!CHECKOUT) {
  process.stderr.write("usage: install_concierge_guards.ts <concierge-checkout-dir>\n");
  process.exit(1);
}

// The .ts's SCRIPT_DIR is garelier-core/scripts; this TS is at
// garelier-core/driver/src/scripts, so hooks/ is ../../../scripts/hooks. Emit
// forward slashes so the stored core.hooksPath matches the .ts's `cd && pwd`
// value byte-for-byte (git config value freeze).
const SCRIPT_DIR = resolve(import.meta.dir, "../../../scripts").replace(/\\/g, "/");
const HOOKS_DIR = `${SCRIPT_DIR}/hooks`;

if (!existsSync(`${CHECKOUT}/.git`)) {
  process.stderr.write(`install_concierge_guards: not a git worktree: ${CHECKOUT}\n`);
  process.exit(1);
}
if (!existsSync(`${HOOKS_DIR}/pre-push`)) {
  process.stderr.write(`install_concierge_guards: pre-push hook missing at ${HOOKS_DIR}\n`);
  process.exit(1);
}

try { chmodSync(`${HOOKS_DIR}/pre-push`, 0o755); } catch {}

// Per-worktree config so only the Concierge worktree gets this hooks path.
function gitOrExit(argv: string[]): void {
  const r = spawnSync(requireRuntimeExecutable("git"), argv, { windowsHide: true, stdio: "inherit" });
  if ((r.status ?? 1) !== 0) process.exit(r.status || 1);
}
gitOrExit(["-C", CHECKOUT, "config", "extensions.worktreeConfig", "true"]);
gitOrExit(["-C", CHECKOUT, "config", "--worktree", "core.hooksPath", HOOKS_DIR]);

console.log(`  + Concierge push guard installed (DEC-030): ${CHECKOUT} core.hooksPath -> ${HOOKS_DIR}`);
