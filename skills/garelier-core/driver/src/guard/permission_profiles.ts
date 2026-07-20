// Serializable permission-profile bundle (W-113). The evaluator compiles these
// strings at runtime; dispatch records store only the stable profile name and
// concrete fence roots.

export type PermissionProfileName = "baseline-destructive" | "producer" | "scout" | "gate";

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
  producer: {
    extends: "baseline-destructive",
    // Without a trusted fence, an unrecognized command still prompts (ask). With
    // one, W-122 lets a bulk-working producer (python / baker runs) proceed: the
    // user's risk model treats in-fence accidents as acceptable, and the deny
    // floor still stops every out-of-fence mutation, egress, and forced rewrite.
    unknown: "ask",
    unknown_action: "allow",
    deny: [
      { id: "producer_push", pattern: String.raw`\bgit\s+push\b`, reason: "producer roles never push" },
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
};

export function profileForRole(role: string | undefined): PermissionProfileName {
  const r = (role ?? "").toLowerCase();
  if (r === "scout") return "scout";
  if (r === "guardian" || r === "observer") return "gate";
  if (["worker", "smith", "librarian", "artisan", "producer", "isolate"].includes(r)) return "producer";
  return "baseline-destructive";
}
