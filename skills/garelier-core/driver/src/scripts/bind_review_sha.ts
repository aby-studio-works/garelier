#!/usr/bin/env bun
/** Bind a committed review candidate to both producer artifacts. */
import { existsSync, readFileSync } from "node:fs";
import { assertNoReparseOnPath, assertSafeLeaf, canonicalPath, writeGuardedFileSync } from "../guard/path_guard.ts";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  MachineArtifactError,
  parseMachineArtifact,
  rewriteMachineArtifact,
} from "../dispatch/machine_artifact.ts";
import { reviewGateLogName } from "../dispatch/dock_review_record.ts";

export interface BindReviewShaArgs {
  container: string;
  resultPath?: string;
  review: string;
  base: string;
  gateLog?: string;
  /** Commit measured by gateLog. Differs from review only for an explicitly
   * reused heavy run over an identical engine-bearing tree. */
  gateReview?: string;
  gateResult?: "GREEN";
  stat?: string;
  replace?: boolean;
}

const SHA = /^[0-9a-f]{40}$/;

/** The `[gate]` fields the DRIVER owns end to end (W-709, DEC-100 P1).
 *
 * Every one of them is derived — from the dispatch binding's base, the
 * candidate checkout's HEAD, and the review SHA the log is named for — so none
 * of them is a producer input. The binder writes them on every bind and names
 * the ones whose producer-authored value it replaced. */
const DRIVER_OWNED_GATE_FIELDS = ["review_sha", "declared_base_sha", "gate_review_sha", "gate_log", "candidate_stat"] as const;
const DRIVER_READ_GATE_FIELDS = [
  ...DRIVER_OWNED_GATE_FIELDS,
  "previous_review_sha",
  "dock_gate",
] as const;
type DriverReadGateField = typeof DRIVER_READ_GATE_FIELDS[number];
type GateFields = Record<string, unknown> & Partial<Record<DriverReadGateField, string>>;

/** Of those, the fields whose value is a FUNCTION OF THE REVIEW COMMIT.
 *
 * The driver rewrites them on every bind, so from round 2 onward the "prior
 * value" a bind finds is one the DRIVER wrote in round 1 — announcing it as a
 * producer-authored value the driver replaced reports the driver to itself
 * (#464 r3, note 3: the announcement's only discriminating field was
 * `declared_base_sha`). `previous_review_sha` already records that the artifact
 * was bound to another commit before, so nothing is lost by leaving these out;
 * the announcement keeps the one question a reader cannot answer otherwise —
 * did the producer author a value the driver owns. */
const REVIEW_DERIVED_GATE_FIELDS: readonly string[] = ["review_sha", "gate_review_sha", "gate_log", "candidate_stat"];

/** The fields the overwrite announcement names. Derived, so a new driver-owned
 * field lands in the right bucket by its declaration above rather than by
 * someone remembering to edit a second list. */
const ANNOUNCED_OVERWRITE_FIELDS = DRIVER_OWNED_GATE_FIELDS
  .filter((field) => !REVIEW_DERIVED_GATE_FIELDS.includes(field));

/** ONE spelling of the per-artifact bind summary, rendered here and parsed by
 * `review_prepare.ts::summarizeDriverOverwrites` through `parseBindSummary`
 * below (W-688).
 *
 * The reader used to carry its own regex. A regex that stops matching produces
 * NO overwrites, which collapses to the same `none` the reader prints when
 * there genuinely were none — a silent read failure wearing the answer's face.
 * Writer and reader now share this pair, so a spelling change moves both and a
 * line that does not parse is a refusal instead of a `none`. */
export function renderBindSummary(input: {
  label: string;
  previous: boolean;
  overwrote: readonly string[];
}): string {
  return `${input.label}: review_sha=bound declared_base_sha=bound previous=${input.previous ? 1 : 0}`
    + ` driver_overwrote=${input.overwrote.join(",") || "none"}`;
}

export interface BindSummary { label: string; overwrote: string[] }

/** Null when the line is not a bind summary at all (the binder's trailing
 * confirmation line, a warning, a blank). A line that LOOKS like one but does
 * not parse is the caller's problem to raise, which is why this returns the
 * parsed shape rather than an empty list. */
export function parseBindSummary(line: string): BindSummary | null {
  const match = /^(\S+):\s+review_sha=bound\s+declared_base_sha=bound\s+previous=[01]\s+driver_overwrote=(\S+)$/
    .exec(line.trim());
  if (!match) return null;
  const overwrote = match[2] === "none" ? [] : match[2]!.split(",").filter(Boolean);
  return { label: match[1]!, overwrote };
}
function resolveContainerArtifactPath(container: string, candidate: string, label: string): string {
  const root = resolve(container);
  // W-764: reparse traversal is proven by lstat on every entry. Comparing the
  // lexical spelling against `canonicalPath` (a `realpathSync.native` under the
  // hood) also flags a Windows 8.3 short name — a spelling of the same
  // directory, not an escape — which refused every container under a
  // short-name `%TEMP%`.
  assertNoReparseOnPath(root, "bind_review_sha: container");
  const canonicalRoot = canonicalPath(root);
  if (candidate.split(/[\\/]+/).includes("..")) {
    throw new Error(`bind_review_sha: ${label} must not contain '..' path segments`);
  }
  const lexical = resolve(candidate);
  assertNoReparseOnPath(lexical, `bind_review_sha: ${label}`);
  // Containment is measured between BOTH sides in the one canonical form. The
  // container and the artifact reach this function from different producers, so
  // measuring a canonical path against a merely-resolved one made an in-container
  // artifact read as an escape whenever the two spellings differed.
  const canonical = canonicalPath(lexical);
  const rel = relative(canonicalRoot, canonical);
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw new Error(`bind_review_sha: ${label} must stay within the dispatch container: ${lexical}`);
  }
  // The canonical form is what is returned, matching `admitDockProxyReadyPaths`
  // — the other admission boundary for the same container — so a Dock accounting
  // document never carries two spellings of one container (W-764).
  return resolve(canonicalRoot, rel);
}

/** Resolve the exact producer result that Dock admitted for this proxy unit. */
export function resolveReviewResultPath(container: string, resultPath?: string): string {
  const root = resolve(container);
  return resolveContainerArtifactPath(root, resultPath || join(root, "lane", "result.md"), "result path");
}

export interface ReviewArtifactRef { path: string; label: "result" | "report" }

/** The two canonical producer artifacts every proxy admission binds. One
 * spelling, so an admission check and the binder itself can never disagree
 * about which files are in scope. */
export function reviewArtifactPaths(container: string, resultPath?: string): ReviewArtifactRef[] {
  const root = resolve(container);
  const refs: ReviewArtifactRef[] = [
    { path: resolveReviewResultPath(root, resultPath), label: "result" },
    { path: resolveContainerArtifactPath(root, join(root, "report.md"), "report path"), label: "report" },
  ];
  // W-688 / W-653: on an attended-agent lane the session's `result_file` IS
  // `<container>/report.md`, so the two entries above are ONE file under two
  // labels. Binding it twice made the binder emit two summaries for the same
  // artifact and the final accounting print the same pair twice (#464), which
  // reads as two artifacts agreeing rather than one counted twice. De-duplicate
  // on the RESOLVED path — a summary-string comparison would still admit two
  // spellings of the same file. The `result` label wins: it is the register the
  // Dock actually admitted, and `report` is derived from it.
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = process.platform === "win32" ? ref.path.toLowerCase() : ref.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface DeclaredReviewSha extends ReviewArtifactRef {
  /** The artifact's `review_sha:` value, or null when it declares none. */
  declared: string | null;
  /** True when `declared` is a full 40-hex SHA — a FINAL binding claim rather
   * than the producer's pending marker. */
  final: boolean;
}

/** Inspect already-selected artifact bytes. Proxy admission uses this for the
 * freshly transcribed report face before it writes that derived artifact, so a
 * missing/stale report can never crash or veto the current producer register. */
export function inspectDeclaredReviewShaText(
  source: string,
  artifact: ReviewArtifactRef,
): DeclaredReviewSha {
  const declared = gateFields(parseMachineArtifact(source, artifact.label).data, artifact.label).review_sha ?? null;
  return { ...artifact, declared, final: declared !== null && SHA.test(declared) };
}

/** Read (never write) what each canonical artifact currently claims its review
 * SHA to be. Proxy admission consults this BEFORE any mutation so a producer
 * artifact carrying a foreign final SHA is refused rather than overwritten. */
export function inspectDeclaredReviewShas(container: string, resultPath?: string): DeclaredReviewSha[] {
  return reviewArtifactPaths(container, resultPath).map((artifact) => {
    if (!existsSync(artifact.path)) throw new Error(`bind_review_sha: missing artifact: ${artifact.path}`);
    assertSafeLeaf(artifact.path, "bind_review_sha");
    return inspectDeclaredReviewShaText(readFileSync(artifact.path, "utf8"), artifact);
  });
}

/** The gate binding fields, read from typed front matter.
 *
 * These used to be standalone `review_sha:` / `declared_base_sha:` /
 * `gate_log:` / `dock_gate:` lines inserted "near the top" of the prose, which
 * meant the binder had to guess where the top was, count duplicate matches, and
 * re-scan the whole document for stray SHAs. They are ordinary `[gate]` values
 * now, so binding is a field write. */
function gateFields(data: Record<string, unknown>, label: string): GateFields {
  const gate = data.gate;
  if (gate === undefined) return {};
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    throw new Error(`bind_review_sha: [gate] must be a table in ${label}`);
  }
  const fields = { ...(gate as Record<string, unknown>) } as GateFields;
  for (const key of DRIVER_READ_GATE_FIELDS) {
    const value = fields[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`bind_review_sha: [gate] ${key} must be a TOML string in ${label}`);
    }
  }
  return fields;
}

function bindArtifact(before: string, args: BindReviewShaArgs, label: string): string {
  try {
    return rewriteMachineArtifact(before, label, (data) => {
      const gate = gateFields(data, label);
      const priorReview = gate.review_sha;
      if (priorReview === undefined) {
        throw new Error(`bind_review_sha: [gate] review_sha is absent in ${label}`);
      }
      if (priorReview !== args.review && SHA.test(priorReview)) {
        if (!args.replace) throw new Error("bind_review_sha: changing an existing review_sha requires --replace");
        gate.previous_review_sha = priorReview;
      }
      gate.review_sha = args.review;

      // W-709 (DEC-100 P1): `declared_base_sha` is DRIVER-OWNED. This used to
      // REFUSE any prior value that disagreed, so a producer that wrote the
      // base-track destination instead of the pickup base spent a whole round
      // retyping a value the driver already knew (a downstream project's dispatch #538 r19..r22). The
      // driver resolves it from the dispatch binding (`context.task.base_sha` /
      // `control_binding.json.base_sha`) against the candidate checkout, so it
      // WRITES the field and announces the overwrite (see `driver_overwrote=`
      // in the per-artifact summary) instead of asking for it back.
      gate.declared_base_sha = args.base;

      // W-720: `review_sha` and `gate_log` are one pair of facts about one
      // commit, so they are written TOGETHER on every bind. Writing `gate_log`
      // only when it was `undefined` left round 1's log name in a round 2
      // register whose `review_sha` had moved (#463 r2), and the Dock then
      // sealed a register pointing at the previous round's log. `candidate_stat`
      // is the same shape: it describes `base..review`, so it is stale the
      // moment the review moves.
      if (args.stat) gate.candidate_stat = args.stat;
      if (args.gateLog) {
        gate.gate_review_sha = args.gateReview ?? args.review;
        gate.gate_log = args.gateLog;
      }
      if (args.gateResult === "GREEN") {
        if (!args.gateLog) throw new Error("bind_review_sha: GREEN stamping requires --gate-log");
        gate.dock_gate = `GREEN ${args.gateLog}`;
      }
      data.gate = gate;
    });
  } catch (error) {
    if (error instanceof MachineArtifactError) throw new Error(`bind_review_sha: ${error.message}`);
    throw error;
  }
}

export function bindReviewSha(args: BindReviewShaArgs): string[] {
  if (!args.container || !SHA.test(args.review) || !SHA.test(args.base)) {
    throw new Error("bind_review_sha: --container and full 40-hex --review/--base are required");
  }
  if (args.review === args.base) throw new Error("bind_review_sha: --review and --base are the same commit; nothing to bind");
  if (args.gateReview && !SHA.test(args.gateReview)) {
    throw new Error("bind_review_sha: --gate-review must be a full 40-hex SHA");
  }
  if (args.gateReview && !args.gateLog) {
    throw new Error("bind_review_sha: --gate-review requires --gate-log");
  }
  // W-720 / W-809: the log remains paired with the commit it actually
  // measured. Normally that is `review`; review_prepare supplies the explicit
  // older `gateReview` only after proving identical engine trees for heavy-run
  // reuse. Fresh scans and the handoff still bind `review` exactly.
  const gateReview = args.gateReview ?? args.review;
  if (args.gateLog && basename(args.gateLog) !== reviewGateLogName(gateReview)) {
    throw new Error(
      `bind_review_sha: --gate-log ${args.gateLog} is not the review log for --gate-review ${gateReview}`
      + ` (expected ${reviewGateLogName(gateReview)})`,
    );
  }
  const root = resolve(args.container);
  // W-801 AC-2: binding updates an existing review claim; it never creates one.
  // Preflight every canonical artifact before the first write so a missing field
  // cannot leave a two-artifact lane half rebound.
  const declarations = inspectDeclaredReviewShas(root, args.resultPath);
  for (const artifact of declarations) {
    if (artifact.declared === null) {
      throw new Error(`bind_review_sha: [gate] review_sha is absent in ${artifact.label}`);
    }
    assertSafeLeaf(artifact.path, "bind_review_sha");
  }
  const artifacts = declarations.map((artifact) => artifact.path);
  const prepared = artifacts.map((path) => {
    const label = relative(root, path).replace(/\\/g, "/");
    const before = readFileSync(path, "utf8");
    const after = bindArtifact(before, args, label);

    const priorGate = gateFields(parseMachineArtifact(before, label).data, label);
    const gate = gateFields(parseMachineArtifact(after, label).data, label);
    // W-709: say WHICH driver-owned values a producer-authored artifact carried
    // and lost. Overwriting silently would hide a producer that believes it
    // owns these fields; refusing would cost the round the overwrite exists to
    // save. The announcement is the third option, and it is the whole contract.
    const overwrote = ANNOUNCED_OVERWRITE_FIELDS.filter(
      (field) => priorGate[field] !== undefined && priorGate[field] !== gate[field],
    );
    // W-708 (DEC-100 ruling 2): the binding is the TYPED field pair, nothing
    // else. The retired form also scanned the whole document for stray 40-hex
    // runs and refused any that was not the review, the base, a demoted
    // `previous_review_sha`, or a declared `[[instruction]] consumed` value.
    // That scan never caught a false provenance claim. A register that claims
    // ANOTHER commit is refused on exactly ONE path (W-709): proxy admission,
    // `dispatch_prepare_lane_commit_plan.ts::inspectDeclaredReviewShas`, which
    // runs before every mutation on the route where the COORDINATOR creates the
    // commit. On the producer-commits route the checkout's HEAD is the only
    // authority there is, so a disagreeing claim is overwritten and announced
    // rather than argued with. The postcondition below is not a second check on
    // the claim: it asserts this binder wrote what it was told to write.
    // What the scan did produce was an exclusion list that grew with every
    // legitimate way of quoting a commit (W-618 / F-27 / #394 r6).
    if (gate.review_sha !== args.review || gate.declared_base_sha !== args.base) {
      throw new Error(`bind_review_sha: artifact binding invalid (${path})`);
    }
    if (args.gateLog && gate.gate_review_sha !== gateReview) {
      throw new Error(`bind_review_sha: artifact heavy-gate binding invalid (${path})`);
    }
    return {
      path, before, after,
      summary: renderBindSummary({ label, previous: Boolean(gate.previous_review_sha), overwrote }),
    };
  });
  for (const artifact of prepared) {
    if (artifact.after !== artifact.before) writeGuardedFileSync(artifact.path, artifact.after, "bind_review_sha");
  }
  return prepared.map(({ summary }) => summary);
}

function parseArgs(argv: string[]): BindReviewShaArgs {
  const value = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : "";
  };
  const gateResult = value("gate-result");
  if (gateResult && gateResult !== "GREEN") throw new Error("bind_review_sha: --gate-result accepts GREEN only");
  return {
    container: value("container"), resultPath: value("result") || undefined,
    review: value("review"), base: value("base"),
    gateLog: value("gate-log") || undefined, gateReview: value("gate-review") || undefined,
    gateResult: gateResult as "GREEN" | undefined,
    stat: value("stat") || undefined, replace: argv.includes("--replace"),
  };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (!args.container || !SHA.test(args.review) || !SHA.test(args.base)) {
    console.error("bind_review_sha: --container <dispatch dir> --review <full 40-hex SHA> --base <full 40-hex SHA> [--result <container-local result>] [--gate-log <path> --gate-review <full 40-hex SHA>] [--replace] are required");
    if (args.container) {
      console.error(`NEXT_COMMAND: git -C ${JSON.stringify(join(resolve(args.container), "checkout"))} rev-parse HEAD`);
    }
    return 2;
  }
  try {
    const summaries = bindReviewSha(args);
    for (const summary of summaries) console.log(summary);
    // Count-derived: an attended lane's result and report resolve to ONE file,
    // so "both" was wrong there (W-688).
    console.log(`bind_review_sha: ${summaries.length} artifact(s) carry canonical candidate bindings`);
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(main());
