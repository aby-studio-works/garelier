#!/usr/bin/env bun
// Status Web Console entry point (read-only).
//
// Usage:
//   bun run src/status_web.ts --pm-id <pm_id> [--project <path>] [--port N] [--host 127.0.0.1]
//   bun run status -- --pm-id <pm_id>            (via package.json script)
//
// Standalone and side-effect-free: it does NOT claim the driver pid, does
// NOT require [autonomy], and never spawns a provider. It only reads
// runtime files and serves them on loopback. Safe to run alongside the
// driver or on its own.

import { resolve, sep, join } from "node:path";
import { networkInterfaces } from "node:os";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { loadConfig, ConfigError, type SetupConfig } from "./config.ts";
import { startStatusServer } from "./status_server.ts";

interface Args {
  projectRoot: string;
  pmId?: string;
  port?: number;
  host?: string;
  lan?: boolean;
  loopback?: boolean;
}

function parseArgs(argv: string[]): Args {
  let projectRoot = process.cwd();
  let pmId: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let lan = false;
  let loopback = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") projectRoot = resolve(argv[++i]);
    else if (a === "--pm-id") pmId = argv[++i];
    else if (a === "--port") port = parseInt(argv[++i], 10);
    else if (a === "--host") host = argv[++i];
    else if (a === "--lan") lan = true;
    else if (a === "--loopback" || a === "--local") loopback = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return { projectRoot: resolve(projectRoot), pmId, port, host, lan, loopback };
}

function printHelp(): void {
  process.stdout.write(
    `Garelier Status Web Console (read-only).\n\n` +
    `Usage: bun run src/status_web.ts --pm-id <pm_id> [options]\n\n` +
    `  --pm-id <id>          PM identity to display (or GARELIER_PM_ID, or cwd inference)\n` +
    `  --project, -p <path>  Project root (default: cwd)\n` +
    `  --port <n>            Port (default: [status_web] port or 3787)\n` +
    `  --host <addr>         Bind address (overrides the default bind)\n` +
    `  --loopback            Bind 127.0.0.1 only (opt out of the default LAN bind)\n` +
    `  --lan                 Force bind 0.0.0.0 (the default; kept for clarity)\n` +
    `  --help, -h            Show this help\n\n` +
    `LAN-reachable by DEFAULT: binds 0.0.0.0 so another host on the same network\n` +
    `can view it. The dashboard + file tree (incl. source) become readable by\n` +
    `anyone on the LAN; secrets are redacted and gitignored files excluded. Pass\n` +
    `--loopback to restrict to this machine. Read-only: no state changes, no AI.\n`,
  );
}

// Non-internal IPv4 addresses, for printing a clickable LAN URL.
function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function isLoopback(host: string): boolean {
  return /^(127\.|::1$|localhost$)/.test(host);
}

function inferPmId(projectRoot: string, cwd: string): string | undefined {
  const rootAbs = resolve(projectRoot);
  const cwdAbs = resolve(cwd);
  if (!cwdAbs.startsWith(rootAbs)) return undefined;
  const rel = cwdAbs.slice(rootAbs.length).split(sep).filter((p) => p.length > 0);
  if (rel.length >= 2 && rel[0] === "__garelier") return rel[1];
  return undefined;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pmId = args.pmId
    ?? (process.env.GARELIER_PM_ID && process.env.GARELIER_PM_ID.length > 0 ? process.env.GARELIER_PM_ID : undefined)
    ?? inferPmId(args.projectRoot, process.cwd());
  if (!pmId) {
    process.stderr.write(
      `Error: pm_id is required. Provide --pm-id <id>, set GARELIER_PM_ID, ` +
      `or run from inside __garelier/<pm_id>/...\n`,
    );
    process.exit(1);
  }

  // Load config best-effort. The console must work even for a partial
  // install — it just shows fewer fields.
  let config: SetupConfig | null = null;
  try {
    config = loadConfig(args.projectRoot, pmId);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`Warning: could not load setup_config.toml (${e.message}); showing partial status.\n`);
  }

  const sw = config?.statusWeb;
  const port = args.port ?? sw?.port ?? 3787;
  // LAN-reachable by default (0.0.0.0). --loopback restricts to this machine;
  // --lan forces LAN explicitly; an explicit --host / [status_web] host wins
  // over the default. Priority: --loopback > --lan > --host > config > LAN.
  const host = args.loopback ? "127.0.0.1"
    : args.lan ? "0.0.0.0"
    : (args.host ?? sw?.host ?? "0.0.0.0");

  const server = startStatusServer({
    projectRoot: args.projectRoot,
    pmId,
    config,
    host,
    port,
    autoRefreshSeconds: sw?.autoRefreshSeconds ?? 5,
    showSourceUrls: sw?.showSourceUrls ?? true,
  });

  // Write a pidfile so a helper can stop the console without the launching
  // terminal (PM launches it but can't Ctrl+C a detached process).
  const pidDir = join(args.projectRoot, "__garelier", pmId, "runtime", "status_web");
  const pidFile = join(pidDir, "status_web.json");
  try {
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid, host, port: server.port,
      url: `http://${isLoopback(host) ? "127.0.0.1" : host}:${server.port}/`,
      startedAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf8");
  } catch { /* best-effort; the console still runs without a pidfile */ }

  const bumped = server.port !== port ? `  (port ${port} busy → ${server.port})` : "";
  if (isLoopback(host)) {
    process.stdout.write(
      `Garelier Status Web Console (read-only) for pm_id=${pmId}${bumped}\n` +
      `  → http://127.0.0.1:${server.port}/   (loopback only; Ctrl+C to stop)\n` +
      `  Tip: omit --loopback to view from another PC on the same network.\n`,
    );
  } else {
    const urls = lanAddresses().map((ip) => `http://${ip}:${server.port}/`);
    process.stdout.write(
      `Garelier Status Web Console (read-only) for pm_id=${pmId}${bumped}\n` +
      `  Bound to ${host}:${server.port} — reachable from other hosts on this LAN:\n` +
      (urls.length ? urls.map((u) => `    → ${u}\n`).join("") : `    (no external IPv4 detected)\n`) +
      `  WARNING: anyone on this LAN can READ the dashboard and project files\n` +
      `           (incl. source). Secrets are redacted and gitignored files are\n` +
      `           excluded, but treat this as a trusted-network tool. Ctrl+C to stop.\n`,
    );
  }

  const stop = () => { try { server.stop(); } catch { /* ignore */ } process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
