#!/usr/bin/env bun
// TS-first port of scripts/dispatch_event.sh (W-011, DEC-064 §3). Behaviour
// frozen: flags / stdout / stderr / exit codes / events.jsonl line format /
// in_flight.md view bytes / size-cap rotation match the shell 1:1.
//
//   1. Appends ONE event line to runtime/dispatch/events.jsonl.
//   2. Regenerates the derived view runtime/backlog/in_flight.md from the live
//      _dispatch<N>/STATE.md containers (the structural truth).
//
// Usage:
//   dispatch_event.sh --project <root> --pm-id <id> \
//     --kind <start|complete|blocked|rework|cleanup|note> \
//     --role "<role(#id)>" --task "<text>" [--ref <path>]
//   dispatch_event.sh --project <root> --pm-id <id> --regen-only

import {
  appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const err = (s: string) => process.stderr.write(s + "\n");

function jsonEscape(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\n\r]/g, "");
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fileSize(p: string): number {
  try { return statSync(p).size; } catch { return -1; }
}

// awk: after the header line, first line with a non-empty field; return it raw.
function firstNonEmptyAfter(lines: string[], headerRe: RegExp): string {
  let seen = false;
  for (const line of lines) {
    if (!seen) { if (headerRe.test(line)) seen = true; continue; }
    if (line.trim().length > 0) return line;
  }
  return "";
}

function main(): void {
  const argv = process.argv.slice(2);
  let project = "", pm = "", kind = "", role = "", task = "", ref = "";
  let regenOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--project": project = req(argv, ++i); break;
      case "--pm-id": pm = req(argv, ++i); break;
      case "--kind": kind = req(argv, ++i); break;
      case "--role": role = req(argv, ++i); break;
      case "--task": task = req(argv, ++i); break;
      case "--ref": ref = req(argv, ++i); break;
      case "--regen-only": regenOnly = true; break;
      default: err(`dispatch_event: unknown arg ${a}`); process.exit(1);
    }
  }

  if (!project || !pm) {
    err("usage: dispatch_event.sh --project <root> --pm-id <id> --kind <k> --role <r> --task <t> [--ref <p>] | --regen-only");
    process.exit(1);
  }

  const base = `${project}/__garelier/${pm}`;
  if (!isDir(base)) { err(`dispatch_event: no PM at ${base}`); process.exit(1); }

  if (!regenOnly) {
    if (!kind || !role || !task) {
      err("dispatch_event: --kind/--role/--task required (or pass --regen-only)");
      process.exit(1);
    }
    const evDir = `${base}/runtime/dispatch`;
    mkdirSync(evDir, { recursive: true });
    const evFile = `${evDir}/events.jsonl`;

    // Size-cap rotation (DEC-088 Group E). Cap = env, else setup_config, else 5 MiB.
    let evMaxBytes = process.env.GARELIER_DISPATCH_EVENTS_MAX_BYTES ?? "";
    if (!evMaxBytes && isFile(`${base}/_pm/setup_config.toml`)) {
      const m = readFileSync(`${base}/_pm/setup_config.toml`, "utf8")
        .match(/^[ \t]*dispatch_events_max_bytes[ \t]*=[ \t]*([0-9]*)/m);
      if (m) evMaxBytes = m[1];
    }
    if (!evMaxBytes) evMaxBytes = "5242880";
    const cap = Number(evMaxBytes);
    if (isFile(evFile)) {
      const sz = fileSize(evFile);
      if (sz >= 0 && Number.isFinite(cap) && sz >= cap) {
        try { renameSync(evFile, `${evFile}.1`); } catch { /* best-effort */ }
      }
    }

    const refJson = ref ? `"${jsonEscape(ref)}"` : "null";
    const line = `{"ts":"${utcNow()}","role":"${jsonEscape(role)}","kind":"${jsonEscape(kind)}",` +
      `"task":"${jsonEscape(task)}","ref":${refJson}}\n`;
    appendFileSync(evFile, line);
  }

  regenView(base);
}

function regenView(base: string): void {
  const view = `${base}/runtime/backlog/in_flight.md`;
  mkdirSync(dirname(view), { recursive: true });

  const lines: string[] = [];
  lines.push("# In flight — GENERATED VIEW (DEC-064 W-011)");
  lines.push("");
  lines.push("Derived from the live `_dispatch<N>/STATE.md` containers by");
  lines.push("`scripts/dispatch_event.sh`. Do not edit — rewritten on every");
  lines.push("dispatch event. The append-only record is `runtime/dispatch/events.jsonl`.");
  lines.push("");
  lines.push("| Task | Agent | Branch |");
  lines.push("| ---- | ----- | ------ |");

  // Live _dispatch<N> producers (sorted, glob order).
  for (const name of listDirs(base).filter((n) => n.startsWith("_dispatch")).sort()) {
    const stateFile = `${base}/${name}/STATE.md`;
    if (!isFile(stateFile)) continue;
    const n = name.replace(/^_dispatch/, "");
    const content = readFileSync(stateFile, "utf8").split(/\n/);
    let role = "";
    for (const l of content) {
      const m = /^#\s*Dispatch\s*#[0-9]*\s*-\s*([A-Za-z]*)/.exec(l);
      if (m) { role = m[1]; break; }
    }
    const task = firstNonEmptyAfter(content, /^##\s*Current task/);
    const branch = /\(([^()]*)\)\s*$/.exec(task)?.[1] ?? "";
    const taskname = task.replace(/\s*\([^()]*\)\s*$/, "");
    lines.push(`| ${taskname || `#${n}`} | dispatch${n} (${role || "?"}) | ${branch || ""} |`);
  }

  // Legacy/parked persistent role containers (same order as the shell globs).
  const roleDirs = ["_workers", "_scouts", "_smiths", "_librarians", "_observers", "_guardians", "_concierges"];
  const containers: string[] = [];
  for (const rd of roleDirs) {
    for (const id of listDirs(`${base}/${rd}`).sort()) containers.push(`${base}/${rd}/${id}`);
  }
  if (isDir(`${base}/_artisan`)) containers.push(`${base}/_artisan`);

  for (const d of containers) {
    const stateFile = `${d}/STATE.md`;
    if (!isFile(stateFile)) continue;
    const content = readFileSync(stateFile, "utf8").split(/\n/);
    let st = firstNonEmptyAfter(content, /^##\s*Status/).replace(/\s/g, "");
    if (st === "IDLE" || st === "idle" || st === "") continue;
    let rel = d.slice(base.length + 1); // strip "base/"
    rel = rel.replace(/\/$/, "");
    let roledir = rel.split("/")[0].replace(/^_/, "").replace(/s$/, "");
    let id = rel.split("/").pop() ?? "";
    if (rel === "_artisan") { id = "artisan"; roledir = "artisan"; }
    const task = firstNonEmptyAfter(content, /^##\s*Current task/).slice(0, 100);
    lines.push(`| ${task || `(${st})`} | ${id} (${roledir}) | |`);
  }

  writeFileSync(view, lines.map((l) => l + "\n").join(""), "utf8");
}

function req(argv: string[], i: number): string {
  // Mirrors bash ${2:?}: a missing value is a hard error.
  if (i >= argv.length) { err("dispatch_event: missing value for flag"); process.exit(1); }
  return argv[i];
}
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

main();
