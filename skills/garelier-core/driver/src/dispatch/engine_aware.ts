// Garelier dispatch (W-087) — engine-aware dispatch schema + heavy scheduler gate
// + close-contract 照合.
//
// The recurring real-harm this addresses (garelier 有効性監査 2026-07-16, 提案 3):
//   1. RESOURCE BLINDNESS — a full-workspace compile ("heavy") dispatch has no
//      machine-wide slot discipline of its own, so two heavy dispatches launched
//      in parallel OOM a RAM-bound box (31.7 GB budget). The compile-side
//      heavy_compile_lock already serializes live compiles; a heavy DISPATCH must
//      route through the SAME machine-wide slot before it is launched.
//   2. FALSE-DONE ON 到達構成 — a workstream row's AC is functional (consumer /
//      parity) and NARROWER than the blueprint's 到達構成 (named crate / artifact /
//      consumer); a row closes ✅ while a named crate extraction is silently unmet
//      (planning_craft §2-10, the W-484 class). Close must re-check that the named
//      constructs actually landed, not only that the functional AC passed.
//   3. VISUAL WITHOUT A VERDICT — a task with a visible runtime effect (a rendered
//      screen, a sound) is closed on prose alone, with no screenshot / user-verdict
//      pointer that a human actually observed the effect.
//
// This module is the PURE core for all three. It holds (a) the closed vocabulary
// for the two new assignment fields + a back-compat normalizer, (b) the pure heavy
// admission gate the scheduler wrapper (scripts/heavy_dispatch_gate.ts) drives on
// top of the shared heavy_compile_lock, and (c) the pure close-contract checker +
// a reachability resolver the CLI (contract_check.ts --close) drives. Nothing here
// spawns, reads argv, or touches the filesystem except through injected seams, so
// every rule is unit-testable without a repo (mirrors evidence.ts, W-088).

// ── Part 1: assignment schema vocabulary ─────────────────────────────────────

// resource_class — the machine-load class of a dispatch. `heavy` = a full
// workspace compile-grade job that must hold a machine-wide slot (only one runs at
// a time on the RAM-bound box). `light` = a scoped build / small job. `data` = a
// data-shuffle / no-compile job. `review` = a read-only gate / inspection.
export type ResourceClass = "heavy" | "light" | "data" | "review";
export const RESOURCE_CLASSES: readonly ResourceClass[] = ["heavy", "light", "data", "review"] as const;

// runtime_effect — the observable runtime effect a dispatch produces, so close can
// demand the matching RUN evidence. `none` = no runtime surface (docs / pure
// refactor). `headless` = an exercised code path with a captured run artifact but
// no human-visible output. `visual` = a rendered screen (needs a screenshot /
// user-verdict pointer — a visual task is never done on prose alone). `aural` = an
// audio effect. `input` = an input/interaction path.
export type RuntimeEffect = "none" | "headless" | "visual" | "aural" | "input";
export const RUNTIME_EFFECTS: readonly RuntimeEffect[] = ["none", "headless", "visual", "aural", "input"] as const;

// Back-compat defaults (W-087): a dispatch that predates the required fields (or
// omits them) normalizes to the least-constraining values — a light job with no
// runtime effect — and carries a warning, never a hard failure. New dispatches are
// expected to declare both explicitly (dispatch_prepare passes them through).
export const DEFAULT_RESOURCE_CLASS: ResourceClass = "light";
export const DEFAULT_RUNTIME_EFFECT: RuntimeEffect = "none";

export interface NormalizedField<T> {
  value: T;
  // true when the caller supplied nothing / an unknown token and the default was
  // substituted — the signal a warning should be emitted (未指定 → default).
  defaulted: boolean;
  // a human warning when defaulted, else null.
  warning: string | null;
}

function normalizeClosed<T extends string>(
  raw: string | null | undefined,
  vocab: readonly T[],
  def: T,
  field: string,
): NormalizedField<T> {
  const v = (raw ?? "").trim();
  if (v.length === 0) {
    return { value: def, defaulted: true, warning: `${field} unspecified — defaulting to "${def}" (declare it explicitly; required on new dispatches, W-087)` };
  }
  if ((vocab as readonly string[]).includes(v)) {
    return { value: v as T, defaulted: false, warning: null };
  }
  return { value: def, defaulted: true, warning: `${field}="${v}" is not one of ${vocab.join("|")} — defaulting to "${def}" (W-087)` };
}

export function normalizeResourceClass(raw: string | null | undefined): NormalizedField<ResourceClass> {
  return normalizeClosed(raw, RESOURCE_CLASSES, DEFAULT_RESOURCE_CLASS, "resource_class");
}

export function normalizeRuntimeEffect(raw: string | null | undefined): NormalizedField<RuntimeEffect> {
  return normalizeClosed(raw, RUNTIME_EFFECTS, DEFAULT_RUNTIME_EFFECT, "runtime_effect");
}

// ── Part 2: heavy scheduler admission (pure) ─────────────────────────────────
// The pure gate the scheduler wrapper applies to a heavy dispatch. It does NOT
// replace heavy_compile_lock — it decides, from the current machine-wide heavy
// holder count, whether THIS heavy dispatch may start now (admitted) or must wait
// (queued). A non-heavy class never touches the lock (not-heavy). With the default
// one slot, a 2nd heavy while one is held is ALWAYS queued — the "heavy 同時起動 0"
// invariant the RAM budget protects.
export type HeavyAdmissionState = "admitted" | "queued" | "not-heavy";

export interface HeavyAdmissionInput {
  resourceClass: ResourceClass;
  // live, non-stale machine-wide heavy holders right now (the lock's slot count).
  activeHeavyHolders: number;
  // machine-wide heavy slot ceiling; 1 on the RAM-bound box (never below 1 here).
  maxHeavySlots?: number;
}

export interface HeavyAdmission {
  state: HeavyAdmissionState;
  reason: string;
}

export function heavyAdmission(inp: HeavyAdmissionInput): HeavyAdmission {
  if (inp.resourceClass !== "heavy") {
    return { state: "not-heavy", reason: `resource_class="${inp.resourceClass}" is not heavy — no machine-wide slot required` };
  }
  const max = Math.max(1, inp.maxHeavySlots ?? 1);
  if (inp.activeHeavyHolders < max) {
    return { state: "admitted", reason: `heavy slot available (${inp.activeHeavyHolders}/${max} held)` };
  }
  return { state: "queued", reason: `all ${max} machine-wide heavy slot(s) held — queue this heavy dispatch (do NOT start a 2nd concurrent heavy, RAM budget)` };
}

// Classify the outcome of a heavy_compile_lock `--mode acquire` spawn FOR A
// DISPATCH (not a live compile). heavy_compile_lock fail-opens to "OPEN" on
// timeout so a real compile is never deadlocked; a DISPATCH, by contrast, must be
// DEFERRED rather than launched when the machine is busy — so an OPEN that came
// from a busy/held lock (a timeout fail-open) is reinterpreted as `queued`, while
// an OPEN from a disabled/free lock is a genuine `admitted` (nothing to serialize).
// `token` is heavy_compile_lock's stdout; `timedOut` is whether its stderr carried
// the "acquire timed out" fail-open banner (the busy signal).
export function classifyHeavyAcquire(token: string, timedOut: boolean): HeavyAdmission {
  const t = token.trim();
  if (t !== "OPEN" && t.length > 0) {
    return { state: "admitted", reason: `acquired heavy slot ${t}` };
  }
  // token === "OPEN" (or empty): disabled/free => admit; timed-out-busy => queue.
  if (timedOut) {
    return { state: "queued", reason: "heavy_compile_lock is held (acquire timed out, fail-open) — defer this heavy dispatch rather than run a 2nd concurrent heavy" };
  }
  return { state: "admitted", reason: "heavy serialization disabled or lock free (OPEN) — nothing to serialize" };
}

// ── Part 3: close-contract 照合 (pure) ───────────────────────────────────────
// The mechanization of planning_craft §2-10: close = the row's functional AC AND
// the blueprint's 到達構成 (named crate/artifact/consumer) AND the RUN evidence the
// runtime_effect demands. This checker takes RESOLVED inputs (presence booleans /
// pointers a caller derived from the checkout) so it stays pure; the CLI does the
// fs/grep resolution via resolveReachability below.

// One named construct the blueprint's 到達構成 requires to have LANDED. `kind`
// discriminates how the caller resolved presence (a crate dir / an artifact file /
// a reachable consumer reference), for the message only — the rule is uniform.
export interface ReachabilityItem {
  kind: "crate" | "artifact" | "consumer";
  name: string;
  present: boolean;
}

export interface CloseContractInput {
  runtimeEffect: RuntimeEffect;
  // blueprint 到達構成 items with their resolved presence (empty when the blueprint
  // declared no named construct — then this dimension is vacuously satisfied).
  reachability: ReachabilityItem[];
  // whether a RUN artifact (a captured run log / exercise trace) is present. null
  // when the caller supplied none — treated as "not present" only when required.
  runArtifactPresent: boolean | null;
  // a screenshot path / user-verdict pointer for a visual task; null when absent.
  visualVerdictPointer: string | null;
}

// A stable rule code per close-contract rule (caller/test keys off the code).
export type CloseRuleCode =
  | "unreachable-construct" // §2-10 / W-484: a named 到達構成 crate/artifact/consumer did not land
  | "run-artifact-missing"  // runtime_effect demands a RUN artifact but none is present
  | "visual-no-verdict";    // runtime_effect=visual with no screenshot/user-verdict pointer

export interface CloseViolation {
  rule: CloseRuleCode;
  subject: string; // the construct name / the effect — what the rule fired on
  detail: string;
}

export interface CloseContractResult {
  ok: boolean;
  violations: CloseViolation[];
}

// A runtime effect that is not `none` produced SOMETHING at run time, so close
// demands a captured RUN artifact proving it was exercised (not merely compiled).
export function runtimeEffectDemandsRunArtifact(rt: RuntimeEffect): boolean {
  return rt !== "none";
}

export function checkCloseContract(inp: CloseContractInput): CloseContractResult {
  const violations: CloseViolation[] = [];

  // (a) 到達構成: every named construct the blueprint required must have landed.
  // This is the W-484 close-refusal: a row whose functional AC is green but whose
  // named crate/artifact/consumer is absent does NOT close.
  for (const item of inp.reachability) {
    if (!item.present) {
      violations.push({
        rule: "unreachable-construct",
        subject: item.name,
        detail: `blueprint 到達構成 ${item.kind} "${item.name}" did not land (functional AC may be green, but the named construct is absent — do not close, W-484/planning_craft §2-10)`,
      });
    }
  }

  // (b) RUN artifact: a runtime effect that ran must leave a captured artifact.
  if (runtimeEffectDemandsRunArtifact(inp.runtimeEffect) && inp.runArtifactPresent !== true) {
    violations.push({
      rule: "run-artifact-missing",
      subject: inp.runtimeEffect,
      detail: `runtime_effect="${inp.runtimeEffect}" demands a captured RUN artifact (exercised run, not just a compile) — none present`,
    });
  }

  // (c) Visual verdict: a visual task needs a human-observable pointer.
  if (inp.runtimeEffect === "visual" && !(inp.visualVerdictPointer && inp.visualVerdictPointer.trim().length > 0)) {
    violations.push({
      rule: "visual-no-verdict",
      subject: "visual",
      detail: "runtime_effect=visual but no screenshot / user-verdict pointer — a visual task cannot close on prose alone (W-087)",
    });
  }

  return { ok: violations.length === 0, violations };
}

// ── reachability resolution seam ─────────────────────────────────────────────
// The CLI resolves each declared construct's presence against the dispatch
// checkout: a `crate`/`artifact` is a path presence (a crate dir with a build
// manifest, or an artifact file); a `consumer` is a reachable reference found by a
// content search. Both probes are injected so the resolver is pure and testable
// without a repo (mirrors contract_check.ts's GitRunner seam).
export interface ReachabilityQuery {
  // does the named path exist under the checkout (dir or file)?
  exists: (name: string) => boolean;
  // is there at least one reachable reference to the named symbol/id?
  grep: (name: string) => boolean;
}

export interface ReachabilityDecl {
  kind: "crate" | "artifact" | "consumer";
  name: string;
}

export function resolveReachability(decls: ReachabilityDecl[], q: ReachabilityQuery): ReachabilityItem[] {
  return decls.map((d) => ({
    kind: d.kind,
    name: d.name,
    present: d.kind === "consumer" ? q.grep(d.name) : q.exists(d.name),
  }));
}
