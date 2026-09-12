// Canonical attended-dispatch lane state.
//
// STATE.md is dispatch-setup intent and can remain WORKING after the provider
// has emitted its terminal register. The provider session record says whether
// a result is live or stale, while that result's standalone STATE line says
// what the provider actually returned. Keep the precedence pure here so every
// read surface applies the same rule with its own filesystem safety policy.

import { isAbsolute, relative, resolve } from "node:path";
import { canonicalPath, reparseEntryOnPath } from "../guard/path_guard.ts";
import {
  MachineArtifactError,
  optionalMachineString,
  renderMachineArtifact,
  tryParseMachineArtifact,
  type MachineArtifactFault,
} from "./machine_artifact.ts";

export interface DispatchSessionSignal {
  status: string | null;
  resultFile: string | null;
  updatedAt: string | null;
}

export interface DispatchLaneState {
  state: string | null;
  source: "session" | "result" | "legacy_state" | "unknown";
  sessionStatus: string | null;
  resultState: string | null;
}

const LIVE_SESSION = new Set(["running", "resuming"]);

export const DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT =
  "The final response MUST OPEN with `+++` TOML front matter carrying `[lane]` `state = 'REPORTING'` or `state = 'BLOCKED'` (optionally `detail = '''...'''`), then a `+++` line, then your register prose. Every value sits under a `[section]` table - never a top-level bare key. A bare `STATE=` line, a heading above the front matter, a lower-case state, and an unknown state do not satisfy this contract.";

/** The exact block a role copies to open its result. Emitted into prompts so
 * the shape is stated once and never drifts between prompt and parser. */
export const DISPATCH_RESULT_STATE_TEMPLATE = [
  "+++",
  "[lane]",
  "state = 'REPORTING'",
  "detail = '''<one-line delta>'''",
  "+++",
].join("\n");

const DISPATCH_STATES = new Set(["REPORTING", "BLOCKED"]);

export function parseDispatchSession(source: string | null): DispatchSessionSignal {
  if (!source) return { status: null, resultFile: null, updatedAt: null };
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    const timestamps = value.timestamps && typeof value.timestamps === "object" && !Array.isArray(value.timestamps)
      ? value.timestamps as Record<string, unknown>
      : null;
    return {
      status: typeof value.status === "string" ? value.status.toLowerCase() : null,
      resultFile: typeof value.result_file === "string" ? value.result_file : null,
      updatedAt: typeof timestamps?.updated_at === "string" ? timestamps.updated_at : null,
    };
  } catch {
    return { status: null, resultFile: null, updatedAt: null };
  }
}

/** The lane's canonical state, read as a typed TOML value.
 *
 * The retired form matched `^STATE=...` on the literal FIRST line, so a lane
 * that had reached REPORTING still read as stateless the moment its register
 * opened with a heading - which is how #429 blocked every merge and every new
 * dispatch while all of its gates were green. State now lives in front matter,
 * where prose above it is impossible and prose below it is irrelevant.
 *
 * A decode failure returns null exactly like an absent state: this is a status
 * read, and callers that must distinguish the two use dispatchResultStateFault. */
export function parseDispatchResultState(source: string | null): string | null {
  const parsed = tryParseMachineArtifact(source?.slice(0, 64 * 1024) ?? null, "lane result");
  if (!parsed.ok) return null;
  const state = optionalMachineString(parsed.artifact, "lane", "state", "lane result");
  return state !== null && DISPATCH_STATES.has(state) ? state : null;
}

/** Why the lane has no canonical state, for surfaces that must tell a role
 * whether its result was unreadable or simply never written. */
export function dispatchResultStateFault(source: string | null): { fault: MachineArtifactFault; message: string } | null {
  const parsed = tryParseMachineArtifact(source?.slice(0, 64 * 1024) ?? null, "lane result");
  if (!parsed.ok) return { fault: parsed.fault, message: parsed.message };
  const state = optionalMachineString(parsed.artifact, "lane", "state", "lane result");
  if (state === null) return { fault: "absent", message: "lane result front matter has no [lane] state" };
  if (!DISPATCH_STATES.has(state)) {
    return { fault: "invalid", message: `lane result [lane] state is ${JSON.stringify(state)}, expected REPORTING or BLOCKED` };
  }
  return null;
}

/** One named format fault in a producer register (W-688).
 *
 * Each name is a distinct repair, which is the whole point: `retry_explicit_resume`
 * hands these back to the producer, and "your register is malformed" costs a
 * round of guessing while "commit_plan_end_not_final_line" does not. */
export type LaneRegisterFault =
  | "register_front_matter_missing"
  | "register_lane_state_missing"
  | "register_lane_state_invalid"
  | "commit_plan_block_missing"
  | "commit_plan_block_unterminated"
  | "commit_plan_end_not_final_line";

export interface LaneRegisterFinding {
  fault: LaneRegisterFault;
  message: string;
}

const COMMIT_PLAN_OPEN = "=== COMMIT PLAN ===";
const COMMIT_PLAN_CLOSE = "=== END COMMIT PLAN ===";

/**
 * The register contract, checked where the register is CAPTURED (W-688).
 *
 * Every clause below is already stated in the role prompt as a MUST. Nothing
 * read it: a register with no front matter and no COMMIT PLAN block was written
 * to disk and reported `{"ok":true,"status":"ready"}`, and the defect surfaced
 * one seat later — `dock_proxy` could not read a plan to commit, the gate seat
 * could not read a state to consume, and the PM found it by opening the file
 * (#394 r37, a downstream project's dispatch #538 r18).
 *
 * `requireCommitPlan` is the PROXY-mode question: a lane whose producer commits
 * for itself has no plan to hand over, so demanding one there would refuse a
 * correct register.
 *
 * Returns every fault it finds, not the first — a producer fixing one clause
 * and tripping the next spends the same round twice.
 */
export function inspectLaneRegisterFormat(
  source: string | null,
  options: { requireCommitPlan: boolean },
): LaneRegisterFinding[] {
  const findings: LaneRegisterFinding[] = [];
  const text = source ?? "";
  const parsed = tryParseMachineArtifact(text.slice(0, 64 * 1024), "lane result");
  if (!parsed.ok) {
    findings.push({ fault: "register_front_matter_missing", message: parsed.message });
  } else {
    let state: string | null;
    try { state = optionalMachineString(parsed.artifact, "lane", "state", "lane result"); }
    catch (error) {
      if (!(error instanceof MachineArtifactError)) throw error;
      findings.push({ fault: "register_lane_state_invalid", message: error.message });
      state = null;
    }
    if (state === null && findings.length === 0) {
      findings.push({
        fault: "register_lane_state_missing",
        message: `register front matter has no [lane] state. ${DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT}`,
      });
    } else if (state !== null && !DISPATCH_STATES.has(state)) {
      findings.push({
        fault: "register_lane_state_invalid",
        message: `register [lane] state is ${JSON.stringify(state)}, expected REPORTING or BLOCKED`,
      });
    }
  }
  if (options.requireCommitPlan) {
    const lines = text.split(/\r?\n/);
    const opens = lines.filter((line) => line.trim() === COMMIT_PLAN_OPEN).length;
    const closeIndex = lines.map((line) => line.trim()).lastIndexOf(COMMIT_PLAN_CLOSE);
    if (opens === 0) {
      findings.push({
        fault: "commit_plan_block_missing",
        message: `register carries no \`${COMMIT_PLAN_OPEN}\` block; a PROXY-mode lane hands its commit over as that block, and prose describing one is not one`,
      });
    } else if (closeIndex < 0) {
      findings.push({
        fault: "commit_plan_block_unterminated",
        message: `register opens ${opens} \`${COMMIT_PLAN_OPEN}\` block(s) and closes none with \`${COMMIT_PLAN_CLOSE}\``,
      });
    } else {
      const lastNonEmpty = lines.map((line) => line.trim()).reduce(
        (last, line, index) => (line ? index : last),
        -1,
      );
      if (closeIndex !== lastNonEmpty) {
        findings.push({
          fault: "commit_plan_end_not_final_line",
          message: `\`${COMMIT_PLAN_CLOSE}\` must be the register's final non-empty line (it is line ${closeIndex + 1} of ${lastNonEmpty + 1})`,
        });
      }
    }
  }
  return findings;
}

/** The review SHA a lane register binds itself to, when it declares one. */
export function laneResultReviewSha(source: string | null): string | null {
  const parsed = tryParseMachineArtifact(source, "lane result");
  if (!parsed.ok) return null;
  const sha = optionalMachineString(parsed.artifact, "lane", "review_sha", "lane result");
  return sha !== null && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Render the canonical lane result: front matter first, register prose below. */
export function renderDispatchResult(state: string, detail: string, body: string): string {
  if (!DISPATCH_STATES.has(state)) throw new Error(`lane result state must be REPORTING or BLOCKED, got ${state}`);
  const fields: Array<readonly [string, string]> = [["state", state]];
  if (detail.trim()) fields.push(["detail", detail.trim()]);
  return renderMachineArtifact([{ name: "lane", fields }], body);
}

export function parseLegacyDispatchState(source: string | null): string | null {
  if (!source) return null;
  const lines = source.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s*Status\b/i.test(line));
  if (heading < 0) return null;
  for (let index = heading + 1; index < lines.length; index++) {
    const state = lines[index]!.trim();
    if (state) return state.toUpperCase();
  }
  return null;
}

export function resolveDispatchLaneState(inputs: {
  sessionSource: string | null;
  resultSource: string | null;
  legacyStateSource?: string | null;
}): DispatchLaneState {
  const session = parseDispatchSession(inputs.sessionSource);
  const resultState = parseDispatchResultState(inputs.resultSource);
  if (session.status && LIVE_SESSION.has(session.status)) {
    return { state: "WORKING", source: "session", sessionStatus: session.status, resultState };
  }
  if (resultState) {
    return { state: resultState, source: "result", sessionStatus: session.status, resultState };
  }
  // Legacy containers without a provider session/result retain their original
  // STATE.md semantics. Once either canonical lane signal exists, stale
  // STATE.md must never override an incomplete/corrupt provider result.
  if (!inputs.sessionSource && !inputs.resultSource) {
    const legacy = parseLegacyDispatchState(inputs.legacyStateSource ?? null);
    if (legacy) return { state: legacy, source: "legacy_state", sessionStatus: null, resultState: null };
  }
  return { state: null, source: "unknown", sessionStatus: session.status, resultState };
}

/** Admit a provider-declared result only after resolving every existing path
 * component. A rejected declaration returns null so callers cannot accidentally
 * read the lexical fallback through a symlink/junction. */
export function dispatchSessionResultPath(laneRoot: string, sessionSource: string | null): string | null {
  const declared = parseDispatchSession(sessionSource).resultFile;
  const lane = resolve(laneRoot);
  // The lane directory itself is framework-owned. Refuse an ALIASED lane rather
  // than treating its external target as the trusted root — proven by lstat on
  // every entry (W-764). The lexical-vs-canonical string comparison that used to
  // stand here also rejected a Windows 8.3 spelling of the lane, which is the
  // same directory, and every lane under a short-name `%TEMP%` then read as
  // having no provider result at all.
  if (reparseEntryOnPath(lane)) return null;
  const canonicalLane = canonicalPath(lane);
  const raw = declared ?? resolve(lane, "result.md");
  if ((declared && !isAbsolute(declared)) || raw.split(/[\\/]+/).includes("..")) return null;
  const candidate = canonicalPath(raw);
  const rel = relative(canonicalLane, candidate);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? candidate : null;
}

/** One chokepoint for provider-result reads: admission always completes before
 * the caller's reader callback can touch the filesystem. */
export function readDispatchSessionResult<T>(
  laneRoot: string,
  sessionSource: string | null,
  read: (path: string) => T,
): { path: string | null; source: T | null } {
  const path = dispatchSessionResultPath(laneRoot, sessionSource);
  return { path, source: path ? read(path) : null };
}
