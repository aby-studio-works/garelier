// Single source of truth for the per-role conventions the Status Web reads out
// of a project's __garelier tree. The status snapshot used to hardcode these
// inline, so its assumptions silently drifted from what a role actually does:
//
//   • it checked report.md for EVERY REPORTING role while Guardian's container
//     leaf was guardian_report.md and Concierge's was concierge_report.md — so a
//     healthy gate role was flagged "REPORTING without report.md" forever;
//   • it matched the substring "rate_limited", so a rate_limited_CLEARED recovery
//     event read as an ACTIVE limit.
//
// role_contracts.test.ts CI-enforces every entry here against the canonical role
// skills (the same pattern as DEC-048's git_command_policy SoT checked against
// the driver grant). The status layer therefore can never again diverge from a
// role's real contract — or silently fail to handle a newly-added role — without
// a failing test, instead of the divergence surfacing as a bogus warning a human
// has to notice.

/**
 * Canonical denominator for every Garelier role.
 *
 * `wanderer` belongs here because it is a real framework role, but it is marked
 * external-advisory: unlike the ten managed roles it has no driver-owned
 * container, REPORTING artifact, or concurrency slot. Keeping that distinction
 * in the value (rather than omitting Wanderer from the role list) lets
 * cross-role audits derive a genuine 11-role denominator.
 */
export const FRAMEWORK_ROLE_CONTRACTS = {
  pm: { execution: "managed", scheduling: "foreground" },
  dock: { execution: "managed", scheduling: "foreground" },
  artisan: { execution: "managed", scheduling: "detached" },
  worker: { execution: "managed", scheduling: "detached" },
  scout: { execution: "managed", scheduling: "detached" },
  smith: { execution: "managed", scheduling: "detached" },
  librarian: { execution: "managed", scheduling: "detached" },
  observer: { execution: "managed", scheduling: "detached" },
  guardian: { execution: "managed", scheduling: "detached" },
  concierge: { execution: "managed", scheduling: "detached" },
  wanderer: { execution: "external-advisory", scheduling: "external" },
} as const;

export type FrameworkRoleKind = keyof typeof FRAMEWORK_ROLE_CONTRACTS;
export type RoleKind = Exclude<FrameworkRoleKind, "wanderer">;
export const ALL_FRAMEWORK_ROLE_KINDS =
  Object.freeze(Object.keys(FRAMEWORK_ROLE_CONTRACTS)) as readonly FrameworkRoleKind[];
export type DetachedRoleKind = {
  [K in FrameworkRoleKind]:
    (typeof FRAMEWORK_ROLE_CONTRACTS)[K]["scheduling"] extends "detached" ? K : never
}[FrameworkRoleKind];
/** Managed background roles counted by the concurrency scheduler. */
export const DETACHED_ROLE_KINDS = Object.freeze(
  ALL_FRAMEWORK_ROLE_KINDS.filter(
    (role): role is DetachedRoleKind =>
      FRAMEWORK_ROLE_CONTRACTS[role].scheduling === "detached",
  ),
);

// Worktree roles the driver instantiates from setup_config arrays and that pass
// through a REPORTING handoff in their container. (pm / dock are
// driver-supervised, not worktree agents; artisan is a single lane handled
// separately — none of the three is subject to the REPORTING-artifact check.)
export const WORKTREE_ROLE_KINDS: readonly RoleKind[] = [
  "worker", "scout", "smith", "librarian", "observer", "guardian", "concierge",
];

/** The verdict marker `merge_land.ts` composes for a gate seat, as a path
 * TEMPLATE. One spelling, used by both faces below, so the producer row and the
 * authored-artifact row cannot drift apart. */
export const gateVerdictMarker = (kind: string): string =>
  `runtime/${kind}/results/<branch-slug>-${kind}.md`;
export const gateVerdictSummary = (kind: string): string =>
  `runtime/${kind}/results/<branch-slug>-${kind}.json`;

// TWO FACES, ONE REGISTER (W-789), WITH THE GATE SEATS NAMED (W-784).
//
// `capture` is the file that lands in a role's CONTAINER ROOT when it enters
// REPORTING, and it is the DRIVER's: scaffolded by dispatch_prepare, written by
// the launcher's capture of the final response, transcribed by land_pipeline.
// The harness refuses a subagent Write to a `*report.md` name, so a producer
// never authors it; status and merge-gate readers consume the capture only.
//
// `producer` is the leaf the role authors with its own hands. For a dispatched
// LANE seat that is the common `lane/register.md`. For the two GATE seats it is
// NOT: `merge_land.ts` reads a Guardian / Observer verdict from
// `runtime/<role>/results/<branch-slug>-<role>.md` AND NOWHERE ELSE (lines 587
// and 588 compose exactly those two paths), so a gate seat pointed at
// `lane/register.md` would leave the land with no marker to read — the contract
// would be stated and unconsumable at the same time. Its completion register is
// the SendMessage.
export const ROLE_REPORT_ARTIFACT: Record<RoleKind, {
  producer: string;
  capture: string;
  additional_producer_artifacts?: readonly string[];
}> = {
  pm: { producer: "report.md", capture: "report.md" },
  dock: { producer: "report.md", capture: "report.md" },
  artisan: { producer: "lane/register.md", capture: "report.md" },
  worker: { producer: "lane/register.md", capture: "report.md" },
  scout: { producer: "lane/register.md", capture: "report.md" },
  smith: { producer: "lane/register.md", capture: "report.md" },
  librarian: { producer: "lane/register.md", capture: "report.md" },
  observer: { producer: gateVerdictMarker("observer"), capture: "report.md" },
  guardian: {
    producer: gateVerdictMarker("guardian"),
    capture: "report.md",
    additional_producer_artifacts: [gateVerdictSummary("guardian"), "questions.md"],
  },
  concierge: { producer: "lane/register.md", capture: "report.md" },
};

/** Driver-captured REPORTING artifact read by status/merge consumers. */
export function reportArtifact(kind: string): string {
  return (ROLE_REPORT_ARTIFACT as Record<string, { capture: string }>)[kind]?.capture ?? "report.md";
}

/** Producer-authored completion register leaf. For a GATE seat this is the
 * verdict-marker PATH TEMPLATE under `runtime/`, not a container leaf, so it is
 * never joined to a container path. */
export function registerArtifact(kind: string): string {
  return (ROLE_REPORT_ARTIFACT as Record<string, { producer: string }>)[kind]?.producer ?? "lane/register.md";
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
