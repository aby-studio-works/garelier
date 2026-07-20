# command_guard — the safety enforcement point (operator reference)

The command_guard is a Claude Code **PreToolUse hook** that evaluates a shell
command *before it runs* and returns allow / ask / deny. It mechanically enforces
the written safety references (`deletion_and_forcewrite_safety.md`,
`injection_and_egress.md`, `package_policy.md`). Implementation:
`driver/src/guard/command_guard.ts`; tunable policy:
`control/operations/command_guard_policy.toml`.

W-113 adds a dispatch-bound permission layer above the legacy rule classes.
`dispatch_prepare.ts` writes it into the producer's `context.json`; isolate
`lane_dispatch.ts` writes the same fields into `<slug>.dispatch.json`. The hook
resolves that record from the tool call's cwd (and agent name when present), so
every spawn receives its fence without per-agent settings edits.

## Dispatch permission profiles

The canonical data bundle is
`driver/src/guard/permission_profiles.ts`. Every record contains
`permission_profile` plus absolute `fence_roots`.

W-183: a record may also declare `guard.additional_roots` — extra repo control
roots the SAME operator is authorized to work in (a consuming-project PM-direct seat that
also touches the garelier repo). They are EXPLICIT (never inferred from the
ambient cwd — the guard refuses cwd trust, W-119) and carry the same record-level
trust as `fence_roots`, so `permissionRecordFrom` merges them into the effective
fence: a declared cross-repo op (an absolute `cd` into the declared repo) is
in-fence, while an UNdeclared repo stays out-of-fence and fails closed. Author
them with `attended_record --additional-root <path>` (repeatable). NOTE (O N4):
`additional_roots` only dissolves the ask when the record CO-LIVES on the session
cwd side AND the command uses an absolute chdir (`cd <abs>` / `git -C <abs>`) into
the declared repo. If the record lives only on the TARGET repo side, use the
absolute `-C` form so the W-150 cross-repo lookup can DISCOVER the record there —
a bare-relative cross-repo command stays fail-closed by design (the guard refuses
to trust the ambient cwd, W-119).

W-159: a record may declare `guard.quality_gate_commands` — verify commands a
record-backed seat runs. `command_guard` allows a command whose WHOLE normalized
form matches a listed entry VERBATIM (`isDeclaredWholeCommand`), covering a
non-preset script or compound the per-segment preset match misses. The allow is
**profile-agnostic** (any profile carrying a declared list, not only `gate`); in
practice only the fail-closed gate seat carries a list. It is safe on every
profile because it only suppresses the fail-closed unknown band — the deny floor
(egress / delete / secret / force / process_kill / the per-profile mutation deny)
is evaluated separately and binds ALL profiles under strictest-wins, so a listed
entry can never launder a deny-floor command. Author with `attended_record
--quality-gate <cmd>` (repeatable); `dispatch_prepare` seats it from the project
fact pack.

| Profile | Effective boundary | Unknown command |
| --- | --- | --- |
| `baseline-destructive` | deny force-push, hard reset, forced clean, shallow/root or indirect delete, `.git` delete, and broad process termination | ask |
| `producer` | baseline + deny every push + deny create/write/delete outside the assigned worktree and granted roots | ask |
| `scout` | baseline + read-only (commit/push/rm/mv/copy/create/write denied) | deny |
| `gate` | baseline + read-only except a verdict write inside the recorded verdict fence | deny |

All matching rules are evaluated and the strictest result wins:
`deny > ask > allow`. A command that does not match the profile's allow table
uses the profile's unknown-command result; it never silently falls through to
allow. The project TOML remains the tuning surface for the older safety rule
classes, but cannot relax a dispatch-profile deny.

The profile fence complements, rather than replaces, the provider boundary:
Claude producers receive the PreToolUse profile and Codex producers receive
`workspace-write` plus explicit `--add-dir` grants. Both are dispatched with the
same concrete worktree/granted-root list, giving the two producer families an
equivalent path wall.

## What it decides (rule classes)

Every family is a **per-family opt-in flag** (W-164): the framework ships with
all flags OFF (a family with its flag off contributes no decision = passthrough),
and a consuming project (the target project / garelier) turns them on. The "Action" column is
what the family produces **when its flag is on**; the "Flag" column is the policy
key that enables it.

| Class | Trigger | Action (flag on) | Flag (W-164) |
| --- | --- | --- | --- |
| pipe_to_shell | `curl`/`wget`/`iwr … \| sh/bash/pwsh` | deny | `pipe_to_shell_guard_enabled` |
| network_egress | `curl`/`wget`/`Invoke-*` upload/POST/PUT/PATCH (`-d`/`-F`/`-T`) | deny (Concierge exempt) | `network_egress_guard_enabled` |
| network_offlist | plain GET to a host not in `network_allow_domains` | deny (Concierge exempt) | `network_egress_guard_enabled` |
| git_egress | `git push` / `git fetch` / `git pull` / `git remote add\|set-url` (reaches a remote) | deny (Concierge exempt) | `git_egress_guard_enabled` |
| remote_package_exec | remote-package **immediate execution**: `bunx` / `uvx` / `npx <pkg>` / `bun x <pkg>` / `pipx run` / `pnpm dlx` / `npm exec` / `pnpm exec` / `uv run --with` / `deno run <remote http(s) url>` (fetch external package + run in one step). Local runners (`bun run`, `npm run`, `bunx ./x.ts`, `npx ./x.js`, `uv run x.py`, `deno run ./x.ts`) are NOT matched. | deny; a specific package individually allowable via `actions.remote_package_exec` | `remote_exec_guard_enabled` |
| install_run + tool_install_update | package/system-tool install, update, upgrade, installer acquisition, install-run tools; recursively inspects static shell wrappers and fails closed on an opaque/over-depth wrapper | all-seat deny (applies even when the main guard is disabled or an action override says `allow`) | `install_guard_enabled` |
| codex_raw_exec | raw `codex exec` (not via `dispatch_codex_producer.ts`): workspace-write/unspecified sandbox | ask (danger-full-access: deny; read-only probe: allow) | `codex_raw_exec_guard_enabled` |
| recursive_delete | `rm -rf` / `Remove-Item -Recurse` outside `$GARELIER_CONTAINER` | deny | `recursive_delete_guard_enabled` |
| indirect_delete | a delete/`reset`/`clean` command whose flags/targets are hidden behind shell indirection (`$VAR` / `$(…)` / backtick), e.g. `F=-rf; rm $F` | ask (heuristic; not a full shell parse) | `indirect_delete_guard_enabled` |
| force_write | `git push --force` / `reset --hard` / `clean -f` / `branch -f` / `--amend` / `restore` / `checkout -- <path>` | ask | `force_write_guard_enabled` |
| secret_file | delete/overwrite `*.db` / `*.sqlite` / `*.env` / `credentials*` | ask in-container, deny outside | `secret_file_guard_enabled` |
| process_kill | indiscriminate name/image **bulk** process kill (`Get-Process cargo,rustc \| Stop-Process`, `Stop-Process -Name`, `taskkill /IM`, `pkill`/`killall <name>`, plus the PowerShell aliases `spps`/`gps`/`kill` — `gps cargo \| spps`, `Get-Process cargo \| kill`, `kill -Name`) NOT scoped to the own worktree. Evaluated **per statement** (`;`/`&&`/`\|\|`/newline split, `\|` kept as a pipeline) so a decoy fence token or a stray `-Id` in another statement cannot launder a bulk kill. A kill filtered to the own worktree (`Where-Object { $_.CommandLine -like '*_dispatch<N>*' }`, `pkill -f <fence path>`) and a PID-scoped kill (`Stop-Process -Id` / `taskkill /PID` / POSIX `kill <pid>`) are out of scope (allowed). | deny for a worker/producer seat (it can stop OTHER lanes' builds — the #371 incident); ask for a PM-direct (`lane_kind`) / PM / record-less seat. The deny/ask report recommends the exact fence token the guard accepts (`distinctiveFenceToken`), matching the dispatch preamble (W-173). | `process_kill_guard_enabled` |
| profile_path_fence | dispatch-profile per-segment path fence: a mutation target outside the resolved fence | deny | `path_fence_guard_enabled` |

The dispatch-profile deny table and the fail-closed `profile_unknown` band are the
seat core (they only apply when a dispatch record resolves a profile) and are NOT
per-family-gated; only `profile_path_fence` has a flag. `enabled: false` still
short-circuits everything to allow.

A deny/ask reason always tells the agent to escalate to the PM, so a blocked
command is never a dead end. On its own internal error the guard **fails to
`ask`** (never fail-open).

### Per-family enable flags (W-164)

Every guard family has its own enable flag in `command_guard_policy.toml`, all
strict-boolean (`= true` to enable; a missing key / non-boolean / string `"true"`
→ off). The two supply-chain flags `install_guard_enabled` (W-160) and
`remote_exec_guard_enabled` (W-163) are the same shape and are **not renamed**.
Rules of the model:

- **Framework default = every flag off.** With a flag off its family passes
  through (contributes no decision). This keeps the framework a non-mandatory
  layer for non-users.
- **A project turns them on.** The target project and garelier project policies ship
  every family on. Enabling is per-family, so a project can be selective.
- **Independence.** Flags are independent — enabling one never enables another;
  in particular `remote_exec_guard_enabled` and `install_guard_enabled` are
  separate.
- **Individual allow.** With a family on, a specific class can still be relaxed
  per-command via `[command_guard.actions]` (e.g. `remote_package_exec = "allow"`).
- **Report on every deny/ask.** See the next section — a blocked/paused command
  is never silent.

Two families keep extra behavior worth calling out:

- **`remote_exec_guard_enabled`** matches only external fetch-and-run forms; a
  genuinely local runner (`bun run`, `bunx ./x.ts`, `deno run ./x.ts`,
  `uv run x.py`) is never caught, and W-164 folded in the previously-missed
  `npx -y pkg` / `bun x` / quoted / `npm exec` / `pnpm exec` forms and anchored
  `deno run` so a local script passing a URL argument is not falsely denied.
- **`install_guard_enabled`** is the comprehensive install floor: it hard-denies
  install/update/upgrade, installer acquisition, pipe-to-shell, and install-run
  tools for every seat even when the main guard is disabled or an action override
  says `allow`, and it recursively inspects static `bash`/`sh`/`cmd`/PowerShell
  wrapper payloads, failing closed on an opaque or over-depth wrapper.

### PM-readable report on every deny/ask (W-164)

Every guard deny / ask also writes a structured, PM-readable report — a silent
block is a dead end for the PM, and the guard is insurance against AI runaway /
script bugs. The report **integrates into the existing `incidents.jsonl` stream**
(the one `runtime_recovery_hook.ts` writes) rather than a second mechanism: an
incident-shaped record with a `guard_deny` / `guard_ask` kind carrying the command
(verbatim), rule, fence roots, reason, and a recommended next step. It lands in the
pm-scoped `__garelier/<pm>/runtime/hooks/incidents.jsonl` — see *Where guard output
lands* below. `dock_status` reads these back and surfaces
them in the **pmAction** pane (`guard=N` plus the newest few), and `pmAction.needed`
trips on any open guard report. Writing is best-effort and never disturbs the
guard's own verdict.

## Resolution mode + per-profile learning-loop lists (W-179 d)

Two project-tunable knobs govern what happens when the guard would **ask**, and let
the PM teach the guard so a resolved class stops re-asking. Both live in the existing
`command_guard_policy.toml` (no new config layer, no new file).

### `resolution_mode` — `"pm"` (default) | `"ask"` (opt-out)

- **`pm` (the default when the guard is active, user 裁定第 6 報 2026-07-20)**: the
  guard emits **no user-facing ask at all**. *Every* ask becomes a fail-closed
  **deny** — not only a resolution-miss (`profile_unknown`) but *every profile-internal
  family ask* (`force_write`, a PM-direct `process_kill`, `codex_raw_exec`,
  `indirect_delete`, an in-fence `secret_file`, a `project_ask`). The deny carries an
  escalate-to-PM instruction, and the W-164 PM-readable report is written for it with
  `pm_pending: true` and a `pattern_hint` (the normalized command form the pattern lists
  match on). **No new allow is ever synthesized** (deny + report only) — the *only* way
  a command passes in pm mode is a project **allow** pattern. This is the fix for the
  ask-storm class (a subagent on an unattended fleet blocking on an ask no one answers):
  pm mode converts the block into a report the PM resolves.
- **`ask` (opt-out)**: an ask surfaces an attended prompt to the user, as before —
  the pre-W-179 behavior, for a project that wants a human in the loop.

**Upgrade note (existing guard-on projects)**: the W-179 default flip means a project
that previously saw attended asks silently switches to deny+PM-report on upgrade. If
you want the old prompts back, set `resolution_mode = "ask"` explicitly.

**Pattern caution (profile_rules lists)**: patterns are evaluated as **unanchored
regex** (a bare `git` matches any command containing "git") — always anchor (`^…$`)
and avoid unbounded nested quantifiers (ReDoS). A malformed regex never fails open
(it is skipped), but an over-broad one silently widens an allow.

**The enable flag is first.** `resolution_mode` only decides what an *actual* ask
becomes; it never makes the guard do more than it otherwise would. A disabled guard
(`enabled = false`) or a family whose flag is off still contributes nothing — that gate
runs before the mode is consulted, so pm mode cannot manufacture a decision on a passed-
through command.

### Provider independence

pm mode is **provider-agnostic** — its whole adjudication loop is file-canonical, so it
works identically whether the PM (or the resolving seat) is Claude Code or Codex:

- The pending report is the `incidents.jsonl` stream (surfaced by `dock_status`
  pmAction and woken by `fleet_watch` FLEET-ATTENTION); the adjudication is a text edit
  to the profile lists in `command_guard_policy.toml`. No provider-specific channel or
  approval UI is involved, so a codex-sub or codex-PM resolves it the same way.
- The `command_guard` **hook itself** is a Claude Code PreToolUse hook on the Bash
  layer. A **codex lane has no such hook** — the codex sandbox plays the equivalent
  role (a headless codex run has no interactive approval prompt at all), so pm mode's
  "no user ask" posture is already the codex reality on that side.
- Merging *codex-denied* operations into the same PM report stream is a future
  extension (out of scope here).

### `[command_guard.profile_rules.<profile>]` — the PM's learning loop

Per-profile `allow` / `ask` / `deny` **regex** lists, consulted **inside the profile
judgment** (across the profile chain, so a rule on `baseline-destructive` covers every
seat). Patterns match the same git-normalized, prose-stripped command form the profile
deny table uses (a `git -C <path>` prefix or quoted prose cannot launder them).

| List | Effect |
| --- | --- |
| `deny` | hard block (`project_deny`) — a command that would otherwise pass is denied |
| `ask` | attended pause (`project_ask`); in pm mode it becomes a deny like any ask |
| `allow` | learning-loop escape (`project_allow`): relaxes the fail-closed unknown band **and any ask** for a matching command — but **never a family/profile deny** |

**Precedence (strictest-wins, `project の allow より family deny が先勝ち`):** a project
`allow` can only turn an *ask/unknown* into an allow. Any hard deny — a family egress /
path-fence / recursive-delete / secret-file deny, or a profile deny (`scout_mutation`,
`producer_push`, `gate_mutation`, `.git` delete, …) — is evaluated first and wins. So
allow-listing a mutation for a Scout still cannot let it mutate; allow-listing a
`git push` for a producer is still denied as egress.

The **mechanism** is: a pm-mode deny lands a `guard_deny` incident with
`pm_pending: true` and a `pattern_hint`; the PM copies that hint (or a tighter regex)
into `[command_guard.profile_rules.<profile>].allow` (permit) or `.deny` (hard-block),
and the next same-shape command on that profile no longer escalates. The adjudication
lives in the project's own profile config — no separate state layer — so a
garelier-publish user grows their own lists the same way.

The PM's **judgment procedure** (how to classify a pending, when to grow a pattern vs
answer once, the numeric/token discipline) is canonical in the knowledge base, not
duplicated here: see the project knowledge base
(`system/pm-resolution-mode-adjudication.md`).
This doc owns the guard *mechanism*; that knowledge doc owns the PM *policy*.

### Scope boundary (user 裁定 2026-07-20 第 5 報)

pm mode governs **only the garelier guard layer**. It does not reach into the harness
prompt layer. The three-layer division of labor stays: the **guard** fail-closes and
reports at command time; **Guardian / Observer** catch policy issues in the *deliverable*
at the gate; the **PM** adjudicates an in-flight rule violation (stop / redirect / allow).
pm mode only removes the user-facing ask from the guard layer's share of that split.

## Driver script path guard

Shell-hook coverage cannot contain a bug inside a TypeScript helper, so the
driver also has a lower-level fence at `driver/src/guard/path_guard.ts`.
Destructive `node:fs` calls in `driver/src/**/*.ts` are forbidden by the
`path_guard_lint.ts` CI step; callers use the guarded rm/rmdir/unlink/rename
wrappers instead. The library canonicalizes the candidate (including existing
symlinks and `..`) before checking the configured roots and throws before the
filesystem call when the candidate is empty/undefined, a drive root, depth less
than three, an ancestor of a fence root, outside every fence, or `.git` itself/
below it. Creation/write wrappers share the same fence for new mutation paths.

The guard never contains a cleanup exception for `.git` and no Garelier code
should delete `.git` or anything below it. Detection is warning/deny only.

## Where the hook must live — two applicability paths

Claude Code applies hooks from the settings of the **session that owns the tool
call**. A Garelier role reaches the tool call by one of two launch shapes, and
the hook has to be registered in the right place for each:

| Launch shape | Whose settings apply | Where the guard hook lives | Wired by |
| --- | --- | --- | --- |
| **Independent session** (driver mode / a role started with cwd = its `checkout/`) | the checkout's `.claude/settings.local.json` | each role checkout | wizard `write_role_settings` (per checkout) |
| **Attended subagent** (a PM session spawns it with the Agent tool — *not* a separate session) | the **parent PM session's** settings: the target **project-root** `.claude/settings.local.json` / `.claude/settings.json`, or user `~/.claude/settings.json` | target project root | wizard project-root install (`install_hook.ts`, merge) |

Both are wired at setup. If only the checkout hook existed, attended parallel
work (a PM spawning several subagents) would run **unguarded** — which is exactly
the case this second path closes.

## How the wizard installs it

- **Per checkout:** `write_role_settings` writes the hook (plus `claudeMdExcludes`)
  into each role checkout's `.claude/settings.local.json`.
- **Project root:** the wizard merges the hook into
  `<project>/.claude/settings.local.json` with `install_hook.ts` — a
  key-preserving, idempotent merge that never clobbers a user's existing
  settings. `settings.local.json` (local, gitignored by convention) is used, not
  the tracked `settings.json`, so Garelier's project-root footprint stays
  local-only (DEC-051 keeps the repo Garelier-free for non-users).

### Opt-in: propagate via tracked settings + a project-owned shim

If you want every worktree/clone to inherit the guard without re-running the
wizard, you can TRACK it — but **never register a Garelier-internal path in a
tracked `settings.json`**: a contributor who has not installed Garelier would
then get an error on *every* tool call. Instead use the shipped **shim**
(`templates/command_guard_shim.ts`), which is project-owned and degrades to a
no-op:

1. copy `command_guard_shim.ts` into the repo, e.g.
   `.claude/hooks/garelier_command_guard_shim.ts`, and commit it;
2. register the **shim** (a repo-relative path) in the tracked
   `.claude/settings.json`:
   `{"type":"command","command":"bun \".claude/hooks/garelier_command_guard_shim.ts\""}`.

The shim exits 0 (allow, harmless) when `bun` or the guard is not present, so a
non-Garelier developer is unaffected; when Garelier is installed it delegates to
`command_guard.ts`. This mirrors the framework's **non-mandatory-layer** rule
(as with the commit convention): Garelier work merged onto a shared branch must
never impose Garelier on people who do not use it.

## General wiring principles (apply to every hook/setting the wizard writes)

These hold for the command_guard hook and for any future wiring the wizard adds
(`claudeMdExcludes`, SessionStart digests, …):

- **Non-mandatory layer.** The default is the per-developer, **untracked**
  `settings.local.json` — opt-in per person, zero footprint in the tracked repo
  (DEC-051). Tracking is opt-in and, when done, goes through a graceful shim so
  non-users are a no-op, never an error.
- **Self-identifying + reversible.** Wizard-written wiring is identifiable
  (the command references `command_guard`) so it can be removed precisely without
  disturbing a user's own keys or other tools' hooks. **Easy in, easy out.**

## Teardown — removing the wiring

`setup_wizard.ts --mode teardown` (run from `__garelier/<pm_id>/_pm/`) reverses
the wiring:

- **(a)** strips *only* the command_guard hook from the project-root and each
  role checkout's `settings.local.json` — a merge-aware removal that leaves every
  other key and any other tool's hooks intact, and deletes a settings file only
  if it becomes empty (via `install_hook.ts --uninstall`);
- **(b)** **inventories** the remaining worktrees / containers and hands them to
  the `deletion_and_forcewrite_safety.md` two-stage rule (inventory → approval →
  remove) — teardown never deletes a worktree or any data on its own;
- then prints the `doctor` command to verify no wiring residue remains.

`doctor` reports **`command-guard-residue`** (P1) if a hook is still registered
but the guard binary is gone (a move or a partial teardown), and
**`command-guard-hook`** (P2) when no hook is registered at all.

## Diagnosing where the hook is

- Check a checkout: look for `command_guard` in
  `<checkout>/.claude/settings.local.json`.
- Check the attended path: look for it in `<project>/.claude/settings.local.json`
  (and `.claude/settings.json`, `~/.claude/settings.json`).
- `doctor` reports `command-guard-hook` (P2) when no hook is registered and
  `command-guard-residue` (P1) when a hook is registered but the guard is gone
  (see Teardown below).

## 2026-07-17/18 再設計 (W-118〜W-133) — 実運用で判明した class と現行の判定機構

aby_works (target project) での 2 日間の実戦投入で、ask/deny 誤発火の class を実測駆動で
潰した。現行の判定 pipeline と record 供給網は以下が正:

### 判定 pipeline (現行)

1. **agent 同定** (`resolveAgentName`): payload の `agent_name ?? agent_type ?? agent_id`
   (W-125 — 実 payload は agent_type が spawn 名を運ぶ)。bare-hash agent_id のみの payload は
   W-133 fallback (command の信頼済み絶対 cd 先 → container 推定) へ。
2. **record 解決** (`findDispatchPermissionRecord`): explicit env → cwd-walk context.json →
   lane `.meta` → **全祖先 `__garelier` root を近い順に走査** (W-126 — full-repo checkout の
   内側 committed tree に遮られない)。gate 席は producer context.json の `gate_agents.*.name`
   一致で合成 record (W-129)。record 内の相対 path は **record file 位置基準で resolve**
   (W-127 — hook cwd は使わない)。record 皆無 + `ga-guardian/observer/refuter-*` 名は
   naming fallback で gate profile (W-130、安全方向のみ)。**W-174: `context.json` の信用は
   POSITIVE LOCATION ALLOWLIST** (R3、denylist から転換 — 1-field `worktree` claim で全 signal
   回避された Observer 反例を根絶)。信用するのは唯一の dispatcher 配置形のみ: 親 dir が
   dispatch container (`_?dispatch<N>`) **かつ** (worktree 宣言時は) worktree が container 配下
   (`<container>/checkout`) を指す。それ以外の場所 (lane worktree・checkout 内・任意 dir、
   宣言 worktree/fence 不問) は不採用。fence_roots は判定に使わない (PM-direct は repo root を
   fence — R1)。正規 lane record は `_crew/lanes/.meta/*.dispatch.json` (別 basename、対象外)。
   不採用 record は **`guard_record_rejected` として incidents.jsonl に report** (silent drop 禁止、
   進行中 forge / 正規移行の誤爆を PM が可視化)。不採用時は real container record か record-less
   baseline へ。**残課題**: 自 worktree 内に allowlist 形 (`<own>/_dispatch9/checkout`) を作り込む
   模倣は provenance nonce (dispatcher 署名) で完全閉塞予定 (W-174 row 残)。
3. **fence anchor** (W-119): 「own worktree」は **per-segment** に、command 自身の絶対リテラル
   cd → record worktree の順で導出。**hook の session cwd は fence 判定に使わない**
   (persistent-cwd 汚染事故 #348 の再発防止)。
4. **分類**: 複合 command は segment 分解し全 segment 安全なら allow (W-118)。inert redirect
   (`2>/dev/null` 等) は分類前に strip (W-120)。mutation 動詞は `MUTATION_VERBS` 単一定義
   (W-128 — quoted 引数の空文字化 throw を根絶)。
5. **unknown の既定** (W-122): **信頼 fence が解決できる producer は unknown → allow**
   (user リスクモデル「このフォルダ内ならバグってもいいが fence 外事故は不可」準拠)。
   deny 床 (drive root / 浅 path / 祖先 / `.git` / fence 外削除 / egress / secret / force) は
   全 seat で unknown-allow より優先 (strictest-wins)。record 無し = 従来通り ask (fail-closed)。
   gate 席は unknown → deny のまま (read-only 保証、unknown_action を意図的に付けない)。

### record 供給網

| 席 | record 供給 | 手作業 |
| --- | --- | --- |
| dispatch producer | `dispatch_prepare.ts` が context.json guard block (絶対 path、W-127) | なし |
| dispatch gate 席 | 同 context.json の `gate_agents` 名から自動合成 (W-129) | なし |
| ad-hoc gate 席 (design reviewer 等) | naming fallback (W-130) | なし |
| PM-attended producer (isolate lane 等) | `attended_record.ts --agent <name> --worktree <abs> --profile producer` — **spawn の前に発行** (後発行だと初回 command が ask、実測 2 回) | 1 command |
| PM-direct 宣言 lane | `attended_record.ts --pm-direct` が `lane_kind: "pm-direct"` record を発行 → `contract_check.ts --stall-scan` は advisory 表示のみ (hard `BYPASS-SPAWN` でない、W-155/DEC-093) | 1 command |
| 同定不能 payload (bare-hash) | W-133 cd-先 container 推定 fallback | なし |

### 診断 = guard trace

ask/deny (および `GARELIER_GUARD_TRACE=1` で全件) を
`guardRuntimeDir(cwd)/guard_trace.jsonl` (下記 *Where guard output lands*) に 1 行 JSON で記録
(`{ts, cwd, agent_*, resolved_agent, record_found, profile, rule, action, command(80 字)}`)。
**ask の screenshot を人間から貰う前に trace を読む** — 「simulation は緑だが実物は ask」の
推測 loop はこれで終わった (実績: 導入直後に record 発行順序ミス・bare-hash payload・
trace 自身の path bug W-131 を一晩で特定)。

### on/off (project-local、user 権限)

- off: `bun install_hook.ts --uninstall <project>/.claude/settings.local.json`
- on: `bun install_hook.ts <project>/.claude/settings.local.json <command_guard.ts path>`
- 組織設定があればそれが優先。on/off は user/PM の裁量 (2026-07-17 user 確認)。

### incident catalog (実測駆動の修正履歴)

W-113 (profile 束) → W-118 (fenced read-only 連鎖) → W-119 (fence anchor per-segment 化) →
W-120 (inert redirect / read-only preset) → W-122 (fence 内 unknown-allow + attended_record) →
W-125 (agent_type 同定) → W-126 (nested-checkout 貫通 + trace) → W-127 (record 絶対 path) →
W-128 (MUTATION_VERBS 単一定義) → W-129 (gate 席自動解決) → W-130 (naming fallback) →
W-131 (trace path 修正) → W-133 (bare-hash fallback) → W-139 (BYPASS-SPAWN detective) →
W-150 (deny floor の git global-opts strip) → W-153 (read-only preset の git global-opts strip) →
W-155 (宣言済 pm-direct lane = advisory) → W-174 (context.json record の location allowlist) →
W-176 (wholly read-only 短絡 allow + `$(`/`<(`/`&`/write-form escape 閉塞) →
W-177 (write-form flag の path-fence model) →
W-179 (a: read-only 制御構造の再帰 allow / b: lane record の cwd-containment 採用 /
c: guard_ask の FLEET-ATTENTION surfacing / **d: PM 解決モード + profile 別
learning-loop list** — 上記「Resolution mode」節)。
教訓: **fail-closed の ask は安全だが、ask の摩擦は guard の死** (user が off にする) —
誤 ask は 1 件ずつ class として特定し、安全方向の自動解決だけを積む。

### Where guard output lands (W-188)

Guard report (`incidents.jsonl`) と trace (`guard_trace.jsonl`) は同一 dir、
`guardRuntimeDir(cwd)` が決める。**Garelier は導入先 repo の間借り人であり、
project root に状態 dir を作らない** — 全て `__garelier/` 配下に閉じる。

| 条件 | 書込先 |
| :--- | :--- |
| cwd が `__garelier/<pm>/…` 配下 | `__garelier/<pm>/runtime/hooks/` |
| それ以外で `GARELIER_PM_ID` が実在 pm を指す | `__garelier/<pm>/runtime/hooks/` |
| それ以外で `__garelier/` 直下の pm が唯一 (`__` 始まりは pm でない) | `__garelier/<pm>/runtime/hooks/` |
| 複数 pm で帰属不能 | `__garelier/__atmos/guard/unresolved/` (既存共有 tier。新階層も偽 pm id も作らない) |
| `__garelier` が無い project | **書かない・作らない** (deny/allow 判定は不変、report が出ないだけ) |

v2.13.1 以前は最後の 2 行が project root の `.claude/runtime/garelier/` に落ちていた
(消費側 repo を汚す規約違反)。読み手 (`dock_status` / `fleet_watch`) は移行のため
旧 path も READ するが、書込は無い。旧 dir は transient なので削除して良い。

## See also

- `deletion_and_forcewrite_safety.md`, `injection_and_egress.md`,
  `package_policy.md` — the prose this hook enforces.
- `command_guard_policy.toml` (control/operations/) — per-class action overrides
  and the network allow-list.
- `driver/src/guard/attended_record.ts` — PM-attended spawn への record 発行 CLI (W-122)。
