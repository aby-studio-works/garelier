#!/usr/bin/env bun
// TS-first port of driver/src/scripts/scheduler_adapter.ts (W-083). Behaviour frozen:
// flags / stdout / stderr / exit codes / generated file paths + formats match
// the shell 1:1. Called by an external scheduler when a Garelier scheduled job
// is due; it records a run and notifies PM, and never executes the job body.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { realpathSync } from "node:fs";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

const USAGE = `Usage:
  scheduler_adapter.ts --job-id JOB_ID [options]

Options:
  --pm-id PM_ID         PM whose scheduled_jobs/ owns this job. Required
                        when multiple PMs exist under __garelier/.
  --project-root PATH   Target project root. Defaults to current directory.
  --now ISO8601         Override trigger timestamp for tests.
  -h, --help            Show this help.

v2.1: pm-id aware. Jobs live under __garelier/<pm_id>/control/scheduled_jobs/
and run state under __garelier/<pm_id>/runtime/scheduled_jobs/. This
reference adapter is called by an external scheduler when a Garelier
scheduled job is due. It records a run and notifies PM; it never
executes the job body directly.`;

function usage(sink: (s: string) => void): void {
  for (const line of USAGE.split("\n")) sink(line);
}

// awk toml_value(section, key, file): first matching key inside [section]
// (section "" = top-level before any header), with inline "#" comment strip and
// one layer of surrounding quotes removed. Mirrors the shell awk byte for byte.
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

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

// `C:\a\b` -> `/c/a/b`, matching MSYS `pwd -P` so display/generated paths are
// byte-identical to the shell. A no-op for paths already in POSIX form (Linux).
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

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function main(): number {
  const argv = process.argv.slice(2);
  let projectRoot = ".";
  let jobId = "";
  let now = "";
  let pmId = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-root") { projectRoot = need(argv, ++i, "--project-root value"); }
    else if (a === "--job-id") { jobId = need(argv, ++i, "--job-id value"); }
    else if (a === "--pm-id") { pmId = need(argv, ++i, "--pm-id value"); }
    else if (a === "--now") { now = need(argv, ++i, "--now value"); }
    else if (a === "-h" || a === "--help") { usage(out); return 0; }
    else { err(`Unknown argument: ${a}`); usage(err); return 1; }
  }

  if (!jobId) { usage(err); return 1; }

  if (!/^J-[A-Za-z0-9._-]+$/.test(jobId)) { err(`Invalid job id: ${jobId}`); return 1; }

  if (!isDir(projectRoot)) { err(`Project root not found: ${projectRoot}`); return 1; }

  // Shell did `cd "$PROJECT_ROOT"; PROJECT_ROOT="$(pwd -P)"` — a POSIX absolute
  // path used in messages and (via bash) for the -d/-f checks. Under native bun
  // the FS calls need the real relative/Windows path (cwd == project root after
  // chdir), so keep the POSIX form purely for display and drive FS off relative
  // paths — byte-identical output on every platform, correct FS on Windows.
  process.chdir(projectRoot);
  const projectRootPosix = toPosix(realpathSync(process.cwd()));
  const garelierRoot = `${projectRootPosix}/__garelier`;

  if (!isDir("__garelier")) { err(`Error: not a Garelier project root: ${projectRootPosix}`); return 1; }

  // Auto-detect pm_id when not provided.
  if (!pmId) {
    const cands: string[] = [];
    for (const ent of readdirEntries("__garelier")) {
      if (!isDir(`__garelier/${ent}`)) continue;
      if (isFile(`__garelier/${ent}/_pm/setup_config.toml`)) cands.push(ent);
    }
    if (cands.length === 0) {
      err(`Error: No Garelier PM initialized under ${garelierRoot}; run setup_wizard.`);
      return 1;
    } else if (cands.length === 1) {
      pmId = cands[0];
    } else {
      err(`Error: multiple PMs found under ${garelierRoot} — pass --pm-id <id>.`);
      err("       Available PMs:");
      for (const p of cands) err(`         - ${p}`);
      return 1;
    }
  }

  const pmConfig = `${garelierRoot}/${pmId}/_pm/setup_config.toml`;
  if (!isFile(`__garelier/${pmId}/_pm/setup_config.toml`)) { err(`Error: PM '${pmId}' not found (${pmConfig} missing).`); return 1; }

  const jobFile = `__garelier/${pmId}/control/scheduled_jobs/${jobId}.toml`;
  if (!isFile(jobFile)) { err(`Scheduled job file not found: ${jobFile}`); return 1; }

  if (!now) now = utcNow();
  const stamp = utcStamp();
  const runId = now.replace(/[:+]/g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
  const runDir = `__garelier/${pmId}/runtime/scheduled_jobs/runs/${jobId}/${runId}`;

  const jobText = readFileSync(jobFile, "utf8");
  const tv = (section: string, key: string) => tomlValue(section, key, jobText);

  const writeRun = (status: string, reason = ""): void => {
    mkdirSync(runDir, { recursive: true });
    let body = "";
    body += `job_id = "${tomlEscape(jobId)}"\n`;
    body += `run_id = "${tomlEscape(runId)}"\n`;
    body += `pm_id = "${tomlEscape(pmId)}"\n`;
    body += `triggered_at = "${tomlEscape(now)}"\n`;
    body += `status = "${tomlEscape(status)}"\n`;
    body += `adapter = "scheduler_adapter.ts"\n`;
    if (reason) body += `reason = "${tomlEscape(reason)}"\n`;
    writeFileSync(`${runDir}/run.toml`, body);
  };

  const manifestJobId = tv("", "job_id");
  const status = tv("", "status");
  const ownerRole = tv("", "owner_role");
  const timezone = tv("", "timezone");
  const schedule = tv("", "schedule");
  const purpose = tv("", "purpose");
  const allowCommits = tv("safety", "allow_commits");
  const allowPromote = tv("safety", "allow_promote");
  const allowProductionWrite = tv("safety", "allow_production_write");
  const lockResourceRaw = tv("lock", "resource");
  const lockModeRaw = tv("lock", "mode");

  if (manifestJobId !== jobId) {
    err("job_id field does not match --job-id");
    writeRun("failed_validation", "job_id field does not match --job-id");
    return 2;
  }

  if (status !== "active") {
    writeRun("skipped_status", `job status is ${status}`);
    out(`SKIPPED_STATUS ${jobId} ${status}`);
    return 0;
  }

  for (const field of ["owner_role", "timezone", "schedule", "purpose"]) {
    if (!tv("", field)) {
      err(`Missing required field: ${field}`);
      writeRun("failed_validation", `missing required field: ${field}`);
      return 2;
    }
  }
  for (const field of ["allow_commits", "allow_promote", "allow_production_write"]) {
    if (!tv("safety", field)) {
      err(`Missing required field: safety.${field}`);
      writeRun("failed_validation", `missing required field: safety.${field}`);
      return 2;
    }
  }

  if (allowPromote === "true") {
    err("allow_promote=true is forbidden for scheduled jobs");
    writeRun("failed_validation", "allow_promote=true is forbidden");
    return 2;
  }

  if (allowProductionWrite === "true") {
    if (!tomlSectionExists("data_change_guards", jobText)) {
      err("Production write job is missing data_change_guards");
      writeRun("failed_validation", "production write job is missing data_change_guards");
      return 2;
    }
    if (tv("data_change_guards", "dry_run_supported") !== "true" ||
        !tv("data_change_guards", "rollback_plan") ||
        tv("data_change_guards", "user_approval_required_per_run") !== "true") {
      err("Production write job has incomplete data_change_guards");
      writeRun("failed_validation", "production write job has incomplete data_change_guards");
      return 2;
    }
  }

  let lockResource = lockResourceRaw || jobId;
  let lockMode = lockModeRaw || "skip_if_running";
  const lockName = safeName(lockResource);
  const lockDir = `__garelier/${pmId}/runtime/scheduled_jobs/locks/${lockName}.lock`;

  mkdirSync(`__garelier/${pmId}/runtime/scheduled_jobs/locks`, { recursive: true });
  mkdirSync(`__garelier/${pmId}/runtime/pm/inbox`, { recursive: true });

  if (lockMode !== "skip_if_running") {
    err(`Unsupported lock mode in reference adapter: ${lockMode}`);
    writeRun("failed_validation", `unsupported lock mode: ${lockMode}`);
    return 2;
  }

  // Atomic lock via a mkdir that fails if the directory already exists.
  try {
    mkdirSync(lockDir);
  } catch {
    writeRun("skipped_locked", `lock already exists: ${lockDir}`);
    out(`SKIPPED_LOCKED ${jobId} ${lockDir}`);
    return 0;
  }

  let lockBody = "";
  lockBody += `job_id = "${tomlEscape(jobId)}"\n`;
  lockBody += `run_id = "${tomlEscape(runId)}"\n`;
  lockBody += `pm_id = "${tomlEscape(pmId)}"\n`;
  lockBody += `created_at = "${tomlEscape(now)}"\n`;
  lockBody += `resource = "${tomlEscape(lockResource)}"\n`;
  lockBody += `mode = "${tomlEscape(lockMode)}"\n`;
  lockBody += `owner = "scheduler_adapter.ts"\n`;
  writeFileSync(`${lockDir}/lock.toml`, lockBody);

  writeRun("notified_pm");
  appendFileSync(`${runDir}/run.toml`, `lock_dir = "${tomlEscape(lockDir)}"\n`);

  const pmNote = `__garelier/${pmId}/runtime/pm/inbox/${stamp}-scheduled-job-${jobId}.md`;
  let note = "";
  note += `# Scheduled job due: ${jobId}\n\n`;
  note += `- PM: \`${pmId}\`\n`;
  note += `- Owner role: \`${ownerRole}\`\n`;
  note += `- Timezone: \`${timezone}\`\n`;
  note += `- Schedule: \`${schedule}\`\n`;
  note += `- Purpose: ${purpose}\n`;
  note += `- Triggered at: \`${now}\`\n`;
  note += `- Job file: \`${jobFile}\`\n`;
  note += `- Run directory: \`${runDir}\`\n`;
  note += `- Lock directory: \`${lockDir}\`\n`;
  note += `- allow_commits: \`${allowCommits}\`\n`;
  note += `- allow_production_write: \`${allowProductionWrite}\`\n`;
  note += `\nPM action:\n`;
  note += `1. Review job inputs, safety flags, and dashboard context.\n`;
  note += `2. Convert the due job into normal PM/Dock work as needed.\n`;
  note += `3. Update \`${runDir}/run.toml\` to a terminal status and remove \`${lockDir}\` when complete.\n`;
  writeFileSync(pmNote, note);

  out(`NOTIFIED_PM ${jobId} ${runId}`);
  return 0;
}

function need(argv: string[], i: number, label: string): string {
  const v = argv[i];
  if (v === undefined || v === "") { err(`missing ${label}`); process.exit(1); }
  return v;
}
function readdirEntries(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

export { tomlValue, tomlSectionExists, safeName, tomlEscape };

if (import.meta.main) process.exit(main());
