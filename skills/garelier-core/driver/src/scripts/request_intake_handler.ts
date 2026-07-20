#!/usr/bin/env bun
// TS-first port of driver/src/scripts/request_intake_handler.ts (W-083). Behaviour frozen:
// flags / stdout / stderr / exit codes / generated file paths + formats match
// the shell 1:1. Validates a delegated request export and writes only Garelier
// runtime/control files; it never executes request-provided commands.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "./_lib.ts";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

const USAGE = `Usage:
  request_intake_handler.ts --request-dir PATH --request-branch BRANCH --target-pm ID [options]

Options:
  --project-root PATH   Target project root. Defaults to current directory.
  --commit-sha SHA      Request branch commit SHA. Defaults to git rev-parse HEAD in request-dir.
  --now ISO8601         Override received timestamp for tests.
  -h, --help            Show this help.

v2.1: pm-id aware. The target PM is named in the request branch
(\`garelier/request/<target_pm>/<source_pm>/<id>-<uid>\`) and passed via
--target-pm. All writes go under __garelier/<target_pm>/{control,runtime}/.

This reference handler validates a delegated request export and writes
only Garelier runtime/control files. It never executes request-provided
commands.`;

function usage(sink: (s: string) => void): void {
  for (const line of USAGE.split("\n")) sink(line);
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function readdirEntries(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

// awk toml_value — see scheduler_adapter.ts for the byte-for-byte contract.
function tomlValue(section: string, key: string, text: string): string {
  let inside = section === "";
  const keyRe = new RegExp("^[\\t ]*" + key + "[\\t ]*=");
  for (const raw of text.split(/\r?\n/)) {
    if (/^[\t ]*#/.test(raw)) continue;
    if (/^[\t ]*$/.test(raw)) continue;
    const head = raw.match(/^[\t ]*\[/);
    if (head) {
      let line = raw.replace(/^[\t ]*\[/, "").replace(/\][\t ]*$/, "");
      inside = line === section;
      continue;
    }
    if (inside && keyRe.test(raw)) {
      let value = raw.replace(/^[^=]*=[\t ]*/, "");
      value = value.replace(/[\t ]+#.*$/, "");
      value = value.replace(/^[\t ]+/, "");
      value = value.replace(/[\t ]+$/, "");
      value = value.replace(/^"/, "").replace(/"$/, "");
      return value;
    }
  }
  return "";
}

function tomlSectionExists(sectionRegex: string, text: string): boolean {
  return new RegExp("^[\\t ]*\\[" + sectionRegex + "\\][\\t ]*$", "m").test(text);
}

// Strip [ ] wrapper, quotes and spaces, split on commas.
function normalizeList(list: string): string {
  let l = list;
  if (l.startsWith("[")) l = l.slice(1);
  if (l.endsWith("]")) l = l.slice(0, -1);
  l = l.replace(/"/g, "").replace(/ /g, "");
  return l;
}
function listContains(list: string, needle: string): boolean {
  const l = normalizeList(list);
  return l.split(",").some((item) => item === needle);
}
function listEmpty(list: string): boolean {
  return normalizeList(list) === "";
}

function sourceIdExists(text: string, sourceId: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    if (!/^[\t ]*id[\t ]*=/.test(raw)) continue;
    let value = raw.replace(/^[^=]*=[\t ]*/, "");
    value = value.replace(/[\t ]+#.*$/, "");
    value = value.replace(/^[\t ]+/, "");
    value = value.replace(/[\t ]+$/, "");
    value = value.replace(/^"/, "").replace(/"$/, "");
    if (value === sourceId) return true;
  }
  return false;
}

function boolTrue(v: string): boolean {
  return v.toLowerCase() === "true";
}

function priorityRank(v: string): number {
  switch (v) {
    case "low": return 1;
    case "normal": return 2;
    case "high": return 3;
    case "urgent": return 4;
    default: return 0;
  }
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// `C:\a\b` -> `/c/a/b`, matching MSYS `pwd -P` so display/generated paths are
// byte-identical to the shell. A no-op for POSIX-form paths (Linux).
function toPosix(p: string): string {
  const s = p.replace(/\\/g, "/");
  const m = s.match(/^([A-Za-z]):\/(.*)$/);
  if (m) return `/${m[1].toLowerCase()}/${m[2]}`;
  const root = s.match(/^([A-Za-z]):\/?$/);
  if (root) return `/${root[1].toLowerCase()}`;
  return s;
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function main(): number {
  const argv = process.argv.slice(2);
  let projectRoot = ".";
  let requestDir = "";
  let requestBranch = "";
  let targetPm = "";
  let commitSha = "";
  let now = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-root") { projectRoot = need(argv, ++i, "--project-root value"); }
    else if (a === "--request-dir") { requestDir = need(argv, ++i, "--request-dir value"); }
    else if (a === "--request-branch") { requestBranch = need(argv, ++i, "--request-branch value"); }
    else if (a === "--target-pm") { targetPm = need(argv, ++i, "--target-pm value"); }
    else if (a === "--commit-sha") { commitSha = need(argv, ++i, "--commit-sha value"); }
    else if (a === "--now") { now = need(argv, ++i, "--now value"); }
    else if (a === "-h" || a === "--help") { usage(out); return 0; }
    else { err(`Unknown argument: ${a}`); usage(err); return 1; }
  }

  if (!requestDir || !requestBranch || !targetPm) { usage(err); return 1; }

  if (!isDir(projectRoot)) { err(`Project root not found: ${projectRoot}`); return 1; }

  // Shell canonicalizes via `pwd -P` (POSIX absolute) and uses that for both the
  // -d/-f checks (through bash) and every message / generated field. Under native
  // bun, FS needs the real path, so keep a POSIX display form and drive FS off
  // relative / Windows paths — identical output everywhere, correct FS on Windows.
  process.chdir(projectRoot);
  const projectRootPosix = toPosix(realpathSync(process.cwd()));
  const garelierRoot = `${projectRootPosix}/__garelier`;

  if (!isDir("__garelier")) { err(`Error: not a Garelier project root: ${projectRootPosix}`); return 1; }

  const targetPmConfig = `${garelierRoot}/${targetPm}/_pm/setup_config.toml`;
  if (!isFile(`__garelier/${targetPm}/_pm/setup_config.toml`)) {
    err(`Error: target PM '${targetPm}' is not initialized at ${targetPmConfig}`);
    const cands: string[] = [];
    for (const ent of readdirEntries("__garelier")) {
      if (!isDir(`__garelier/${ent}`)) continue;
      if (isFile(`__garelier/${ent}/_pm/setup_config.toml`)) cands.push(ent);
    }
    if (cands.length > 0) {
      err("       Available PMs:");
      for (const p of cands) err(`         - ${p}`);
    } else {
      err("       No PMs initialized; run setup_wizard.");
    }
    return 1;
  }

  if (!isDir(requestDir)) { err(`Request directory not found: ${requestDir}`); return 1; }
  const requestDirWin = realpathSync(requestDir);
  const requestDirPosix = toPosix(requestDirWin);

  const requestTomlWin = `${requestDirWin}/.garelier/request.toml`;
  const requestMdWin = `${requestDirWin}/.garelier/request.md`;
  const requestToml = `${requestDirPosix}/.garelier/request.toml`; // display / generated form
  const requestMd = `${requestDirPosix}/.garelier/request.md`;

  const pmControl = `__garelier/${targetPm}/control`;
  const pmRuntime = `__garelier/${targetPm}/runtime`;
  const allowSources = `${pmControl}/request_intake/allowed_sources.toml`;
  const allowKinds = `${pmControl}/request_intake/allowed_request_kinds.toml`;
  const capabilities = `${pmControl}/delegation/capability_registry.toml`;

  if (!isFile(requestTomlWin)) { err(`Missing request manifest: ${requestToml}`); return 1; }

  if (!now) now = utcNow();
  const stamp = utcStamp();

  if (!commitSha) {
    const r = spawnSync(requireRuntimeExecutable("git"), ["-C", requestDirWin, "rev-parse", "HEAD"], { windowsHide: true, encoding: "utf8" });
    commitSha = r.status === 0 ? (r.stdout ?? "").trim() : "unknown";
    if (!commitSha) commitSha = "unknown";
  }

  const reqText = readFileSync(requestTomlWin, "utf8");
  const tvReq = (section: string, key: string) => tomlValue(section, key, reqText);

  const writeRejection = (rid: string, reason: string): void => {
    const safeId = rid || `unknown-${stamp}`;
    mkdirSync(`${pmRuntime}/requests/rejected`, { recursive: true });
    mkdirSync(`${pmControl}/reports/requests`, { recursive: true });
    let toml = "";
    toml += `# Rejected delegated request\n`;
    toml += `request_id = "${tomlEscape(safeId)}"\n`;
    toml += `target_pm = "${tomlEscape(targetPm)}"\n`;
    toml += `request_branch = "${tomlEscape(requestBranch)}"\n`;
    toml += `commit_sha = "${tomlEscape(commitSha)}"\n`;
    toml += `rejected_at = "${tomlEscape(now)}"\n`;
    toml += `reason = "${tomlEscape(reason)}"\n`;
    writeFileSync(`${pmRuntime}/requests/rejected/${safeId}.toml`, toml);

    let md = "";
    md += `# Request rejected: ${safeId}\n\n`;
    md += `- Target PM: \`${targetPm}\`\n`;
    md += `- Request branch: \`${requestBranch}\`\n`;
    md += `- Commit SHA: \`${commitSha}\`\n`;
    md += `- Rejected at: \`${now}\`\n`;
    md += `- Reason: ${reason}\n`;
    if (isFile(requestTomlWin)) md += `- Manifest: \`${requestToml}\`\n`;
    writeFileSync(`${pmControl}/reports/requests/${safeId}-rejected.md`, md);

    err(`REJECTED ${safeId}: ${reason}`);
  };

  const reasons: string[] = [];
  const reject = (r: string) => reasons.push(r);

  const requestId = tvReq("", "request_id");
  const shortUid = tvReq("", "short_uid");
  const sourcePm = tvReq("", "source_pm");
  const manifestTargetPm = tvReq("", "target_pm");
  const kind = tvReq("", "kind");
  const priority = tvReq("", "priority");
  const manifestBranch = tvReq("git", "request_branch");
  const allowCommits = tvReq("safety", "allow_commits");
  const allowPromote = tvReq("safety", "allow_promote");
  const allowProductionWrite = tvReq("safety", "allow_production_write");

  const branchRe = /^garelier\/request\/([^/]+)\/([^/]+)\/(R-[0-9]{8}-[0-9]{4}-[a-z0-9-]+)-([a-f0-9]{6,8})$/;
  const bm = requestBranch.match(branchRe);
  let branchTarget = "", branchSource = "", branchRequestId = "", branchUid = "";
  if (bm) {
    branchTarget = bm[1]; branchSource = bm[2]; branchRequestId = bm[3]; branchUid = bm[4];
  } else {
    reject("request branch does not match garelier/request/<target>/<source>/<request_id>-<uid>");
  }

  for (const field of ["request_id", "short_uid", "source_pm", "target_pm", "kind", "priority", "created_at"]) {
    if (!tvReq("", field)) reject(`missing required field: ${field}`);
  }
  for (const field of ["request_branch"]) {
    if (!tvReq("git", field)) reject(`missing required field: git.${field}`);
  }
  for (const field of ["allow_commits", "allow_promote", "allow_production_write"]) {
    if (!tvReq("safety", field)) reject(`missing required field: safety.${field}`);
  }

  if (/^[\t ]*(command|commands|script|shell|exec|run|entrypoint|arguments|args|env)[\t ]*=/m.test(reqText)) {
    reject("request manifest contains a forbidden executable field");
  }

  if (branchRequestId && requestId !== branchRequestId) reject("request_id does not match request branch");
  if (branchUid && shortUid !== branchUid) reject("short_uid does not match request branch");
  if (branchSource && sourcePm !== branchSource) reject("source_pm does not match request branch");
  if (branchTarget && branchTarget !== targetPm) reject(`branch target_pm '${branchTarget}' does not match --target-pm '${targetPm}'`);
  if (manifestBranch !== requestBranch) reject("git.request_branch does not match request branch");
  if (manifestTargetPm !== targetPm) reject("target_pm is not this local PM");

  if (!isFile(allowSources)) {
    reject(`allowed_sources.toml is missing for target PM '${targetPm}'`);
  } else if (sourcePm && !sourceIdExists(readFileSync(allowSources, "utf8"), sourcePm)) {
    reject("source_pm is not allowlisted");
  }

  if (!isFile(allowKinds)) {
    reject(`allowed_request_kinds.toml is missing for target PM '${targetPm}'`);
  } else if (kind) {
    const kindsText = readFileSync(allowKinds, "utf8");
    if (!tomlSectionExists(`kind\\.${kind}`, kindsText)) {
      reject("kind is not listed in allowed_request_kinds.toml");
    }
    if (tomlValue(`kind.${kind}`, "allowed", kindsText) === "false") {
      reject("kind is explicitly disabled");
    }
  }

  if (!isFile(capabilities)) {
    reject(`capability_registry.toml is missing for target PM '${targetPm}'`);
  } else if (kind) {
    const capText = readFileSync(capabilities, "utf8");
    if (!tomlSectionExists(`capability\\.${kind}`, capText)) {
      reject("kind is not present in capability_registry.toml");
    } else {
      const capEnabled = tomlValue(`capability.${kind}`, "enabled", capText);
      const capAllowCommits = tomlValue(`capability.${kind}`, "allow_commits", capText);
      const capAllowProd = tomlValue(`capability.${kind}`, "allow_production_write", capText);
      const capSources = tomlValue(`capability.${kind}`, "allowed_sources", capText);
      const capMaxPriority = tomlValue(`capability.${kind}`, "max_priority", capText);

      if (capEnabled !== "true") reject("capability is not enabled");
      if (boolTrue(allowCommits) && capAllowCommits !== "true") reject("request allows commits but capability does not");
      if (boolTrue(allowProductionWrite) && capAllowProd !== "true") reject("request allows production write but capability does not");
      if (!capSources || listEmpty(capSources)) {
        reject("capability has no enrolled source PMs");
      } else if (!listContains(capSources, sourcePm)) {
        reject("source_pm is not enrolled for this capability");
      }
      if (capMaxPriority) {
        if (priorityRank(priority) > priorityRank(capMaxPriority)) reject("priority exceeds capability max_priority");
      }
    }
  }

  if (boolTrue(allowPromote)) reject("allow_promote=true is forbidden");

  if (boolTrue(allowProductionWrite)) {
    if (!tomlSectionExists("data_change_guards", reqText)) {
      reject("production write request is missing data_change_guards");
    } else {
      if (tvReq("data_change_guards", "dry_run_supported") !== "true") reject("production write request must support dry_run");
      if (!tvReq("data_change_guards", "rollback_plan")) reject("production write request is missing rollback_plan");
      if (tvReq("data_change_guards", "user_approval_required_per_run") !== "true") reject("production write request must require per-run user approval");
    }
  }

  const inboxToml = `${pmRuntime}/requests/inbox/${requestId}.toml`;
  const processedToml = `${pmRuntime}/requests/processed/${requestId}.toml`;
  if (requestId) {
    for (const existing of [inboxToml, processedToml]) {
      if (isFile(existing)) {
        const existingSha = tomlValue("intake", "commit_sha", readFileSync(existing, "utf8"));
        if (existingSha === commitSha) {
          out(`ALREADY_ACCEPTED ${requestId} ${commitSha}`);
          return 0;
        }
        reject("duplicate request_id exists with a different commit SHA");
      }
    }
  }

  if (reasons.length > 0) {
    const reason = reasons.join(";");
    writeRejection(requestId, reason);
    return 2;
  }

  mkdirSync(`${pmRuntime}/requests/inbox`, { recursive: true });
  mkdirSync(`${pmRuntime}/pm/inbox`, { recursive: true });
  mkdirSync(`${pmRuntime}/requests/processed`, { recursive: true });
  mkdirSync(`${pmRuntime}/requests/rejected`, { recursive: true });
  mkdirSync(`${pmControl}/reports/requests`, { recursive: true });

  let inbox = "";
  inbox += `# Normalized by Garelier request_intake_handler.ts\n`;
  inbox += reqText;
  inbox += `\n\n[intake]\n`;
  inbox += `target_pm = "${tomlEscape(targetPm)}"\n`;
  inbox += `commit_sha = "${tomlEscape(commitSha)}"\n`;
  inbox += `received_at = "${tomlEscape(now)}"\n`;
  inbox += `request_dir = "${tomlEscape(requestDirPosix)}"\n`;
  inbox += `handler = "request_intake_handler.ts"\n`;
  writeFileSync(inboxToml, inbox);

  const pmNote = `${pmRuntime}/pm/inbox/${stamp}-request-${requestId}.md`;
  let note = "";
  note += `# Delegated request accepted: ${requestId}\n\n`;
  note += `- Source PM: \`${sourcePm}\`\n`;
  note += `- Target PM: \`${manifestTargetPm}\`\n`;
  note += `- Kind: \`${kind}\`\n`;
  note += `- Priority: \`${priority}\`\n`;
  note += `- Request branch: \`${requestBranch}\`\n`;
  note += `- Commit SHA: \`${commitSha}\`\n`;
  note += `- Received at: \`${now}\`\n`;
  note += `- Normalized request: \`${inboxToml}\`\n`;
  if (isFile(requestMdWin)) note += `- Request brief: \`${requestMd}\`\n`;
  note += `\nPM action:\n`;
  note += `1. Review the normalized request and delegated capability bounds.\n`;
  note += `2. Convert acceptable work into a blueprint or dashboard task.\n`;
  note += `3. Move the normalized request to \`${pmRuntime}/requests/processed/\` when handled.\n`;
  writeFileSync(pmNote, note);

  out(`ACCEPTED ${requestId} ${commitSha}`);
  return 0;
}

function need(argv: string[], i: number, label: string): string {
  const v = argv[i];
  if (v === undefined || v === "") { err(`missing ${label}`); process.exit(1); }
  return v;
}

export { tomlValue, tomlSectionExists, listContains, listEmpty, sourceIdExists, priorityRank, boolTrue, tomlEscape };

if (import.meta.main) process.exit(main());
