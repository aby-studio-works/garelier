// Additive, stack-neutral baseline verification presets for command_guard.
//
// A project's resolved `quality_gate` commands are the first authority. These
// entries cover ordinary local verification commands before a project has a
// dispatch fact pack (or where a stack's wizard default is being used). Keep
// patterns narrow: a match grants only the profile's unknown-command exception;
// destructive and path-fence rules still run independently.

export interface QualityGatePreset {
  id: string;
  pattern: string;
}

/**
 * Stack-independent commands that inspect local state without changing it.
 * Patterns deliberately constrain `git branch` to listing forms: an arbitrary
 * branch name would create a branch and must remain profile-controlled.
 */
export interface ReadOnlyInspectionPreset {
  id: string;
  pattern: string;
}

export const QUALITY_GATE_PRESETS: readonly QualityGatePreset[] = [
  { id: "rust-cargo", pattern: String.raw`^cargo\s+(?:build|check|test|run|fmt|clippy)\b` },
  { id: "node-package", pattern: String.raw`^(?:npm|pnpm|yarn)\s+(?:(?:run\s+)?(?:build|test|lint|typecheck|check)|ci)\b` },
  { id: "node-typescript", pattern: String.raw`^(?:node\s+(?:\.\/)?node_modules\/typescript\/lib\/tsc\.js\b|bun\s+test|tsc\b)` },
  { id: "python", pattern: String.raw`^(?:pytest|ruff\s+(?:check|format)|mypy)\b` },
  { id: "go", pattern: String.raw`^go\s+(?:build|test|vet|fmt)\b` },
  { id: "dotnet", pattern: String.raw`^dotnet\s+(?:build|test|format)\b` },
  { id: "make", pattern: String.raw`^make\s+(?:check|test|build|lint|verify)\b` },
  { id: "gradle", pattern: String.raw`^(?:gradle|\.\/gradlew)\s+(?:build|test|check)\b` },
];

export const READ_ONLY_INSPECTION_PRESETS: readonly ReadOnlyInspectionPreset[] = [
  { id: "git-read", pattern: String.raw`^git\s+(?:status|log|diff|show|rev-parse|ls-files|grep|merge-base|ls-tree|cat-file|rev-list|describe|shortlog|check-attr)\b` },
  { id: "git-branch-list", pattern: String.raw`^git\s+branch(?:\s+(?:--show-current|--list(?:\s+.*)?|-l(?:\s+.*)?|--all|-a|--remotes|-r|--verbose|-v|-vv))*\s*$` },
  { id: "git-remote-read", pattern: String.raw`^git\s+remote(?:\s+(?:-v|get-url\s+\S+))?\s*$` },
  { id: "git-worktree-list", pattern: String.raw`^git\s+worktree\s+list\b` },
  // W-140: sort/uniq/comm/tr/cut/diff added — a read-only inspection PIPE
  // chain (`find … | sort | wc -l`) needs every stage recognized, or one
  // unrecognized segment fails the all-segment-read-only check and the whole
  // chain falls to baseline `ask` (3x live friction, user-traced 2026-07-18).
  // `cd` is deliberately NOT added here: it already resolves through the
  // dedicated fence-aware `isFencedChangeDirectory()` check in
  // command_guard.ts (which verifies the destination is inside fenceRoots);
  // a bare `cd` alternative in this plain verb-prefix pattern would have no
  // such awareness and would let a `cd` to OUTSIDE the fence read as
  // read-only too, defeating that check's own purpose (see the
  // `id !== "change-directory"` guard + its comment in command_guard.ts).
  // W-179: `sed` added — a read-only inspection pipe/chain (`grep … ; sed -n '1,5p' f`,
  // user-traced 2026-07-20) needs it. `sed -i`/`--in-place` REWRITES the file, so it
  // is caught as a write by hasWriteFormFlag (WF_SED_INPLACE) in command_guard.ts and
  // escapes read-only before this preset is consulted — a bare/`-n`/`s///` sed stays read-only.
  { id: "posix-inspection", pattern: String.raw`^(?:ls|dir|cat|type|head|tail|find|grep|rg|wc|stat|pwd|echo|where|which|sort|uniq|comm|tr|cut|diff|sed)\b` },
  // W-179 (d, 実測 2026-07-20 13:14): `sleep 1; tail -15 <log>` asked because `sleep`
  // was not read-only vocabulary, so the whole poll chain fell to unknown. A `sleep`
  // with ONLY numeric arg(s) (optional s/m/h/d suffix) executes nothing and mutates
  // nothing — read-only. Deliberately NOT a bare `sleep\b` head (that would let
  // `sleep $(evil)` ride read-only): the numeric-only tail keeps it non-wildcard, and
  // a command substitution is caught by segmentEscapesReadOnly before this anyway.
  { id: "sleep", pattern: String.raw`^sleep(?:\s+\d+(?:\.\d+)?[smhd]?)+\s*$` },
  { id: "change-directory", pattern: String.raw`^cd(?:\s+\S.*)?\s*$` },
  { id: "powershell-inspection", pattern: String.raw`^(?:Get-ChildItem|Get-Content|Select-String|Test-Path)\b` },
];
