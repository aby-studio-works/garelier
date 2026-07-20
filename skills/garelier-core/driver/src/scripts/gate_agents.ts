// W-168: the canonical gate/dispatch seat IDENTITY derivation, shared by
// dispatch_prepare (which EMITS a dispatch's gate_agents) and attended_spawn
// (which REPRODUCES it verbatim). ONE formula so a PM's spawned gate seat carries
// the SAME name / report path / verdict template dispatch_prepare declared — hand-
// made seat names (user 指摘 2026-07-19: "サブの名称が ga-role でなくなっている") become
// structurally impossible, not a discipline the PM must remember.

export const GATE_VERDICT_TEMPLATE = "skills/garelier-core/templates/gate_verdict.md";

/** Agent-name sanitizer shared with dispatch_prepare: keep [A-Za-z0-9_-], force an
 * alnum first char, cap at 64. */
export function sanitizeAgentName(value: string): string {
  let result = value.replace(/[^A-Za-z0-9_-]/g, "-");
  if (!/^[A-Za-z0-9]/.test(result)) result = `a${result}`;
  return result.slice(0, 64);
}

/** The canonical `ga-<role>-<slug>` seat name. This IS the naming convention the
 * user requires; anything else is a hand-made name the W-168 detective flags. */
export function seatAgentName(role: string, slug: string): string {
  return sanitizeAgentName(`ga-${role}-${slug}`);
}

/** The seat's report path (relative to the pm control root), matching
 * dispatch_prepare's gate_agents.report. */
export function seatReportPath(role: string, slug: string): string {
  return `runtime/${role}/results/${slug}-${role}.md`;
}
