#!/usr/bin/env bun
//
// Garelier repo CI gate. Run from anywhere; resolves the repo root from its
// own location. Mirrors what .github/workflows/ci.yml runs:
//
//   1. driver typecheck (tsc --noEmit)
//   2. driver unit tests (bun test)
//   3. repository shell allowlist: task_mirror_hook is the sole shell file
//   4. wizard fresh-setup smoke in a throwaway git repo, then driver
//      loadConfig parse of the generated config
//   … (all subsequent integration smokes / lints)
//
// Exits non-zero if any step fails.
//
// TS port (W-083, Wave D). ci is the EXECUTOR of verification oracles, so each
// integration smoke / lint runs its shell body verbatim through bash.exe
// (contract §5) — this guarantees byte-for-byte step-verdict parity with the
// former shell CI. What ci OWNS in TS is the runner + the shim-form gate that
// REPLACES the old `bash -n` step (blueprint Wave D). The two wizard smokes get
// the d3 layout-v2 fix (_pm -> _crew/pm) since fresh now writes _crew/pm.
//
// Canonical invocation: bun skills/garelier-core/driver/src/scripts/ci.ts

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { requireRuntimeExecutable, run, runBash } from "./_lib.ts";

const ROOT =
  process.env.GARELIER_CI_ROOT && process.env.GARELIER_CI_ROOT !== ""
    ? resolve(process.env.GARELIER_CI_ROOT)
    : resolve(import.meta.dir, "..", "..", "..", "..", "..");
const DRIVER = join(ROOT, "skills", "garelier-core", "driver");

let fail = 0;
const out = (s: string) => process.stdout.write(`${s}\n`);
function step(name: string): void {
  out("");
  out(`=== ${name} ===`);
}

// W-026: fail FAST + CLEARLY when the driver deps are missing.
if (!existsSync(join(DRIVER, "node_modules"))) {
  out(`CI: driver dependencies are not installed (${DRIVER}/node_modules is missing).`);
  out("    Driver dependencies are missing. Provision them outside Garelier, then re-run ci.ts.");
  out("    Garelier does not install, update, or download toolchain/dependency prerequisites.");
  out("    (node_modules is gitignored, so a fresh 'git worktree add' has none — W-026.)");
  process.exit(1);
}

// ── bash-block runner ─────────────────────────────────────────────────────────
// Route an oracle body to bash.exe verbatim. The body echoes its own "  ok"/
// "  FAIL" line(s) and signals failure by exiting non-zero (ci.ts's `fail=1` is
// rewritten to `exit 1`). ROOT/DRIVER/WS/CA/CB/CD are injected via a preamble so
// the bodies stay verbatim.
const PRE = [
  "set -uo pipefail",
  `ROOT=${JSON.stringify(ROOT)}`,
  `DRIVER="$ROOT/skills/garelier-core/driver"`,
  "WS=_workshop; CA=alpha; CB=beta; CD=delta",
  `cd "$ROOT"`,
  "",
].join("\n");
function sh(body: string): boolean {
  const r = runBash(["-c", PRE + body], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  return r.exitCode === 0;
}

// ── steps ─────────────────────────────────────────────────────────────────────
type Step = { name: string; body?: string; fn?: () => boolean };
const steps: Step[] = [];
const S = (name: string, body: string) => steps.push({ name, body });
const F = (name: string, fn: () => boolean) => steps.push({ name, fn });

// 1. driver typecheck
F("driver typecheck (tsc --noEmit)", () => {
  const tsc = join(DRIVER, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(tsc)) { out(`  FAIL: local TypeScript is missing: ${tsc}`); return false; }
  const ok = run([requireRuntimeExecutable("node"), tsc, "--noEmit"], { cwd: DRIVER, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// 2. driver unit tests
F("driver unit tests (bun test)", () => {
  const ok = run(["bun", "test"], { cwd: DRIVER, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// 3. export mode self-check smoke (W-110). This runs the attended release
// pipeline in dry-run mode against a disposable public clone. It exercises the
// real history-free export and its dev-index/export-index 100755 set comparison
// on every CI run without pushing, tagging, or requiring GitHub credentials.
S(
  "release dry-run export mode self-check smoke (W-110)",
  `
PTMP="$(mktemp -d)"
if (
    set -e
    git init -q "$PTMP"
    git -C "$PTMP" symbolic-ref HEAD refs/heads/main
    git -C "$PTMP" config user.email ci@ci
    git -C "$PTMP" config user.name ci
    printf '# public fixture\\n' > "$PTMP/README.md"
    git -C "$PTMP" add README.md
    git -C "$PTMP" commit -qm init
    bun "$DRIVER/src/scripts/release.ts" --publish-repo "$PTMP" --dry-run
); then
    echo "  ok"
else
    echo "  FAIL"
    rm -rf "$PTMP"
    exit 1
fi
rm -rf "$PTMP"
`,
);

// 4. W-111 permanent shell allowlist. Scan the filesystem rather than only the
// index so an untracked shell file cannot bypass the gate.
F("shell allowlist (task_mirror_hook only; W-111)", () => {
  const allowed = "skills/garelier-core/hooks/task_mirror_hook.sh";
  const found: string[] = [];
  const walk = (dir: string, rel = ""): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || (rel === "" && name === "__garelier")) continue;
      const path = join(dir, name);
      const next = rel ? `${rel}/${name}` : name;
      const st = statSync(path);
      if (st.isDirectory()) walk(path, next);
      else if (name.endsWith(`.${"s"}h`)) found.push(next.replace(/\\/g, "/"));
    }
  };
  walk(ROOT);
  found.sort();
  if (found.length !== 1 || found[0] !== allowed) {
    out(`  FAIL: shell allowlist mismatch: ${found.join(", ") || "(none)"}`);
    return false;
  }
  const syntax = runBash(["-n", join(ROOT, allowed)], { stderr: "inherit" }).exitCode === 0;
  out(syntax ? `  ok (${allowed} is the sole shell file and parses)` : `  FAIL: ${allowed} syntax`);
  return syntax;
});

// W-112: console-less Windows parents must not let child processes allocate a
// transient console window. The AST lint covers Bun and node:child_process
// calls in production code and test fixtures; windowsHide is a no-op elsewhere.
F("spawn windowsHide lint (W-112)", () => {
  const lint = join(DRIVER, "src", "scripts", "spawn_windows_hide_lint.ts");
  const ok = run(["bun", lint, ROOT], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

F("bare tool spawn lint (Windows/POSIX path resolution)", () => {
  const lint = join(DRIVER, "src", "scripts", "tool_spawn_lint.ts");
  const ok = run(["bun", lint, join(ROOT, "skills")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-113: destructive filesystem operations must pass the canonical path fence.
F("path_guard raw destructive fs lint (W-113)", () => {
  const lint = join(DRIVER, "src", "scripts", "path_guard_lint.ts");
  const ok = run(["bun", lint, join(DRIVER, "src")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-165: showcase/ is a gitignored, transient deliverable drop-zone (retention.md
// § Showcase, W-085). A committed file there is a convention breach — detect it.
F("tracked showcase lint (W-165)", () => {
  const lint = join(DRIVER, "src", "scripts", "showcase_tracked_lint.ts");
  const ok = run(["bun", lint, ROOT], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// 4. install.ts smoke
S(
  "install.ts smoke (Claude Code + Codex skill roots)",
  `
ITMP="$(mktemp -d)"
if (
    set -e
    export CLAUDE_HOME="$ITMP/claude"
    export CODEX_HOME="$ITMP/codex"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/install.ts" >/dev/null
    for root in "$CLAUDE_HOME/skills" "$CODEX_HOME/skills"; do
        for skill in garelier-core garelier-pm garelier-worker; do
            [ -L "$root/$skill" ] || { echo "missing symlink: $root/$skill" >&2; exit 1; }
            [ -f "$root/$skill/SKILL.md" ] || { echo "missing SKILL.md through symlink: $root/$skill" >&2; exit 1; }
        done
    done
    bun "$ROOT/skills/garelier-core/driver/src/scripts/install.ts" --codex-only >/dev/null
    [ -L "$CODEX_HOME/skills/garelier-pm" ]
); then
    echo "  ok"
else
    echo "  FAIL"
    rm -rf "$ITMP"
    exit 1
fi
rm -rf "$ITMP"
`,
);

// 5. wizard fresh-setup smoke — EXILE opt-in.  d3 (W-083): fresh writes _crew/pm
//    under layout v2, so the diff-mode cd resolves the crew PM dir.
S(
  "wizard fresh-setup smoke — EXILE opt-in (throwaway git repo)",
  `
crewpm() { if [ -d "$1/_crew/pm" ]; then echo "$1/_crew/pm"; else echo "$1/_pm"; fi; }
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
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode fresh --skip-confirm \\
        --pm-id ci --project-name CI --target main \\
        --workers "w1:claude-code" --scouts "s1:claude-code" \\
        --librarians "lib1:claude-code" --observers "obs1:claude-code" --artisan \\
        --stack typescript --permission-profile reviewed >/dev/null
    cd "$TMP"
    PTR="$TMP/__garelier/ci/runtime/workspace_paths"
    resolve_c() { [ -f "$PTR" ] && awk -v k="$1" 'index($0,k"=")==1{print substr($0,length(k)+2);exit}' "$PTR" || true; }
    for d in runtime/observer/requests control/observations; do
        [ -e "__garelier/ci/$d" ] || { echo "missing __garelier/ci/$d" >&2; exit 1; }
    done
    for kv in worker.w1 scout.s1 librarian.lib1 observer.obs1 artisan; do
        [ -n "$(resolve_c "$kv")" ] && { echo "fresh wrote a pointer entry for $kv (DEC-065: no pre-created containers)" >&2; exit 1; }
    done
    for r in _dock _workers _scouts _smiths _librarians _observers _guardians _concierges _artisan; do
        [ -e "__garelier/ci/$r" ] && { echo "fresh pre-created role dir $r (DEC-065: dispatch-native)" >&2; exit 1; }
    done
    [ -f "__garelier/.gitignore" ] || { echo "nested __garelier/.gitignore not written" >&2; exit 1; }
    grep -qE '^\\*/runtime/$' "__garelier/.gitignore" || { echo "nested __garelier/.gitignore missing */runtime/ rule" >&2; exit 1; }
    grep -qE '^\\*/_librarians/$' "__garelier/.gitignore" || { echo "nested __garelier/.gitignore missing worktree rules (_librarians/)" >&2; exit 1; }
    git check-ignore -q "__garelier/ci/runtime" || { echo "git does not honor nested __garelier/.gitignore for runtime/" >&2; exit 1; }
    [ -f "__garelier/.ignore" ] || { echo "nested __garelier/.ignore not written" >&2; exit 1; }
    if [ -f .gitignore ] && grep -qi "garelier" .gitignore; then
        echo "project root .gitignore must stay Garelier-free (DEC-051 nested ignores)" >&2; exit 1
    fi
    if [ -f .gitignore ] && grep -qE '^/(STATE|assignment|report|under_review|merged|abort|track-target)\\.md$|^/archive/$' .gitignore; then
        echo "retired root-anchored coordination rules still present in root .gitignore" >&2; exit 1
    fi
    if grep -qE '^/(STATE|assignment|report|under_review|merged|abort|track-target)\\.md$|^/archive/$' "__garelier/.gitignore"; then
        echo "retired root-anchored coordination rules leaked into nested __garelier/.gitignore" >&2; exit 1
    fi
    [ -f "__garelier/ci/knowledge/security/security_policy.md" ] || { echo "security scaffold not seeded at __garelier/ci/knowledge/security/" >&2; exit 1; }
    [ -f "__garelier/ci/knowledge/security/registries/secret_patterns.toml" ] || { echo "security registries not seeded" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); if(!c.observers.length||!c.artisan||c.qualityGate.stack!=="typescript"){throw new Error("generated config did not parse as expected");}' "$TMP"
    cd "$(crewpm "$TMP/__garelier/ci")"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code" --scouts "s1:claude-code" \\
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
); then echo "  ok fresh-setup + diff + loadConfig parse"; else echo "  FAIL wizard smoke"; rm -rf "$TMP" "$WSHOME"; exit 1; fi
rm -rf "$TMP" "$WSHOME"
`,
);

// 6. wizard fresh defaults
S(
  "wizard fresh defaults — exactly one of every role, no flags (DEC-055)",
  `
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
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode fresh --skip-confirm \\
        --pm-id ci --project-name CI --target main --stack typescript >/dev/null
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const n=r=>(c[r]??[]).length; const roles=["workers","scouts","smiths","librarians","observers","guardians","concierges"]; const bad=roles.filter(r=>n(r)!==1); if(bad.length||!c.artisan){throw new Error("expected one of every role + artisan; wrong="+bad.join(",")+" artisan="+!!c.artisan);}' "$TMP"
); then echo "  ok (no flags -> one of every role + artisan)"; else echo "  FAIL fresh-defaults smoke"; rm -rf "$TMP" "$WSHOME"; exit 1; fi
rm -rf "$TMP" "$WSHOME"
`,
);

// 7. wizard on-demand container smoke — IN-PROJECT default.  d3 (W-083): _crew/pm.
S(
  "wizard on-demand container smoke — IN-PROJECT default (DEC-036/065)",
  `
crewpm() { if [ -d "$1/_crew/pm" ]; then echo "$1/_crew/pm"; else echo "$1/_pm"; fi; }
ITMP="$(mktemp -d)"
if (
    set -e
    unset GARELIER_HOME
    cd "$ITMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    printf '# mainline\\n' > CLAUDE.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    mkdir __garelier; cd __garelier
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode fresh --skip-confirm \\
        --pm-id ci --project-name CI --target main \\
        --workers "w1:claude-code" --scouts "s1:claude-code" --artisan >/dev/null
    cd "$ITMP"
    for r in _dock _workers _scouts _artisan; do
        [ -e "__garelier/ci/$r" ] && { echo "fresh pre-created role dir $r (DEC-065)" >&2; exit 1; }
    done
    cd "$(crewpm "$ITMP/__garelier/ci")"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code,w2:claude-code" --scouts "s1:claude-code" --artisan >/dev/null
    cd "$ITMP"
    INATIVE="$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$ITMP" 2>/dev/null || printf '%s' "$ITMP")"
    [ -e "__garelier/ci/runtime/workspace_paths" ] && { echo "in-project default wrote a workspace_paths pointer (should not)" >&2; exit 1; }
    if [ -d "__garelier/ci/_crew" ]; then
        dir="__garelier/ci/_crew/workers/w2"
    else
        dir="__garelier/ci/_workers/w2"
    fi
    [ -e "$ITMP/$dir/checkout/.git" ] || { echo "in-project worktree missing: $dir/checkout" >&2; exit 1; }
    [ -f "$ITMP/$dir/STATE.md" ]      || { echo "container STATE.md missing: $dir" >&2; exit 1; }
    s="$ITMP/$dir/checkout/.claude/settings.local.json"
    [ -f "$s" ] || { echo "claudeMdExcludes settings missing: $s" >&2; exit 1; }
    grep -qF "$INATIVE/CLAUDE.md" "$s" || { echo "claudeMdExcludes does not exclude the target CLAUDE.md: $s" >&2; exit 1; }
    if git -C "$ITMP/$dir/checkout" status --porcelain | grep -q "settings.local.json"; then
        echo "settings.local.json leaks as untracked in $dir/checkout" >&2; exit 1
    fi
    if [ -e "__garelier/ci/_workers/w1" ]; then
        echo "diff created an unrequested container for w1" >&2; exit 1
    fi
); then echo "  ok dispatch-native fresh + on-demand diff add: in-project container, no pointer, claudeMdExcludes, no untracked leak"; else echo "  FAIL in-project on-demand smoke"; rm -rf "$ITMP"; exit 1; fi
rm -rf "$ITMP"
`,
);

// 8. doctor smoke (safety gate)
S(
  "doctor smoke (safety gate)",
  `
WIZ="$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts"
DOCTOR="$ROOT/skills/garelier-core/driver/src/scripts/doctor.ts"
crewpm() { if [ -d "$1/_crew/pm" ]; then echo "$1/_crew/pm"; else echo "$1/_pm"; fi; }
DTMP="$(mktemp -d)"
if (
    set -e
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$DTMP/.garelier-home"
    init_repo() {
        cd "$1"; git init -q
        git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
        git config user.email ci@ci; git config user.name ci
        echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    }
    A="$DTMP/strict"; mkdir -p "$A"; init_repo "$A"
    ( cd "$A" && mkdir __garelier && cd __garelier && \\
      bun "$WIZ" --mode fresh --skip-confirm --pm-id ci --project-name S --target main \\
        --workers "w1:claude-code" --scouts "s1:claude-code" --stack typescript >/dev/null )
    if bun "$DOCTOR" --pm-id ci --project "$A" >/dev/null 2>&1; then
        echo "expected doctor P0 (AGENTS placeholders) on strict setup, got exit 0" >&2; exit 1
    fi
    rm -f "$A/AGENTS.md"
    out="$(bun "$DOCTOR" --pm-id ci --project "$A" 2>&1 || true)"
    case "$out" in *agents-missing*) : ;; *) echo "expected agents-missing P0 when AGENTS.md absent" >&2; exit 1 ;; esac
    if bun "$DOCTOR" --pm-id ci --project "$A" >/dev/null 2>&1; then
        echo "expected nonzero exit for missing AGENTS.md" >&2; exit 1
    fi
    B="$DTMP/min"; mkdir -p "$B"; init_repo "$B"
    ( cd "$B" && mkdir __garelier && cd __garelier && \\
      bun "$WIZ" --mode fresh --skip-confirm --pm-id ci --project-name M --target main \\
        --workers "w1:claude-code" --scouts "s1:claude-code" --stack typescript \\
        --agents-policy minimal >/dev/null )
    if ! bun "$DOCTOR" --pm-id ci --project "$B" >/dev/null 2>&1; then
        echo "expected doctor exit 0 after --agents-policy minimal" >&2
        bun "$DOCTOR" --pm-id ci --project "$B" >&2 || true; exit 1
    fi
    CFG="$(crewpm "$B/__garelier/ci")/setup_config.toml"
    sed -i.bak 's/^profile = "reviewed"/profile = "dangerous"/' "$CFG" && rm -f "$CFG.bak"
    out="$(bun "$DOCTOR" --pm-id ci --project "$B" 2>&1 || true)"
    case "$out" in *permissions-dangerous*) : ;; *) echo "expected permissions-dangerous P1 finding" >&2; exit 1 ;; esac
    sed -i.bak 's/^profile = "dangerous"/profile = "reviewed"/' "$CFG" && rm -f "$CFG.bak"
    awk '
        /^\\[quality_gate\\]/ { print "[quality_gate]"; print "stack = \\"custom\\""; print "commands = ["; print "]"; skip=1; next }
        skip && /^\\]/ { skip=0; next }
        skip { next }
        { print }
    ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
    if bun "$DOCTOR" --pm-id ci --project "$B" >/dev/null 2>&1; then
        echo "expected doctor P0 for custom stack with empty commands" >&2; exit 1
    fi
); then echo "  ok doctor: strict P0 / missing-AGENTS P0 / minimal clean / dangerous P1 / custom-empty P0"; else echo "  FAIL doctor smoke"; rm -rf "$DTMP"; exit 1; fi
rm -rf "$DTMP"
`,
);

// 9. DEC-036 exile migrate smoke.  d3 (W-083): read the migrated config via crewpm.
S(
  "DEC-036 exile migrate smoke (in-proj -> exile home, opt-in)",
  `
WIZ="$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts"
crewpm() { if [ -d "$1/_crew/pm" ]; then echo "$1/_crew/pm"; else echo "$1/_pm"; fi; }
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
    printf '[project]\\nname = "ci"\\ngarelier_version = "2.7.0"\\nwizard_version = "2.7.0"\\n\\n[branches]\\ntarget = "main"\\n' > "__garelier/ci/_pm/setup_config.toml"
    git worktree add --detach "__garelier/ci/_workers/w1/checkout" "garelier/main/ci/studio" >/dev/null
    printf 'You are worker w1 (provider: claude-code, model: claude-code) in a Garelier project.\\n' > "__garelier/ci/_workers/w1/CLAUDE.md"
    printf '# worker w1 — State\\n\\n## Status\\nWORKING\\n\\n## Current task\\nbig feature\\n' > "__garelier/ci/_workers/w1/STATE.md"
    ( cd __garelier && bun "$WIZ" --mode migrate --skip-confirm --pm-id ci >/dev/null )
    PTR="$MTMP/__garelier/ci/runtime/workspace_paths"
    c="$(awk -v k=worker.w1 'index($0,k"=")==1{print substr($0,length(k)+2);exit}' "$PTR")"
    [ -n "$c" ] || { echo "migrate: pointer has no worker.w1" >&2; exit 1; }
    case "$c" in "$MTMP"/*) echo "migrate: container still inside the project ($c)" >&2; exit 1 ;; esac
    [ -d "$c/checkout" ] || { echo "migrate: exile worktree missing" >&2; exit 1; }
    git worktree list --porcelain | grep -qF "$c/checkout" || { echo "migrate: exile checkout not registered" >&2; exit 1; }
    [ -f "$c/STATE.md" ] || { echo "migrate: STATE.md lost" >&2; exit 1; }
    grep -q "WORKING" "$c/STATE.md" || { echo "migrate: STATE not preserved" >&2; exit 1; }
    [ -e "$c/checkout/STATE.md" ] && { echo "migrate: STATE leaked into checkout" >&2; exit 1; }
    grep -q "\\.\\./STATE.md" "$c/CLAUDE.md" || { echo "migrate: CLAUDE.md not regenerated with ../STATE.md" >&2; exit 1; }
    [ -e "__garelier/ci/_workers/w1" ] && { echo "migrate: in-proj container not removed" >&2; exit 1; }
    CFG="$(crewpm "$MTMP/__garelier/ci")/setup_config.toml"; CURV="$(tr -d '[:space:]' < "$ROOT/VERSION")"
    grep -q "garelier_version = \\"$CURV\\"" "$CFG" || { echo "migrate: garelier_version not bumped to $CURV" >&2; exit 1; }
    grep -q "wizard_version = \\"$CURV\\"" "$CFG" || { echo "migrate: wizard_version not bumped to $CURV" >&2; exit 1; }
    ( cd __garelier && bun "$WIZ" --mode migrate --skip-confirm --pm-id ci >/dev/null )
); then echo "  ok migrate relocates worktree+mailbox, preserves coordination + STATE, bumps any old version -> current"; else echo "  FAIL migrate smoke"; rm -rf "$MTMP" "$MHOME"; exit 1; fi
rm -rf "$MTMP" "$MHOME"
`,
);

// 10. DEC-036 doctor reaches exiled containers
S(
  "DEC-036 doctor reaches exiled containers (P0 leak scan)",
  `
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
        printf '[branches]\\ntarget = "main"\\n'
        printf '[[guardians]]\\nid = "g1"\\nprovider = "claude-code"\\nmodel = "claude-code"\\n'
        printf '[guardian_policy]\\nenabled = true\\n'
    } > "__garelier/ci/_pm/setup_config.toml"
    GC="$DHOME/studios/exile-ci/_guardians/g1"
    mkdir -p "$GC"
    # Native Bun cannot resolve Git Bash's /tmp spelling on Windows. Real
    # wizard pointers use the native/mixed absolute spelling, so do the same.
    GC_DISPLAY="$(cd "$GC" && (pwd -W 2>/dev/null || pwd))"
    printf 'guardian.g1=%s\\n' "$GC_DISPLAY" > "__garelier/ci/runtime/workspace_paths"
    printf 'verdict: BLOCK\\nleaked: AKIAIOSFODNN7EXAMPLE\\n' > "$GC/guardian_report.md"
    out="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/doctor.ts" --pm-id ci --project "$DTMP" 2>&1 || true)"
    printf '%s' "$out" | grep -q "guardian-report-leak" \\
        || { echo "doctor missed the secret in the EXILED guardian report" >&2; exit 1; }
); then echo "  ok doctor resolves exiled containers (P0 guardian-report-leak fires)"; else echo "  FAIL doctor exile-scan smoke"; rm -rf "$DTMP" "$DHOME"; exit 1; fi
rm -rf "$DTMP" "$DHOME"
`,
);

// 11. deprecated-path lint
S(
  "deprecated-path lint",
  `
dead="docs/$(printf '%s' project_state)/"
hits="$(git -C "$ROOT" grep -nI -e "$dead" \\
    -- ':(exclude)__garelier/$WS/control/decisions/*' ':(exclude)CHANGELOG.md' ':(exclude)ci.ts' \\
       ':(exclude)__garelier/*' 2>/dev/null || true)"
if [ -n "$hits" ]; then
    echo "  FAIL: retired path '$dead' found in shipped content:"
    echo "$hits" | sed 's/^/    /'
    exit 1
else
    echo "  ok (no retired '$dead' in shipped content)"
fi
`,
);

// 12. inclusive-language lint
S(
  "inclusive-language lint (banned terms in shipped content)",
  `
banned="$(git -C "$ROOT" grep -nIw -i -e ma"ster" -e sl"ave" -e white"list" -e black"list" \\
    -- skills docs scripts README.md CLAUDE.md AGENTS.md 2>/dev/null || true)"
if [ -n "$banned" ]; then
    echo "  FAIL: banned term found in shipped content (use main / allowlist / denylist):"
    echo "$banned" | sed 's/^/    /'
    exit 1
else
    echo "  ok (no banned inclusive-language terms in shipped content)"
fi
`,
);

// 13. skill YAML frontmatter validation
S(
  "skill YAML frontmatter validation",
  `
if bun "$ROOT/scripts/check_skill_frontmatter.ts"; then
    echo "  ok"
else
    echo "  FAIL"
    exit 1
fi
`,
);

// 14. executable bit check
S(
  "executable bit check (shell exception + bin, executable TS shebangs)",
  `
nonexec="$(git -C "$ROOT" ls-files --stage -- 'skills/garelier-core/hooks/task_mirror_hook.sh' 'bin/garelier' | awk '$1!="100755"{print "    "$1" "$4}')"
if [ -n "$nonexec" ]; then
    echo "  FAIL: these tracked executables are missing the +x bit (git update-index --chmod=+x):"
    echo "$nonexec"
    exit 1
fi
bad_ts="$(git -C "$ROOT" ls-files --stage -- '*.ts' | awk '$1=="100755"{print $4}' | while IFS= read -r f; do head -1 "$ROOT/$f" | grep -qx '#!/usr/bin/env bun' || echo "    $f"; done)"
if [ -n "$bad_ts" ]; then
    echo "  FAIL: executable TypeScript files without the Bun shebang:"
    echo "$bad_ts"
    exit 1
fi
echo "  ok (shell exception + bin are 100755; executable TS files use the Bun shebang)"
`,
);

// 15. skill slash-menu visibility
S(
  "skill slash-menu visibility (only user entry points are user-invocable)",
  `
entry=" garelier-pm garelier-control-project garelier-control-library "
vis=0
while IFS= read -r f; do
    sk="$(basename "$(dirname "$f")")"
    case "$entry" in *" $sk "*) continue ;; esac
    if ! grep -qE '^user-invocable:[[:space:]]*false[[:space:]]*$' "$ROOT/$f"; then
        echo "  FAIL: $sk is internal — its SKILL.md must set 'user-invocable: false'"; vis=1
    fi
done < <(git -C "$ROOT" ls-files -- 'skills/garelier-*/SKILL.md')
if [ "$vis" -eq 0 ]; then echo "  ok (entry points pm/control-project/control-library invocable; 11 internal skills hidden)"; else exit 1; fi
`,
);

// 16. DEC-036 exile-path lint
S(
  "DEC-036 exile-path lint (role SKILLs must not hardcode relative hops)",
  `
dec035=0
hop_hits="$(git -C "$ROOT" grep -nIE 'is \`\\.\\./\\.\\./\\.\\.' \\
    -- 'skills/garelier-*/SKILL.md' 'skills/garelier-*/references/*' 2>/dev/null || true)"
if [ -n "$hop_hits" ]; then
    echo "  FAIL: role SKILL/reference instructs a fixed relative hop (breaks under DEC-035 exile):"
    echo "$hop_hits" | sed 's/^/    /'
    echo "    -> address primary/runtime/control via the role's CLAUDE.md absolute paths"
    dec035=1
fi
if [ "$dec035" -eq 0 ]; then echo "  ok (no fixed relative hops in role SKILLs; handoff resolver wired)"; else exit 1; fi
`,
);

// 17. doc drift check
S(
  "doc drift check (version + DEC index)",
  `
drift=0
VER="$(tr -d '[:space:]' < "$ROOT/VERSION")"
if ! grep -qF "## [$VER]" "$ROOT/CHANGELOG.md"; then
    echo "  FAIL: CHANGELOG.md has no '## [$VER]' section (VERSION=$VER)"; drift=1
fi
if ! grep -qF "$VER" "$ROOT/README.md"; then
    echo "  FAIL: README.md does not mention VERSION $VER"; drift=1
fi
for mf in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
    if ! grep -qF "\\"version\\": \\"$VER\\"" "$ROOT/$mf"; then
        echo "  FAIL: $mf does not declare \\"version\\": \\"$VER\\""; drift=1
    fi
done
if [ -e "$ROOT/docs/decisions" ]; then
    echo "  FAIL: docs/decisions is a duplicate decision authority; migrate records into __garelier/$WS/control/decisions"; drift=1
fi
record_ids="$(for f in "$ROOT"/__garelier/$WS/control/decisions/DEC-[0-9]*-*.md; do
    [ -e "$f" ] || continue
    basename "$f"
done | sed -E 's/^(DEC-[0-9]+)-.*/\\1/' | sort)"
dec_file="$ROOT/__garelier/$WS/control/project_dashboard/decisions.md"
if [ -f "$dec_file" ]; then
    index_ids="$(grep -oE '^\\| DEC-[0-9]+' "$dec_file" | grep -oE 'DEC-[0-9]+' | sort)"
    missing="$(comm -23 <(printf '%s\\n' "$record_ids") <(printf '%s\\n' "$index_ids") | tr '\\n' ' ')"
    orphan="$(comm -13 <(printf '%s\\n' "$record_ids") <(printf '%s\\n' "$index_ids") | tr '\\n' ' ')"
    if [ -n "$missing" ]; then echo "  FAIL: decisions.md is missing canonical records:$missing"; drift=1; fi
    if [ -n "$orphan" ]; then echo "  FAIL: decisions.md indexes missing records:$orphan"; drift=1; fi
fi
if [ "$drift" -eq 0 ]; then echo "  ok (VERSION $VER reflected; DEC index in sync)"; else exit 1; fi
`,
);

// 18. two-layer documentation sync
S(
  "two-layer documentation sync",
  `
if bun "$ROOT/scripts/check_doc_sync.ts"; then
    echo "  ok"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 19. commit + history lint
S(
  "commit + history lint (DEC-051, framework repo only)",
  `
cl=0
bun "$ROOT/skills/garelier-core/scripts/lint_commits.ts" --last "$ROOT" || cl=1
for hf in "$ROOT"/__garelier/$WS/_pm/history.md "$ROOT"/__garelier/$WS/control/history.md; do
    [ -f "$hf" ] && { bun "$ROOT/skills/garelier-core/scripts/lint_history.ts" "$hf" || cl=1; }
done
( cd "$ROOT/skills/garelier-core/scripts" && bun test lint_commits.test.ts >/dev/null ) || cl=1
if [ "$cl" -eq 0 ]; then echo "  ok"; else echo "  FAIL"; exit 1; fi
`,
);

// 20. control / knowledge contract graph tests
S(
  "control / knowledge contract graph tests",
  `
if (
    set -e
    CTMP="$(mktemp -d)"
    trap 'rm -rf "$CTMP"' EXIT
    git -C "$CTMP" init -q
    git -C "$CTMP" config user.email ci@ci
    git -C "$CTMP" config user.name ci
    bun "$ROOT/skills/garelier-control-project/scripts/init_control.ts" --project "$CTMP" --pm-id _workshop >/dev/null
    bun "$ROOT/skills/garelier-control-library/scripts/init_library.ts" --project "$CTMP" --pm-id _workshop >/dev/null
    bun "$ROOT/skills/garelier-core/scripts/control_graph.ts" --project "$CTMP" --pm-id _workshop --validate >/dev/null
    bun "$ROOT/skills/garelier-core/scripts/knowledge_graph.ts" --project "$CTMP" --pm-id _workshop --validate >/dev/null
); then
    echo "  ok (_workshop starters initialize and validate)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 21. Garelier Control lifecycle smoke
S(
  "Garelier Control lifecycle smoke",
  `
if (
    set -e
    LTMP="$(mktemp -d)"
    trap 'rm -rf "$LTMP"' EXIT
    git -C "$LTMP" init -q
    git -C "$LTMP" config user.email ci@ci
    git -C "$LTMP" config user.name ci
    printf '# lifecycle\\n' > "$LTMP/README.md"
    git -C "$LTMP" add README.md
    git -C "$LTMP" commit -qm init
    for id in alpha beta; do
        bun "$ROOT/skills/garelier-control-project/scripts/init_control.ts" \\
            --project "$LTMP" --pm-id "$id" >/dev/null
    done
    printf '# alpha\\n' > "$LTMP/__garelier/$CA/control/decisions/alpha.md"
    printf '# beta\\n' > "$LTMP/__garelier/$CB/control/decisions/beta.md"
    bun "$ROOT/skills/garelier-control-project/scripts/consolidate_controls.ts" \\
        --project "$LTMP" --from-pm-id alpha,beta --to-pm-id _workshop --apply >/dev/null
    test -f "$LTMP/__garelier/$WS/runtime/import/consolidation/"*/reports/plan.md
    bun "$ROOT/skills/garelier-control-project/scripts/split_control.ts" \\
        --project "$LTMP" --from-pm-id alpha --to-pm-id gamma \\
        --select decisions/alpha.md --apply >/dev/null
    test -f "$LTMP/__garelier/gamma/runtime/import/split/"*/source/control/decisions/alpha.md
    bun "$ROOT/skills/garelier-pm/scripts/control_export.ts" \\
        --project "$LTMP" --pm-id alpha --to "$LTMP/control-bundle" >/dev/null
    bun "$ROOT/skills/garelier-pm/scripts/control_import.ts" \\
        --project "$LTMP" --pm-id delta --from "$LTMP/control-bundle" --apply >/dev/null
    test -f "$LTMP/__garelier/$CD/control/decisions/alpha.md"
    bun "$ROOT/skills/garelier-control-library/scripts/init_library.ts" \\
        --project "$LTMP" --pm-id _workshop >/dev/null
    git -C "$LTMP" add __garelier
    [ -f "$LTMP/.gitignore" ] && git -C "$LTMP" add .gitignore || true
    git -C "$LTMP" commit -qm starters
    bun "$ROOT/skills/garelier-librarian/scripts/knowledge_export.ts" \\
        --project "$LTMP" --to "$LTMP/knowledge-bundle" >/dev/null
    bun "$ROOT/skills/garelier-librarian/scripts/knowledge_import.ts" \\
        --project "$LTMP" --pm-id delta --from "$LTMP/knowledge-bundle" >/dev/null
    test -f "$LTMP/__garelier/$CD/runtime/librarian/raw/imported-knowledge-bundle/_source_registry.stub.toml"
); then
    echo "  ok (consolidate / split / control bundle / knowledge bundle)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 22. small starter -> full _workshop upgrade smoke
S(
  "small starter -> full _workshop upgrade smoke",
  `
if (
    set -e
    UTMP="$(mktemp -d)"
    trap 'rm -rf "$UTMP"' EXIT
    git -C "$UTMP" init -q
    git -C "$UTMP" symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git -C "$UTMP" config user.email ci@ci
    git -C "$UTMP" config user.name ci
    printf '# starter\\n' > "$UTMP/README.md"
    git -C "$UTMP" add README.md
    git -C "$UTMP" commit -qm init
    bun "$ROOT/skills/garelier-control-project/scripts/init_control.ts" \\
        --project "$UTMP" --pm-id _workshop >/dev/null
    bun "$ROOT/skills/garelier-control-library/scripts/init_library.ts" \\
        --project "$UTMP" --pm-id _workshop >/dev/null
    printf '\\nStarter sentinel.\\n' >> "$UTMP/__garelier/$WS/control/project_dashboard/notes.md"
    printf '\\nLibrary sentinel.\\n' >> "$UTMP/__garelier/$WS/knowledge/project/index.md"
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    cd "$UTMP/__garelier"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" \\
        --mode fresh --skip-confirm --pm-id _workshop --project-name Starter \\
        --target main --workers "w1:claude-code" --scouts "s1:claude-code" \\
        --artisan --stack typescript --agents-policy minimal >/dev/null
    cd "$UTMP"
    grep -q 'mode = "full"' __garelier/$WS/control/control.toml
    grep -q 'Starter sentinel' __garelier/$WS/control/project_dashboard/notes.md
    grep -q 'Library sentinel' __garelier/$WS/knowledge/project/index.md
    test -f __garelier/$WS/_crew/pm/setup_config.toml
    grep -q '^\\[artisan\\]' __garelier/$WS/_crew/pm/setup_config.toml
    test ! -e __garelier/$WS/_artisan
    git show-ref --verify --quiet refs/heads/garelier/main/_workshop/studio
); then
    echo "  ok (_workshop control + knowledge preserved; full roles added)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 23. dispatch prepare/cleanup smoke
S(
  "dispatch prepare/cleanup smoke (DEC-063)",
  `
DT="$(mktemp -d)"
if ( cd "$DT" && git init -q -b main . && git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init         && git branch "garelier/main/tpm/studio"         && OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$DT" --pm-id tpm --role worker --slug ci-smoke --base "garelier/main/tpm/studio")"         && echo "$OUT" | grep -q '"branch":"garelier/main/tpm/workbench/#1/ci-smoke"'         && echo "$OUT" | grep -q '"prompt_preamble":"You are the Garelier worker for dispatch #1 (ci-smoke)'         && echo "$OUT" | grep -q 'Garelier: tpm worker#1 {{TASK_ID}}'         && echo "$OUT" | grep -q 'Branch: garelier/main/tpm/workbench/#1/ci-smoke. At pickup, base-track'         && { echo "$OUT" | grep -q 'preserve every required gate as ONE whole command' || { echo "  FAIL check: heavy-discipline gate line absent from preamble" >&2; false; }; }         && { echo "$OUT" | grep -q 'Falling silent at a milestone (commit, compile start, report) is a stall and a violation' || { echo "  FAIL check: falling-silent stall line absent from preamble" >&2; false; }; }         && echo "$OUT" | grep -q '"gate_agents":{"guardian":{"name":"ga-guardian-ci-smoke","model":"","report":"runtime/guardian/results/ci-smoke-guardian.md","verdict_template":"skills/garelier-core/templates/gate_verdict.md"},"observer":{"name":"ga-observer-ci-smoke","model":"","report":"runtime/observer/results/ci-smoke-observer.md","verdict_template":"skills/garelier-core/templates/gate_verdict.md"}}}'         && [ "$(cat "$DT/__garelier/tpm/runtime/backlog/next_id")" = "2" ]         && git -C "$DT/__garelier/tpm/_dispatch1/checkout" branch --show-current | grep -q "workbench/#1/ci-smoke"         && grep -q '"kind":"start"' "$DT/__garelier/tpm/runtime/dispatch/events.jsonl"         && grep -q '| #1 ci-smoke | dispatch1 (worker) |' "$DT/__garelier/tpm/runtime/backlog/in_flight.md"         && grep -q '^# Report - #1 ci-smoke' "$DT/__garelier/tpm/_dispatch1/report.md"         && [ -f "$DT/__garelier/tpm/_dispatch1/context.json" ]         && grep -q 'dispatch_fact_pack' "$DT/__garelier/tpm/_dispatch1/context.json"         && grep -q 'workbench/#1/ci-smoke' "$DT/__garelier/tpm/_dispatch1/context.json"         && grep -q '"gate_agents"' "$DT/__garelier/tpm/_dispatch1/context.json"         && grep -q 'ga-guardian-ci-smoke' "$DT/__garelier/tpm/_dispatch1/context.json"         && ! bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_cleanup.ts" --project "$DT" --pm-id tpm --id 1 --delete-branch >/dev/null 2>&1         && [ -n "$(git -C "$DT" branch --list "*workbench*")" ]         && bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_cleanup.ts" --project "$DT" --pm-id tpm --id 1 --delete-branch --force >/dev/null         && [ -z "$(git -C "$DT" branch --list "*workbench*")" ]         && grep -q '"kind":"cleanup"' "$DT/__garelier/tpm/runtime/dispatch/events.jsonl"         && ! grep -q '| #1 ci-smoke' "$DT/__garelier/tpm/runtime/backlog/in_flight.md"         && grep -q '^# #1 ci-smoke - archived by dispatch_cleanup' "$DT/__garelier/tpm/runtime/backlog/done/1-ci-smoke.md"         && [ ! -e "$DT/__garelier/tpm/_dispatch1" ]         && ! bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$DT" --pm-id tpm --role scout --slug s --base "garelier/main/tpm/studio" 2>/dev/null ); then
    echo "  ok (prepare: id+branch+start event+in_flight view+report scaffold+context.json fact-pack; cleanup: unmerged --delete-branch refused (W-044), --force archives to done/ + removes all; read-only rejected)"
else
    echo "  FAIL: dispatch prepare/cleanup smoke"; rm -rf "$DT" 2>/dev/null || true; exit 1
fi
rm -rf "$DT" 2>/dev/null || true
`,
);

// 24. dispatch prepare — codex proxy-commit seat mode smoke
S(
  "dispatch prepare — codex proxy-commit seat mode smoke (W-042)",
  `
CT="$(mktemp -d)"
if (
    set -e
    cd "$CT"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    OUT_PROXY="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$CT" --pm-id tpm --role worker --slug codex-proxy --base "garelier/main/tpm/studio" --model codex-ci-smoke-model)"
    echo "$OUT_PROXY" | grep -q '"commit_mode":"proxy"'
    echo "$OUT_PROXY" | grep -q 'Commit (PROXY mode — W-042): you CANNOT run git add / git commit / git stash'
    echo "$OUT_PROXY" | grep -q 'Garelier-Seat: codex codex-ci-smoke-model (proxy-commit via dock seat)'
    echo "$OUT_PROXY" | grep -q 'commit plan submitted (Dock commits — PROXY mode, no SHA yet)'
    echo "$OUT_PROXY" | grep -q 'Output control (output_control.md): your final response and every progress message use the compressed register'
    OUT_SELF="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$CT" --pm-id tpm --role worker --slug codex-self --base "garelier/main/tpm/studio" --model codex-ci-smoke-model --commit-mode self)"
    echo "$OUT_SELF" | grep -q '"commit_mode":"self"'
    if echo "$OUT_SELF" | grep -q 'PROXY mode — W-042'; then
      echo "FAIL: self-mode preamble leaked PROXY-only rule text" >&2; exit 1
    fi
    if echo "$OUT_SELF" | grep -q 'Garelier-Seat:'; then
      echo "FAIL: self-mode preamble leaked the Garelier-Seat trailer" >&2; exit 1
    fi
    echo "$OUT_SELF" | grep -q 'branch + commit SHA, report path'
    echo "$OUT_SELF" | grep -q 'Output control (output_control.md): your final response and every progress message use the compressed register'
); then
    echo "  ok (codex default -> proxy JSON key + PROXY preamble + Garelier-Seat trailer + output-control block; --commit-mode self -> self JSON key + PROXY text absent + output-control block still present)"
else
    echo "  FAIL: dispatch prepare codex proxy-commit seat mode smoke"; rm -rf "$CT" 2>/dev/null || true; exit 1
fi
rm -rf "$CT" 2>/dev/null || true
`,
);

// 25. merge_land seat-trailer preflight smoke
S(
  "merge_land seat-trailer preflight smoke (guardian round-2 N1)",
  `
ST="$(mktemp -d)"
if (
    set -e
    cd "$ST"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-missing --base "garelier/main/tpm/studio" --model codex-ci-seat-model >/dev/null
    grep -q '"commit_mode": "proxy"' "$ST/__garelier/tpm/_dispatch1/context.json"
    git -C "$ST/__garelier/tpm/_dispatch1/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): x [#1]

Garelier: tpm dock#9 W-999"
    set +e
    OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 1 --no-pull 2>&1)"
    RC=$?
    set -e
    [ "$RC" -eq 2 ]
    echo "$OUT" | grep -q "fail --require-seat-trailer"
    echo "$OUT" | grep -q "missing/malformed .Garelier-Seat: codex <model> (proxy-commit via dock seat). trailer"
    echo "$OUT" | grep -q "COMMIT_RULE duty 2/3"
    [ ! -d "$ST/__garelier/tpm/runtime/merge_gate/requests" ] || [ -z "$(ls -A "$ST/__garelier/tpm/runtime/merge_gate/requests" 2>/dev/null)" ]
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-stripped --base "garelier/main/tpm/studio" --model codex-ci-seat-model2 >/dev/null
    grep -q '"commit_mode": "proxy"' "$ST/__garelier/tpm/_dispatch2/context.json"
    grep -v '"commit_mode"' "$ST/__garelier/tpm/_dispatch2/context.json" > "$ST/ctx2.tmp"
    mv "$ST/ctx2.tmp" "$ST/__garelier/tpm/_dispatch2/context.json"
    if grep -q "commit_mode" "$ST/__garelier/tpm/_dispatch2/context.json"; then
      echo "FAIL: commit_mode strip did not actually remove the key" >&2; exit 1
    fi
    grep -q '"model": "codex-ci-seat-model2"' "$ST/__garelier/tpm/_dispatch2/context.json"
    git -C "$ST/__garelier/tpm/_dispatch2/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): y [#2]

Garelier: tpm dock#9 W-998"
    set +e
    OUT2="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 2 --no-pull 2>&1)"
    RC2=$?
    set -e
    [ "$RC2" -eq 2 ]
    echo "$OUT2" | grep -q "fail --require-seat-trailer"
    echo "$OUT2" | grep -q "codex-model-inferred"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-gone --base "garelier/main/tpm/studio" --model codex-ci-seat-model3 >/dev/null
    B3="garelier/main/tpm/workbench/#3/seat-gone"
    git -C "$ST/__garelier/tpm/_dispatch3/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): z [#3]

Garelier: tpm dock#9 W-997
Garelier-Seat: codex codex-ci-seat-model3 (proxy-commit via dock seat)"
    rm -f "$ST/__garelier/tpm/_dispatch3/context.json"
    set +e
    OUT3="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --branch "$B3" --dispatch-id 3 --no-pull 2>&1)"
    RC3=$?
    set -e
    [ "$RC3" -eq 2 ]
    echo "$OUT3" | grep -q "container/context.json is unresolvable"
    echo "$OUT3" | grep -q "seat-trailer checked"
    set +e
    OUT3B="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --branch "$B3" --dispatch-id 3 --no-pull --seat-trailer skip 2>&1)"
    set -e
    if echo "$OUT3B" | grep -q "container/context.json is unresolvable"; then
      echo "FAIL: --seat-trailer skip override did not suppress the unresolvable-container error" >&2; exit 1
    fi
    echo "$OUT3B" | grep -q "seat-trailer check skipped for dispatch #3 — container unresolvable"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-corrupt --base "garelier/main/tpm/studio" --model codex-ci-seat-model4 >/dev/null
    grep -q '"commit_mode": "proxy"' "$ST/__garelier/tpm/_dispatch4/context.json"
    printf '{}' > "$ST/__garelier/tpm/_dispatch4/context.json"
    git -C "$ST/__garelier/tpm/_dispatch4/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): w [#4]

Garelier: tpm dock#9 W-994"
    set +e
    OUT4="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 4 --no-pull 2>&1)"
    RC4=$?
    set -e
    [ "$RC4" -eq 2 ]
    echo "$OUT4" | grep -q "exists but its content is unreadable"
    echo "$OUT4" | grep -q "neither routing.commit_mode nor routing.model resolved"
    set +e
    OUT4B="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 4 --no-pull --seat-trailer checked 2>&1)"
    set -e
    if echo "$OUT4B" | grep -q "exists but its content is unreadable"; then
      echo "FAIL: --seat-trailer checked override did not suppress the content-unreadable error" >&2; exit 1
    fi
    echo "$OUT4B" | grep -q "seat-trailer check skipped for dispatch #4 — context.json content unreadable"
); then
    echo "  ok (proxy dispatch with a Garelier-Seat-less commit is refused by merge_land pre-submit, before any merge_request submit; stripped commit_mode still caught via model fallback; unresolvable container fails closed without --seat-trailer, proceeds with it; corrupted-{} content also fails closed and proceeds with an override)"
else
    echo "  FAIL: merge_land seat-trailer preflight smoke"; rm -rf "$ST" 2>/dev/null || true; exit 1
fi
rm -rf "$ST" 2>/dev/null || true
`,
);

// 26. merge_request helper smoke
S(
  "merge_request helper smoke (DEC-064)",
  `
MT="$(mktemp -d)"
mkdir -p "$MT/__garelier/tpm/_pm"
printf '[branches]
integration = "garelier/main/tpm/studio"
' > "$MT/__garelier/tpm/_pm/setup_config.toml"
if bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_request.ts" --project "$MT" --pm-id tpm --quality-gate "bun test"         --branch "garelier/main/tpm/workbench/#1/ci-smoke" --guardian PASS --observer PASS --no-poll >/dev/null 2>&1         && MRF="$(ls "$MT"/__garelier/tpm/runtime/merge_gate/requests/*.json 2>/dev/null | head -1)"         && grep -q '"studio_branch": "garelier/main/tpm/studio"' "$MRF"         && grep -q '"guardian_verdict": "PASS"' "$MRF"         && grep -q '"merge_message": "merge ' "$MRF"         && ! bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_request.ts" --project "$MT" --pm-id tpm --quality-gate "bun test" --branch b --no-poll >/dev/null 2>&1; then
    echo "  ok (derives studio + verdicts + non-empty message; guardian-less request refused)"
else
    echo "  FAIL: merge_request helper smoke"; rm -rf "$MT" 2>/dev/null || true; exit 1
fi
rm -rf "$MT" 2>/dev/null || true
`,
);

// 27. runtime_recovery_hook smoke
S(
  "runtime_recovery_hook smoke (W-035)",
  `
if bun test "$ROOT/skills/garelier-core/hooks/runtime_recovery_hook.test.ts" >/dev/null 2>&1; then
    echo "  ok (failure incident / spill / SubagentStop block+escalate / marker pass / broken state)"
else
    echo "  FAIL: runtime_recovery_hook smoke"; exit 1
fi
`,
);

// 28. dispatch preamble runtime marker smoke
S(
  "dispatch preamble runtime marker smoke (W-035)",
  `
PT="$(mktemp -d)"
if (
    set -e
    cd "$PT"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$PT" --pm-id tpm --role worker --slug runtime-preamble --base "garelier/main/tpm/studio")"
    # W-114: echo WHICH assertion fails (a bare "FAIL: …smoke" is undiagnosable
    # from a remote CI log). Both greps were wrong on EVERY platform, unnoticed
    # because nobody runs the full ci.ts locally. (1) dispatch_prepare emits the
    # preamble as a JSON field (emitJsonLine -> JSON.stringify), so the marker's
    # inner quotes are escaped to \\" — the plain '{"runtime_ok"' pattern never
    # matched. Use a quote-agnostic BRE ('.*' spans the \\" escaping). (2) the
    # timeout-rerun rule was reworded from "do not immediately re-run" to the
    # recovery/rearm wording (dispatch_prepare.ts §Recovery).
    echo "$OUT" | grep -q 'GARELIER_RUNTIME_STATUS: {.*runtime_ok' || { echo "  FAIL check: runtime-status marker line absent from preamble" >&2; exit 1; }
    echo "$OUT" | grep -q 'may the SAME whole command be explicitly rearmed' || { echo "  FAIL check: timeout rearm-discipline line absent from preamble" >&2; exit 1; }
); then
    echo "  ok (runtime status marker + timeout rearm discipline)"
else
    echo "  FAIL: dispatch preamble runtime marker smoke"; rm -rf "$PT" 2>/dev/null || true; exit 1
fi
rm -rf "$PT" 2>/dev/null || true
`,
);

// 29. run_summarized smoke
S(
  "run_summarized smoke (W-043b, inbound output discipline)",
  `
RT="$(mktemp -d)"
if (
    set -e
    OUT1="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug ok -- echo "hello")"
    echo "$OUT1" | grep -q "exit=0"
    LOGF1="$(echo "$OUT1" | sed -n 's/.*log=//p')"
    [ -f "$LOGF1" ]
    grep -q "^hello$" "$LOGF1"
    STATUS1="$RT/status/ok.status"
    OUT1S="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug status-ok --status-file "$STATUS1" -- echo "status hello")"
    echo "$OUT1S" | grep -q "exit=0"
    grep -q '^START=' "$STATUS1"
    grep -q '^CMD=echo status\\\\ hello ' "$STATUS1"
    grep -q '^LOG=' "$STATUS1"
    grep -q '^END=' "$STATUS1"
    grep -q '^EXIT=0$' "$STATUS1"
    set +e
    OUT2="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug fail -- bash -c 'echo "error: boom" >&2; exit 3')"
    RC2=$?
    set -e
    [ "$RC2" -eq 3 ]
    echo "$OUT2" | grep -q "exit=3"
    echo "$OUT2" | grep -q "error: boom"
    FIXTURE="$RT/cargo_fixture.txt"
    {
        for i in $(seq 1 50); do echo "test t$i ... ok"; done
        echo "test t51 ... FAILED"
        echo "test result: FAILED. 50 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s"
    } > "$FIXTURE"
    OUT3="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug cargo-test -- cat "$FIXTURE")"
    echo "$OUT3" | grep -q "test result: FAILED"
    echo "$OUT3" | grep -q "t51 ... FAILED"
    ! bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" 2>/dev/null
    ! bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --bogus x 2>/dev/null
); then
    echo "  ok (success/failure/cargo-test-style summarized; full output kept in log file; bad args rejected)"
else
    echo "  FAIL: run_summarized smoke"; rm -rf "$RT" 2>/dev/null || true; exit 1
fi
rm -rf "$RT" 2>/dev/null || true
`,
);

// 30. control-only Status Web smoke
S(
  "control-only Status Web smoke",
  `
if (
    set -e
    STMP="$(mktemp -d)"
    cleanup_status_smoke() {
        if [ -f "$STMP/__garelier/$WS/runtime/status_web/status_web.json" ]; then
            GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
                bun "$ROOT/skills/garelier-core/driver/src/scripts/stop_status.ts" \\
                --project "$STMP" >/dev/null 2>&1 || true
        fi
        # stop_status waits for shutdown, but Windows can retain the server cwd
        # for a short interval after process exit. Retry the disposable cleanup.
        cd / 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            rm -rf "$STMP" 2>/dev/null && break
            sleep 0.2
        done
        [ ! -e "$STMP" ]
    }
    trap cleanup_status_smoke EXIT
    git -C "$STMP" init -q
    bun "$ROOT/skills/garelier-control-project/scripts/init_control.ts" \\
        --project "$STMP" >/dev/null
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/start_status.ts" \\
        --project "$STMP" --loopback >/dev/null
    STATUS_PIDFILE="$STMP/__garelier/$WS/runtime/status_web/status_web.json"
    STATUS_URL="$(bun -e 'const x=JSON.parse(await Bun.file(process.argv[1]).text()); console.log(x.url.replace(/\\/$/, ""))' "$STATUS_PIDFILE")"
    bun -e 'const u=process.argv[1]; const h=await fetch(u+"/api/health").then(r=>r.json()); const c=await fetch(u+"/api/control").then(r=>r.json()); if(!h.ok||!c.ok) process.exit(1)' "$STATUS_URL"
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/status_web_status.ts" \\
        --project "$STMP" >/dev/null
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/stop_status.ts" \\
        --project "$STMP" >/dev/null
); then
    echo "  ok (control-only start / status / API / stop)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 31. knowledge provenance/rights safety lint
S(
  "knowledge provenance/rights safety lint",
  `
if bun "$ROOT/scripts/check_knowledge_safety.ts"; then
    echo "  ok"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 32. role knowledge trees lint
S(
  "role knowledge trees lint (DEC-029)",
  `
kt=0
for forbidden in garelier-security-guide garelier-debugging garelier-code-review \\
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
RI="$ROOT/skills/garelier-librarian/templates/role_index.toml"
if [ ! -f "$RI" ]; then
    echo "  FAIL: missing role index: skills/garelier-librarian/templates/role_index.toml (DEC-048)"; kt=1
else
    for ref in $(grep -oE '"[A-Za-z0-9_/.-]+\\.md"' "$RI" 2>/dev/null | tr -d '"' | sed -E 's#^__garelier/[^/]+/knowledge/##' | sort -u); do
        tpl="$ROOT/skills/garelier-librarian/templates/$ref"
        if [ ! -f "$tpl" ]; then
            echo "  FAIL: role_index.toml names a knowledge doc with no template: $ref"; kt=1
        fi
    done
fi
if [ ! -f "$ROOT/skills/garelier-librarian/templates/knowledge_query.md" ]; then
    echo "  FAIL: missing knowledge_query template: skills/garelier-librarian/templates/knowledge_query.md (DEC-048)"; kt=1
fi
if [ ! -f "$ROOT/skills/garelier-librarian/templates/git_command_policy.toml" ]; then
    echo "  FAIL: missing git command policy: skills/garelier-librarian/templates/git_command_policy.toml (DEC-048)"; kt=1
fi
if [ "$kt" -eq 0 ]; then echo "  ok (no forbidden Skills; tree indexes present; canonical_index lists trees; role_index + git_command_policy present)"; else exit 1; fi
`,
);

// 33. knowledge doc reverse reachability lint
S(
  "knowledge doc reverse reachability lint (DEC-090, W-074)",
  `
krr=0
bun "$ROOT/scripts/check_knowledge_reachability.ts" || krr=1
( cd "$ROOT/scripts" && bun test check_knowledge_reachability.test.ts >/dev/null ) || krr=1
if [ "$krr" -eq 0 ]; then echo "  ok"; else echo "  FAIL"; exit 1; fi
`,
);

// 34. worker_finalize smoke
S(
  "worker_finalize smoke (W-069, gate->commit->REPORTING bundle)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/worker_finalize.test.ts" >/dev/null 2>&1; then
    echo "  ok (green-commit / idempotent / gate-red / studio-guard / undefined-gate)"
else
    echo "  FAIL: worker_finalize smoke"; exit 1
fi
`,
);

// 35. gate_result_waiter smoke
S(
  "gate_result_waiter smoke (W-079, attended merge-result push)",
  `
GW=0
bun test "$ROOT/skills/garelier-core/scripts/gate_result_waiter.test.ts" >/dev/null 2>&1 || GW=1
NT="$(mktemp -d)"
mkdir -p "$NT/__garelier/tpm/_pm"
printf '[branches]\\nintegration = "garelier/main/tpm/studio"\\n' > "$NT/__garelier/tpm/_pm/setup_config.toml"
NOUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_request.ts" --project "$NT" --pm-id tpm --quality-gate "bun test" \\
    --branch "garelier/main/tpm/workbench/#1/ci-smoke" --guardian PASS --notify --no-poll 2>&1 1>/dev/null || true)"
REQ_FILE="$(find "$NT/__garelier/tpm/runtime/merge_gate/requests" -maxdepth 1 -type f -name '*.json' ! -name '*.summary.json' | head -1)"
RID="$(grep -m1 '"request_id"' "$REQ_FILE" 2>/dev/null | sed -E 's/.*"request_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/')"
[ -n "$RID" ] || { echo "  FAIL: request JSON did not expose request_id" >&2; GW=1; }
# Native Bun normalizes an MSYS /tmp argument to its Windows path. Compare the
# same physical spelling locally while retaining plain pwd on Linux CI.
NT_DISPLAY="$(cd "$NT" && (pwd -W 2>/dev/null || pwd))"
echo "$NOUT" | grep -qF "gate_result_waiter.ts --project $NT_DISPLAY --pm-id tpm --request-id $RID" \\
    || { echo "  FAIL: --notify hint did not reference the request's waiter command" >&2; GW=1; }
rm -rf "$NT" 2>/dev/null || true
if [ "$GW" -eq 0 ]; then
    echo "  ok (success/failed/conflict/mid-wait/timeout/bad-args; --notify emits matching waiter command)"
else
    echo "  FAIL: gate_result_waiter smoke"; exit 1
fi
`,
);

// 36. merge_request_id_recover smoke
S(
  "merge_request_id_recover smoke (W-064, false-abort recovery from request-file evidence)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/merge_request_id_recover.test.ts" >/dev/null 2>&1; then
    echo "  ok (stderr-path / newest-file / stale-guard / basename / relative-retry)"
else
    echo "  FAIL: merge_request_id_recover smoke"; exit 1
fi
`,
);

// 37. workspace_isolate smoke
S(
  "workspace_isolate smoke (W-080, --collect dirty-worktree guard)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/workspace_isolate.test.ts" >/dev/null 2>&1; then
    echo "  ok (dirty-refuse / force-collect / clean-regression)"
else
    echo "  FAIL: workspace_isolate smoke"; exit 1
fi
`,
);

// 38. dispatch_watch --fleet smoke
S(
  "dispatch_watch --fleet smoke (W-071, durable fleet dormancy watch)",
  `
DW_LOG="$(mktemp)"
if bun test "$ROOT/skills/garelier-core/scripts/dispatch_watch.test.ts" >"$DW_LOG" 2>&1; then
    echo "  ok (drain / gated-exclude / multi-watch / revive / usage)"
else
    echo "  FAIL: dispatch_watch --fleet smoke (full captured log follows)"
    cat "$DW_LOG"
    rm -f "$DW_LOG"
    exit 1
fi
rm -f "$DW_LOG"
`,
);

// 39. fleet_watch standing-loop smoke
S(
  "fleet_watch standing-loop smoke (W-028, permanent stall watch that never expires)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/fleet_watch.test.ts" >/dev/null 2>&1; then
    echo "  ok (actionable / clean-cap / lock-guard / stale-reclaim / suppression / stop / usage)"
else
    echo "  FAIL: fleet_watch standing-loop smoke"; exit 1
fi
`,
);

// 40. task_mirror_hook delta smoke
S(
  "task_mirror_hook delta smoke (W-030, framework-owned PostToolUse Task-mirror)",
  `
if bun test "$ROOT/skills/garelier-core/hooks/task_mirror_hook.test.ts" >/dev/null 2>&1; then
    echo "  ok (out-of-scope / no-flags guard / baseline / no-delta / delta)"
else
    echo "  FAIL: task_mirror_hook delta smoke"; exit 1
fi
`,
);

// 41. merge_land macro smoke
S(
  "merge_land macro smoke (W-088, submit->wait->cleanup->pull in one command)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/merge_land.test.ts" >/dev/null 2>&1; then
    echo "  ok (success / failure / guard non-interference)"
else
    echo "  FAIL: merge_land macro smoke"; exit 1
fi
`,
);

// 42. merge-gate robustness smoke
S(
  "merge-gate robustness smoke (W-076 mid-gate absorb / W-077 primary-escape heal)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/merge_gate_robustness.test.ts" >/dev/null 2>&1; then
    echo "  ok (absorb-intact success / non-match abort / lossless heal / non-identical fail / second-runner exclusion)"
else
    echo "  FAIL: merge-gate robustness smoke"; exit 1
fi
`,
);

// 43. dispatch_cleanup options smoke
S(
  "dispatch_cleanup options smoke (W-019 --report-from-file / W-021 --record-touches)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/dispatch_cleanup.test.ts" >/dev/null 2>&1; then
    echo "  ok (report-from-file / missing-source no-op / record-touches)"
else
    echo "  FAIL: dispatch_cleanup options smoke"; exit 1
fi
`,
);

// 44. dispatch_codex_producer sandbox/add-dir smoke
S(
  "dispatch_codex_producer sandbox/add-dir smoke",
  `
if bun test "$ROOT/skills/garelier-core/scripts/dispatch_codex_producer.test.ts" >/dev/null 2>&1; then
    echo "  ok (danger refused / workspace-write add-dir grants)"
else
    echo "  FAIL: dispatch_codex_producer smoke"; exit 1
fi
`,
);

// 45. pm_commit merge-gate commit guard smoke
S(
  "pm_commit merge-gate commit guard smoke (W-023)",
  `
if bun test "$ROOT/skills/garelier-core/scripts/pm_commit.test.ts" >/dev/null 2>&1; then
    echo "  ok (idle commit / active-lock + queued refuse / resolved idle / --wait)"
else
    echo "  FAIL: pm_commit commit-guard smoke"; exit 1
fi
`,
);

// 46. blueprint_ship ship/abandon bookkeeping smoke
S(
  "blueprint_ship ship/abandon bookkeeping smoke (W-064 #10)",
  `
if bun test "$ROOT/skills/garelier-pm/scripts/blueprint_ship.test.ts" >/dev/null 2>&1; then
    echo "  ok (shipped / dry-run / abandoned / missing-entry note)"
else
    echo "  FAIL: blueprint_ship smoke"; exit 1
fi
`,
);

// 47. version-drift check
S(
  "version-drift check (W-060, VERSION is the single source)",
  `
VD_V="$(tr -d '[:space:]' < "$ROOT/VERSION")"
vd=0
vd_check() {
    if [ -z "$2" ]; then
        echo "  FAIL: $1 — no version literal found (surface moved? update ci.ts W-060 list)"; vd=1
    elif [ "$2" != "$VD_V" ]; then
        echo "  FAIL: $1 — '$2' != VERSION '$VD_V'"; vd=1
    fi
}
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
    vd_check "$f" "$(grep -oE '"version": *"[0-9]+\\.[0-9]+\\.[0-9]+"' "$ROOT/$f" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
done
vd_check "README.md (license line)" "$(grep -oE 'Garelier v[0-9]+\\.[0-9]+\\.[0-9]+' "$ROOT/README.md" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
vd_check "README.ja.md (license line)" "$(grep -oE 'Garelier v[0-9]+\\.[0-9]+\\.[0-9]+' "$ROOT/README.ja.md" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
vd_check "setup_wizard TypeScript implementation (version literals)" "$(grep -E 'WIZARD_VERSION = |garelier_version = |wizard_version = |Garelier version: |Garelier Setup Wizard|initialize PM .*\\(v[0-9]' \
    "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" \
    "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard/config_emit.ts" \
    "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard/fresh.ts" \
    "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard/migrate.ts" 2>/dev/null \
    | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
if [ "$vd" -eq 0 ]; then
    echo "  ok (plugin.json / marketplace.json / README / README.ja / setup_wizard TS all = $VD_V)"
else
    echo "  FAIL: version drift — bump every surface with the release (W-060)"; exit 1
fi
`,
);

// ── run ───────────────────────────────────────────────────────────────────────
for (const s of steps) {
  step(s.name);
  const ok = s.fn ? s.fn() : sh(s.body!);
  if (!ok) fail = 1;
}

out("");
out(fail === 0 ? "CI: all checks passed." : "CI: FAILURES above.");
process.exit(fail);
