// W-168: the canonical gate/dispatch seat IDENTITY derivation, shared by
// dispatch_prepare (which emits a dispatch's gate_agents and reproduces it for
// attended seats). ONE formula so a PM's spawned gate seat carries
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
 * dispatch_prepare's gate_agents.report.
 *
 * The role is appended HERE and nowhere else. When a PM passed a slug that
 * already ended in the role (`w1042-audit-effective-observer`), the emitter
 * produced `...-observer-observer.md` while the same prompt's Output section
 * named `...-observer.md`, and the seat had to pick — #427 / #431 / #432 each
 * left two candidate verdict files behind. Refusing the doubled slug makes the
 * two-path prompt structurally impossible instead of a naming discipline the
 * PM has to remember (W-634).
 *
 * A gate slug never needs the role for uniqueness: every identifier derived
 * from (role, slug) already carries the role - this path carries it in the
 * directory AND the suffix, and seatAgentName carries it as a prefix - so a
 * producer and its gate seats cannot collide on an equal slug.
 *
 * Refusing a role-suffixed slug HERE was tried and reverted: a producer whose
 * own branch slug legitimately ends in a role name (`w424-observer`, a task
 * ABOUT the observer) is not a doubled gate slug, and the guard could not tell
 * them apart. The doubling is also not what loses a verdict - writer and reader
 * both derive the path from this one function, so they agree even when the slug
 * is doubled (measured: 425 doubled verdict files, 422 of which exist only at
 * the doubled path and are still found). What actually lost verdicts in W-634 is
 * a PROMPT that names a second, hand-written path beside this one. That check is
 * assertSingleVerdictPath below: the helper lives here beside the derivation it
 * compares against, and dispatch_prepare calls it at spawn, so the refusal lands
 * on the prompt rather than on the slug. */
export function seatReportPath(role: string, slug: string): string {
  return `runtime/${role}/results/${slug}-${role}.md`;
}

/** Every distinct `runtime/<role>/results/<file>.md` this text names for ONE role,
 * normalised to that suffix so an absolute path and a repo-relative one compare
 * equal. A prompt legitimately names the OTHER gate role's verdict (an Observer
 * reads the Guardian's), so the caller scopes this to the seat's own role. */
export function verdictPathsFor(markdown: string, role: string): string[] {
  const pattern = new RegExp(`runtime[\\\\/]${role}[\\\\/]results[\\\\/][^\\s\`'"()<>]+\\.md`, "g");
  return [...new Set((markdown.match(pattern) ?? []).map((hit) => hit.replace(/\\/g, "/")))];
}

/**
 * A gate seat's prompt must name NO verdict path for that seat other than the one
 * its identity derives.
 *
 * Two different paths in one prompt make the seat pick, and a seat that picks the
 * one the merge gate does not read writes a verdict nothing finds — a merge then
 * proceeds with no gate evidence, or reads a stale round's file. That the choice
 * has so far been made correctly is a property of the seats, not of the mechanism.
 *
 * ZERO paths is accepted, deliberately. The check owns "no CONFLICTING path", not
 * "the path is mentioned": the seat's write target reaches it through the prompt
 * skeleton and `gate_agents.<role>.report` regardless of what the task body says,
 * so refusing a body that simply does not repeat the path would reject prompts
 * that are already unambiguous. Every count above one is refused.
 */
export function assertSingleVerdictPath(markdown: string, role: string, reportPath: string, sourceLabel: string): void {
  const declared = reportPath.replace(/\\/g, "/");
  const found = verdictPathsFor(markdown, role);
  const stray = found.filter((path) => !path.endsWith(declared));
  if (stray.length === 0) return;
  throw new Error(
    `gate prompt refused (${sourceLabel}): a ${role} seat's prompt names ${found.length} different ${role} verdict path(s) — ` +
    `${stray.join(", ")} beside the declared ${declared}. The seat must not have to choose which one the merge gate reads. ` +
    `Name only the declared path (it is derived from the seat's role + slug), and pass the branch slug as --slug so the ` +
    `derived path does not gain a second role suffix.`,
  );
}
