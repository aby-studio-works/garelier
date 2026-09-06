#!/usr/bin/env bun
/** Bind a committed review candidate to both producer artifacts. */
import { existsSync, readFileSync } from "node:fs";
import { assertSafeLeaf, canonicalPath, writeGuardedFileSync } from "../guard/path_guard.ts";
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
const DRIVER_OWNED_GATE_FIELDS = ["review_sha", "declared_base_sha", "gate_log", "candidate_stat"] as const;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveContainerArtifactPath(container: string, candidate: string, label: string): string {
  const root = resolve(container);
  const canonicalRoot = canonicalPath(root);
  if (!samePath(root, canonicalRoot)) {
    throw new Error("bind_review_sha: container must not traverse a symlink or reparse point");
  }
  if (candidate.split(/[\\/]+/).includes("..")) {
    throw new Error(`bind_review_sha: ${label} must not contain '..' path segments`);
  }
  const lexical = resolve(candidate);
  const rel = relative(root, lexical);
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
    throw new Error(`bind_review_sha: ${label} must stay within the dispatch container: ${lexical}`);
  }
  const canonical = canonicalPath(lexical);
  const expected = resolve(canonicalRoot, rel);
  if (!samePath(canonical, expected)) {
    throw new Error(`bind_review_sha: ${label} must not traverse a symlink or reparse point: ${lexical}`);
  }
  return expected;
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
  return [
    { path: resolveReviewResultPath(root, resultPath), label: "result" },
    { path: resolveContainerArtifactPath(root, join(root, "report.md"), "report path"), label: "report" },
  ];
}

export interface DeclaredReviewSha extends ReviewArtifactRef {
  /** The artifact's `review_sha:` value, or null when it declares none. */
  declared: string | null;
  /** True when `declared` is a full 40-hex SHA — a FINAL binding claim rather
   * than the producer's pending marker. */
  final: boolean;
}

/** Read (never write) what each canonical artifact currently claims its review
 * SHA to be. Proxy admission consults this BEFORE any mutation so a producer
 * artifact carrying a foreign final SHA is refused rather than overwritten. */
export function inspectDeclaredReviewShas(container: string, resultPath?: string): DeclaredReviewSha[] {
  return reviewArtifactPaths(container, resultPath).map((artifact) => {
    if (!existsSync(artifact.path)) throw new Error(`bind_review_sha: missing artifact: ${artifact.path}`);
    assertSafeLeaf(artifact.path, "bind_review_sha");
    const label = relative(resolve(container), artifact.path).replace(/\\/g, "/");
    const declared = gateFields(parseMachineArtifact(readFileSync(artifact.path, "utf8"), label).data, label).review_sha ?? null;
    return { ...artifact, declared, final: declared !== null && SHA.test(declared) };
  });
}

/** The gate binding fields, read from typed front matter.
 *
 * These used to be standalone `review_sha:` / `declared_base_sha:` /
 * `gate_log:` / `dock_gate:` lines inserted "near the top" of the prose, which
 * meant the binder had to guess where the top was, count duplicate matches, and
 * re-scan the whole document for stray SHAs. They are ordinary `[gate]` values
 * now, so binding is a field write. */
function gateFields(data: Record<string, unknown>, label: string): Record<string, string> {
  const gate = data.gate;
  if (gate === undefined) return {};
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    throw new Error(`bind_review_sha: [gate] must be a table in ${label}`);
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(gate as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`bind_review_sha: [gate] ${key} must be a TOML string in ${label}`);
    fields[key] = value;
  }
  return fields;
}

function bindArtifact(before: string, args: BindReviewShaArgs, label: string): string {
  try {
    return rewriteMachineArtifact(before, label, (data) => {
      const gate = gateFields(data, label);
      const priorReview = gate.review_sha ?? null;
      if (priorReview !== null && priorReview !== args.review && SHA.test(priorReview)) {
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
      if (args.gateLog) gate.gate_log = args.gateLog;
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
  // W-720: the pair is checked at the ONE place that writes it. A log named for
  // another review can no longer be stamped into an artifact, so `review_sha`
  // and `gate_log` in a bound register always describe the same commit.
  if (args.gateLog && basename(args.gateLog) !== reviewGateLogName(args.review)) {
    throw new Error(
      `bind_review_sha: --gate-log ${args.gateLog} is not the review log for --review ${args.review}`
      + ` (expected ${reviewGateLogName(args.review)})`,
    );
  }
  const root = resolve(args.container);
  const artifacts = reviewArtifactPaths(root, args.resultPath).map((artifact) => artifact.path);
  for (const path of artifacts) {
    if (!existsSync(path)) throw new Error(`bind_review_sha: missing artifact: ${path}`);
    assertSafeLeaf(path, "bind_review_sha");
  }
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
    const overwrote = DRIVER_OWNED_GATE_FIELDS.filter(
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
    return {
      path, before, after,
      summary: `${label}: review_sha=bound declared_base_sha=bound previous=${gate.previous_review_sha ? 1 : 0}`
        + ` driver_overwrote=${overwrote.join(",") || "none"}`,
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
    gateLog: value("gate-log") || undefined, gateResult: gateResult as "GREEN" | undefined,
    stat: value("stat") || undefined, replace: argv.includes("--replace"),
  };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (!args.container || !SHA.test(args.review) || !SHA.test(args.base)) {
    console.error("bind_review_sha: --container <dispatch dir> --review <full 40-hex SHA> --base <full 40-hex SHA> [--result <container-local result>] [--replace] are required");
    if (args.container) {
      console.error(`NEXT_COMMAND: git -C ${JSON.stringify(join(resolve(args.container), "checkout"))} rev-parse HEAD`);
    }
    return 2;
  }
  try {
    for (const summary of bindReviewSha(args)) console.log(summary);
    console.log("bind_review_sha: both artifacts carry canonical candidate bindings");
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(main());
