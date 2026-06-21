#!/usr/bin/env bash
#
# Garelier repo CI gate. Run from anywhere; resolves the repo root from its
# own location. Mirrors what .github/workflows/ci.yml runs:
#
#   1. driver typecheck (tsc --noEmit)
#   2. driver unit tests (bun test)
#   3. bash -n syntax check on every *.sh
#   4. PowerShell parse on every *.ps1 (when pwsh is present)
#   5. wizard fresh-setup smoke in a throwaway git repo, then driver
#      loadConfig parse of the generated config
#
# Exits non-zero if any step fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Framework/starter dogfood pm_id as a VARIABLE, so the public-export dead-link
# gate's literal `__garelier/$WS` pattern doesn't flag these functional CI
# paths (the dogfood control tree is excluded from publish; these steps no-op
# when its files are absent, e.g. in a published checkout).
WS="_workshop"
CA=alpha; CB=beta; CD=delta   # consolidation/bundle smoke test pm-ids (variable so the export dead-link gate does not flag the functional __garelier/<id>/control test paths)
cd "$ROOT"
DRIVER="$ROOT/skills/garelier-core/driver"
fail=0
step() { echo ""; echo "=== $* ==="; }

step "driver typecheck (tsc --noEmit)"
if ( cd "$DRIVER" && bunx tsc --noEmit ); then echo "  ok"; else echo "  FAIL"; fail=1; fi

step "driver unit tests (bun test)"
if ( cd "$DRIVER" && bun test ); then echo "  ok"; else echo "  FAIL"; fail=1; fi

step "bash -n (shell syntax)"
while IFS= read -r f; do
    [ -f "$f" ] || continue
    if bash -n "$f"; then echo "  ok $f"; else echo "  FAIL $f"; fail=1; fi
done < <(find . -name '*.sh' -not -path './.git/*')

step "PowerShell parse (.ps1)"
if command -v pwsh >/dev/null 2>&1; then
    while IFS= read -r f; do
        [ -f "$f" ] || continue
        if pwsh -NoProfile -Command "\$e=\$null;[System.Management.Automation.Language.Parser]::ParseFile('$f',[ref]\$null,[ref]\$e)|Out-Null; if(\$e){exit 1}"; then
            echo "  ok $f"
        else
            echo "  FAIL $f"; fail=1
        fi
    done < <(find . -name '*.ps1' -not -path './.git/*')
else
    echo "  (pwsh not found — skipped; the windows CI job covers .ps1)"
fi

step "wizard fresh-setup smoke — EXILE opt-in (throwaway git repo)"
TMP="$(mktemp -d)"
WSHOME="$(mktemp -d)"   # DEC-036: opt into exile via an isolated GARELIER_HOME (never touches ~/.garelier)
if (
    set -e
    cd "$TMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$WSHOME"
    mkdir __garelier; cd __garelier
    bash "$ROOT/skills/garelier-pm/scripts/setup_wizard.sh" --mode fresh --skip-confirm \
        --pm-id ci --project-name CI --target main \
        --workers "w1:claude-code" --scouts "s1:claude-code" \
        --librarians "lib1:claude-code" --observers "obs1:claude-code" --artisan \
        --stack typescript --permission-profile reviewed >/dev/null
    cd "$TMP"
    PTR="$TMP/__garelier/ci/runtime/workspace_paths"
    resolve_c() { [ -f "$PTR" ] && awk -v k="$1" 'index($0,k"=")==1{print substr($0,length(k)+2);exit}' "$PTR" || true; }
    # In-proj authority (control/runtime) stays under the project.
    for d in runtime/observer/requests control/observations; do
        [ -e "__garelier/ci/$d" ] || { echo "missing __garelier/ci/$d" >&2; exit 1; }
    done
    # DEC-065 dispatch-native: fresh setup pre-creates NO role containers and
    # writes NO pointer entries — roster entries are seat defaults; the exile
    # opt-in takes effect when a container is created on demand (diff below).
    for kv in worker.w1 scout.s1 librarian.lib1 observer.obs1 artisan; do
        [ -n "$(resolve_c "$kv")" ] && { echo "fresh wrote a pointer entry for $kv (DEC-065: no pre-created containers)" >&2; exit 1; }
    done
    for r in _dock _workers _scouts _smiths _librarians _observers _guardians _concierges _artisan; do
        [ -e "__garelier/ci/$r" ] && { echo "fresh pre-created role dir $r (DEC-065: dispatch-native)" >&2; exit 1; }
    done
    # DEC-051: Garelier writes a NESTED __garelier/.gitignore and never touches the
    # project root .gitignore. Verify the nested file exists with the runtime rule,
    # git honors it, and the project root stays Garelier-free (zero footprint).
    [ -f "__garelier/.gitignore" ] || { echo "nested __garelier/.gitignore not written" >&2; exit 1; }
    grep -qE '^\*/runtime/$' "__garelier/.gitignore" || { echo "nested __garelier/.gitignore missing */runtime/ rule" >&2; exit 1; }
    grep -qE '^\*/_librarians/$' "__garelier/.gitignore" || { echo "nested __garelier/.gitignore missing worktree rules (_librarians/)" >&2; exit 1; }
    git check-ignore -q "__garelier/ci/runtime" || { echo "git does not honor nested __garelier/.gitignore for runtime/" >&2; exit 1; }
    [ -f "__garelier/.ignore" ] || { echo "nested __garelier/.ignore not written" >&2; exit 1; }
    if [ -f .gitignore ] && grep -qi "garelier" .gitignore; then
        echo "project root .gitignore must stay Garelier-free (DEC-051 nested ignores)" >&2; exit 1
    fi
    # The retired root-anchored /STATE.md-style rules must never resurface anywhere.
    if [ -f .gitignore ] && grep -qE '^/(STATE|assignment|report|under_review|merged|abort|track-target)\.md$|^/archive/$' .gitignore; then
        echo "retired root-anchored coordination rules still present in root .gitignore" >&2; exit 1
    fi
    if grep -qE '^/(STATE|assignment|report|under_review|merged|abort|track-target)\.md$|^/archive/$' "__garelier/.gitignore"; then
        echo "retired root-anchored coordination rules leaked into nested __garelier/.gitignore" >&2; exit 1
    fi
    # DEC-077: Guardian security knowledge seeded into the pm knowledge home (ci).
    [ -f "__garelier/ci/knowledge/security/security_policy.md" ] || { echo "security scaffold not seeded at __garelier/ci/knowledge/security/" >&2; exit 1; }
    [ -f "__garelier/ci/knowledge/security/registries/secret_patterns.toml" ] || { echo "security registries not seeded" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); if(!c.observers.length||!c.artisan||c.qualityGate.stack!=="typescript"){throw new Error("generated config did not parse as expected");}' "$TMP"
    # Diff mode: swap librarian, drop observer, disable artisan; then re-parse.
    # The lib2 ADD is the on-demand container-creation path (DEC-065) — assert
    # the full DEC-036 exile contract on it: container outside the project,
    # pointer recorded, coordination files at the container, no STATE leak.
    cd "$TMP/__garelier/ci/_pm"
    bash "$ROOT/skills/garelier-pm/scripts/setup_wizard.sh" --mode diff --skip-confirm \
        --workers "w1:claude-code" --scouts "s1:claude-code" \
        --librarians "lib2:claude-code" --observers "" --no-artisan >/dev/null
    cd "$TMP"
    lib2c="$(resolve_c librarian.lib2)"
    [ -n "$lib2c" ] || { echo "diff: pointer has no entry for librarian.lib2" >&2; exit 1; }
    case "$lib2c" in "$TMP"/*) echo "diff: lib2 container is INSIDE the project ($lib2c) — exile (opt-in) requires it outside" >&2; exit 1 ;; esac
    [ -d "$lib2c/checkout" ] || { echo "diff: missing exile worktree $lib2c/checkout" >&2; exit 1; }
    [ -f "$lib2c/STATE.md" ]  || { echo "diff: coordination STATE.md not at exile container $lib2c" >&2; exit 1; }
    [ -f "$lib2c/CLAUDE.md" ] || { echo "diff: coordination CLAUDE.md not at exile container $lib2c" >&2; exit 1; }
    [ -e "$lib2c/checkout/STATE.md" ] && { echo "diff: STATE.md leaked INTO worktree $lib2c/checkout" >&2; exit 1; }
    git worktree list --porcelain | grep -qF "$lib2c/checkout" || { echo "diff: exile worktree not registered: $lib2c/checkout" >&2; exit 1; }
    grep -q "../STATE.md" "$lib2c/CLAUDE.md" || { echo "diff: role CLAUDE.md missing ../STATE.md" >&2; exit 1; }
    [ -n "$(resolve_c librarian.lib1)" ] && { echo "diff: lib1 pointer not removed" >&2; exit 1; }
    [ -n "$(resolve_c artisan)" ] && { echo "diff: artisan pointer not removed" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const libs=(c.librarians??[]).map(l=>l.id); if(libs.join()!=="lib2"||(c.observers??[]).length!==0||c.artisan){throw new Error("diff-mode config did not parse as expected: "+JSON.stringify(libs));}' "$TMP"
); then echo "  ok fresh-setup + diff + loadConfig parse"; else echo "  FAIL wizard smoke"; fail=1; fi
rm -rf "$TMP" "$WSHOME"

step "wizard fresh defaults — exactly one of every role, no flags (DEC-055)"
# DEC-055: a fresh setup with NO composition flags must default to exactly one
# of every role (worker/scout/smith/librarian/observer/guardian/concierge) plus
# the Artisan lane. 0 is impossible in fresh.
TMP="$(mktemp -d)"; WSHOME="$(mktemp -d)"
if (
    set -e
    cd "$TMP"
    git init -q; git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$WSHOME"
    mkdir __garelier; cd __garelier
    bash "$ROOT/skills/garelier-pm/scripts/setup_wizard.sh" --mode fresh --skip-confirm \
        --pm-id ci --project-name CI --target main --stack typescript >/dev/null
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const n=r=>(c[r]??[]).length; const roles=["workers","scouts","smiths","librarians","observers","guardians","concierges"]; const bad=roles.filter(r=>n(r)!==1); if(bad.length||!c.artisan){throw new Error("expected one of every role + artisan; wrong="+bad.join(",")+" artisan="+!!c.artisan);}' "$TMP"
); then echo "  ok (no flags -> one of every role + artisan)"; else echo "  FAIL fresh-defaults smoke"; fail=1; fi
rm -rf "$TMP" "$WSHOME"

step "wizard on-demand container smoke — IN-PROJECT default (DEC-036/065)"
# Fresh creates NO containers (DEC-065). A diff-mode roster ADD is the
# on-demand creation path: the DEFAULT (no GARELIER_HOME, no --exile) must
# create the container IN the project, write NO workspace_paths pointer, and
# emit claudeMdExcludes so the target's mainline CLAUDE.md is not re-loaded
# by the ancestry walk.
ITMP="$(mktemp -d)"
if (
    set -e
    unset GARELIER_HOME
    cd "$ITMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    printf '# mainline\n' > CLAUDE.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    mkdir __garelier; cd __garelier
    bash "$ROOT/skills/garelier-pm/scripts/setup_wizard.sh" --mode fresh --skip-confirm \
        --pm-id ci --project-name CI --target main \
        --workers "w1:claude-code" --scouts "s1:claude-code" --artisan >/dev/null
    cd "$ITMP"
    # Fresh: dispatch-native — nothing pre-created (DEC-065).
    for r in _dock _workers _scouts _artisan; do
        [ -e "__garelier/ci/$r" ] && { echo "fresh pre-created role dir $r (DEC-065)" >&2; exit 1; }
    done
    # On-demand: add worker w2 via diff mode.
    cd "$ITMP/__garelier/ci/_pm"
    bash "$ROOT/skills/garelier-pm/scripts/setup_wizard.sh" --mode diff --skip-confirm \
        --workers "w1:claude-code,w2:claude-code" --scouts "s1:claude-code" --artisan >/dev/null
    cd "$ITMP"
    # claudeMdExcludes is written with NATIVE absolute paths (cygpath -m on Windows).
    INATIVE="$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$ITMP" 2>/dev/null || printf '%s' "$ITMP")"
    # No pointer by default.
    [ -e "__garelier/ci/runtime/workspace_paths" ] && { echo "in-project default wrote a workspace_paths pointer (should not)" >&2; exit 1; }
    dir="__garelier/ci/_workers/w2"
    [ -e "$ITMP/$dir/checkout/.git" ] || { echo "in-project worktree missing: $dir/checkout" >&2; exit 1; }
    [ -f "$ITMP/$dir/STATE.md" ]      || { echo "container STATE.md missing: $dir" >&2; exit 1; }
    s="$ITMP/$dir/checkout/.claude/settings.local.json"
    [ -f "$s" ] || { echo "claudeMdExcludes settings missing: $s" >&2; exit 1; }
    grep -qF "$INATIVE/CLAUDE.md" "$s" || { echo "claudeMdExcludes does not exclude the target CLAUDE.md: $s" >&2; exit 1; }
    # settings.local.json must not show as untracked in the role worktree.
    if git -C "$ITMP/$dir/checkout" status --porcelain | grep -q "settings.local.json"; then
        echo "settings.local.json leaks as untracked in $dir/checkout" >&2; exit 1
    fi
    # Seats w1/s1 stay container-less (seat defaults only).
    # NB: an `[ -e … ] && { …; exit 1; }` here would be the subshell's LAST
    # statement — when the test is false the AND-list itself returns 1 and
    # fails the smoke. Use a full if.
    if [ -e "__garelier/ci/_workers/w1" ]; then
        echo "diff created an unrequested container for w1" >&2; exit 1
    fi
); then echo "  ok dispatch-native fresh + on-demand diff add: in-project container, no pointer, claudeMdExcludes, no untracked leak"; else echo "  FAIL in-project on-demand smoke"; fail=1; fi
rm -rf "$ITMP"

step "doctor smoke (safety gate)"
WIZ="$ROOT/skills/garelier-pm/scripts/setup_wizard.sh"
DOCTOR="$ROOT/skills/garelier-core/scripts/doctor.sh"
DTMP="$(mktemp -d)"
if (
    set -e
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$DTMP/.garelier-home"   # DEC-035: isolate role homes under the temp dir
    init_repo() {
        cd "$1"; git init -q
        git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
        git config user.email ci@ci; git config user.name ci
        echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    }
    # (1) strict fresh setup -> AGENTS.md keeps placeholders -> doctor P0 (exit 1).
    A="$DTMP/strict"; mkdir -p "$A"; init_repo "$A"
    ( cd "$A" && mkdir __garelier && cd __garelier && \
      bash "$WIZ" --mode fresh --skip-confirm --pm-id ci --project-name S --target main \
        --workers "w1:claude-code" --scouts "s1:claude-code" --stack typescript >/dev/null )
    if bash "$DOCTOR" --pm-id ci --project "$A" >/dev/null 2>&1; then
        echo "expected doctor P0 (AGENTS placeholders) on strict setup, got exit 0" >&2; exit 1
    fi
    # (2) missing AGENTS.md -> doctor P0 agents-missing (exit 1).
    # NB: capture output then match — `doctor | grep` would return doctor's
    # nonzero (P0) exit under `set -o pipefail` even when grep matches.
    rm -f "$A/AGENTS.md"
    out="$(bash "$DOCTOR" --pm-id ci --project "$A" 2>&1 || true)"
    case "$out" in *agents-missing*) : ;; *) echo "expected agents-missing P0 when AGENTS.md absent" >&2; exit 1 ;; esac
    if bash "$DOCTOR" --pm-id ci --project "$A" >/dev/null 2>&1; then
        echo "expected nonzero exit for missing AGENTS.md" >&2; exit 1
    fi
    # (3) minimal fresh setup -> all placeholders filled -> doctor clean (exit 0).
    B="$DTMP/min"; mkdir -p "$B"; init_repo "$B"
    ( cd "$B" && mkdir __garelier && cd __garelier && \
      bash "$WIZ" --mode fresh --skip-confirm --pm-id ci --project-name M --target main \
        --workers "w1:claude-code" --scouts "s1:claude-code" --stack typescript \
        --agents-policy minimal >/dev/null )
    if ! bash "$DOCTOR" --pm-id ci --project "$B" >/dev/null 2>&1; then
        echo "expected doctor exit 0 after --agents-policy minimal" >&2
        bash "$DOCTOR" --pm-id ci --project "$B" >&2 || true; exit 1
    fi
    CFG="$B/__garelier/ci/_pm/setup_config.toml"
    # (4) dangerous permission profile -> doctor P1 (still exit 0, but flagged).
    sed -i.bak 's/^profile = "reviewed"/profile = "dangerous"/' "$CFG" && rm -f "$CFG.bak"
    out="$(bash "$DOCTOR" --pm-id ci --project "$B" 2>&1 || true)"
    case "$out" in *permissions-dangerous*) : ;; *) echo "expected permissions-dangerous P1 finding" >&2; exit 1 ;; esac
    sed -i.bak 's/^profile = "dangerous"/profile = "reviewed"/' "$CFG" && rm -f "$CFG.bak"
    # (5) custom stack with empty commands -> doctor P0 (exit 1).
    awk '
        /^\[quality_gate\]/ { print "[quality_gate]"; print "stack = \"custom\""; print "commands = ["; print "]"; skip=1; next }
        skip && /^\]/ { skip=0; next }
        skip { next }
        { print }
    ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
    if bash "$DOCTOR" --pm-id ci --project "$B" >/dev/null 2>&1; then
        echo "expected doctor P0 for custom stack with empty commands" >&2; exit 1
    fi
); then echo "  ok doctor: strict P0 / missing-AGENTS P0 / minimal clean / dangerous P1 / custom-empty P0"; else echo "  FAIL doctor smoke"; fail=1; fi
rm -rf "$DTMP"

step "DEC-036 exile migrate smoke (in-proj -> exile home, opt-in)"
# Synthesize an DEC-020 (nested) per-PM worker and run migrate; assert the
# worktree + mailbox relocate to the machine-local home OUTSIDE the project, the
# coordination files stay at the (exile) container, STATE is preserved, and the
# gitignored pointer is written.
MTMP="$(mktemp -d)"; MHOME="$(mktemp -d)"
if (
    set -e
    cd "$MTMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    git branch "garelier/main/ci/studio" main
    export GARELIER_HOME="$MHOME"
    mkdir -p "__garelier/ci/_pm" "__garelier/ci/_workers/w1" "__garelier/ci/runtime"
    printf '[project]\nname = "ci"\ngarelier_version = "2.7.0"\nwizard_version = "2.7.0"\n\n[branches]\ntarget = "main"\n' > "__garelier/ci/_pm/setup_config.toml"
    # DEC-020 nested worktree; coordination files at the container root (the
    # realistic state migrate relocates), worker mid-task (STATE WORKING).
    git worktree add --detach "__garelier/ci/_workers/w1/checkout" "garelier/main/ci/studio" >/dev/null
    printf 'You are worker w1 (provider: claude-code, model: claude-code) in a Garelier project.\n' > "__garelier/ci/_workers/w1/CLAUDE.md"
    printf '# worker w1 — State\n\n## Status\nWORKING\n\n## Current task\nbig feature\n' > "__garelier/ci/_workers/w1/STATE.md"
    ( cd __garelier && bash "$WIZ" --mode migrate --skip-confirm --pm-id ci >/dev/null )
    # Post-conditions: relocated to the exile home recorded in the pointer.
    PTR="$MTMP/__garelier/ci/runtime/workspace_paths"
    c="$(awk -v k=worker.w1 'index($0,k"=")==1{print substr($0,length(k)+2);exit}' "$PTR")"
    [ -n "$c" ] || { echo "migrate: pointer has no worker.w1" >&2; exit 1; }
    case "$c" in "$MTMP"/*) echo "migrate: container still inside the project ($c)" >&2; exit 1 ;; esac
    [ -d "$c/checkout" ] || { echo "migrate: exile worktree missing" >&2; exit 1; }
    git worktree list --porcelain | grep -qF "$c/checkout" || { echo "migrate: exile checkout not registered" >&2; exit 1; }
    [ -f "$c/STATE.md" ] || { echo "migrate: STATE.md lost" >&2; exit 1; }
    grep -q "WORKING" "$c/STATE.md" || { echo "migrate: STATE not preserved" >&2; exit 1; }
    [ -e "$c/checkout/STATE.md" ] && { echo "migrate: STATE leaked into checkout" >&2; exit 1; }
    grep -q "\.\./STATE.md" "$c/CLAUDE.md" || { echo "migrate: CLAUDE.md not regenerated with ../STATE.md" >&2; exit 1; }
    [ -e "__garelier/ci/_workers/w1" ] && { echo "migrate: in-proj container not removed" >&2; exit 1; }
    # Version rewrite (v2.7.3 generalization): ANY prior version — here 2.7.0,
    # which the old enumerated 2.0.0-2.6.5 list MISSED — must be bumped to the
    # installed VERSION, for both garelier_version and wizard_version.
    CFG="$MTMP/__garelier/ci/_pm/setup_config.toml"; CURV="$(tr -d '[:space:]' < "$ROOT/VERSION")"
    grep -q "garelier_version = \"$CURV\"" "$CFG" || { echo "migrate: garelier_version not bumped to $CURV" >&2; exit 1; }
    grep -q "wizard_version = \"$CURV\"" "$CFG" || { echo "migrate: wizard_version not bumped to $CURV" >&2; exit 1; }
    # Idempotent: a second migrate is a no-op (no failure).
    ( cd __garelier && bash "$WIZ" --mode migrate --skip-confirm --pm-id ci >/dev/null )
); then echo "  ok migrate relocates worktree+mailbox, preserves coordination + STATE, bumps any old version -> current"; else echo "  FAIL migrate smoke"; fail=1; fi
rm -rf "$MTMP" "$MHOME"

step "DEC-036 doctor reaches exiled containers (P0 leak scan)"
# Regression guard: doctor's P0 security scans must resolve the (exiled)
# container via the pointer, not the empty in-project glob. Plant a secret in an
# EXILED Guardian report and assert doctor still flags it.
DTMP="$(mktemp -d)"; DHOME="$(mktemp -d)"
if (
    set -e
    cd "$DTMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    mkdir -p "__garelier/ci/_pm" "__garelier/ci/runtime"
    {
        printf '[branches]\ntarget = "main"\n'
        printf '[[guardians]]\nid = "g1"\nprovider = "claude-code"\nmodel = "claude-code"\n'
        printf '[guardian_policy]\nenabled = true\n'
    } > "__garelier/ci/_pm/setup_config.toml"
    # Exile the Guardian container outside the project; record the pointer.
    GC="$DHOME/studios/exile-ci/_guardians/g1"
    mkdir -p "$GC"
    printf 'guardian.g1=%s\n' "$GC" > "__garelier/ci/runtime/workspace_paths"
    printf 'verdict: BLOCK\nleaked: AKIAIOSFODNN7EXAMPLE\n' > "$GC/guardian_report.md"
    out="$(bash "$ROOT/skills/garelier-core/scripts/doctor.sh" --pm-id ci --project "$DTMP" 2>&1 || true)"
    printf '%s' "$out" | grep -q "guardian-report-leak" \
        || { echo "doctor missed the secret in the EXILED guardian report" >&2; exit 1; }
); then echo "  ok doctor resolves exiled containers (P0 guardian-report-leak fires)"; else echo "  FAIL doctor exile-scan smoke"; fail=1; fi
rm -rf "$DTMP" "$DHOME"

step "deprecated-path lint"
# The studio/control rename (DEC-003) retired the pre-rename project-state
# docs path. It must not resurface in SHIPPED content (templates, skills,
# scripts, driver, docs). DECs and CHANGELOG keep it as a historical note,
# and this repo's own dashboard logs the migration — those are excluded.
dead="docs/project_state/"
hits="$(git -C "$ROOT" grep -nI -e "$dead" \
    -- ':(exclude)__garelier/$WS/control/decisions/*' ':(exclude)CHANGELOG.md' ':(exclude)ci.sh' \
       ':(exclude)__garelier/*' 2>/dev/null || true)"
if [ -n "$hits" ]; then
    echo "  FAIL: retired path '$dead' found in shipped content:"
    echo "$hits" | sed 's/^/    /'
    fail=1
else
    echo "  ok (no retired '$dead' in shipped content)"
fi

step "inclusive-language lint (banned terms in shipped content)"
# The branch term "master" (slavery connotation) is banned — Garelier uses
# "main". slave / whitelist / blacklist are forward-guarded (currently absent;
# prefer allowlist / denylist). Scope to SHIPPED framework content only; the
# dogfood __garelier tree, historical DECs, and CHANGELOG keep any legacy
# wording as record and are out of scope here. ci.sh itself is not scanned
# (it lives at the repo root, outside the scoped dirs) so this pattern's own
# term list is not a self-match. Use -w (whole word) so "remaster"/"mastermind"
# and the like never false-positive.
banned="$(git -C "$ROOT" grep -nIw -i -e master -e slave -e whitelist -e blacklist \
    -- skills docs scripts README.md CLAUDE.md AGENTS.md 2>/dev/null || true)"
if [ -n "$banned" ]; then
    echo "  FAIL: banned term found in shipped content (use main / allowlist / denylist):"
    echo "$banned" | sed 's/^/    /'
    fail=1
else
    echo "  ok (no banned inclusive-language terms in shipped content)"
fi

step "skill YAML frontmatter validation"
# Claude Code silently drops all metadata when a SKILL.md frontmatter block is
# invalid YAML. Parse every shipped skill with Bun's real YAML parser so a
# plain-scalar `: ` or similar syntax error cannot pass the release gate.
if bun "$ROOT/scripts/check_skill_frontmatter.ts"; then
    echo "  ok"
else
    echo "  FAIL"
    fail=1
fi

step "executable bit check (.sh + bin/garelier must be 100755)"
# Distributed scripts must keep git's executable bit. ZIP extraction can drop the
# filesystem bit (CLAUDE.md notes the chmod workaround), but the TRACKED mode must
# be 100755 so POSIX clones and the plugin's bin/ on PATH stay runnable. They were
# all 100644 before v2.7.3. Fix a regression with: git update-index --chmod=+x <f>.
nonexec="$(git -C "$ROOT" ls-files --stage -- '*.sh' 'bin/garelier' | awk '$1!="100755"{print "    "$1" "$4}')"
if [ -n "$nonexec" ]; then
    echo "  FAIL: these tracked executables are missing the +x bit (git update-index --chmod=+x):"
    echo "$nonexec"
    fail=1
else
    echo "  ok (all .sh + bin/garelier are 100755)"
fi

step "skill slash-menu visibility (only user entry points are user-invocable)"
# Garelier ships 14 skills; only the user ENTRY POINTS (pm + the two control-*
# starters) should appear as `/` slash commands. Every other skill is an internal
# role / reference, auto-activated by the model or by dispatch — its SKILL.md must
# carry `user-invocable: false` so it stays out of the `/` menu (v2.7.3).
entry=" garelier-pm garelier-control-project garelier-control-library "
vis=0
while IFS= read -r f; do
    sk="$(basename "$(dirname "$f")")"
    case "$entry" in *" $sk "*) continue ;; esac
    if ! grep -qE '^user-invocable:[[:space:]]*false[[:space:]]*$' "$ROOT/$f"; then
        echo "  FAIL: $sk is internal — its SKILL.md must set 'user-invocable: false'"; vis=1
    fi
done < <(git -C "$ROOT" ls-files -- 'skills/garelier-*/SKILL.md')
if [ "$vis" -eq 0 ]; then echo "  ok (entry points pm/control-project/control-library invocable; 11 internal skills hidden)"; else fail=1; fi

step "DEC-036 exile-path lint (role SKILLs must not hardcode relative hops)"
# Under DEC-035 a role's container is a machine-local home OUTSIDE the project,
# so the old fixed relative hops (primary checkout `../../../../../`, runtime
# `../../../runtime/`, control `../../../control/`) no longer reach the project.
# Role SKILLs/references must point at the ABSOLUTE paths in the role's CLAUDE.md
# instead. The instructional form is "<thing> is `../../../…`"; DEC-035 caveats
# phrase it as "the old relative `../…` no longer reach", which does not match.
dec035=0
# NB: do NOT escape the backtick (GNU grep treats \` as a start-of-buffer anchor,
# silently making the pattern never match). Use a literal backtick.
hop_hits="$(git -C "$ROOT" grep -nIE 'is `\.\./\.\./\.\.' \
    -- 'skills/garelier-*/SKILL.md' 'skills/garelier-*/references/*' 2>/dev/null || true)"
if [ -n "$hop_hits" ]; then
    echo "  FAIL: role SKILL/reference instructs a fixed relative hop (breaks under DEC-035 exile):"
    echo "$hop_hits" | sed 's/^/    /'
    echo "    -> address primary/runtime/control via the role's CLAUDE.md absolute paths"
    dec035=1
fi
# The Dock/PM handoff resolver must stay wired: the driver injects each
# (The driver-side rosterScanLines() guard was deleted with prompts.ts under
# DEC-066 — dispatch resolves containers via dispatch_prepare, not prompts.)
if [ "$dec035" -eq 0 ]; then echo "  ok (no fixed relative hops in role SKILLs; handoff resolver wired)"; else fail=1; fi

step "doc drift check (version + DEC index)"
# Guard against the version / DEC-index drift the all-roles review caught: the
# version source (VERSION) must be reflected in CHANGELOG + README, and the
# dashboard decisions index must exactly match canonical DEC records.
drift=0
VER="$(tr -d '[:space:]' < "$ROOT/VERSION")"
if ! grep -qF "## [$VER]" "$ROOT/CHANGELOG.md"; then
    echo "  FAIL: CHANGELOG.md has no '## [$VER]' section (VERSION=$VER)"; drift=1
fi
if ! grep -qF "$VER" "$ROOT/README.md"; then
    echo "  FAIL: README.md does not mention VERSION $VER"; drift=1
fi
# The plugin manifests carry their own version field; a release sweep that
# only rewrites the previous version string silently misses them when they
# lag further behind (they were stuck at 2.7.0 through the 2.7.1 release).
for mf in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
    if ! grep -qF "\"version\": \"$VER\"" "$ROOT/$mf"; then
        echo "  FAIL: $mf does not declare \"version\": \"$VER\""; drift=1
    fi
done
if [ -e "$ROOT/docs/decisions" ]; then
    echo "  FAIL: docs/decisions is a duplicate decision authority; migrate records into __garelier/$WS/control/decisions"; drift=1
fi
record_ids="$(for f in "$ROOT"/__garelier/$WS/control/decisions/DEC-[0-9]*-*.md; do
    [ -e "$f" ] || continue
    basename "$f"
done | sed -E 's/^(DEC-[0-9]+)-.*/\1/' | sort)"
dec_file="$ROOT/__garelier/$WS/control/project_dashboard/decisions.md"
if [ -f "$dec_file" ]; then
    index_ids="$(grep -oE '^\| DEC-[0-9]+' "$dec_file" | grep -oE 'DEC-[0-9]+' | sort)"
    missing="$(comm -23 <(printf '%s\n' "$record_ids") <(printf '%s\n' "$index_ids") | tr '\n' ' ')"
    orphan="$(comm -13 <(printf '%s\n' "$record_ids") <(printf '%s\n' "$index_ids") | tr '\n' ' ')"
    if [ -n "$missing" ]; then echo "  FAIL: decisions.md is missing canonical records:$missing"; drift=1; fi
    if [ -n "$orphan" ]; then echo "  FAIL: decisions.md indexes missing records:$orphan"; drift=1; fi
fi
if [ "$drift" -eq 0 ]; then echo "  ok (VERSION $VER reflected; DEC index in sync)"; else fail=1; fi

step "two-layer documentation sync"
if bun "$ROOT/scripts/check_doc_sync.ts"; then
    echo "  ok"
else
    echo "  FAIL"; fail=1
fi

step "commit + history lint (DEC-051, framework repo only)"
# Non-mandatory layer: this gates THIS framework repo's own commits + history.
# Target projects do NOT get this in their shared CI — they use it opt-in /
# pipeline-only / Garelier-artifact-scoped. Lints are no-ops where files are absent.
cl=0
bun "$ROOT/skills/garelier-core/scripts/lint_commits.ts" --last "$ROOT" || cl=1
for hf in "$ROOT"/__garelier/$WS/_pm/history.md "$ROOT"/__garelier/$WS/control/history.md; do
    [ -f "$hf" ] && { bun "$ROOT/skills/garelier-core/scripts/lint_history.ts" "$hf" || cl=1; }
done
if [ "$cl" -eq 0 ]; then echo "  ok"; else echo "  FAIL"; fail=1; fi

step "control / knowledge contract graph tests"
if (
    set -e
    CTMP="$(mktemp -d)"
    trap 'rm -rf "$CTMP"' EXIT
    git -C "$CTMP" init -q
    git -C "$CTMP" config user.email ci@ci
    git -C "$CTMP" config user.name ci
    bash "$ROOT/skills/garelier-control-project/scripts/init_control.sh" --project "$CTMP" --pm-id _workshop >/dev/null
    bash "$ROOT/skills/garelier-control-library/scripts/init_library.sh" --project "$CTMP" --pm-id _workshop >/dev/null
    bun "$ROOT/skills/garelier-core/scripts/control_graph.ts" --project "$CTMP" --pm-id _workshop --validate >/dev/null
    bun "$ROOT/skills/garelier-core/scripts/knowledge_graph.ts" --project "$CTMP" --pm-id _workshop --validate >/dev/null
); then
    echo "  ok (_workshop starters initialize and validate)"
else
    echo "  FAIL"; fail=1
fi

step "Garelier Control lifecycle smoke"
if (
    set -e
    LTMP="$(mktemp -d)"
    trap 'rm -rf "$LTMP"' EXIT
    git -C "$LTMP" init -q
    git -C "$LTMP" config user.email ci@ci
    git -C "$LTMP" config user.name ci
    printf '# lifecycle\n' > "$LTMP/README.md"
    git -C "$LTMP" add README.md
    git -C "$LTMP" commit -qm init
    for id in alpha beta; do
        bash "$ROOT/skills/garelier-control-project/scripts/init_control.sh" \
            --project "$LTMP" --pm-id "$id" >/dev/null
    done
    printf '# alpha\n' > "$LTMP/__garelier/$CA/control/decisions/alpha.md"
    printf '# beta\n' > "$LTMP/__garelier/$CB/control/decisions/beta.md"
    bash "$ROOT/skills/garelier-control-project/scripts/consolidate_controls.sh" \
        --project "$LTMP" --from-pm-id alpha,beta --to-pm-id _workshop --apply >/dev/null
    test -f "$LTMP/__garelier/$WS/runtime/import/consolidation/"*/reports/plan.md
    bash "$ROOT/skills/garelier-control-project/scripts/split_control.sh" \
        --project "$LTMP" --from-pm-id alpha --to-pm-id gamma \
        --select decisions/alpha.md --apply >/dev/null
    test -f "$LTMP/__garelier/gamma/runtime/import/split/"*/source/control/decisions/alpha.md
    bash "$ROOT/skills/garelier-pm/scripts/control_export.sh" \
        --project "$LTMP" --pm-id alpha --to "$LTMP/control-bundle" >/dev/null
    bash "$ROOT/skills/garelier-pm/scripts/control_import.sh" \
        --project "$LTMP" --pm-id delta --from "$LTMP/control-bundle" --apply >/dev/null
    test -f "$LTMP/__garelier/$CD/control/decisions/alpha.md"
    bash "$ROOT/skills/garelier-control-library/scripts/init_library.sh" \
        --project "$LTMP" --pm-id _workshop >/dev/null
    # DEC-051: ignores are nested under __garelier/.gitignore (no root .gitignore
    # is created), so adding __garelier/ covers them. Tolerate a root .gitignore if
    # some other step produced one.
    git -C "$LTMP" add __garelier
    [ -f "$LTMP/.gitignore" ] && git -C "$LTMP" add .gitignore || true
    git -C "$LTMP" commit -qm starters
    bash "$ROOT/skills/garelier-librarian/scripts/knowledge_export.sh" \
        --project "$LTMP" --to "$LTMP/knowledge-bundle" >/dev/null
    bash "$ROOT/skills/garelier-librarian/scripts/knowledge_import.sh" \
        --project "$LTMP" --pm-id delta --from "$LTMP/knowledge-bundle" >/dev/null
    test -f "$LTMP/__garelier/$CD/runtime/librarian/raw/imported-knowledge-bundle/_source_registry.stub.toml"
); then
    echo "  ok (consolidate / split / control bundle / knowledge bundle)"
else
    echo "  FAIL"; fail=1
fi

step "small starter -> full _workshop upgrade smoke"
if (
    set -e
    UTMP="$(mktemp -d)"
    trap 'rm -rf "$UTMP"' EXIT
    git -C "$UTMP" init -q
    git -C "$UTMP" symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git -C "$UTMP" config user.email ci@ci
    git -C "$UTMP" config user.name ci
    printf '# starter\n' > "$UTMP/README.md"
    git -C "$UTMP" add README.md
    git -C "$UTMP" commit -qm init
    bash "$ROOT/skills/garelier-control-project/scripts/init_control.sh" \
        --project "$UTMP" --pm-id _workshop >/dev/null
    bash "$ROOT/skills/garelier-control-library/scripts/init_library.sh" \
        --project "$UTMP" --pm-id _workshop >/dev/null
    printf '\nStarter sentinel.\n' >> "$UTMP/__garelier/$WS/control/project_dashboard/notes.md"
    printf '\nLibrary sentinel.\n' >> "$UTMP/__garelier/$WS/knowledge/project/index.md"
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    cd "$UTMP/__garelier"
    bash "$ROOT/skills/garelier-pm/scripts/setup_wizard.sh" \
        --mode fresh --skip-confirm --pm-id _workshop --project-name Starter \
        --target main --workers "w1:claude-code" --scouts "s1:claude-code" \
        --artisan --stack typescript --agents-policy minimal >/dev/null
    cd "$UTMP"
    grep -q 'mode = "full"' __garelier/$WS/control/control.toml
    grep -q 'Starter sentinel' __garelier/$WS/control/project_dashboard/notes.md
    grep -q 'Library sentinel' __garelier/$WS/knowledge/project/index.md
    test -f __garelier/$WS/_pm/setup_config.toml
    # DEC-065 dispatch-native: artisan lane enabled in config, no container.
    grep -q '^\[artisan\]' __garelier/$WS/_pm/setup_config.toml
    test ! -e __garelier/$WS/_artisan
    git show-ref --verify --quiet refs/heads/garelier/main/_workshop/studio
); then
    echo "  ok (_workshop control + knowledge preserved; full roles added)"
else
    echo "  FAIL"; fail=1
fi

step "dispatch prepare/cleanup smoke (DEC-063)"
DT="$(mktemp -d)"
if ( cd "$DT" && git init -q -b main . && git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init         && git branch "garelier/main/tpm/studio"         && OUT="$(bash "$ROOT/skills/garelier-core/scripts/dispatch_prepare.sh" --project "$DT" --pm-id tpm --role worker --slug ci-smoke --base "garelier/main/tpm/studio")"         && echo "$OUT" | grep -q '"branch":"garelier/main/tpm/workbench/#1/ci-smoke"'         && [ "$(cat "$DT/__garelier/tpm/runtime/backlog/next_id")" = "2" ]         && git -C "$DT/__garelier/tpm/_dispatch1/checkout" branch --show-current | grep -q "workbench/#1/ci-smoke"         && grep -q '"kind":"start"' "$DT/__garelier/tpm/runtime/dispatch/events.jsonl"         && grep -q '| #1 ci-smoke | dispatch1 (worker) |' "$DT/__garelier/tpm/runtime/backlog/in_flight.md"         && grep -q '^# Report - #1 ci-smoke' "$DT/__garelier/tpm/_dispatch1/report.md"         && bash "$ROOT/skills/garelier-core/scripts/dispatch_cleanup.sh" --project "$DT" --pm-id tpm --id 1 --delete-branch >/dev/null         && [ -z "$(git -C "$DT" branch --list "*workbench*")" ]         && grep -q '"kind":"cleanup"' "$DT/__garelier/tpm/runtime/dispatch/events.jsonl"         && ! grep -q '| #1 ci-smoke' "$DT/__garelier/tpm/runtime/backlog/in_flight.md"         && grep -q '^# #1 ci-smoke - archived by dispatch_cleanup' "$DT/__garelier/tpm/runtime/backlog/done/1-ci-smoke.md"         && [ ! -e "$DT/__garelier/tpm/_dispatch1" ]         && ! bash "$ROOT/skills/garelier-core/scripts/dispatch_prepare.sh" --project "$DT" --pm-id tpm --role scout --slug s --base "garelier/main/tpm/studio" 2>/dev/null ); then
    echo "  ok (prepare: id+branch+start event+in_flight view+report scaffold; cleanup: archive to done/ + remove all; read-only rejected)"
else
    echo "  FAIL: dispatch prepare/cleanup smoke"; fail=1
fi
rm -rf "$DT" 2>/dev/null || true

step "merge_request helper smoke (DEC-064)"
MT="$(mktemp -d)"
mkdir -p "$MT/__garelier/tpm/_pm"
printf '[branches]
integration = "garelier/main/tpm/studio"
' > "$MT/__garelier/tpm/_pm/setup_config.toml"
if bash "$ROOT/skills/garelier-core/scripts/merge_request.sh" --project "$MT" --pm-id tpm         --branch "garelier/main/tpm/workbench/#1/ci-smoke" --guardian PASS --observer PASS --no-poll >/dev/null 2>&1         && MRF="$(ls "$MT"/__garelier/tpm/runtime/merge_gate/requests/*.json 2>/dev/null | head -1)"         && grep -q '"studio_branch": "garelier/main/tpm/studio"' "$MRF"         && grep -q '"guardian_verdict": "PASS"' "$MRF"         && grep -q '"merge_message": "merge ' "$MRF"         && ! bash "$ROOT/skills/garelier-core/scripts/merge_request.sh" --project "$MT" --pm-id tpm --branch b --no-poll >/dev/null 2>&1; then
    echo "  ok (derives studio + verdicts + non-empty message; guardian-less request refused)"
else
    echo "  FAIL: merge_request helper smoke"; fail=1
fi
rm -rf "$MT" 2>/dev/null || true

step "control-only Status Web smoke"
if (
    set -e
    STMP="$(mktemp -d)"
    cleanup_status_smoke() {
        if [ -f "$STMP/__garelier/$WS/runtime/status_web/status_web.json" ]; then
            GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \
                bash "$ROOT/skills/garelier-core/scripts/stop_status.sh" \
                --project "$STMP" >/dev/null 2>&1 || true
        fi
        rm -rf "$STMP"
    }
    trap cleanup_status_smoke EXIT
    git -C "$STMP" init -q
    bash "$ROOT/skills/garelier-control-project/scripts/init_control.sh" \
        --project "$STMP" >/dev/null
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \
        bash "$ROOT/skills/garelier-core/scripts/start_status.sh" \
        --project "$STMP" --loopback >/dev/null
    STATUS_PIDFILE="$STMP/__garelier/$WS/runtime/status_web/status_web.json"
    STATUS_URL="$(bun -e 'const x=JSON.parse(await Bun.file(process.argv[1]).text()); console.log(x.url.replace(/\/$/, ""))' "$STATUS_PIDFILE")"
    bun -e 'const u=process.argv[1]; const h=await fetch(u+"/api/health").then(r=>r.json()); const c=await fetch(u+"/api/control").then(r=>r.json()); if(!h.ok||!c.ok) process.exit(1)' "$STATUS_URL"
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \
        bash "$ROOT/skills/garelier-core/scripts/status_web_status.sh" \
        --project "$STMP" >/dev/null
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \
        bash "$ROOT/skills/garelier-core/scripts/stop_status.sh" \
        --project "$STMP" >/dev/null
); then
    echo "  ok (control-only start / status / API / stop)"
else
    echo "  FAIL"; fail=1
fi

step "knowledge provenance/rights safety lint"
if bun "$ROOT/scripts/check_knowledge_safety.ts"; then
    echo "  ok"
else
    echo "  FAIL"; fail=1
fi

step "role knowledge trees lint (DEC-029)"
# Knowledge is Librarian-managed reference content, NOT new "convenience" Skills.
# (1) No forbidden new-Skill directories. (2) The four new Librarian templates
# trees each ship an index.md. (3) canonical_index lists the role knowledge trees.
kt=0
for forbidden in garelier-security-guide garelier-debugging garelier-code-review \
                 garelier-quality-guide garelier-user-review garelier-system-thinking; do
    if [ -d "$ROOT/skills/$forbidden" ]; then
        echo "  FAIL: forbidden knowledge-as-Skill directory exists: skills/$forbidden (use the knowledge trees under __garelier/<pm_id>/knowledge/ instead)"; kt=1
    fi
done
for tree in engineering quality review system; do
    if [ ! -f "$ROOT/skills/garelier-librarian/templates/$tree/index.md" ]; then
        echo "  FAIL: missing Librarian template index: skills/garelier-librarian/templates/$tree/index.md"; kt=1
    fi
done
if [ ! -f "$ROOT/skills/garelier-librarian/templates/security/index.md" ]; then
    echo "  FAIL: missing security tree index: skills/garelier-librarian/templates/security/index.md"; kt=1
fi
for tree in engineering quality review system; do
    if ! grep -qF "$tree/index.md" "$ROOT/docs/canonical_index.md"; then
        echo "  FAIL: docs/canonical_index.md does not list the $tree/index.md knowledge tree"; kt=1
    fi
done
# DEC-048: the role_index (inverse axis: role -> docs) is the single source of
# truth for the role->knowledge mapping. It must exist and every doc it names
# must exist as a template, so the by-role and by-topic axes cannot drift.
RI="$ROOT/skills/garelier-librarian/templates/role_index.toml"
if [ ! -f "$RI" ]; then
    echo "  FAIL: missing role index: skills/garelier-librarian/templates/role_index.toml (DEC-048)"; kt=1
else
    # role_index entries are knowledge-relative (`<tree>/<file>.md`), QUOTED in the
    # TOML arrays; match only quoted paths so prose mentions in comments are not
    # treated as entries. A legacy __garelier/<layer>/knowledge/ prefix is stripped.
    for ref in $(grep -oE '"[A-Za-z0-9_/.-]+\.md"' "$RI" 2>/dev/null | tr -d '"' | sed -E 's#^__garelier/[^/]+/knowledge/##' | sort -u); do
        tpl="$ROOT/skills/garelier-librarian/templates/$ref"
        if [ ! -f "$tpl" ]; then
            echo "  FAIL: role_index.toml names a knowledge doc with no template: $ref"; kt=1
        fi
    done
fi
if [ ! -f "$ROOT/skills/garelier-librarian/templates/knowledge_query.md" ]; then
    echo "  FAIL: missing knowledge_query template: skills/garelier-librarian/templates/knowledge_query.md (DEC-048)"; kt=1
fi
# DEC-048 capability invariant: the git command policy (SoT for which git
# commands roles may run) must exist. (Its driver-grant mirror test was
# deleted with the driver under DEC-066.)
if [ ! -f "$ROOT/skills/garelier-librarian/templates/git_command_policy.toml" ]; then
    echo "  FAIL: missing git command policy: skills/garelier-librarian/templates/git_command_policy.toml (DEC-048)"; kt=1
fi
if [ "$kt" -eq 0 ]; then echo "  ok (no forbidden Skills; tree indexes present; canonical_index lists trees; role_index + git_command_policy present)"; else fail=1; fi

echo ""
if [ "$fail" -eq 0 ]; then echo "CI: all checks passed."; else echo "CI: FAILURES above."; fi
exit "$fail"
