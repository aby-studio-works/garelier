// gateEnv / env minimizer — the single source of truth for every Garelier
// driver child-process env: the merge gate's own git/bun plumbing, the actual
// project quality-gate/preflight/run-verify command spawn (the same class of
// spawn as gate_runner.ts's runStep), and the codex/claude provider-launcher
// child env (dispatch_provider.ts, provider_session.ts). Centralized here
// so
// the commit-marker boundary AND the env-minimization policy cannot drift between call
// sites.
//
// W-123: on Windows Bun an in-process `process.env.X = ...` / `delete
// process.env.X` does NOT propagate to spawnSync/spawn children — the child
// inherits the env snapshotted at process start, not the mutated one (proven:
// `bun -e 'process.env.X="1"; spawnSync(["sh","-c","echo ${X:-UNSET}"])'` →
// UNSET). merge-gate.ts historically relied on top-level `process.env`
// mutations (GARELIER_MERGE_GATE_COMMIT / GIT_TERMINAL_PROMPT set, RUSTC_WRAPPER
// deleted) reaching git and the quality-gate compile. On Windows Bun they did
// not, so (a) the gate's own merge commit was blocked by the commit_guard hook
// AFTER a full quality-gate pass (a real target-project abort, 2026-07-17) and
// (b) the quality gate compiled through sccache from a stale RUSTC_WRAPPER
// (broken-rlib #346 class). The fix is to pass an EXPLICIT env object — a spread
// of the current process.env DOES carry mutations to the child — at every
// spawn. Centralized here so the commit-marker boundary cannot drift between call sites.
//
// A key whose value is `undefined` is dropped from the child env by Bun (proven:
// `{ ...process.env, RW: undefined }` → child sees RW UNSET), which is exactly
// the unset semantics the RUSTC wrappers need.

import { injectLaneEnv, mergeEnvironmentCaseInsensitive } from "./lane_env.ts";

// --- W-249: shared env minimizer (moved from gate_runner.ts, W-157/W-236/W-237/W-241) --
//
// gate_runner.ts's per-step child env started as a MINIMAL allowlist (W-157
// BLOCK 4: a step can never read tokens/keys from the inherited environment)
// plus a name-based secret override (W-157 O) and a value-based URL-credential
// check (W-241). W-241's own worker sweep then found THREE other spawn sites —
// merge-gate.ts's gateEnv() (git/bun plumbing AND, until this change, the
// project's own quality-gate command spawn), provider_session.ts's
// providerChildEnv() (codex/claude resume), and dispatch_provider.ts's
// childEnvWithBun() (codex launch) — that spread `process.env` into a child
// with NO name filter and NO value filter at all: a strictly WIDER gap than
// gate_runner's pre-W-241 state (raw `*_TOKEN`/`*_SECRET` sailed through, not
// just a URL-embedded credential). This module is the one minimizer every site
// now goes through, with a per-site POLICY rather than one fixed allowlist —
// see `minimizeEnv()`'s doc for why a provider launcher (codex/claude CLI)
// must NOT get the name-based secret drop (it legitimately needs its own
// `*_API_KEY`/`*_TOKEN` to authenticate) while a build/gate command spawn
// (cargo/rustc/scripts) gets the full MINIMAL_ENV_KEYS allowlist.

// PATHEXT is required for Windows executable resolution (which/cc-rs/sccache) —
// without it a step's spawned `which clang` still succeeds but `sccache clang`
// cannot resolve the compiler's binary path, failing every cc-rs C compile
// (W-236).
// Windows env var names are case-insensitive by OS convention, and the enumerated
// casing a process observes depends on the launching shell — Git Bash under bun
// surfaces SYSTEMROOT/SYSTEMDRIVE/COMSPEC/WINDIR (all-caps) rather than the
// SystemRoot/SystemDrive/ComSpec/windir spellings below, so a case-sensitive test
// silently dropped them from every gate step's child env (W-237, found via W-236 O
// gate N1). The /i flag matches any casing instead of chasing individual spellings
// (a second instance of the same drop class after W-236's PATHEXT fix); the mixed
// literal casing above is left as-is for readability. SECRET_ENV_RE below is
// already case-insensitive, so this does not change which secrets get through —
// see the isSecretEnvKey allowlist/secret cross-check in minimizeEnv().
export const MINIMAL_ENV_KEYS = /^(?:PATH|Path|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|SystemRoot|SystemDrive|ComSpec|windir|CARGO(?:_\w+)?|RUSTUP(?:_\w+)?|RUSTFLAGS|RUST_\w+|RUSTC\w*|CC|CXX|AR|MSYSTEM|MINGW\w*|LANG|LC_\w+|NUMBER_OF_PROCESSORS)$/i;
// W-157 O elevation: a blanket secret drop that OVERRIDES the allowlist. The guard
// only inspects the shell string, so a compiled step (build.rs, a test body, a
// cargo credential-provider) that reads an env var and egresses directly is invisible
// to it — env minimisation is the ONLY defense there. So even an allowlisted var
// (e.g. `CARGO_REGISTRY_TOKEN` matches `CARGO_\w+`) is dropped if its name carries a
// credential marker. Fail-closed: match wins, the var is never forwarded.
//
// This name-based drop is opt-out (`dropSecretNames: false`), NOT unconditional,
// because a provider-launcher child (codex/claude CLI) legitimately needs its own
// `*_API_KEY`/`*_TOKEN` env to authenticate — dropping those would break the
// launch, not secure it (W-249). Every call site still gets the value-based
// hasEmbeddedCredential() check below unconditionally.
export const SECRET_ENV_RE = /_TOKEN|_SECRET|_PASSWORD|_KEY|_CREDENTIAL/i;
export function isSecretEnvKey(key: string): boolean { return SECRET_ENV_RE.test(key); }

// W-241: SECRET_ENV_RE above is a NAME check — it never sees a credential embedded
// in a VALUE that sits behind an otherwise-innocuous, allowlisted name. `cargo`
// reads registry/proxy endpoints as `scheme://user:pass@host` userinfo URLs
// (CARGO_HTTP_PROXY, CARGO_REGISTRIES_<name>_INDEX, …), all of which match the
// `CARGO(?:_\w+)?` head in MINIMAL_ENV_KEYS and sailed through unfiltered (found by
// W-237 G gate N3). This is a second, orthogonal check on the VALUE: any forwarded
// value carrying URL userinfo (`scheme://user:pass@host`) is dropped even when its
// NAME passes the allowlist — fail-closed, same posture as the name-based override
// above. A bare endpoint with no embedded credential (no `:...@` userinfo) still
// forwards; proxy/registry URLs without creds are legitimate build inputs.
//
// W-249 (Guardian N1): the original single regex only matched a SCHEME-prefixed URL
// with an explicit password colon. Four bypass shapes still forwarded a credential
// through an allowlisted name — each gets its own branch below so a false-positive
// or a miss in one is easy to isolate without touching the others:
//   (a) password-less / token-only userinfo — `https://ghp_xxx...@host` (no `:`
//       before `@`; the GitHub-PAT / Azure-DevOps-PAT-as-username convention). A
//       SHORT username (`https://git@host`) is deliberately NOT flagged — real
//       tokens run 20+ chars, so the length floor keeps ordinary `user@host` forms
//       (git/ssh-style remotes) from false-positiving.
//   (b) scheme-omitted `user:pass@host[:port]` — a raw proxy value with no
//       `scheme://` (or even `//`) prefix at all.
//   (c) scheme-relative `//user:pass@host` (protocol-relative URL).
//   (d) percent-encoded colon (`user%3Apass@host`) — decoded before testing, so it
//       composes with (a)/(b)/(c) instead of needing a 4th branch.
// (a) scheme + token-only userinfo (no colon), 20+ token-alphabet chars. W-249
// (Guardian N2 = Observer N2): `/` and `=` are deliberately EXCLUDED from the
// token alphabet — a real PAT never contains either (GitHub/Azure-DevOps PATs
// are hex/URL-safe-base64), so the capture rate is unchanged, but a real URL
// PATH now stops the run before it can span across a `/` boundary and reach an
// unrelated `@`. Without this, `https://registry.example.test/some/long/path/@scope/pkg`
// (an npm-scope-style path segment) or a namespaced Docker digest reference
// (`.../myorg/myimage@sha256:…`) false-positived: the old class let the whole
// multi-segment PATH before the `@` count as "one long token".
const TOKEN_USERINFO_CRED_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[A-Za-z0-9._~+-]{20,}@/;
// (b)/(c) colon-separated userinfo with an OPTIONAL scheme — covers both the
// original `scheme://u:p@h` shape and the protocol-relative `//u:p@h` shape.
const COLON_USERINFO_CRED_RE = /(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^/@\s]*:[^/@\s]*@/;
// (b) fully scheme-less, slash-less `user:pass@host[:port]` — the raw shape a
// proxy env var can use with no `scheme://`/`//` prefix. Every segment excludes
// backslash so a Windows path (`C:\Users\name@corp\bin`) can never satisfy this
// pattern (paths use `\`, and never end at `/`/`?`/`#`/end-of-string right after
// a bare directory-looking segment the way a credential URL's host does).
//
// W-249 (Guardian N2, found empirically while implementing the token-class fix
// above): the ORIGINAL bare-form host segment accepted ANY non-separator run,
// which flags dependency-coordinate syntax as a credential — e.g. a Maven/Gradle
// override env var `com.example:artifact@jar` (group:artifact@packaging) has
// EXACTLY the `X:Y@Z` shape this branch looks for. Requiring Z to look host-like
// (a dotted multi-label name, or a single-label name with an explicit `:port`)
// excludes `@jar`/`@pom`/`@war`-style packaging suffixes (no dot, no port) while
// every realistic bare credential URL still matches — proxy/registry creds are
// conventionally written with either a dotted domain or an explicit port. A
// single-label, portless, dotless bare host (`svc:pass@dbhost`) is the one
// deliberately accepted gap from this change; it is an atypical shape for a
// credential URL and was judged a better trade than the false-positive class
// above, which is common in real dependency-management env vars.
const BARE_USERINFO_CRED_RE = /(?<![\w:/\\.@-])[^\s/\\@:]{1,64}:[^\s/\\@:]{1,128}@(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+(?::\d{1,5})?|[A-Za-z0-9-]+:\d{1,5})(?:[/?#]|$)/;

// (d) percent-encoded colon — decode before testing so one pass covers all 3
// shapes above with the colon either literal or `%3A`/`%3a`-encoded.
function decodeCredentialColon(value: string): string { return value.replace(/%3[Aa]/g, ":"); }

export function hasEmbeddedCredential(value: string): boolean {
  const v = decodeCredentialColon(value);
  return COLON_USERINFO_CRED_RE.test(v) || TOKEN_USERINFO_CRED_RE.test(v) || BARE_USERINFO_CRED_RE.test(v);
}

export interface MinimizeEnvOptions {
  /** Source env to filter; defaults to `process.env`. */
  source?: Record<string, string | undefined>;
  /** Restrict the result to MINIMAL_ENV_KEYS (+ extraAllow). Default false — most
   * call sites (git/bun plumbing, provider launchers) need env this module cannot
   * fully enumerate; only a build/gate command spawn (cargo/rustc/scripts — the
   * same class as gate_runner.ts's runStep) should set this true. */
  allowlist?: boolean;
  /** Extra name allowlist, OR'd with MINIMAL_ENV_KEYS when `allowlist: true`. */
  extraAllow?: RegExp;
  /** Drop any var whose NAME carries a credential marker (SECRET_ENV_RE). Default
   * true. A provider CLI (codex/claude) legitimately needs its OWN api-key-shaped
   * env (ANTHROPIC_API_KEY, CODEX_API_KEY, …) to authenticate, so a caller
   * spawning one of those passes `false` here — narrowing to the value-only
   * hasEmbeddedCredential() check below, which never matches an opaque API key
   * (it requires a URL-shaped `…://user:pass@host` / `user:pass@host` value). */
  dropSecretNames?: boolean;
  /** Extra keys merged onto the result AFTER filtering (e.g. CARGO_INCREMENTAL=0). */
  extraSet?: Record<string, string>;
}

/** Filter an env object per `opts` (see MinimizeEnvOptions). The value-based
 * hasEmbeddedCredential() check ALWAYS applies — it is not one of the toggles —
 * because a value that carries embedded URL userinfo credentials has no
 * legitimate reason to reach any child process this module spawns. */
export function minimizeEnv(opts: MinimizeEnvOptions = {}): Record<string, string> {
  const source = opts.source ?? process.env;
  const useAllowlist = !!opts.allowlist;
  const dropSecretNames = opts.dropSecretNames !== false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== "string") continue;
    if (dropSecretNames && SECRET_ENV_RE.test(k)) continue;
    if (useAllowlist && !MINIMAL_ENV_KEYS.test(k) && !(opts.extraAllow && opts.extraAllow.test(k))) continue;
    if (hasEmbeddedCredential(v)) {
      // Name only — the value that triggered the drop is never logged.
      try { process.stderr.write(`env-minimizer: dropped env ${k} — value carries an embedded URL credential\n`); } catch { /* best-effort */ }
      continue;
    }
    out[k] = v;
  }
  return mergeEnvironmentCaseInsensitive(out, opts.extraSet ?? {}) as Record<string, string>;
}

/** gate_runner.ts's per-step child env: full MINIMAL_ENV_KEYS allowlist + the
 * name/value secret drops, plus CARGO_INCREMENTAL=0. Kept as a named function
 * (rather than inlining minimizeEnv() at each call site) so gate_runner.ts and
 * merge-gate.ts's own quality-gate command spawn (gateCommandEnv() below) stay
 * provably identical policy — both call THIS. */
export function minimalEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  return minimizeEnv({ source, allowlist: true, extraSet: { CARGO_INCREMENTAL: "0" } });
}

export const ROLE_SEAT_ENV = "GARELIER_ROLE_SEAT";
const RUSTC_WRAPPER_ENV_KEYS = new Set(["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]);

/** Windows treats environment names case-insensitively. Remove every observed
 * spelling before adding the canonical empty/unset keys, otherwise a lowercase
 * inherited key can survive beside the uppercase bypass key. */
export function withoutRustcWrapperEnv<T extends string | undefined>(
  source: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!RUSTC_WRAPPER_ENV_KEYS.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/** Core-owned provider invariants. Fresh launch and exact-session resume pass
 * this complete overlay as layer 3 of injectLaneEnv(); keeping it separate from
 * the scrubbed provider base prevents a project declaration from replacing a
 * role-seat invariant. */
export function roleProviderCoreEnv(): Record<string, string> {
  return {
    [ROLE_SEAT_ENV]: "1",
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
  };
}

/** Provider CLI env: keep provider authentication inputs, but make every Cargo
 * child bypass shared rustc wrappers so a sandbox role can never become the
 * first launcher of a machine-wide sccache server. */
export function roleProviderEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return injectLaneEnv(
    withoutRustcWrapperEnv(minimizeEnv({ source, dropSecretNames: false })),
    {},
    roleProviderCoreEnv(),
  ) as Record<string, string>;
}

/** Worker scoped-gate env: exactly the shared minimal policy, with only the
 * role marker and explicit shared-wrapper bypass layered on top. */
export function roleBuildEnv(
  source: Record<string, string | undefined> = process.env,
  projectOverrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return injectLaneEnv(
    withoutRustcWrapperEnv(minimalEnv(source)),
    projectOverrides,
    {
      CARGO_INCREMENTAL: "0",
      ...roleProviderCoreEnv(),
    },
  ) as Record<string, string>;
}

/** The child-process env for a merge-gate git/bun PLUMBING spawn (status, merge,
 * config reads — never the project's own quality-gate command): no interactive
 * git prompt + the RUSTC wrappers unset, layered
 * over a VALUE-ONLY-filtered process env (name-based secret drop + credential-URL
 * value drop, no MINIMAL_ENV_KEYS allowlist — git/bun plumbing needs env this
 * module cannot enumerate, e.g. project-specific GARELIER_ config vars). Extra
 * overrides win except Rust wrapper keys, which are always removed
 * case-insensitively before the canonical unset keys are added. */
export function gateEnv(
  projectOverrides: Record<string, string | undefined> = {},
  coreOwned: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const inherited = withoutRustcWrapperEnv(minimizeEnv({}));
  return injectLaneEnv(inherited, projectOverrides, mergeEnvironmentCaseInsensitive(coreOwned, {
    GARELIER_MERGE_GATE_COMMIT: undefined,
    GIT_TERMINAL_PROMPT: "0",
    RUSTC_WRAPPER: undefined,
    RUSTC_WORKSPACE_WRAPPER: undefined,
  }));
}

/** The sole env carrying the commit-guard exemption marker. Use only for the
 * merge gate's final gate-owned `git commit`. */
export function gateCommitEnv(
  projectOverrides: Record<string, string | undefined> = {},
  coreOwned: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return mergeEnvironmentCaseInsensitive(gateEnv(projectOverrides, coreOwned), {
    GARELIER_MERGE_GATE_COMMIT: "1",
  });
}

/** The child-process env for the ACTUAL project quality-gate/preflight/run-verify
 * command spawn (merge-gate.ts step 3b/4/4b) — the SAME class of spawn as
 * gate_runner.ts's runStep (a cargo/cooker/scripts/quality command), so it gets
 * the SAME full minimization via minimalEnv() (W-249: this was the residual half
 * of the W-241 gap — merge-gate's own spawned gate command still got the raw,
 * unfiltered gateEnv() spread). The commit marker is explicitly absent because
 * a project command may itself invoke `git commit`. */
export function gateCommandEnv(
  projectOverrides: Record<string, string | undefined> = {},
  extraCoreOwned: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const inherited = minimalEnv();
  const coreOwned = mergeEnvironmentCaseInsensitive({ CARGO_INCREMENTAL: inherited.CARGO_INCREMENTAL }, extraCoreOwned, {
    GARELIER_MERGE_GATE_COMMIT: undefined,
    GIT_TERMINAL_PROMPT: "0",
    RUSTC_WRAPPER: undefined,
    RUSTC_WORKSPACE_WRAPPER: undefined,
  });
  return injectLaneEnv(withoutRustcWrapperEnv(inherited), projectOverrides, coreOwned);
}
