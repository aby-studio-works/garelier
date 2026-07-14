#!/usr/bin/env bun
// Garelier peer-channel CLI (DEC-076). Thin subcommand wrapper over channel.ts
// so shells, a Codex Stop hook (check-inbox), the Wanderer (send/presence), and
// the PM-side review gate (await + presence-check) can all drive the channel.
//
//   bun cli.ts send     --project P --pm-id ID --channel C --from PEER --to PEER --kind K --body TEXT [--ref PATH]
//   bun cli.ts inbox    --project P --pm-id ID --channel C --as PEER [--mark-read] [--json]
//   bun cli.ts presence --project P --pm-id ID --channel C --peer PEER [--tool T --model M --pid N] [--beat]
//   bun cli.ts present  --project P --pm-id ID --channel C --peer PEER [--staleness-ms N]   (exit 0 present, 3 absent)
//   bun cli.ts await    --project P --pm-id ID --channel C --as PEER --since ID [--kind K] [--timeout-ms N] [--poll-ms N] [--json]
//
// Exit codes: 0 ok; 2 usage error; 3 await timeout / peer absent.

import {
  channelDir, appendMessage, inboxFor, readLog, setReadId,
  writePresence, readPresence, isPresent, awaitMessage,
} from "./channel.ts";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { f[key] = true; }
    else { f[key] = next; i++; }
  }
  return f;
}

function need(f: Record<string, string | boolean>, keys: string[]): string[] {
  const missing = keys.filter((k) => typeof f[k] !== "string" || (f[k] as string).length === 0);
  if (missing.length) {
    process.stderr.write(`peer: missing required --${missing.join(" --")}\n`);
    process.exit(2);
  }
  return keys.map((k) => f[k] as string);
}

const STALENESS_DEFAULT_MS = 120_000;   // a heartbeat older than 2 min = absent
const TIMEOUT_DEFAULT_MS = 180_000;     // PM await before Observer fallback
const POLL_DEFAULT_MS = 3_000;

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const f = parseFlags(rest);

  switch (sub) {
    case "send": {
      const [project, pmId, channel, from, to, kind, body] =
        need(f, ["project", "pm-id", "channel", "from", "to", "kind", "body"]);
      const msg = appendMessage(project, pmId, channel, {
        from, to, kind, body, ...(typeof f.ref === "string" ? { ref: f.ref } : {}),
      });
      process.stdout.write(JSON.stringify(msg) + "\n");
      return;
    }
    case "inbox": {
      const [project, pmId, channel, as] = need(f, ["project", "pm-id", "channel", "as"]);
      const dir = channelDir(project, pmId, channel);
      const msgs = inboxFor(dir, as);
      if (f["mark-read"]) {
        const maxId = readLog(dir).reduce((m, x) => Math.max(m, x.id || 0), 0);
        if (maxId > 0) setReadId(dir, as, maxId);
      }
      if (f.json) { process.stdout.write(JSON.stringify(msgs) + "\n"); return; }
      if (msgs.length === 0) { process.stdout.write("(no unread messages)\n"); return; }
      for (const m of msgs) {
        process.stdout.write(`#${m.id} [${m.kind}] from ${m.from}: ${m.body}${m.ref ? `  (ref: ${m.ref})` : ""}\n`);
      }
      return;
    }
    case "presence": {
      const [project, pmId, channel, peer] = need(f, ["project", "pm-id", "channel", "peer"]);
      const pres = writePresence(project, pmId, channel, {
        peer,
        ...(typeof f.tool === "string" ? { tool: f.tool } : {}),
        ...(typeof f.model === "string" ? { model: f.model } : {}),
        ...(typeof f.pid === "string" ? { pid: Number(f.pid) } : {}),
      });
      process.stdout.write(JSON.stringify(pres) + "\n");
      return;
    }
    case "present": {
      const [project, pmId, channel, peer] = need(f, ["project", "pm-id", "channel", "peer"]);
      const dir = channelDir(project, pmId, channel);
      const staleness = typeof f["staleness-ms"] === "string" ? Number(f["staleness-ms"]) : STALENESS_DEFAULT_MS;
      const pres = readPresence(dir, peer);
      const ok = isPresent(pres, staleness, Date.now());
      process.stdout.write(`${ok ? "present" : "absent"}${pres ? ` (beat ${pres.beatAt})` : ""}\n`);
      process.exit(ok ? 0 : 3);
      return;
    }
    case "await": {
      const [project, pmId, channel, as, since] = need(f, ["project", "pm-id", "channel", "as", "since"]);
      const kind = typeof f.kind === "string" ? f.kind : null;
      const hit = await awaitMessage(
        project, pmId, channel, as, Number(since),
        (m) => kind === null || m.kind === kind,
        {
          timeoutMs: typeof f["timeout-ms"] === "string" ? Number(f["timeout-ms"]) : TIMEOUT_DEFAULT_MS,
          pollMs: typeof f["poll-ms"] === "string" ? Number(f["poll-ms"]) : POLL_DEFAULT_MS,
        },
      );
      if (!hit) {
        process.stderr.write("await: timeout — no matching reply (fall back to Observer)\n");
        process.exit(3);
      }
      process.stdout.write((f.json ? JSON.stringify(hit) : `#${hit.id} [${hit.kind}] from ${hit.from}: ${hit.body}`) + "\n");
      return;
    }
    default:
      process.stderr.write(
        "usage: bun cli.ts <send|inbox|presence|present|await> --project P --pm-id ID --channel C ...\n",
      );
      process.exit(2);
  }
}

main().catch((e) => { process.stderr.write(`peer: ${e?.message ?? e}\n`); process.exit(1); });
