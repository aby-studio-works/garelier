// Single source of truth for the per-role conventions the Status Web reads out
// of a project's __garelier tree. The status snapshot used to hardcode these
// inline, so its assumptions silently drifted from what a role actually does:
//
//   • it checked report.md for EVERY REPORTING role, but Guardian writes
//     guardian_report.md and Concierge writes concierge_report.md — so a healthy
//     gate role was flagged "REPORTING without report.md" forever;
//   • it matched the substring "rate_limited", so a rate_limited_CLEARED recovery
//     event read as an ACTIVE limit.
//
// role_contracts.test.ts CI-enforces every entry here against the canonical role
// skills (the same pattern as DEC-048's git_command_policy SoT checked against
// the driver grant). The status layer therefore can never again diverge from a
// role's real contract — or silently fail to handle a newly-added role — without
// a failing test, instead of the divergence surfacing as a bogus warning a human
// has to notice.

export type RoleKind =
  | "pm" | "dock" | "artisan" | "worker" | "scout"
  | "smith" | "librarian" | "observer" | "guardian" | "concierge";

// Worktree roles the driver instantiates from setup_config arrays and that pass
// through a REPORTING handoff in their container. (pm / dock are
// driver-supervised, not worktree agents; artisan is a single lane handled
// separately — none of the three is subject to the REPORTING-artifact check.)
export const WORKTREE_ROLE_KINDS: readonly RoleKind[] = [
  "worker", "scout", "smith", "librarian", "observer", "guardian", "concierge",
];

// The file a role writes to its CONTAINER ROOT when it enters REPORTING.
// GROUNDED IN THE SKILL'S WRITE INSTRUCTION, *not* the template filename:
// librarian / observer / artisan write report.md though their templates are
// named *_report.md. Only Guardian and Concierge write a role-prefixed name.
export const ROLE_REPORT_ARTIFACT: Record<RoleKind, string> = {
  pm: "report.md",            // declared for completeness; not worktree-checked
  dock: "report.md",     // "
  artisan: "report.md",       // single lane; reports to PM, not gate-checked here
  worker: "report.md",
  scout: "report.md",
  smith: "report.md",
  librarian: "report.md",
  observer: "report.md",
  guardian: "guardian_report.md",
  concierge: "concierge_report.md",
};

/** The REPORTING artifact for a role kind (falls back to the generic report.md
 *  for the non-worktree / supervised kinds). */
export function reportArtifact(kind: string): string {
  return (ROLE_REPORT_ARTIFACT as Record<string, string>)[kind] ?? "report.md";
}

// Skill directory basename per role — the anchor for the CI grounding test.
export const ROLE_SKILL_DIR: Record<RoleKind, string> = {
  pm: "garelier-pm",
  dock: "garelier-dock",
  artisan: "garelier-artisan",
  worker: "garelier-worker",
  scout: "garelier-scout",
  smith: "garelier-smith",
  librarian: "garelier-librarian",
  observer: "garelier-observer",
  guardian: "garelier-guardian",
  concierge: "garelier-concierge",
};

// setup_config.toml array key (TOML `[[<key>]]`) → role kind. Drives the
// config-coverage test: every role the setup wizard can provision must be a role
// the status layer knows how to read.
export const CONFIG_ARRAY_KIND: Record<string, RoleKind> = {
  workers: "worker",
  scouts: "scout",
  smiths: "smith",
  librarians: "librarian",
  observers: "observer",
  guardians: "guardian",
  concierges: "concierge",
};

// Driver log event names for provider throttling, split by meaning. The Status
// Web rate-limit classifier derives its "recovered" matcher from `cleared`, so
// it recognizes exactly the event the driver emits on recovery — and the test
// asserts every rate_limit* event literal the driver actually emits is
// classified here, so a rename on either side fails CI rather than resurrecting
// the "a cleared limit shows as active" bug.
export const RATE_LIMIT_EVENTS = {
  active: ["rate_limited", "rate_limited_recorded", "rate_limit_backoff"],
  cleared: ["rate_limited_cleared"],
} as const;
