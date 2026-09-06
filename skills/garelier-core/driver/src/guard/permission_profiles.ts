// Serializable permission-profile bundle (W-113). The evaluator compiles these
// strings at runtime; dispatch records store only the stable profile name and
// concrete fence roots.

import type { FrameworkRoleKind } from "../role_contracts.ts";

export type PermissionProfileName = "baseline-destructive" | "role" | "scout" | "gate" | "concierge";

export interface PermissionProfileData {
  extends?: PermissionProfileName;
  /** Fail-closed action for a command that matched no allow pattern and no
   * deny/ask class, evaluated WITHOUT a trusted fence (or when the profile has
   * no fenced relaxation). Never relaxes below this. */
  unknown: "allow" | "ask" | "deny";
  /** W-122: the action a record-backed seat takes for that same unknown-class
   * command WHEN a trusted fence resolves (fence_roots non-empty) — the in-fence
   * "accidents are acceptable" band. Absent = always use `unknown`. Only ever a
   * RELAXATION ("allow"/"ask"); the deny floor (profile deny rules + path fence +
   * the global egress/delete/secret/force classes) is evaluated first and each
   * outranks this under strictest-wins, so it can never weaken a deny/ask class. */
  unknown_action?: "allow" | "ask";
  deny: readonly { id: string; pattern: string; reason: string }[];
}

const BASELINE_DENY = [
  { id: "force_push", pattern: String.raw`\bgit\s+push\b[^\n;]*(?:--force(?:-with-lease)?\b|\s-f\b)`, reason: "force-push is forbidden for every role" },
  { id: "hard_reset", pattern: String.raw`\bgit\s+reset\b[^\n;]*--hard\b`, reason: "hard reset can discard shared work" },
  { id: "force_clean", pattern: String.raw`\bgit\s+clean\b[^\n;]*(?:-\S*(?:fdx|fxd|xdf|xfd|dfx|dxf)|--force)`, reason: "forced recursive clean is forbidden" },
  { id: "git_delete", pattern: String.raw`\b(?:rm|del|rd|rmdir|Remove-Item)\b[^\n;]*(?:\s|[\\/])\.git(?:[\\/]|\s|$)`, reason: ".git deletion is unconditionally forbidden" },
  { id: "indirect_delete", pattern: "\\b(?:rm|del|rd|rmdir|Remove-Item)\\b[^\\n;]*(?:\\$[A-Za-z_{(]|`)", reason: "delete targets hidden by shell expansion are forbidden" },
  { id: "shallow_delete", pattern: String.raw`\b(?:rm|del|rd|rmdir|Remove-Item)\b[^\n;]*(?:\s[A-Za-z]:[\\/]?(?:\s|$)|\s[\\/](?:\s|$)|\s[A-Za-z]:[\\/][^\\/\s]+(?:\s|$))`, reason: "drive-root and shallow delete targets are forbidden" },
  { id: "wide_taskkill", pattern: String.raw`\b(?:taskkill|Stop-Process)\b[^\n;]*(?:/IM\s+\*|-Name\s+\*)`, reason: "broad process termination is forbidden" },
] as const;

export const PERMISSION_PROFILES: Record<PermissionProfileName, PermissionProfileData> = {
  "baseline-destructive": {
    unknown: "ask",
    deny: BASELINE_DENY,
  },
  role: {
    extends: "baseline-destructive",
    // Without a trusted fence, an unrecognized command still prompts (ask). With
    // one, W-122 lets a bulk-working role (python / baker runs) proceed: the
    // user's risk model treats in-fence accidents as acceptable, and the deny
    // floor still stops every out-of-fence mutation, egress, and forced rewrite.
    unknown: "ask",
    unknown_action: "allow",
    deny: [
      { id: "role_push", pattern: String.raw`\bgit\s+push\b`, reason: "roles never push" },
    ],
  },
  scout: {
    extends: "baseline-destructive",
    unknown: "deny",
    deny: [
      { id: "scout_mutation", pattern: String.raw`\b(?:git\s+(?:add|commit|push)|rm|del|rd|rmdir|Remove-Item|mv|move|Move-Item|cp|copy|Copy-Item|mkdir|touch|Set-Content|Out-File|New-Item)\b|(?<!>)>(?!>)`, reason: "Scout is read-only" },
    ],
  },
  gate: {
    extends: "baseline-destructive",
    // No unknown_action (W-122): gate roles (Guardian/Observer) are read-only, so
    // unknown stays fail-closed to deny. A fenced unknown-allow would let an
    // interpreter (`python x.py`) or a Set-Content/Out-File write — neither of
    // which the gate_mutation token class nor the MUTATION_HINT path fence catch —
    // slip past the read-only guarantee. Fenced verdict writes stay allowed via
    // the dedicated gateVerdictWrite branch, not via unknown-allow.
    unknown: "deny",
    deny: [
      { id: "gate_mutation", pattern: String.raw`\b(?:git\s+(?:add|commit|push)|rm|del|rd|rmdir|Remove-Item|mv|move|Move-Item|cp|copy|Copy-Item|mkdir|touch)\b`, reason: "gate roles are read-only except their verdict files" },
    ],
  },
  concierge: {
    extends: "baseline-destructive",
    // Concierge is the sole external-operation executor (DEC-025). A trusted
    // record + fence allows its approved local promote mutations and target
    // push, while the inherited baseline floor and the role-specific bans below
    // remain hard denies. W-305 deliberately narrows the command-layer exemption
    // to explicit promote-shaped git operations; curl/wget do not inherit it and
    // remote URL mutation is separately verified against either the live
    // configured URL or an exact PM-approved record pair in command_guard.
    // Source hardening is a ref-name rule, not content reachability. The
    // /^[A-Z][A-Z0-9_]*$/ pseudo-ref class denies an unqualified, letter-leading
    // all-uppercase SHA or tag/branch name; use a lowercase SHA, refs/tags/<NAME>,
    // or refs/heads/<NAME>. A digit-leading uppercase SHA does not match and
    // remains valid. Promote intentionally merges approved studio content.
    //
    // Accepted risk (F3): the dispatch record is unsigned JSON. Its authority
    // rests on its protected control-tree location, agent-name/cwd containment,
    // and the path fence — not HMAC/signature integrity. The pre-push hook is an
    // unconditional second layer, installed before dispatch_prepare emits this
    // profile, but it does not turn the record into a signed credential.
    unknown: "ask",
    unknown_action: "allow",
    deny: [
      { id: "concierge_garelier_push", pattern: String.raw`\bgit\s+push\b[^\n;]*\bgarelier\/`, reason: "Concierge never pushes local-only garelier/* refs" },
      { id: "concierge_pull", pattern: String.raw`\bgit\s+pull\b`, reason: "Concierge never runs blind git pull; fetch then merge the assignment-named ref" },
    ],
  },
};

/** Exhaustive role-to-profile contract over the canonical eleven-role list.
 * Adding a framework role without assigning its permission profile is therefore
 * a compile error instead of a silent baseline fallback. */
export const ROLE_PERMISSION_PROFILE: Record<FrameworkRoleKind, PermissionProfileName> = {
  pm: "baseline-destructive",
  dock: "baseline-destructive",
  artisan: "role",
  worker: "role",
  scout: "scout",
  smith: "role",
  librarian: "role",
  observer: "gate",
  guardian: "gate",
  concierge: "concierge",
  wanderer: "baseline-destructive",
};

export function profileForRole(role: string | undefined): PermissionProfileName {
  const r = (role ?? "").toLowerCase();
  if (Object.hasOwn(ROLE_PERMISSION_PROFILE, r)) return ROLE_PERMISSION_PROFILE[r as FrameworkRoleKind];
  // These are execution-seat aliases, not framework roles.
  if (r === "role" || r === "isolate") return "role";
  return "baseline-destructive";
}
