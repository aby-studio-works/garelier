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
// W-062: the Observer verdict is ALSO bound to a `review_sha`, symmetric with
// the Guardian G-15 stale-verdict guard (W-035). A passing Observer verdict for
// a commit the workbench tip has since moved past no longer covers HEAD and is
// refused as stale (with the same message-only-amend tree-hash fallback), so an
// Observer PASS cannot be silently invalidated by a later commit.
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
//   10 guardian_verdict_bound_by     ("" | "sha" | "tree" — W-035: how a passing
//                                     Guardian verdict was bound to the workbench
//                                     tip when guardian_required=true. "tree" means
//                                     the reviewed commit SHA no longer matches the
//                                     tip (e.g. a message-only amend/reword) but the
//                                     reviewed tree is byte-identical to the tip's
//                                     tree, so the G-15 stale-verdict guard accepted
//                                     it without a re-review.)
//   11 observer_verdict_bound_by     ("" | "sha" | "tree" — W-062: the same, for a
//                                     passing Observer verdict when
//                                     observer_required=true. Symmetric with
//                                     guardian_verdict_bound_by so an Observer PASS
//                                     accepted via the message-only-amend tree
//                                     fallback is auditable, not silent.)
//   12 refuter_gate_fail             ("" when ok, else the hold reason; W-066:
//                                     non-empty ONLY when a present refuter
//                                     verdict is REFUTED — an independent agent
//                                     overturned the Observer verdict, so hold
//                                     the merge for PM escalation. A refuter
//                                     verdict is never mandatory; its absence is
//                                     an advisory warn decided in bash.)
//   13 refuter_verdict               ("" | "UPHELD" | "REFUTED" — the resolved
//                                     refuter verdict; "" = absent. bash uses
//                                     absence + high-stakes to emit the advisory
//                                     warn.)
//   14 preflight_command_count       (integer string; count of the preflight
//                                     records that follow — lightweight,
//                                     fail-fast checks the gate runs right after
//                                     the merge and BEFORE the quality gate; W-023)
//   15..(15+count-1) preflight_commands   (one record per preflight command)
//   (15+count).. quality_gate_commands    (one record per command)
//
// Exit codes: 0 on success (records written), 2 on a fatal parse/validation
// error (bash treats this like the old "missing required fields" path).

const PASSING = new Set(["PASS", "PASS_WITH_NOTES"]);

// Canonical verdict enums. Observer allows REWORK_RECOMMENDED; Guardian does
// not (DEC-024 §9). Verdict resolution matches by EXACT whole-token equality
// against these sets from the STRUCTURED location only (the "## Verdict"
// heading / `verdict:` field). W-057: it never does an unanchored substring
// scan of the whole report — an untouched template placeholder such as
// `{{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}` (a menu of choices, not a
// filled verdict) and a malformed token like `PASSED`/`BLOCKING` resolve to
// null (= no verdict = fail-closed), never to a passing PASS. A null verdict
// must not gate a merge (observerGateReason/guardianGateReason refuse it).
const OBSERVER_VERDICTS = new Set([
  "PASS",
  "PASS_WITH_NOTES",
  "REWORK_RECOMMENDED",
  "BLOCK",
  "NO_OPINION",
]);
const GUARDIAN_VERDICTS = new Set(["PASS", "PASS_WITH_NOTES", "BLOCK", "NO_OPINION"]);
// W-066: the refuter is the opt-in adversarial-verify layer that sits ON TOP of
// the Observer verdict for a high-stakes merge. It does not re-review the code;
// it verifies the Observer's verdict (can a PASS be overturned / is a REWORK
// finding invalid), refute-default. Its verdict is a two-value enum — UPHELD
// (the Observer verdict survived) or REFUTED (it did not).
const REFUTER_VERDICTS = new Set(["UPHELD", "REFUTED"]);

// The captured token is a verdict only when the WHOLE trimmed token is exactly
// one canonical enum value. No truncation (PASS_WITH_NOTES never becomes PASS)
// and no substring coercion (PASSED never becomes PASS).
function exactVerdict(token: string | undefined, allowed: Set<string>): string | null {
  const t = (token ?? "").trim();
  return allowed.has(t) ? t : null;
}

function fail(msg: string): never {
  process.stderr.write(`merge_gate_parse: ${msg}\n`);
  process.exit(2);
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function extractVerdict(reportText: string): string | null {
  // The verdict is authoritative ONLY as a single canonical token under the
  // "## Verdict" heading. `[A-Z_]+` cannot start on the `{` of a `{{...}}`
  // placeholder, so an unfilled report captures nothing; a filled-but-wrong
  // token (e.g. PASSED) is captured but rejected by exactVerdict. Either way
  // the result is null (fail-closed), never a guessed pass.
  const sec = reportText.match(/##\s*Verdict[^\n]*\n+\s*([A-Z_]+)/);
  return sec ? exactVerdict(sec[1], OBSERVER_VERDICTS) : null;
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
  // DEC-088 (C2): when the policy requires a report-backed verdict
  // (observer_require_report), do NOT honor an asserted observer_verdict string
  // with no backing report — that is the "--observer PASS without running
  // Observer" bypass. Default (flag absent) is unchanged: string fallback stands.
  if (!verdict && req.observer_require_report !== true) {
    verdict = str(req.observer_verdict) || null;
  }
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

// The Observer reviews a specific commit too (W-062, symmetric with the
// Guardian G-15 guard). review_sha is read from the report (authoritative — the
// same `review_sha:` field convention Guardian uses, see extractReviewSha) or,
// failing that, the request's observer_review_sha.
export function extractObserverReviewSha(reportText: string): string | null {
  return extractReviewSha(reportText);
}

export function resolveObserverReviewSha(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string | null {
  const reportPath = str(req.observer_report_path);
  if (reportPath) {
    const text = readReport(reportPath);
    if (text != null) {
      const sha = extractReviewSha(text);
      if (sha) return sha;
    }
  }
  return str(req.observer_review_sha) || null;
}

// Decide the Observer-gate refusal reason ("" = ok) for a parsed request.
// `readReport` returns the report text for a path, or null when unreadable.
// headSha/treeHash (optional) drive the W-062 stale-verdict guard — omitted
// (as in unit tests without git), the stale check is a no-op and the gate
// behaves as it did before W-062.
export function observerGateReason(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): string {
  if (req.observer_required !== true) return "";
  const verdict = resolveVerdict(req, readReport);
  if (!verdict) {
    return "observer_required=true but no Observer verdict found (missing report and observer_verdict)";
  }
  if (!PASSING.has(verdict)) {
    return `observer_required=true but Observer verdict is ${verdict} (need PASS or PASS_WITH_NOTES)`;
  }
  const check = checkObserverStaleness(req, readReport, headSha, treeHash);
  if (check.stale) {
    return `observer verdict is stale: reviewed ${check.reviewSha} but ${str(req.workbench_branch)} tip is now ${check.tip} (re-run Observer on HEAD)`;
  }
  return "";
}

// W-062: how a passing Observer verdict was bound to the workbench tip — ""
// when the gate did not apply or bind (not required, no verdict, no headSha
// resolver, no review_sha), "sha" for an exact commit match, "tree" when the
// guard fell back to the tree-hash comparison (message-only amend). Symmetric
// with guardianVerdictBoundBy.
export function observerVerdictBoundBy(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): "sha" | "tree" | "" {
  if (req.observer_required !== true) return "";
  const verdict = resolveVerdict(req, readReport);
  if (!verdict || !PASSING.has(verdict)) return "";
  return checkObserverStaleness(req, readReport, headSha, treeHash).boundBy;
}

// ---- Refuter gate (W-066) — opt-in adversarial verify ON TOP of the Observer ----

// The refuter verdict is authoritative ONLY as an exact canonical token in a
// `refuter_verdict:` field, same fail-closed contract as extractVerdict /
// extractGuardianVerdict (W-057): a `{{...}}` placeholder or a malformed token
// (e.g. `REFUTE`, `UPHOLD`) resolves to null, never a substring-coerced value.
export function extractRefuterVerdict(reportText: string): string | null {
  const m = reportText.match(/^\s*refuter_verdict:\s*([A-Z_]+)/m);
  return m ? exactVerdict(m[1], REFUTER_VERDICTS) : null;
}

// Resolve the refuter verdict carried by a request: from the report at
// refuter_report_path when given (report-authoritative — an asserted UPHELD
// string cannot cover a report that says REFUTED, the anti-rubber-stamp
// property this layer exists for), else the request's refuter_verdict field.
// null when none. Unlike Observer/Guardian there is no require_report gate: the
// refuter is opt-in and lightweight, so the string fallback always stands.
export function resolveRefuterVerdict(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string | null {
  const reportPath = str(req.refuter_report_path);
  if (reportPath) {
    const text = readReport(reportPath);
    if (text != null) {
      const fromReport = extractRefuterVerdict(text);
      if (fromReport) return fromReport;
    }
  }
  return exactVerdict(str(req.refuter_verdict), REFUTER_VERDICTS);
}

// Decide the refuter-gate refusal reason ("" = ok) for a parsed request. Unlike
// the Observer/Guardian gates there is NO required flag: a refuter verdict is
// never mandatory (its ABSENCE is only an advisory warn on a high-stakes merge,
// decided in bash from the require_for_* subset). But when a refuter verdict IS
// present and it is REFUTED, an independent agent overturned the Observer's
// verdict — hold the merge and escalate to PM (fail-closed, W-057 style).
export function refuterGateReason(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string {
  const verdict = resolveRefuterVerdict(req, readReport);
  if (verdict === "REFUTED") {
    return "refuter REFUTED the Observer verdict (W-066): an independent adversarial-verify agent did not uphold the Observer's PASS/REWORK — holding merge for PM escalation";
  }
  return "";
}

// ---- Guardian gate (DEC-024) — same shape as the Observer gate ----

// Guardian verdicts are a SUBSET of the Observer set — no REWORK_RECOMMENDED
// (DEC-024 §9: PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION only). See
// GUARDIAN_VERDICTS above.

export function extractGuardianVerdict(reportText: string): string | null {
  // Guardian reports declare the verdict in a `verdict:` field (front matter).
  // Same fail-closed contract as extractVerdict (W-057): only an exact
  // canonical token in the `verdict:` field counts; a `{{...}}` placeholder or
  // a malformed token resolves to null, never a substring-coerced pass.
  const front = reportText.match(/^\s*verdict:\s*([A-Z_]+)/m);
  return front ? exactVerdict(front[1], GUARDIAN_VERDICTS) : null;
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
  // DEC-088 (C2): when the policy requires a report-backed verdict
  // (guardian_require_report), do NOT honor an asserted guardian_verdict string
  // with no backing report — that is the "--guardian PASS without running
  // Guardian" bypass. Default (flag absent) is unchanged: string fallback stands.
  if (!verdict && req.guardian_require_report !== true) {
    verdict = str(req.guardian_verdict) || null;
  }
  return verdict;
}

export function hasPassingGuardianVerdict(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): boolean {
  const v = resolveGuardianVerdict(req, readReport);
  return v != null && PASSING.has(v);
}

// The Guardian and Observer both review a specific commit (review_sha). If the
// workbench tip moves after a verdict is written, the verdict no longer covers
// HEAD — a stale verdict must not gate the merge (DEC-024 / G-15 for Guardian,
// W-062 for Observer). Both report formats declare it in the same `review_sha:`
// field, so a single extractor serves both; each per-role resolver falls back to
// the request's `<role>_review_sha`.
export function extractReviewSha(reportText: string): string | null {
  const m = reportText.match(/^\s*review_sha:\s*([0-9a-fA-F]{7,40})\b/m);
  return m ? m[1] : null;
}

// Back-compat named export (W-035 named this Guardian-specific before W-062
// generalized it to the shared extractReviewSha).
export function extractGuardianReviewSha(reportText: string): string | null {
  return extractReviewSha(reportText);
}

export function resolveGuardianReviewSha(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
): string | null {
  const reportPath = str(req.guardian_report_path);
  if (reportPath) {
    const text = readReport(reportPath);
    if (text != null) {
      const sha = extractReviewSha(text);
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

interface StalenessCheck {
  stale: boolean;
  boundBy: "sha" | "tree" | "";
  reviewSha: string | null;
  tip: string | null;
}

// Stale-verdict guard core, shared by BOTH the Guardian (G-15 / W-035) and
// Observer (W-062) gates so the two behave identically. It works on an
// already-resolved reviewSha + workbench so the only role-specific part is where
// that sha came from (checkGuardianStaleness / checkObserverStaleness below). A
// reviewer reviews a TREE, not a commit's metadata: a message-only amend/reword
// changes the commit SHA but not the tree, so a reviewed tree identical to the
// tip's tree still covers HEAD. Only a real tree diff (actual code changed after
// review) is stale.
function checkStaleness(
  reviewSha: string | null,
  workbench: string,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): StalenessCheck {
  if (!headSha) return { stale: false, boundBy: "", reviewSha, tip: null };
  if (!reviewSha || !workbench) return { stale: false, boundBy: "", reviewSha, tip: null };
  const tip = headSha(workbench);
  if (!tip) return { stale: false, boundBy: "", reviewSha, tip: null };
  if (shaMatches(reviewSha, tip)) return { stale: false, boundBy: "sha", reviewSha, tip };
  if (treeHash) {
    const reviewTree = treeHash(reviewSha);
    const tipTree = treeHash(tip);
    if (reviewTree && tipTree && reviewTree === tipTree) {
      return { stale: false, boundBy: "tree", reviewSha, tip };
    }
  }
  return { stale: true, boundBy: "", reviewSha, tip };
}

function checkGuardianStaleness(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): StalenessCheck {
  return checkStaleness(resolveGuardianReviewSha(req, readReport), str(req.workbench_branch), headSha, treeHash);
}

function checkObserverStaleness(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): StalenessCheck {
  return checkStaleness(resolveObserverReviewSha(req, readReport), str(req.workbench_branch), headSha, treeHash);
}

export function guardianGateReason(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): string {
  if (req.guardian_required !== true) return "";
  const verdict = resolveGuardianVerdict(req, readReport);
  if (!verdict) {
    return "guardian_required=true but no Guardian verdict found (missing report and guardian_verdict)";
  }
  if (!PASSING.has(verdict)) {
    return `guardian_required=true but Guardian verdict is ${verdict} (need PASS or PASS_WITH_NOTES)`;
  }
  const check = checkGuardianStaleness(req, readReport, headSha, treeHash);
  if (check.stale) {
    return `guardian verdict is stale: reviewed ${check.reviewSha} but ${str(req.workbench_branch)} tip is now ${check.tip} (re-run Guardian on HEAD)`;
  }
  return "";
}

// W-035: how a passing Guardian verdict was bound to the workbench tip — ""
// when the gate did not apply or bind (not required, no verdict, no
// headSha resolver, no review_sha), "sha" for an exact commit match, "tree"
// when the guard fell back to the tree-hash comparison (message-only amend).
export function guardianVerdictBoundBy(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
): "sha" | "tree" | "" {
  if (req.guardian_required !== true) return "";
  const verdict = resolveGuardianVerdict(req, readReport);
  if (!verdict || !PASSING.has(verdict)) return "";
  return checkGuardianStaleness(req, readReport, headSha, treeHash).boundBy;
}

// Build the NUL-delimited record list for a parsed request, or throw on a
// fatal validation error.
export function buildRecords(
  req: Record<string, unknown>,
  readReport: (path: string) => string | null,
  headSha?: (ref: string) => string | null,
  treeHash?: (ref: string) => string | null,
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
  // W-023: lightweight preflight commands, run right after the merge and
  // BEFORE the (potentially expensive) quality gate, so a cheap, deterministic
  // check like a stale Cargo.lock fails in seconds instead of at the end of a
  // multi-minute compile/test gate.
  const preflightCommands = Array.isArray(req.preflight)
    ? (req.preflight as unknown[]).map(str).filter((c) => c.length > 0)
    : [];

  if (!requestId || !workbench || !studio) {
    throw new Error(
      "request JSON missing required fields (request_id / workbench_branch / studio_branch)",
    );
  }
  if (commands.length === 0) {
    throw new Error("request JSON has no quality_gate_commands");
  }

  const observerGateFail = observerGateReason(req, readReport, headSha, treeHash);
  const passing = hasPassingVerdict(req, readReport) ? "true" : "false";
  const observerBoundBy = observerVerdictBoundBy(req, readReport, headSha, treeHash);
  const guardianGateFail = guardianGateReason(req, readReport, headSha, treeHash);
  const guardianPassing = hasPassingGuardianVerdict(req, readReport) ? "true" : "false";
  const guardianBoundBy = guardianVerdictBoundBy(req, readReport, headSha, treeHash);
  // W-066: the refuter fields. refuterGateFail is non-empty only on a present
  // REFUTED verdict (hold + escalate); refuterVerdict is the resolved value ("" =
  // absent) so bash can distinguish UPHELD from absent for the advisory-warn path.
  const refuterGateFail = refuterGateReason(req, readReport);
  const refuterVerdict = resolveRefuterVerdict(req, readReport) ?? "";

  // DEC-049 C2 — fail-fast ordering: emit the cheap, deterministic FAST checks
  // FIRST, then the authoritative FULL set minus anything already covered by fast
  // (dedupe by exact command string). A fmt/clippy violation then costs seconds,
  // not a full build+test, on the rare rework. The gate is unchanged when no fast
  // commands are configured (ordered === commands). The bash/ps1 runners need no
  // change — they execute the emitted list in order and stop at the first failure.
  const fastSet = new Set(fastCommands);
  const ordered = [...fastCommands, ...commands.filter((c) => !fastSet.has(c))];

  return [
    requestId, workbench, studio, mergeMessage, preMergeBaseTracking, timeout,
    observerGateFail, passing, guardianGateFail, guardianPassing, guardianBoundBy,
    observerBoundBy,
    refuterGateFail, refuterVerdict,
    String(preflightCommands.length), ...preflightCommands,
    ...ordered,
  ];
}

// W-045: a request's target_root is untrusted (hand-edited, a broken test
// fixture, a stale/foreign lock, ...). Resolving a relative/malformed value
// against `fallback` and trusting the result is what let a bogus literal
// (e.g. an unexpanded "$DT" leaking out of a shell fixture) become a real
// absolute path — `<fallback>/$DT` — that callers then used as a git cwd,
// planting a stray literal-named directory inside the real project. Trust
// only a value that is already absolute, contains no literal "$", AND names
// an existing directory; anything else falls back to `fallback` untouched.
export function resolveTrustedTargetRoot(rawTargetRoot: unknown, fallback: string): string {
  const target = typeof rawTargetRoot === "string" ? rawTargetRoot.trim() : "";
  if (!target || target.includes("$") || !require("node:path").isAbsolute(target)) return fallback;
  try {
    return require("node:fs").statSync(target).isDirectory() ? target : fallback;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const reqPath = process.argv[2];
  // Optional project root; a relative observer_report_path is resolved against
  // it (the driver spawns the Git Bash merge gate with cwd = project root, but passing
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
  const targetRoot = resolveTrustedTargetRoot(req.target_root, projectRoot);

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
  // W-035: resolve a commit-ish to its TREE sha, for the G-15 stale-verdict
  // guard's message-only-amend fallback (checkGuardianStaleness).
  const treeHash = (ref: string): string | null => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", `${ref}^{tree}`], {
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
      treeHash,
    );
  } catch (e) {
    fail((e as Error).message);
  }

  process.stdout.write(records.join("\0") + "\0");
}

if (import.meta.main) {
  void main();
}
