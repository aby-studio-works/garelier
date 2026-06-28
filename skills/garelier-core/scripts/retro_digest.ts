#!/usr/bin/env bun
// Garelier retro digest — DEC-067: lessons-learned harvesting.
//
// Zero-LLM aggregation of what went WRONG over a period, as raw material for
// knowledge_update_request drafts: rework/refuted/blocked dispatch events,
// failed merge-gate results, and the "Context pack gaps" sections from
// archived dispatch reports (DEC-071). The model's job afterwards is judgment
// only (which causes repeat and deserve a rule); this script does the
// remembering.
//
// Run it at milestone close (garelier-pm/references/planning.md §5) or any
// time the operator asks "what kept going wrong?".
//
// Single cross-platform implementation (DEC-072 TS-first; replaces the former
// shell-script pair).
//
// Usage: retro_digest.ts --project <root> --pm-id <id> [--since YYYY-MM-DD]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

let project = "", pm = "", since = "";
const argv = process.argv;
for (let i = 2; i < argv.length; i++) {
  // Accept both GNU long options and legacy one-dash spellings so existing
  // wrapper invocations keep working.
  const a = argv[i].toLowerCase();
  if (a === "--project" || a === "-project") project = argv[++i] ?? "";
  else if (a === "--pm-id" || a === "-pmid") pm = argv[++i] ?? "";
  else if (a === "--since" || a === "-since") since = argv[++i] ?? "";
  else if (a === "-h" || a === "--help") {
    console.log("usage: retro_digest.ts --project <root> --pm-id <id> [--since YYYY-MM-DD]");
    process.exit(0);
  } else { console.error(`retro_digest: unknown arg ${a}`); process.exit(2); }
}
if (!project || !pm) {
  console.error("usage: retro_digest.ts --project <root> --pm-id <id> [--since YYYY-MM-DD]");
  process.exit(2);
}

const base = join(project, "__garelier", pm);
const ev = join(base, "runtime", "dispatch", "events.jsonl");
const mg = join(base, "runtime", "merge_gate", "results");
const done = join(base, "runtime", "backlog", "done");

const inWindow = (dateStr: string): boolean =>
  !since || !dateStr || dateStr.slice(0, 10) >= since;
const read = (p: string): string => {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
};
const list = (dir: string, suffix: string): string[] => {
  try { return readdirSync(dir).filter((n) => n.endsWith(suffix)).sort(); } catch { return []; }
};

console.log(`=== Garelier retro digest — PM ${pm}${since ? ` since ${since}` : ""} ===`);
console.log("(material for knowledge_update_request drafts; judgment is the reader's job)");
console.log("");

const counts: Record<string, number> = { rework: 0, blocked: 0, note: 0 };
if (existsSync(ev)) {
  console.log("--- dispatch events (rework / blocked / note) ---");
  for (const line of read(ev).split(/\r?\n/)) {
    const ts = line.match(/"ts":"([^"]*)"/)?.[1] ?? "";
    const kind = line.match(/"kind":"([^"]*)"/)?.[1] ?? "";
    const task = (line.match(/"task":"([^"]*)"/)?.[1] ?? "").slice(0, 110);
    if (!(kind in counts)) continue;
    if (!inWindow(ts)) continue;
    counts[kind]++;
    console.log(`  [${kind}] ${ts || "?"} ${task}`);
  }
  console.log(`  totals: rework=${counts.rework} blocked=${counts.blocked} note=${counts.note}`);
} else {
  console.log(`--- no events file (${ev}) ---`);
}

console.log("");
let fails = 0;
if (existsSync(mg)) {
  console.log("--- merge-gate results that were NOT success ---");
  for (const name of list(mg, ".json")) {
    if (name.includes("summary")) continue;
    const st = read(join(mg, name)).match(/"status"\s*:\s*"([a-z]+)"/)?.[1] ?? "";
    if (st === "success") continue;
    const d = name.slice(0, 8);
    if (!inWindow(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)) continue;
    fails++;
    console.log(`  [${st}] ${name}`);
  }
  console.log(`  totals: non-success gate results=${fails}`);
}

console.log("");
let gaps = 0;
if (existsSync(done)) {
  console.log("--- Context pack gaps (DEC-071: facts producers had to rediscover) ---");
  for (const name of list(done, ".md")) {
    // Section body between "## Context pack gaps" and the next "## ", minus
    // blank lines, scaffold hint lines, and explicit "none" entries.
    const lines = read(join(done, name)).split(/\r?\n/);
    const body: string[] = [];
    let inSec = false;
    for (const line of lines) {
      if (/^## Context pack gaps/.test(line)) { inSec = true; continue; }
      if (inSec && /^## /.test(line)) break;
      if (!inSec) continue;
      if (!line.trim()) continue;
      if (line.startsWith("(facts you had to rediscover")) continue;
      if (/^[-*\s]*(none|n\/a)[.\s]*$/i.test(line)) continue;
      body.push(line);
    }
    if (body.length === 0) continue;
    gaps++;
    console.log(`  [${basename(name)}]`);
    for (const line of body.slice(0, 8)) console.log(`    ${line}`);
  }
  console.log(`  totals: reports with gaps=${gaps}`);
}

console.log("");
console.log("Next step (judgment, not bookkeeping): for any cause OR context-pack gap");
console.log("that appears more than once above, draft a knowledge_update_request");
console.log("(garelier-librarian/templates/knowledge_update_request.md) naming the");
console.log("rule or trigger that would have prevented it — recurring gaps mean the");
console.log("PM's blueprints under-specify that area; PM approves, Librarian");
console.log("applies (DEC-029/067).");
