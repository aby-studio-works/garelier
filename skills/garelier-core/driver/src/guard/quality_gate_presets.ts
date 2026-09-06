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
  // W-217: `bun run typecheck` runs the project's LOCAL tsc via the package.json
  // `typecheck` script (`node ./node_modules/typescript/lib/tsc.js --noEmit` in
  // this repo's own driver/package.json). It is never blocked by the
  // `install_run`/`comprehensiveInstallRun` floor for the precise reason that
  // floor's own regex (`/\b(uvx|bunx|npx|pipx\s+run|pnpm\s+dlx)\b/i`) simply does
  // not contain "bun" — only "bunx" is a listed head, and "bun run" is a
  // textually distinct substring from "bunx" (G/O review F4: the earlier
  // comment's "REMOTE_EXEC_HEADS" framing named the wrong mechanism —
  // REMOTE_EXEC_HEADS only controls whether `stripQuotedProse` preserves quotes,
  // it has no bearing on whether `comprehensiveInstallRun` matches). Scoped to
  // the literal `typecheck` script name with a trailing word/end boundary
  // (`(?=\s|$)`, not `\b` — `\b` alone would ALSO match `typecheck:evil` or
  // `typecheck-and-publish`, since `k`→`:`/`k`→`-` are still word→non-word
  // boundaries; O review found this), so a differently-named package.json
  // script sharing the `typecheck` prefix is not vouched by this preset.
  { id: "bun-run-typecheck", pattern: String.raw`^bun\s+run\s+typecheck(?=\s|$)` },
  { id: "python", pattern: String.raw`^(?:pytest|ruff\s+(?:check|format)|mypy)\b` },
  { id: "go", pattern: String.raw`^go\s+(?:build|test|vet|fmt)\b` },
  { id: "dotnet", pattern: String.raw`^dotnet\s+(?:build|test|format)\b` },
  { id: "make", pattern: String.raw`^make\s+(?:check|test|build|lint|verify)\b` },
  { id: "gradle", pattern: String.raw`^(?:gradle|\.\/gradlew)\s+(?:build|test|check)\b` },
];

export const READ_ONLY_INSPECTION_PRESETS: readonly ReadOnlyInspectionPreset[] = [
  // W-517: `merge-tree` joins this alternation. It is the plumbing three-way
  // merge: it resolves the merge in memory and reports the result. `--write-tree`
  // names the only thing it can persist — TREE and BLOB objects in the object
  // store — and an object nothing references is inert: no ref moves, the index is
  // untouched, and the working tree is not written. That is the property the
  // `gate` profile row asks for ("read-only except a verdict write"), so the gate
  // seat computing a merge preview is inside the boundary the profile table
  // already declared, not an extension of it. The row that filed this expected the
  // deny to be a `destructive` classification; the measured rule was
  // `profile_unknown` — there is no destructive classification for merge-tree at
  // all, it simply matched nothing. `git merge` itself (which DOES move a ref) is
  // not in this alternation and stays outside; the W-318 merge-gate rule below
  // matches it exactly, no longer by prefix.
  //
  // W-517 r2: the terminator is `(?=\s|$)`, NOT `\b` — and that fix belongs to the
  // WHOLE alternation, not just the added verb. `\b` is a word boundary, and every
  // member here ends in a word character that can be followed by `-`, so `\b`
  // matched a PREFIX: `git merge-tree-evil x`, `git rev-parse-evil`,
  // `git ls-files-evil` all rode this preset. `git <name>` executes `git-<name>`
  // from PATH, and a gate seat's cwd is the reviewed checkout, so a committed or
  // planted `git-merge-tree-evil` would have run under a read-only allow. This
  // file has now taught the same lesson five times (`typecheck:evil`,
  // `graph-export`, `sha256sum-evil`, `guardian_scan.ts-evil`, and this one).
  //
  // W-517 r3/r4: tightening the terminator also removed SIX verbs the loose `\b`
  // had been admitting AS A SIDE EFFECT — `diff` matched `diff-tree` /
  // `diff-index` / `diff-files`, and `show` matched `show-ref` / `show-branch` /
  // `show-index`. All six are real read-only plumbing (they print a diff, resolve
  // refs, or dump a pack index; none writes a ref, an index or a working tree),
  // so removing them was a false-deny regression, not the fix. They are listed
  // here as EXPLICIT members: admitted for what they do, not because a boundary
  // happened to be loose.
  //
  // The denominator behind that claim is `git help -a` — every subcommand this
  // git build knows (484 on the measured build) — evaluated through the base
  // guard and the tip guard and diffed. An earlier revision of this comment said
  // the census covered "every real git subcommand sharing a prefix with a member
  // of this alternation"; it was a 20-input hand list, which is a smaller claim
  // than those words make. The full run then found `show-index`, the one verb the
  // hand list had missed. With it listed, the ONLY direction change across the
  // whole denominator is `merge-tree` (deny -> read_only), which is W-517's own
  // purpose.
  { id: "git-read", pattern: String.raw`^git\s+(?:status|log|diff|diff-tree|diff-index|diff-files|show|show-ref|show-branch|show-index|rev-parse|ls-files|grep|merge-base|merge-tree|ls-tree|cat-file|rev-list|describe|shortlog|check-attr)(?=\s|$)` },
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
  // W-382 (FORK-B, ruling (a)): the cargo QUERY subcommands — the ones whose
  // whole job is to resolve the manifest/dependency graph and PRINT it. They are
  // admitted as a CLASS, defined by a property of the subcommand rather than by
  // naming the two commands the row happened to hit: cargo's writing work lives
  // in a DISJOINT set of subcommands (build, install, publish, package, fix, add,
  // remove, update, generate-lockfile, vendor, clean, run, test), so a subcommand
  // is in this class exactly when it has no write mode of its own. A subcommand
  // that is not listed is not silently trusted and not silently denied by a
  // second list — it simply is not in the class, and falls to the profile rules
  // as before. `cargo pkgid` / `cargo locate-project` are in the class by that
  // property alone, and `cargo generate-lockfile` is outside it, without either
  // being enumerated anywhere else.
  //
  // Stated rather than implied: `tree` and `metadata` DO resolve dependencies,
  // and resolution creates or refreshes `Cargo.lock` when the lock is missing or
  // stale.
  //
  // W-382 r2 CORRECTION: an earlier revision of this comment claimed that write
  // "is inside the invoking workspace by construction (cargo has no flag that
  // redirects the lockfile elsewhere)". That is FALSE. `--manifest-path` points
  // cargo at any manifest on the filesystem and the lockfile is written beside
  // THAT manifest, so an unconstrained flag tail let
  // `cargo tree --manifest-path <out-of-fence>/Cargo.toml` write outside the
  // seat's fence under a read-only allow. The head match here therefore does NOT
  // vouch for the flag tail: cargo's path-valued flags (`--manifest-path`,
  // `--target-dir`, `--out-dir`) are a shared write-form core in command_guard.ts
  // (`WF_CARGO_PATH_CORE`), so they escape read-only and their operand is
  // fence-checked exactly like `--output` — in-fence allowed, out-of-fence denied.
  // `--config` and `-Z` are refused outright (they choose a program to run and
  // name no path for a fence to check). A caller that wants no lockfile write at
  // all passes `--locked`/`--offline`; the seat is not required to.
  //
  // The terminator is `(?=\s|$)`, never `\b` — this file has taught that lesson
  // four times (`typecheck:evil`, `graph-export`, `sha256sum-evil`,
  // `guardian_scan.ts-evil`): `e`->`-` is a word boundary, so `\b` would also
  // admit `cargo tree-evil`, and a `cargo-tree-evil` on PATH is a different
  // executable that cargo would happily run.
  { id: "cargo-query", pattern: String.raw`^cargo\s+(?:tree|metadata|pkgid|locate-project|verify-project|read-manifest)(?=\s|$)` },
  // A version/help probe executes no subcommand at all. Same class, same reason a
  // gate seat needs it: reporting the toolchain it measured with.
  { id: "cargo-version", pattern: String.raw`^cargo\s+(?:--version|-V|--help|-h)(?=\s|$)` },
  { id: "change-directory", pattern: String.raw`^cd(?:\s+\S.*)?\s*$` },
  // W-353: `Get-FileHash` is the PowerShell digest reader — same read-only class
  // as the coreutils `*sum` family below, added to the existing alternation
  // rather than as a second preset. The terminator is `(?=\s|$)`, NOT `\b`:
  // `h`->`-` is a word boundary, so `\b` also matched `Get-FileHash-evil x`
  // (probe-confirmed). Tightening it fixes the pre-existing members of this
  // alternation at the same time — they shared the one terminator, so the flaw
  // could not be fixed for the added verb alone.
  { id: "powershell-inspection", pattern: String.raw`^(?:Get-ChildItem|Get-Content|Select-String|Test-Path|Get-FileHash)(?=\s|$)` },
  // W-353: a gate seat could not compute a digest, so it could not INDEPENDENTLY
  // re-derive a hard-bound raw-trace sha and had to accept the role's declared
  // value — the gate verifying nothing it did not already trust (実測: three
  // consecutive consuming-project gates, 2026-08-03; the PM recomputed by hand each time).
  // These commands read a file and print a digest; none has a write mode at all
  // (a `> out` redirect is a separate write form that escapes read-only before
  // this preset is consulted, exactly as for the other inspection heads).
  // Terminator is `(?=\s|$)`, NOT `\b` — this file has taught the same lesson
  // twice already (`bun-run-typecheck` above: `\b` would also match
  // `typecheck:evil`; `garelier-control-readonly` below: `\b` let `graph-export`
  // ride `graph`). `\b` here likewise ALLOWED `sha256sum-evil /etc/passwd`,
  // `sha256sum.exe a.txt`, and `cksum/../../evil a` (probe-confirmed): a digest
  // head is only this exact word, and `.exe` / `-evil` / a path continuation
  // names a DIFFERENT executable that a gate seat would resolve from its cwd —
  // which is the reviewed checkout, so a committed lookalike would run.
  { id: "hash-digest", pattern: String.raw`^(?:sha1sum|sha224sum|sha256sum|sha384sum|sha512sum|md5sum|b2sum|cksum)(?=\s|$)` },
  // W-353: merge_gate_parse.ts is how a verdict file's own shape / review_sha
  // binding is read, and a gate seat could not run it — it could not self-parse
  // the very artifact it was about to emit.
  //
  // It writes nothing (no `Bun.write` / `writeFileSync` / `appendFileSync` /
  // `mkdirSync` / `rmSync`), but it DOES execute: `merge_gate_parse.ts:549`
  // pulls `execFileSync` in via `require("node:child_process")` — invisible to an
  // import-line grep — and runs `git rev-parse --verify` at `:557` / `:569`. An
  // earlier revision of this comment claimed "zero spawnSync/execSync calls,
  // verified", which was a claim whose evidence never covered `execFileSync` nor
  // require()-style imports; corrected here rather than restated. What makes the
  // execution acceptable is the SHAPE, not its absence: an argv ARRAY (no shell,
  // so no shell metacharacter path), a resolved `git` executable rather than a
  // caller-chosen one, and `rev-parse --verify`, which resolves refs and runs no
  // repository-supplied code.
  //
  // Residual, stated rather than implied: its git cwd is
  // `resolveTrustedTargetRoot(req.target_root, projectRoot)` (`:515-523`), which
  // checks only absolute / no `$` / isDirectory — so a request JSON can point the
  // ref resolution at ANOTHER repository. That is the same unbound-target class
  // this row closes elsewhere, but `resolveTrustedTargetRoot` is shared with
  // merge_gate.ts, so binding it is a merge-gate behavior change and belongs to
  // its own row (reported, not silently narrowed here).
  //
  // Same anchored-basename shape as the guardian_scan preset above, with the same
  // acknowledged residual: it trusts the invocation's basename, not the file's
  // true origin. Trailing `['"]?(?=\s|$)` (allowing only a closing quote), not
  // `\b`: `\b` also matched `bun merge_gate_parse.ts-evil x` (probe-confirmed),
  // and since `bun <file>` EXECUTES, a `merge_gate_parse.ts-evil` committed to
  // the reviewed tree would be runnable TS at the gate seat.
  { id: "garelier-merge-gate-parse", pattern: String.raw`^bun\s+["']?(?:\S*[\\/])?merge_gate_parse\.ts['"]?(?=\s|$)` },
  // W-217: a gate seat (Guardian/Observer, profile "gate") could not run its own
  // DEC-079 mechanized tooling — every observed shape (`--project/--base/--head`
  // flags, positional `<config> <projectRoot> <base> <head>`, `--help`) fell to
  // the fail-closed profile_unknown deny, so every gate degraded to hand-reasoning
  // over the raw diff/registries (defeating the token-saving mechanization DEC-079
  // exists for; W-217 実測 2026-07-26/27, 7+ gates). W-307 makes the flag form
  // canonical while retaining the positional form: `--project/--base/--head`
  // are parsed by guardian_scan itself, and config resolution uses `--config`,
  // `--pm-id`, or the canonical `_crew/pm` namespace.
  // The preset intentionally recognizes both forms because its safety property
  // is based on the scanner basename/write surface, not one argv spelling.
  // `guardian_scan.ts` has exactly
  // ONE write path — `--out <path>` (Bun.write; verified 2026-07-27, no other
  // fs-mutating call in the file) — so it is excluded here; without `--out` the
  // script only reads git/toml and prints to stdout. `--out` present falls
  // through to the gate-verdict-write / profile_unknown path instead (unchanged,
  // still fail-closed; W-217 G1 also taught `hasWriteFormFlag`/`writeFormTargets`
  // to recognize bare `--out`, so that fallback now correctly ALLOWS an in-fence
  // `--out` target via the existing verdict-write mechanism and still DENIES an
  // out-of-fence one. G R2 correction: this lookahead is NOT actually an
  // independent second line of defense — it and hasWriteFormFlag both key off
  // the SAME literal substring `--out`, so they are one shared point of
  // failure, not two (a spelling/alias drift on either would silently drift
  // both, since neither is derived from the other). Documented honestly rather
  // than claimed as defense-in-depth.
  //
  // The `["']?(?:\S*[\\/])?` prefix ANCHORS the match to the file's actual
  // BASENAME — a bare, unanchored `guardian_scan\.ts` substring search matched a
  // LOOKALIKE file too (`evil_guardian_scan.ts`, `/tmp/my_guardian_scan.ts` —
  // O review finding, F1 blocking): the optional group only consumes a run of
  // non-space characters that ENDS in a path separator (or nothing, for a bare
  // relative filename), so the character immediately preceding the literal
  // filename must be the start of the token, an opening quote, or `/`/`\` —
  // never an arbitrary substring boundary like `_`. Pinned by 3 lookalike-DENY
  // tests in command_guard.test.ts. G R2 correction: this is a BASENAME anchor
  // only, not a real-path or file-content check — `bun /tmp/guardian_scan.ts`
  // (an actual copy or symlink placed at a different path, but with the exact
  // right basename) is still ALLOWED by this preset. That residual is accepted
  // as equivalent to `bun test`'s own existing residual — this codebase
  // already trusts an invocation's head/basename everywhere, never a file's
  // true origin or content — not a new hole introduced here.
  // W-365: the trailing boundary was bare `\b`, which does NOT anchor to the
  // end of the filename -- `s`->`-` is itself a word->non-word transition, so
  // `\bguardian_scan\.ts\b` matches a PREFIX of `guardian_scan.ts-evil` just
  // as readily as the real file (a gate seat's cwd is the reviewed checkout,
  // so a committed lookalike would run; this file already taught the same
  // lesson for `typecheck:evil` / `graph-export` / `sha256sum-evil`). Found by
  // inspection while writing the sibling identity-scrub-lint preset below
  // (which needed the SAME terminator decision) -- fixed here too rather than
  // left as a known-bad twin, with a `guardian_scan.ts-evil` /
  // `evil_guardian_scan.ts` lookalike-DENY regression pair in
  // command_guard.test.ts. `(?=\s|$)` after an optional closing quote closes
  // it, matching garelier-control-readonly's already-correct terminator.
  { id: "garelier-guardian-scan", pattern: String.raw`^bun\s+["']?(?:\S*[\\/])?guardian_scan\.ts['"]?(?=\s|$)(?![\s\S]*--out\b)` },
  // evidence_pack.ts (gate_field_manual.md) only reads the named evidence-pack
  // markdown and validates its shape against the template; it has no write path
  // at all (verified 2026-07-27, zero fs-write calls in the file). Same anchored-
  // basename shape as guardian_scan.ts above (F1); same W-365 terminator fix,
  // same `evidence_pack.ts-evil` / `evil_evidence_pack.ts` lookalike-DENY pair.
  { id: "garelier-evidence-pack", pattern: String.raw`^bun\s+["']?(?:\S*[\\/])?evidence_pack\.ts['"]?(?=\s|$)` },
  // W-365: identity_scrub_lint.ts is a mandatory pre-submit scanner (the
  // role-discipline "identity scrub before commit" check) that ran
  // `git -C <root> grep ...` (a read-only subprocess, argv array, resolved
  // git executable) and wrote only to stdout/stderr -- no fs-write call in
  // the file at all (verified: it imports only spawnSync + _lib helpers, same
  // shape as merge_gate_parse.ts's execFileSync). Before this preset, an
  // ad-hoc gate spawn with no attended_record binding (so no declared
  // quality_gate_commands) could not run it: profile_unknown denied a
  // mandatory, harmless read-only lint purely because nothing had transcribed
  // it into a record (실측: W-365). Same anchored-basename shape as the other
  // garelier-* script presets above (F1); it accepts an optional positional
  // root argument, so the pattern only anchors the head, not the tail.
  // Terminator is `['"]?(?=\s|$)`, not bare `\b` (see the guardian_scan
  // comment above -- writing THIS preset is what surfaced the identical
  // lookalike hole in its two siblings; all three carry the same terminator
  // and the same lookalike-DENY test shape in command_guard.test.ts).
  { id: "garelier-identity-scrub-lint", pattern: String.raw`^bun\s+["']?(?:\S*[\\/])?identity_scrub_lint\.ts['"]?(?=\s|$)` },
  // `garelier control <verb>` — control.ts's own `execute()` dispatches
  // `context`/`resume`/`get`/`list`/`doctor`/`graph` through ONE shared
  // read-only branch (`validateReadSyntax` + `planGraphRead`/`legacyRead`); none
  // of the six ever writes control state (F5: originally only `doctor` was
  // allowed here, but the other five share the identical read-only dispatch —
  // verified by reading control.ts's `execute()`, not assumed). `--profile
  // fast|strict` stays doctor-specific in practice (it is the only one of the
  // six whose own arg-parser accepts that flag; this preset does not need to
  // encode that per-verb difference — control.ts's parser already rejects an
  // invalid flag for any other verb). `control.ts create` / `work-update` /
  // `session-open` / any writing subcommand is NOT in this alternation and
  // stays fail-closed. Same anchored-basename shape as guardian_scan.ts (F1).
  // Trailing boundary is `(?=\s|$)`, not `\b` (G R2: `\b` alone let
  // `graph-export` ride the `graph` alternative, since `h`→`-` is still a
  // word→non-word boundary — the exact class of bug the typecheck preset's own
  // `(?=\s|$)` fix already closed; same fix, same reason, applied here too).
  { id: "garelier-control-readonly", pattern: String.raw`^bun\s+["']?(?:\S*[\\/])?control\.ts['"]?\s+(?:context|resume|get|list|doctor|graph)(?=\s|$)` },
  // W-297: one canonical gitleaks argv, byte-aligned with guardian_scan.ts
  // scannerCommand() and scanner-and-gates.md. The checkout root is literal `.`;
  // JSON goes to stdout (`--report-path -`) and always carries `--redact`, so
  // location evidence is available without writing or exposing a matched value.
  // Delta scope is carried only through gitleaks' `--log-opts <base..head>`
  // argument; a plain positional range is a path, not a commit-range selector.
  //
  // This is deliberately an exact ordered grammar, not a bag of safe-looking
  // tokens. Custom config/baseline/root/output, verbose text output, optional
  // redaction values, and deprecated forms remain profile_unknown-denied. A
  // file-valued gitleaks report is not supported by the generic or PM-declared
  // gate-seat route; outputsStayWithinFence accepts only `--report-path -` for
  // gitleaks. command_guard additionally binds execution to the reviewed
  // worktree, rejects candidate-controlled `.gitleaks.toml` /
  // `.gitleaksignore`, rejects ambient gitleaks config selectors, and applies
  // the same checks recursively inside static declared wrappers. These
  // scanner-specific rules do not constrain unrelated tools.
  //
  // Availability has one canonical probe: guardian_scan.ts --probe-gitleaks
  // above. Direct `gitleaks version` is intentionally not duplicated here.
  {
    id: "gitleaks-readonly",
    pattern: String.raw`^gitleaks\s+(?:dir\s+\.\s+--no-banner\s+--redact\s+--report-format\s+json\s+--report-path\s+-|git\s+\.\s+--no-banner\s+--redact\s+--report-format\s+json\s+--report-path\s+-\s+--log-opts\s+[A-Za-z0-9_./~^:-]+\.{2,3}[A-Za-z0-9_./~^:-]+)\s*$`,
  },
];
