// merge_land — one background command for the whole PM merge ritual (W-088, TS port W-083).
//
// Faithful port of merge_land.sh. Composition macro over the individually-tested
// sibling scripts (merge_request.sh / gate_result_waiter.sh / dispatch_cleanup.sh /
// merge_request_id_recover.sh) and dock_merge.ts — it adds NO merge/gate logic of
// its own. CLI / stdout JSON / stderr / exit codes / generated-file behavior are
// frozen to the bash original (W-083 §3).
//
// Sibling scripts + dock_merge + lint_commits are resolved relative to the SHIM
// dir (GARELIER_SCRIPT_SHIM_DIR, exported by merge_land.sh), so a relocated shim
// running against stand-in siblings (merge_land.test.sh W-055) resolves the same
// way the bash `$SELF_DIR` did; the verdict marker parser reuses
// merge_gate_parse.extractVerdict directly.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractVerdict } from "../merge_gate_parse.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = (process.env.GARELIER_SCRIPT_SHIM_DIR || resolve(moduleDir, "../../../scripts")).replace(/\\/g, "/");
const DRIVER_DISPATCH = resolve(SHIM_DIR, "../driver/src/dispatch").replace(/\\/g, "/");

const HELP = `#
# merge_land.sh — one background command for the whole PM merge ritual (W-088).
#
# Submits, BLOCK-waits for the gate result, and only on a landed merge cleans up
# + pulls. On a failed/aborted/timed-out gate it cleans up NOTHING and returns
# the failure.
#
# Usage:
#   merge_land.sh --project <control-root> --pm-id <id>
#                 (--branch <workbench-branch> | --dispatch-id <N>)
#                 [--guardian <PASS|PASS_WITH_NOTES>] [--observer <verdict>]
#                 [--seat-trailer <checked|skip>]  (guardian round-3 N1 override)
#                 [--no-pull]
#                 [--close-row <item-id> …] [--backlog-path <path>] [--close-trailer <line>]
#                 [--max-wait <seconds>] [--poll-interval <seconds>]
#                 [ …any other merge_request.sh flag… ]
#
# Batch mode (W-022): --id <N1> --id <N2> …  OR  --batch <file>.
`;

// ── process helpers ─────────────────────────────────────────────────────────
interface Cmd { code: number; stdout: string; stderr: string }
function runSync(command: string[], opts: { stderrTo?: "capture" | "inherit" } = {}): Cmd {
  const c = Bun.spawnSync(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: opts.stderrTo === "inherit" ? "inherit" : "pipe",
  });
  return { code: c.exitCode, stdout: c.stdout?.toString() ?? "", stderr: opts.stderrTo === "inherit" ? "" : (c.stderr?.toString() ?? "") };
}
function err(s: string): void { process.stderr.write(s.endsWith("\n") ? s : s + "\n"); }
function out(s: string): void { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); }
function jesc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function firstMatch(text: string, re: RegExp): string { const m = text.match(re); return m ? m[1] : ""; }

// read_marker_verdict — emit the canonical verdict token under `## Verdict`, or
// NOTHING when present-but-malformed (callers gate on file existence first, so an
// empty return there means malformed → the stderr note below).
function readMarkerVerdict(markerPath: string): string {
  let text: string;
  try { text = readFileSync(markerPath, "utf8"); } catch { return ""; }
  const v = extractVerdict(text);
  if (v) return v;
  err(`merge_land: verdict marker ${markerPath} is present but MALFORMED — no bare canonical token under '## Verdict' (a prose sentence, an unfilled {{…}} menu, bold like **PASS**, or a typo like PASSED all read as no-verdict; fix per templates/gate_verdict.md)`);
  return "";
}

function main(): number {
  const argv = process.argv.slice(2);

  // ── W-022 batch pre-scan ──────────────────────────────────────────────────
  const scanShared: string[] = [];
  const scanItems: string[] = [];
  let scanBatchFile = "";
  let nId = 0, nBranch = 0;
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--batch") { scanBatchFile = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--id" || a === "--dispatch-id") { nId++; scanItems.push(`--id ${argv[i + 1] ?? ""}`); i += 2; }
    else if (a === "--branch") { nBranch++; scanItems.push(`--branch ${argv[i + 1] ?? ""}`); i += 2; }
    else { scanShared.push(a); i += 1; }
  }
  let batchMode = false;
  if (scanBatchFile) batchMode = true;
  else if (nId >= 2 || nBranch >= 2) batchMode = true;

  if (batchMode) {
    const items: string[] = [];
    if (scanBatchFile) {
      if (nId > 0 || nBranch > 0) { err("merge_land: --batch <file> cannot be combined with top-level --id/--branch (put each item's flags on its own line in the file)"); return 2; }
      if (!existsSync(scanBatchFile)) { err(`merge_land: --batch file not found: ${scanBatchFile}`); return 2; }
      const lines = readFileSync(scanBatchFile, "utf8").split("\n");
      for (const raw of lines) {
        const line = raw.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
        if (!line) continue;
        if (line.startsWith("#")) continue;
        items.push(line);
      }
      if (items.length === 0) { err(`merge_land: --batch file ${scanBatchFile} has no item lines`); return 2; }
    } else {
      items.push(...scanItems);
    }

    const total = items.length;
    let n = 0, landed = 0;
    err(`merge_land: batch of ${total} item(s) — landing serially, aborting the rest on the first failure.`);
    for (const it of items) {
      n++;
      const iargs = it.split(/\s+/).filter((s) => s.length > 0);
      err(`merge_land: [batch ${n}/${total}] landing: ${iargs.join(" ")}`);
      const r = runSync(["bash", `${SHIM_DIR}/merge_land.sh`, ...scanShared, ...iargs], { stderrTo: "inherit" });
      if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
      if (r.code !== 0) {
        err(`merge_land: [batch ${n}/${total}] FAILED (rc=${r.code}) — aborting; ${total - n} remaining item(s) NOT attempted.`);
        out(`{"batch":true,"total":${total},"attempted":${n},"landed":${landed},"status":"failed","failed_item":"${jesc(it)}"}`);
        return r.code;
      }
      landed++;
      err(`merge_land: [batch ${n}/${total}] landed.`);
    }
    err(`merge_land: batch complete — all ${total} item(s) landed.`);
    out(`{"batch":true,"total":${total},"attempted":${total},"landed":${landed},"status":"success"}`);
    return 0;
  }

  // ── single-land arg parse ──────────────────────────────────────────────────
  const MR_ARGS: string[] = [];
  let PROJECT = "", PM = "", BRANCH = "", TARGET_ROOT = "", DISPATCH_ID = "";
  let NO_PULL = 0, MAX_WAIT = "", POLL_INTERVAL = "";
  let GUARDIAN = "", OBSERVER = "", IN_SEAT_TRAILER = "";
  const CLOSE_ROWS: string[] = [];
  let BACKLOG_PATH_OVERRIDE = "", CLOSE_TRAILER = "";
  const need = (i: number, flag: string): string => { const v = argv[i + 1]; if (v === undefined || v === "") { err(`merge_land: ${flag} requires a value`); process.exit(2); } return v; };
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    switch (a) {
      case "--project": PROJECT = need(i, a); MR_ARGS.push(a, PROJECT); i += 2; break;
      case "--pm-id": PM = need(i, a); MR_ARGS.push(a, PM); i += 2; break;
      case "--target-root": TARGET_ROOT = need(i, a); MR_ARGS.push(a, TARGET_ROOT); i += 2; break;
      case "--branch": BRANCH = need(i, a); i += 2; break;
      case "--guardian": GUARDIAN = need(i, a); i += 2; break;
      case "--observer": OBSERVER = need(i, a); i += 2; break;
      case "--seat-trailer": IN_SEAT_TRAILER = need(i, a); i += 2; break;
      case "--dispatch-id": case "--id": DISPATCH_ID = need(i, a); i += 2; break;
      case "--no-pull": NO_PULL = 1; i += 1; break;
      case "--close-row": CLOSE_ROWS.push(need(i, a)); i += 2; break;
      case "--backlog-path": BACKLOG_PATH_OVERRIDE = need(i, a); i += 2; break;
      case "--close-trailer": CLOSE_TRAILER = need(i, a); i += 2; break;
      case "--max-wait": MAX_WAIT = need(i, a); i += 2; break;
      case "--poll-interval": POLL_INTERVAL = need(i, a); i += 2; break;
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0);
      default: MR_ARGS.push(a); i += 1; break;
    }
  }
  if (IN_SEAT_TRAILER !== "" && IN_SEAT_TRAILER !== "checked" && IN_SEAT_TRAILER !== "skip") {
    err(`merge_land: --seat-trailer must be 'checked' or 'skip' (got '${IN_SEAT_TRAILER}')`); return 2;
  }
  if (!PROJECT || !PM) { err("merge_land: --project and --pm-id are required"); return 2; }
  const GIT_ROOT = TARGET_ROOT || PROJECT;
  const PM_ROOT = `${PROJECT}/__garelier/${PM}`;

  // ── (W-017 a) resolve --branch from --dispatch-id ─────────────────────────
  let BRANCH_ERR = "";
  if (!BRANCH && DISPATCH_ID) {
    const checkout = `${PM_ROOT}/_dispatch${DISPATCH_ID}/checkout`;
    if (!existsSync(checkout)) {
      BRANCH_ERR = `--dispatch-id ${DISPATCH_ID} given but no dispatch checkout at ${checkout} (prepare it first, or it was already cleaned up) — or pass --branch explicitly`;
    } else {
      const r = runSync(["git", "-C", checkout, "symbolic-ref", "--short", "HEAD"]);
      BRANCH = r.code === 0 ? r.stdout.trim() : "";
      if (BRANCH) err(`merge_land: resolved --branch ${BRANCH} from dispatch #${DISPATCH_ID} checkout`);
      else BRANCH_ERR = `dispatch #${DISPATCH_ID} checkout at ${checkout} is not on a branch (detached HEAD?) — pass --branch explicitly`;
    }
  }

  // dispatch id for cleanup: explicit, else the branch's `#<N>/` segment.
  if (!DISPATCH_ID && BRANCH) DISPATCH_ID = firstMatch(BRANCH, /.*#([0-9]+)\/.*/);

  // ── seat-trailer preflight (guardian round-2/3, W-051) ────────────────────
  let SEAT_TRAILER_ERR = "";
  if (DISPATCH_ID) {
    const seatCtx = `${PM_ROOT}/_dispatch${DISPATCH_ID}/context.json`;
    const seatCheckout = `${PM_ROOT}/_dispatch${DISPATCH_ID}/checkout`;
    if (existsSync(seatCtx) && existsSync(seatCheckout)) {
      const ctxText = (() => { try { return readFileSync(seatCtx, "utf8"); } catch { return ""; } })();
      const seatCommitMode = firstMatch(ctxText, /"commit_mode":\s*"([^"]*)"/);
      let seatIsProxy = 0, seatUnreadable = 0;
      if (seatCommitMode === "proxy") seatIsProxy = 1;
      else if (seatCommitMode === "self") seatIsProxy = 0;
      else {
        const seatModel = firstMatch(ctxText, /"model":\s*"([^"]*)"/);
        if (/codex/.test(seatModel)) seatIsProxy = 1;
        else if (!seatCommitMode && !seatModel) seatUnreadable = 1;
      }
      if (seatIsProxy === 1) {
        if (IN_SEAT_TRAILER) {
          err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — explicit --seat-trailer ${IN_SEAT_TRAILER} override`);
        } else {
          const seatBaseSha = firstMatch(ctxText, /"base_sha":\s*"([^"]*)"/);
          const seatLintTs = `${SHIM_DIR}/lint_commits.ts`;
          let seatHandover = 0;
          if (seatBaseSha && existsSync(seatLintTs)) {
            const summaryJson = runSync(["bun", seatLintTs, "--range", seatBaseSha, seatCheckout, "--seat-summary"]).stdout;
            const seatTotal = firstMatch(summaryJson, /"total":([0-9]*)/);
            const seatSelf = firstMatch(summaryJson, /"self":([0-9]*)/);
            if (seatTotal && parseInt(seatTotal, 10) > 0 && seatTotal === seatSelf) {
              seatHandover = 1;
              err(`merge_land: seat handover detected: context.json commit_mode=proxy but branch carries self trailers (${seatTotal}/${seatTotal} commits since ${seatBaseSha}) — switching preflight to self-mode (W-051)`);
            }
            if (seatHandover !== 1) {
              const lint = runSync(["bun", seatLintTs, "--range", seatBaseSha, seatCheckout, "--require-seat-trailer"]);
              if (lint.code !== 0) {
                err(lint.stdout + lint.stderr);
                SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID} is commit_mode=proxy (or codex-model-inferred) but one or more commits on ${BRANCH || "<unresolved>"} (since ${seatBaseSha}) fail --require-seat-trailer (missing/malformed Garelier-Seat trailer — see lint output on stderr above); the Dock must inject/fix the trailer per dispatch_prepare.sh's COMMIT_RULE duty 2/3 before landing, or pass --seat-trailer checked if you have manually verified it`;
              }
            }
          }
        }
      } else if (seatUnreadable === 1) {
        if (IN_SEAT_TRAILER) {
          err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — context.json content unreadable (neither commit_mode nor model resolved), explicit --seat-trailer ${IN_SEAT_TRAILER} override given`);
        } else {
          SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID}'s context.json (${seatCtx}) exists but its content is unreadable — neither routing.commit_mode nor routing.model resolved to a value (corrupted/emptied, not merely a stripped field); cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3 residual: fail-closed, same boundary as an unresolvable container); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed`;
        }
      }
    } else if (IN_SEAT_TRAILER) {
      err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — container unresolvable, explicit --seat-trailer ${IN_SEAT_TRAILER} override given`);
    } else {
      SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID}'s container/context.json is unresolvable (${seatCtx} / ${seatCheckout}) — cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3: fail-closed, since the producer itself can delete/strip this file); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed`;
    }
  }

  // ── (W-017 c) auto-read Guardian/Observer verdicts from markers ───────────
  const SLUG = BRANCH.includes("/") ? BRANCH.slice(BRANCH.lastIndexOf("/") + 1) : BRANCH;
  let GUARDIAN_SRC = "flag", GMARKER = "", OMARKER = "";
  if (BRANCH) {
    GMARKER = `${PM_ROOT}/runtime/guardian/results/${SLUG}-guardian.md`;
    OMARKER = `${PM_ROOT}/runtime/observer/results/${SLUG}-observer.md`;
    if (!GUARDIAN && existsSync(GMARKER)) {
      GUARDIAN = readMarkerVerdict(GMARKER);
      if (GUARDIAN) { GUARDIAN_SRC = "auto"; err(`merge_land: auto-read Guardian verdict '${GUARDIAN}' from ${GMARKER}`); }
    }
    if (!OBSERVER && existsSync(OMARKER)) {
      OBSERVER = readMarkerVerdict(OMARKER);
      if (OBSERVER) err(`merge_land: auto-read Observer verdict '${OBSERVER}' from ${OMARKER}`);
    }
  }

  // ── (W-017 b) one-shot pre-validation ─────────────────────────────────────
  const ERRORS: string[] = [];
  if (!BRANCH) {
    ERRORS.push(BRANCH_ERR || "no merge branch: pass --branch <workbench-branch>, or --dispatch-id <N> (alias --id) to auto-resolve it from the dispatch container");
  }
  if (SEAT_TRAILER_ERR) ERRORS.push(SEAT_TRAILER_ERR);
  if (!GUARDIAN) {
    if (BRANCH && existsSync(GMARKER)) {
      ERRORS.push(`Guardian verdict required: the marker at ${GMARKER} is present but MALFORMED (no bare canonical token under '## Verdict' — see the stderr note above and templates/gate_verdict.md); have the gate role fix it, or pass --guardian <PASS|PASS_WITH_NOTES> to override`);
    } else if (BRANCH) {
      ERRORS.push(`Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES>, or run Guardian so a verdict marker exists at ${GMARKER} ([guardian_policy] require_for_all_merges rejects a merge without one)`);
    } else {
      ERRORS.push("Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES> (or resolve --branch/--dispatch-id first so the Guardian marker can be auto-read)");
    }
  } else if (GUARDIAN_SRC === "auto") {
    if (GUARDIAN !== "PASS" && GUARDIAN !== "PASS_WITH_NOTES") {
      ERRORS.push(`auto-read Guardian verdict is ${GUARDIAN} (from ${GMARKER}), not PASS/PASS_WITH_NOTES — nothing to land; re-run Guardian, or pass --guardian explicitly to override`);
    }
  }
  if (ERRORS.length > 0) {
    err("merge_land: cannot submit — resolve the following first:");
    for (const e of ERRORS) err(`  - ${e}`);
    err("");
    process.stderr.write(HELP);
    return 2;
  }

  // forward resolved branch + verdicts to merge_request.
  MR_ARGS.push("--branch", BRANCH, "--guardian", GUARDIAN);
  if (OBSERVER) MR_ARGS.push("--observer", OBSERVER);

  // ── 1. submit WITHOUT poll ─────────────────────────────────────────────────
  const tmpDir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/merge_land-`);
  const mrErrFile = `${tmpDir}/mr.err`;
  const submitStart = Math.floor(Date.now() / 1000);
  const mr = runSync(["bash", `${SHIM_DIR}/merge_request.sh`, "--no-poll", ...MR_ARGS]);
  writeFileSync(mrErrFile, mr.stderr);
  if (mr.stderr) process.stderr.write(mr.stderr);
  let REQ_ID = "";
  try { REQ_ID = String((JSON.parse(mr.stdout) as Record<string, unknown>).request_id ?? ""); } catch { REQ_ID = ""; }
  if (!REQ_ID && mr.code === 0) {
    const rec = runSync(["bash", `${SHIM_DIR}/merge_request_id_recover.sh`,
      "--stderr-file", mrErrFile,
      "--requests-dir", `${PROJECT}/__garelier/${PM}/runtime/merge_gate/requests`,
      "--since", String(submitStart)]);
    REQ_ID = rec.code === 0 ? rec.stdout.trim() : "";
    if (REQ_ID) err(`merge_land: recovered request_id=${REQ_ID} from the request file (stdout parse failed — W-064).`);
  }
  if (!REQ_ID) {
    err(`merge_land: submit produced no request_id (merge_request rc=${mr.code}); no request was created — aborting.`);
    cleanupTmp(tmpDir);
    return 1;
  }

  // ── 2. spawn the gate via a poll (W-087-detached) ─────────────────────────
  const dockMergeTs = `${DRIVER_DISPATCH}/dock_merge.ts`;
  if (existsSync(dockMergeTs)) {
    runSync(["bun", dockMergeTs, "poll", "--pm-id", PM, "--project", PROJECT]);
  } else {
    err(`merge_land: dock_merge.ts not found at ${dockMergeTs}; relying on an external poller to spawn the gate for ${REQ_ID}.`);
  }
  err(`merge_land: submitted ${REQ_ID}; waiting for the gate result…`);

  // ── 2b. block-wait for the gate result ────────────────────────────────────
  const waitArgs = ["bash", `${SHIM_DIR}/gate_result_waiter.sh`, "--project", PROJECT, "--pm-id", PM, "--request-id", REQ_ID];
  if (MAX_WAIT) waitArgs.push("--max-wait", MAX_WAIT);
  if (POLL_INTERVAL) waitArgs.push("--poll-interval", POLL_INTERVAL);
  const wait = runSync(waitArgs);
  err(wait.stdout);
  const WAIT_RC = wait.code;

  const STATUS_LINE = wait.stdout;
  let STATUS = firstMatch(STATUS_LINE, /^MERGE_RESULT: ([^ ]+) /m);
  let DETAIL = firstMatch(STATUS_LINE, /^MERGE_RESULT: [^ ]+ [^ ]+ (.*)$/m);

  // ── 3. non-success: clean up NOTHING, report ──────────────────────────────
  if (WAIT_RC !== 0) {
    if (!STATUS) STATUS = WAIT_RC === 124 ? "timeout" : "failed";
    if (!DETAIL) DETAIL = firstMatch(STATUS_LINE, /^MERGE_TIMEOUT: (.*)$/m);
    out(`{"request_id":"${jesc(REQ_ID)}","status":"${jesc(STATUS || "failed")}","failure_reason":"${jesc(DETAIL)}","cleaned_up":false}`);
    cleanupTmp(tmpDir);
    return WAIT_RC;
  }

  // ── wait for OUR lock to clear before cleanup + row close ──────────────────
  const LOCK_ACTIVE = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/locks/active.lock`;
  for (let w = 0; w < 50; w++) {
    if (!existsSync(LOCK_ACTIVE)) break;
    let text = ""; try { text = readFileSync(LOCK_ACTIVE, "utf8"); } catch { text = ""; }
    if (!text.includes(REQ_ID)) break;
    Bun.sleepSync(100);
  }

  const STUDIO_COMMIT = DETAIL;

  // ── 4. success: clean up the dispatch + pull ──────────────────────────────
  let CLEANUP_STATUS = "skipped", BRANCH_DELETED = "false";
  if (DISPATCH_ID) {
    const cleanArgs = ["bash", `${SHIM_DIR}/dispatch_cleanup.sh`, "--project", PROJECT, "--pm-id", PM, "--id", DISPATCH_ID, "--delete-branch"];
    if (TARGET_ROOT) cleanArgs.push("--target-root", TARGET_ROOT);
    const clean = runSync(cleanArgs);
    if (clean.stdout) {
      CLEANUP_STATUS = firstMatch(clean.stdout, /"cleanup_status":"([^"]*)"/);
      BRANCH_DELETED = firstMatch(clean.stdout, /"branch_deleted":(true|false)/);
      err(clean.stdout);
    }
    if (!CLEANUP_STATUS) CLEANUP_STATUS = clean.code === 0 ? "success" : `failed(rc=${clean.code})`;
  } else {
    err("merge_land: no --dispatch-id and none derivable from the branch — skipping cleanup.");
  }

  // pull (best-effort, non-fatal).
  let PULLED = "skipped";
  if (NO_PULL !== 1) {
    const pull = runSync(["git", "-C", GIT_ROOT, "pull", "--ff-only"]);
    if (pull.code === 0) PULLED = "true";
    else { PULLED = "false"; err(`merge_land: git pull --ff-only skipped/failed: ${(pull.stderr.split("\n")[0] || "")}`); }
  }

  // ── 5. row close (W-093) ──────────────────────────────────────────────────
  let ROW_CLOSE_FIELD = "";
  if (CLOSE_ROWS.length > 0) {
    const backlogPath = BACKLOG_PATH_OVERRIDE || `${PROJECT}/__garelier/${PM}/control/project_dashboard/backlog.md`;
    let rowClose = "";
    let lockText = ""; try { lockText = readFileSync(LOCK_ACTIVE, "utf8"); } catch { lockText = ""; }
    if (existsSync(LOCK_ACTIVE) && !lockText.includes(REQ_ID)) {
      rowClose = "deferred (gate active)";
      err("merge_land: row close deferred — a foreign merge_gate active.lock is present (a next gate is running); backlog left untouched.");
    } else if (!existsSync(backlogPath)) {
      rowClose = "not-found";
      err(`merge_land: row close: backlog not found at ${backlogPath} — nothing to close.`);
    } else {
      const closed: string[] = [];
      let content = readFileSync(backlogPath, "utf8");
      for (const row of CLOSE_ROWS) {
        const { text, hit } = strikeRow(content, row);
        if (hit) { content = text; closed.push(row); }
      }
      if (closed.length === 0) {
        rowClose = "not-found";
        err(`merge_land: row close: none of [${CLOSE_ROWS.join(" ")}] matched a backlog row in ${backlogPath} — nothing committed.`);
      } else {
        writeFileSync(backlogPath, content);
        const ids = closed.join(", ");
        const msg = `chore(dashboard): ${ids} close (merged ${STUDIO_COMMIT})`;
        const blDirTop = runSync(["git", "-C", dirname(backlogPath), "rev-parse", "--show-toplevel"]);
        const blGit = blDirTop.code === 0 && blDirTop.stdout.trim() ? blDirTop.stdout.trim() : PROJECT;
        const commitArgs = CLOSE_TRAILER
          ? ["git", "-C", blGit, "commit", "-q", "-m", msg, "-m", CLOSE_TRAILER, "--", backlogPath]
          : ["git", "-C", blGit, "commit", "-q", "-m", msg, "--", backlogPath];
        const commit = runSync(commitArgs);
        if (commit.code === 0) {
          rowClose = "closed";
          err(`merge_land: row close: struck [${ids}] from backlog and committed to ${blGit}.`);
        } else {
          rowClose = `commit-failed(rc=${commit.code})`;
          err(`merge_land: row close: git commit failed (rc=${commit.code}); the backlog edit is left in the working tree for the PM.`);
        }
      }
    }
    ROW_CLOSE_FIELD = `,"row_close":"${jesc(rowClose)}"`;
  }

  out(`{"request_id":"${jesc(REQ_ID)}","status":"success","studio_commit":"${jesc(STUDIO_COMMIT)}","dispatch_id":"${jesc(DISPATCH_ID || "")}","branch_deleted":${BRANCH_DELETED || "false"},"cleanup_status":"${jesc(CLEANUP_STATUS || "skipped")}","pulled":"${PULLED}"${ROW_CLOSE_FIELD}}`);
  cleanupTmp(tmpDir);
  return 0;
}

// Strike a table row whose FIRST cell is EXACTLY `id` (never a later-column
// mention, never a longer id that merely starts with it). Mirrors the awk in
// merge_land.sh. Returns the (possibly-unchanged) text + whether it struck ≥1.
function strikeRow(content: string, id: string): { text: string; hit: boolean } {
  const lines = content.split("\n");
  const kept: string[] = [];
  let hit = false;
  for (const line of lines) {
    const l = line.replace(/^[ \t]+/, "");
    if (l.startsWith("|")) {
      const cells = l.split("|");
      if (cells.length >= 3 && cells[1].replace(/^[ \t]+|[ \t]+$/g, "") === id) { hit = true; continue; }
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), hit };
}

function cleanupTmp(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

process.exit(main());
