#!/usr/bin/env bun
// PM-side Wanderer launcher (DEC-076 §6). On an EXPLICIT user instruction ONLY,
// the PM spins up a read-only Codex Wanderer in a new terminal pane and records
// it for reuse. Needs a multiplexer with pane-addressed control (wezterm or
// tmux); windows-terminal can launch but not be driven, so it is manual-only.
//
// Singleton: if a recorded pane is still alive AND present, reuse it instead of
// launching a duplicate.
//
//   bun wanderer_launch.ts --project P --pm-id ID [--channel C --peer PEER]
//       [--percent N] [--sandbox read-only] [--wait-ms N]
// stdout (JSON): { outcome: "reused"|"launched"|"manual", mux?, paneId?, note }
// Exit: 0 reused/launched; 4 manual (no drivable multiplexer).

import { channelDir, readPresence, isPresent } from "./channel.ts";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

function flag(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function run(cmd: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode ?? 1,
    out: new TextDecoder().decode(p.stdout).trim(),
    err: new TextDecoder().decode(p.stderr).trim(),
  };
}
function out(o: object): void { process.stdout.write(JSON.stringify(o) + "\n"); }

interface PaneRec { mux: string; paneId: string; launchedAt: string }
const panePath = (dir: string) => join(dir, "pane.json");
function readPane(dir: string): PaneRec | null {
  const p = panePath(dir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as PaneRec; } catch { return null; }
}
function writePane(dir: string, rec: PaneRec): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(panePath(dir), JSON.stringify(rec, null, 2) + "\n", "utf8");
}

function detectMux(): "wezterm" | "tmux" | "none" {
  if (process.env.WEZTERM_PANE && run(["wezterm", "--version"]).code === 0) return "wezterm";
  if (process.env.TMUX && run(["tmux", "-V"]).code === 0) return "tmux";
  return "none";
}
function paneAlive(mux: string, paneId: string): boolean {
  if (mux === "wezterm") {
    const r = run(["wezterm", "cli", "list", "--format", "json"]);
    if (r.code !== 0) return false;
    try { return (JSON.parse(r.out) as Array<{ pane_id: number }>).some((p) => String(p.pane_id) === paneId); }
    catch { return false; }
  }
  if (mux === "tmux") {
    const r = run(["tmux", "list-panes", "-a", "-F", "#{pane_id}"]);
    return r.code === 0 && r.out.split("\n").includes(paneId);
  }
  return false;
}

async function main(): Promise<void> {
  const project = flag("project");
  const pmId = flag("pm-id");
  if (!project || !pmId) { process.stderr.write("wanderer_launch: --project, --pm-id required\n"); process.exit(2); }
  const channel = flag("channel") ?? "wanderer";
  const peer = flag("peer") ?? "wanderer-01";
  const percent = flag("percent") ?? "45";
  const sandbox = flag("sandbox") ?? "read-only";
  const waitMs = flag("wait-ms") ? Number(flag("wait-ms")) : 45_000;
  const dir = channelDir(project, pmId, channel);
  const staleness = 120_000;

  // Singleton: reuse a live + present Wanderer.
  const existing = readPane(dir);
  if (existing && paneAlive(existing.mux, existing.paneId)
      && isPresent(readPresence(dir, peer), staleness, Date.now())) {
    out({ outcome: "reused", mux: existing.mux, paneId: existing.paneId, note: "live Wanderer present — reusing." });
    return;
  }

  const mux = detectMux();
  if (mux === "none") {
    out({ outcome: "manual", note: "No drivable multiplexer (wezterm/tmux). Launch `codex --sandbox read-only` in the project root yourself; the .codex hooks do the rest." });
    process.exit(4);
  }

  // Split a new pane and start a shell in the project, then type the codex launch.
  let paneId = "";
  if (mux === "wezterm") {
    const from = process.env.WEZTERM_PANE ?? "";
    const split = run([
      "wezterm", "cli", "split-pane", ...(from ? ["--pane-id", from] : []),
      "--right", "--percent", percent, "--cwd", project,
    ]);
    if (split.code !== 0) { out({ outcome: "manual", note: `wezterm split-pane failed: ${split.err}` }); process.exit(4); }
    paneId = split.out.trim();
    await Bun.sleep(900); // let the shell come up
    run(["wezterm", "cli", "send-text", "--pane-id", paneId, "--no-paste", `codex --sandbox ${sandbox}\r`]);
  } else { // tmux
    const split = run(["tmux", "split-window", "-h", "-c", project, "-P", "-F", "#{pane_id}"]);
    if (split.code !== 0) { out({ outcome: "manual", note: `tmux split-window failed: ${split.err}` }); process.exit(4); }
    paneId = split.out.trim();
    await Bun.sleep(900);
    run(["tmux", "send-keys", "-t", paneId, `codex --sandbox ${sandbox}`, "Enter"]);
  }
  writePane(dir, { mux, paneId, launchedAt: new Date().toISOString() });

  // SessionStart does not reliably write the presence heartbeat (DEC-076 §7), and
  // its role briefing may not surface — so send a warm-up turn: it triggers the
  // first Stop hook (which DOES write presence) and (re)states the role.
  await Bun.sleep(6000); // let Codex finish booting before typing
  const warm =
    "You are the read-only Wanderer: an external, advisory, independent design reviewer for " +
    "this project's PM. You make no code edits and no commits. Review requests arrive via your " +
    "peer inbox (surfaced by your hook); when one arrives, read its ref and STATE your verdict + " +
    "advice. Acknowledge in one short line.";
  if (mux === "wezterm") {
    run(["wezterm", "cli", "send-text", "--pane-id", paneId, warm]);
    run(["wezterm", "cli", "send-text", "--pane-id", paneId, "\r"]);
  } else {
    run(["tmux", "send-keys", "-t", paneId, warm, "Enter"]);
  }

  // Wait for the Wanderer's first heartbeat (from the warm-up turn's Stop hook).
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (isPresent(readPresence(dir, peer), staleness, Date.now())) {
      out({ outcome: "launched", mux, paneId, note: `Wanderer up (read-only). pane recorded; presence live.` });
      return;
    }
    await Bun.sleep(2000);
  }
  out({ outcome: "launched", mux, paneId, note: `pane ${paneId} started codex but no presence heartbeat within ${waitMs}ms — it may still be booting / trust the hooks (/hooks), or it hit a prompt.` });
}

main().catch((e) => { process.stderr.write(`wanderer_launch: ${e?.message ?? e}\n`); process.exit(1); });
