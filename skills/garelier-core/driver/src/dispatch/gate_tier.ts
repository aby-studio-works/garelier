// Garelier dispatch (W-192 a) — risk-tier → gate-seat matrix (pure).
//
// DEC-093 established that a light control/docs change does not need the same gate
// as a security-sensitive code change, and the practice grew up by hand: a PM
// decided "docs-only → I'll just diff-review it", "code → Guardian + Observer",
// "security → both at the strongest model". This module MECHANIZES that decision so
// dispatch_prepare emits the required gate seats for a dispatch's risk tier instead
// of the PM re-deriving it (and occasionally over- or under-gating) each time.
//
// It is the coarse tier layer that sits ABOVE gate_field_manual §C's fine-grained
// PM review-pattern table: this decides HOW MANY / WHICH seats and at what model
// floor; §C decides WHICH viewpoints to request once a gate is being written.
//
// Pure + fail-safe toward MORE gating: an unknown / empty scope classifies as
// `code` (two-seat gate), never as docs-only — a misclassification must not drop a
// gate. Nothing here spawns or touches the filesystem (mirrors engine_aware.ts).

export type GateRole = "guardian" | "observer";
export type GateTier = "docs-only" | "test-only" | "code" | "security";

// Risk tags that force the SECURITY tier (two-seat gate at the opus floor). Only
// `security` here — the other model_routing RISK_TAGS (schema/determinism/save/
// cooker) raise the role/gate MODEL a tier but do not change WHICH seats gate,
// so they stay `code` (still Guardian + Observer). Keeping the sets distinct avoids
// conflating "harder review" with "more reviewers".
export const SECURITY_RISK_TAGS = new Set(["security"]);

// A touch under one of these path fragments carries a security surface even without
// a declared tag (guard / auth / crypto / secret / the security docs). Matched
// case-insensitively against the posix-normalized touch.
const SECURITY_PATH_HINTS = ["guard/", "/guard", "auth", "crypto", "secret", "credential", "security"];

function posix(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** A doc-ish touch: markdown / docs & references trees / plain text / licenses. */
export function isDocPath(p: string): boolean {
  const s = posix(p);
  return /\.(md|mdx|txt|rst|adoc)$/.test(s) || /(^|\/)(docs|references|doc)\//.test(s);
}

/** A test-only touch: a test file or a tests/ tree (any common convention). */
export function isTestPath(p: string): boolean {
  const s = posix(p);
  return /(^|\/)(tests?|__tests__|spec)\//.test(s) || /\.(test|spec)\.[a-z0-9]+$/.test(s) || /_tests?\.[a-z0-9]+$/.test(s);
}

function hasSecuritySignal(touches: string[], tags: string[]): boolean {
  if (tags.some((t) => SECURITY_RISK_TAGS.has(t.trim().toLowerCase()))) return true;
  return touches.some((t) => {
    const s = posix(t);
    return SECURITY_PATH_HINTS.some((h) => s.includes(h));
  });
}

/** Classify a dispatch into a gate tier from its declared touches + tags.
 * Precedence (fail-safe toward more gating):
 *   security  — any security tag / security-surface touch (even amid docs).
 *   docs-only — NON-EMPTY touches, every one a doc path.
 *   test-only — NON-EMPTY touches, every one a test path.
 *   code      — everything else, INCLUDING an empty/unknown touch set (unknown
 *               scope must get the full gate, never be mistaken for docs-only).
 */
export function classifyGateTier(touches: string[], tags: string[] = []): GateTier {
  const clean = touches.map((t) => t.trim()).filter(Boolean);
  if (hasSecuritySignal(clean, tags)) return "security";
  if (clean.length === 0) return "code"; // unknown scope → full gate
  if (clean.every(isDocPath)) return "docs-only";
  if (clean.every(isTestPath)) return "test-only";
  return "code";
}

export interface GatePlan {
  tier: GateTier;
  /** The gate seats to actually spawn for this tier (authoritative). */
  seats: GateRole[];
  /** docs-only: the PM diff-reviews it directly, no gate seat is spawned. */
  pm_review_only: boolean;
  /** Floor the gate seats' model at this tier or higher (security → opus). null = no floor. */
  gate_model_floor: "opus" | null;
  /** Which project mandatory-gate policies forced a seat in beyond the tier (W-192);
   * empty when the tier plan already satisfied every floor. */
  policy_floor_applied: string[];
  rationale: string;
}

const GUARDIAN_OBSERVER: GateRole[] = ["guardian", "observer"];

/** The seat matrix for a tier. Authoritative "which seats" — dispatch_prepare emits
 * it as `gate_plan` so the PM spawns exactly these, not a hand-guessed count. */
export function gatePlanForTier(tier: GateTier): GatePlan {
  switch (tier) {
    case "docs-only":
      return { tier, seats: [], pm_review_only: true, gate_model_floor: null, policy_floor_applied: [],
        rationale: "docs-only change — PM diff-review only; no code/security surface for a gate seat to find (DEC-093). A doc that carries a rule/spec change others execute is `code`, not docs-only." };
    case "test-only":
      return { tier, seats: ["observer"], pm_review_only: false, gate_model_floor: null, policy_floor_applied: [],
        rationale: "test-only change — one independent seat (Observer) for the dominant risk (test tautology / discriminating power, §C-2). A fixture carrying real data / secrets is a security surface — declare it `security` (or --full-gate) to add Guardian." };
    case "security":
      return { tier, seats: GUARDIAN_OBSERVER, pm_review_only: false, gate_model_floor: "opus", policy_floor_applied: [],
        rationale: "security-sensitive change — Guardian + Observer at the opus floor; Guardian is primary (bypass / adversarial), Observer complements on quality without duplicating the security axis (§C-8)." };
    case "code":
    default:
      return { tier: "code", seats: GUARDIAN_OBSERVER, pm_review_only: false, gate_model_floor: null, policy_floor_applied: [],
        rationale: "code change (or unknown scope) — the full two-seat gate: Guardian (security/license/provenance) then Observer (correctness/quality), independence preserved (DEC-090)." };
  }
}

// ---- W-192: project mandatory-gate policy FLOOR ------------------------------
//
// A tier plan is a PROPOSAL. A project may mandate a seat on EVERY merge via
// [guardian_policy]/[observer_policy] enabled + require_for_all_merges — the merge
// gate (guardian_policy_check.ts / observer_policy_check.ts) then REFUSES any merge
// lacking that verdict, docs and assets included. So a docs-only tier plan that
// spawned 0 seats would be refused downstream. applyPolicyFloor unions the mandated
// seats into the plan UP FRONT, so the PM spawns the right seats instead of learning
// at the merge gate. It only ever ADDS seats (a floor cannot lower a tier's gate).

export interface GatePolicyFloor {
  // guardian_policy.enabled && guardian_policy.require_for_all_merges (the EXACT
  // condition guardian_policy_check.policyReason enforces).
  requireGuardianForAllMerges: boolean;
  // observer_policy.enabled && observer_policy.require_for_all_merges.
  requireObserverForAllMerges: boolean;
}

export function applyPolicyFloor(plan: GatePlan, floor: GatePolicyFloor): GatePlan {
  const seats = new Set<GateRole>(plan.seats);
  const applied: string[] = [];
  if (floor.requireGuardianForAllMerges && !seats.has("guardian")) { seats.add("guardian"); applied.push("guardian_policy.require_for_all_merges"); }
  if (floor.requireObserverForAllMerges && !seats.has("observer")) { seats.add("observer"); applied.push("observer_policy.require_for_all_merges"); }
  if (applied.length === 0) return plan; // tier already met every floor
  const ordered = (["guardian", "observer"] as GateRole[]).filter((r) => seats.has(r));
  return {
    ...plan,
    seats: ordered,
    pm_review_only: false, // a mandated seat means this is no longer a PM-only diff review
    policy_floor_applied: [...plan.policy_floor_applied, ...applied],
    rationale: `${plan.rationale} — plus a project policy floor forced [${applied.join(", ")}]: a tier proposal cannot undercut a mandatory-gate policy, and the merge gate would refuse a merge missing it (W-192).`,
  };
}

/** Convenience: classify + plan (+ optional policy floor) in one call. */
export function gatePlanFor(touches: string[], tags: string[] = [], floor?: GatePolicyFloor): GatePlan {
  const plan = gatePlanForTier(classifyGateTier(touches, tags));
  return floor ? applyPolicyFloor(plan, floor) : plan;
}
