// Robust merge-gate request parser for the bash merge gate (P1-4 + P0-3).
//
// merge-gate.sh historically extracted request fields with grep/sed/awk,
// which breaks on quote-escapes, embedded newlines, and special characters
// in quality-gate commands. This helper does a real JSON.parse with Bun and
// emits the fields NUL-delimited so bash can read them with `mapfile -d ''`
// without any eval or re-quoting.
//
// It also enforces the Observer merge gate (DEC-019): when the request sets
// `observer_required: true`, the merge may proceed only if a passing Observer
// verdict (PASS / PASS_WITH_NOTES) is present. The verdict is read from the
// Observer's report at `observer_report_path` when given (so a request cannot
// claim a PASS the report does not contain); otherwise the request's
// `observer_verdict` field is used as a fallback.
//
// Output record order (each terminated by a NUL byte):
//   0 request_id
//   1 workbench_branch
//   2 studio_branch
//   3 merge_message
//   4 pre_merge_base_tracking        ("true" | "false")
//   5 quality_gate_timeout_minutes   (integer string)
//   6 observer_gate_fail             ("" when ok, else the failure reason)
//   7 has_passing_verdict            ("true" | "false" — a passing Observer
//                                     verdict accompanies the request)
//   8 guardian_gate_fail             ("" when ok, else the failure reason; DEC-024)
//   9 has_passing_guardian_verdict   ("true" | "false")
//   10.. quality_gate_commands        (one record per command)
//
// Exit codes: 0 on success (records written), 2 on a fatal parse/validation
// error (bash treats this like the old "missing required fields" path).

const PASSING = new Set(["PASS", "PASS_WITH_NOTES"]);
const VERDICT_RE =
  /PASS_WITH_NOTES|REWORK_RECOMMENDED|NO_OPINION|PASS|BLOCK/;

function fail(msg: string): never {
  process.stderr.write(`merge_gate_parse: ${msg}\n`);
  process.exit(2);
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function extractVerdict(reportText: string): string | null {
  // Prefer the verdict declared under a "## Verdict" heading.
  const sec = reportText.match(/##\s*Verdict[^\n]*\n+\s*([A-Z_]+)/);
  if (sec && VERDICT_RE.test(sec[1])) {
    const m = sec[1].match(VERDICT_RE);
    if (m) return m[0];
  }
  const any = reportText.match(VERDICT_RE);
  return any ? any[0] : null;
}

// Resolve the Observer verdict carried by a request: from the report at
// observer_report_path (authoritative — a request cannot claim a PASS the
// report lacks), else the request's observer_verdict field. null when none.
export function resolveVerdict(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string | null {
  let verdict: string | null = null;
  const reportPath = str(req.observer_report_path);
  if (reportPath) {
    const text = readReport(reportPath);
    if (text != null) verdict = extractVerdict(text);
  }
  if (!verdict) verdict = str(req.observer_verdict) || null;
  return verdict;
}

// True when the request carries a passing Observer verdict (independent review
// already happened), regardless of whether observer_required was set.
export function hasPassingVerdict(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): boolean {
  const v = resolveVerdict(req, readReport);
  return v != null && PASSING.has(v);
}

// Decide the Observer-gate refusal reason ("" = ok) for a parsed request.
// `readReport` returns the report text for a path, or null when unreadable.
export function observerGateReason(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string {
  if (req.observer_required !== true) return "";
  const verdict = resolveVerdict(req, readReport);
  if (!verdict) {
    return "observer_required=true but no Observer verdict found (missing report and observer_verdict)";
  }
  if (!PASSING.has(verdict)) {
    return `observer_required=true but Observer verdict is ${verdict} (need PASS or PASS_WITH_NOTES)`;
  }
  return "";
}

// ---- Guardian gate (DEC-024) — same shape as the Observer gate ----

// Guardian verdicts are a SUBSET of the Observer set — no REWORK_RECOMMENDED
// (DEC-024 §9: PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION only).
const GUARDIAN_VERDICT_RE = /PASS_WITH_NOTES|NO_OPINION|PASS|BLOCK/;

export function extractGuardianVerdict(reportText: string): string | null {
  // Guardian reports declare the verdict in a `verdict:` field (front matter).
  const front = reportText.match(/^\s*verdict:\s*([A-Z_]+)/m);
  if (front && GUARDIAN_VERDICT_RE.test(front[1])) {
    const m = front[1].match(GUARDIAN_VERDICT_RE);
    if (m) return m[0];
  }
  const any = reportText.match(GUARDIAN_VERDICT_RE);
  return any ? any[0] : null;
}

export function resolveGuardianVerdict(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string | null {
  let verdict: string | null = null;
  const reportPath = str(req.guardian_report_path);
  if (reportPath) {
    const text = readReport(reportPath);
    if (text != null) verdict = extractGuardianVerdict(text);
  }
  if (!verdict) verdict = str(req.guardian_verdict) || null;
  return verdict;
}

export function hasPassingGuardianVerdict(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): boolean {
  const v = resolveGuardianVerdict(req, readReport);
  return v != null && PASSING.has(v);
}

// The Guardian reviews a specific commit (review_sha). If the workbench tip
// moves after the verdict is written, the verdict no longer covers HEAD — a
// stale verdict must not gate the merge (DEC-024 / G-15). The sha is read
// from the report (authoritative) or the request's guardian_review_sha.
export function extractGuardianReviewSha(reportText: string): string | null {
  const m = reportText.match(/^\s*review_sha:\s*([0-9a-fA-F]{7,40})\b/m);
  return m ? m[1] : null;
}

export function resolveGuardianReviewSha(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string | null {
  const reportPath = str(req.guardian_report_path);
  if (reportPath) {
    const text = readReport(reportPath);
    if (text != null) {
      const sha = extractGuardianReviewSha(text);
      if (sha) return sha;
    }
  }
  return str(req.guardian_review_sha) || null;
}

// Loose prefix match so a short review_sha still matches a full tip sha.
function shaMatches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || y.startsWith(x) || x.startsWith(y);
}

export function guardianGateReason(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
): string {
  if (req.guardian_required !== true) return "";
  const verdict = resolveGuardianVerdict(req, readReport);
  if (!verdict) {
    return "guardian_required=true but no Guardian verdict found (missing report and guardian_verdict)";
  }
  if (!PASSING.has(verdict)) {
    return `guardian_required=true but Guardian verdict is ${verdict} (need PASS or PASS_WITH_NOTES)`;
  }
  // Stale-verdict guard (G-15): reject a PASS that reviewed an older commit
  // than the current workbench tip — the Guardian never saw the new code.
  if (headSha) {
    const reviewSha = resolveGuardianReviewSha(req, readReport);
    const workbench = str(req.workbench_branch);
    if (reviewSha && workbench) {
      const tip = headSha(workbench);
      if (tip && !shaMatches(reviewSha, tip)) {
        return `guardian verdict is stale: reviewed ${reviewSha} but ${workbench} tip is now ${tip} (re-run Guardian on HEAD)`;
      }
    }
  }
  return "";
}

// Build the NUL-delimited record list for a parsed request, or throw on a
// fatal validation error.
export function buildRecords(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
): string[] {
  const requestId = str(req.request_id);
  const workbench = str(req.workbench_branch);
  const studio = str(req.studio_branch);
  const mergeMessage = str(req.merge_message);
  const preMergeBaseTracking = req.pre_merge_base_tracking === true ? "true" : "false";
  const timeoutRaw = req.quality_gate_timeout_minutes_per_cmd;
  const timeout =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? String(Math.floor(timeoutRaw))
      : "120";
  const commands = Array.isArray(req.quality_gate_commands)
    ? (req.quality_gate_commands as unknown[]).map(str).filter((c) => c.length > 0)
    : [];
  const fastCommands = Array.isArray(req.quality_gate_fast_commands)
    ? (req.quality_gate_fast_commands as unknown[]).map(str).filter((c) => c.length > 0)
    : [];

  if (!requestId || !workbench || !studio) {
    throw new Error(
      "request JSON missing required fields (request_id / workbench_branch / studio_branch)",
    );
  }
  if (commands.length === 0) {
    throw new Error("request JSON has no quality_gate_commands");
  }

  const observerGateFail = observerGateReason(req, readReport);
  const passing = hasPassingVerdict(req, readReport) ? "true" : "false";
  const guardianGateFail = guardianGateReason(req, readReport, headSha);
  const guardianPassing = hasPassingGuardianVerdict(req, readReport) ? "true" : "false";

  // DEC-049 C2 — fail-fast ordering: emit the cheap, deterministic FAST checks
  // FIRST, then the authoritative FULL set minus anything already covered by fast
  // (dedupe by exact command string). A fmt/clippy violation then costs seconds,
  // not a full build+test, on the rare rework. The gate is unchanged when no fast
  // commands are configured (ordered === commands). The bash/ps1 runners need no
  // change — they execute the emitted list in order and stop at the first failure.
  const fastSet = new Set(fastCommands);
  const ordered = [...fastCommands, ...commands.filter((c) => !fastSet.has(c))];

  return [requestId, workbench, studio, mergeMessage, preMergeBaseTracking, timeout, observerGateFail, passing, guardianGateFail, guardianPassing, ...ordered];
}

async function main(): Promise<void> {
  const reqPath = process.argv[2];
  // Optional project root; a relative observer_report_path is resolved against
  // it (the driver spawns the merge gate with cwd = project root, but passing
  // it explicitly keeps parsing independent of cwd). Defaults to cwd.
  const projectRoot = process.argv[3] || process.cwd();
  if (!reqPath) fail("usage: merge_gate_parse.ts <request_json_path> [project_root]");

  let raw: string;
  try {
    raw = await Bun.file(reqPath).text();
  } catch (e) {
    fail(`cannot read request: ${(e as Error).message}`);
  }

  let req: Record<string, unknown>;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    fail(`request is not valid JSON: ${(e as Error).message}`);
  }

  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const reqTargetRoot = str(req.target_root);
  const targetRoot = reqTargetRoot
    ? (path.isAbsolute(reqTargetRoot) ? reqTargetRoot : path.resolve(projectRoot, reqTargetRoot))
    : projectRoot;

  // Resolve a branch ref to its tip commit sha (for the stale-verdict guard).
  // Returns null when git is unavailable or the ref does not exist, in which
  // case the stale check is skipped (fail-open on resolution, not on policy).
  const headSha = (ref: string): string | null => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: targetRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  };
  let records: string[];
  try {
    records = buildRecords(
      req,
      (p) => {
        try {
          const abs = path.isAbsolute(p) ? p : path.join(projectRoot, p);
          return fs.readFileSync(abs, "utf8");
        } catch {
          return null;
        }
      },
      headSha,
    );
  } catch (e) {
    fail((e as Error).message);
  }

  process.stdout.write(records.join("\0") + "\0");
}

if (import.meta.main) {
  void main();
}
