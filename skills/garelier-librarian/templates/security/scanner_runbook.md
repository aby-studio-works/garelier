---
knowledge_id: security.scanner_runbook
title: Scanner Runbook (Garelier default — map to your toolchain)
category: security
status: active
owners:
  - pm
consumers:
  - guardian
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Scanner Runbook (Garelier default — map to your toolchain)

General-purpose commands. Set the concrete ones in `[guardian_tools]` and in the
Guardian assignment.

| Gate | Suggested command |
| --- | --- |
| secret scan | `gitleaks dir . --no-banner --redact --report-format json --report-path -` (gitleaks: MIT) |
| dependency / vuln | `npm audit --json` / `cargo audit` / `pip-audit` / `osv-scanner -r .` |
| license | `license-checker` / `cargo deny check licenses` / `pip-licenses` |
| SAST (optional) | `semgrep --config auto` |

## Prerequisite: the named scanner must be installed

A scanner named in `[guardian_tools]` (or the Guardian assignment) is a **hard
prerequisite** when its gate is mandatory and
`block_when_required_scanner_unavailable = true`: if the binary is missing, the
secret / PII gate cannot PASS — it emits **BLOCK** (interactive) /
**ENV-BLOCKED** (driver). Do not provision the scanner autonomously. If the user
explicitly instructs/approves installation, follow the project package policy
and existing command guard (`install_guard_enabled` must be off); otherwise the
environment owner may provision it independently. Resume the gate only after
the prerequisite is available.

- **gitleaks** (default secret scanner, MIT): user-managed prerequisite. Resolve
  an existing executable absolutely; if absent or incompatible, BLOCK/SKIP per
  policy. Its resolver only locates an existing local executable; it does not
  install or authorize installation.
  Verify with `bun skills/garelier-core/driver/src/guardian_scan.ts --probe-gitleaks`
  — a bare `gitleaks version` is NOT the probe and is refused at a gate seat.
  - `gitleaks detect` is **deprecated since 8.19** (still runs, but hidden from
    `--help`). The modern equivalents — kept on one line each so they are safe to
    copy verbatim (a wrapped command is copied truncated):

    ```bash
    gitleaks dir . --no-banner --redact --report-format json --report-path -
    gitleaks git . --no-banner --redact --report-format json --report-path - --log-opts <base>...<head>
    ```

## probe-READY is NOT mandatory-scanner satisfaction (W-353)

`--probe-gitleaks` answers ONE question: is the executable present and does it
run. `status: "READY"` means the scanner **can** run — it is availability, not
coverage, and **never** satisfies a mandatory secret / PII gate on its own.
A mandatory gate is satisfied only by an actual scan of the reviewed tree whose
result the verdict cites.

- **READY + no scan run** → the mandatory dimension is UNCOVERED. Report it as
  such; do not record PASS for a scan that never happened.
- **BLOCK from the probe** (missing / broken executable) with
  `block_when_required_scanner_unavailable = true` → the gate is **BLOCK**.
- A scan that ran must be cited by its result (findings, or an explicit
  zero-finding result), not by the probe's exit code.

Run every declared scanner as **`cd <worktree> && <command>`** (W-353): the
harness resets the seat's shell cwd between calls and each declared scanner is
bound to the reviewed worktree, so a bare invocation fails closed after a reset.
That denial is a cwd problem, not an unavailable scanner — never let it trigger
degraded mode.

Corollary — the command the seat is authorized to run is the one issued by
`dispatch_prepare` in the seat's permission record (`quality_gate_commands`) and
printed in its spawn plan, NOT whatever prose `[guardian_tools]` happens to
contain. The guard accepts only the canonical gitleaks grammar, so a config
carrying an older spelling makes the two disagree; `dispatch_prepare` reports that
as `scanner_config_drift`. Fix the config — do not hand-run the drifted form and
do not treat its denial as "the scanner is unavailable".

## Delegated scan — when the gate seat itself cannot run the scanner (W-353)

Distinct from degraded mode, and **preferred over it**: coverage stays full and
only the executor changes. Use it when the scanner exists but the gate seat
cannot invoke it (permission profile, environment, sandbox).

1. The seat **escalates** with the attempted command verbatim + the exact failure,
   **naming the denial reason**.
2. The **PM runs the scan with an explicit range / target**.
3. The result is written **verbatim** into an evidence file — command, range /
   target, **the `base` / `head` SHA the scan covered**, and full output (findings
   or an explicit zero-finding result).
4. The seat **cites that evidence file** in its verdict and records that the scan
   was operator-delegated, not seat-run.

**The SHA is mandatory and the citing seat MUST REFUSE evidence that is not bound
to it.** A branch name is mutable, so "recorded the range" can be literally true
of a different tree than the one under review. **A baseline must come from OUTSIDE
the thing it binds** — a reference taken from its own subject cannot say the
subject is the right one. Concretely: **a seat MUST refuse an evidence file whose
recorded base/head does not resolve to its own `review_sha`, and that refusal is
a `BLOCK`.** Requiring the SHA without the refusal duty yields an artifact that
looks bound while nobody must check it. (Header convention follows
`templates/gate_evidence_pack.md`; do not reuse that artifact itself.)

**If the citation does not arrive within the seat's turn, that dimension's status is
`UNCOVERED`** — you cannot write `PASS` until a citation exists, nor
`PASS_WITH_NOTES` (notes are non-blocking; an unrun mandatory scan is not).
**That restriction is limited to the delegated path**: it is about relying on someone
else's scan — do not cite an evidence file that does not exist. A seat whose seat
binding cannot hold (cross-repo) is also `UNCOVERED`; that gap is tracked separately,
and since nothing was delegated there — the seat is stating its own coverage
honestly — the restriction above does not apply to it.

**`UNCOVERED` is a dimension status, not a verdict token.** Only the project's
defined verdict values may appear in `[verdict] result`; declare an uncovered dimension
as an `[[uncovered]]` front-matter table (canonical grammar below).

**`UNCOVERED` labels a DIMENSION; it does not forbid a verdict.** Read together,
the rules above can be taken to mean that a seat which cannot bind may never issue
a passing verdict — which would stop everything, including the change that removes
the limitation. It was introduced so a seat stops **inventing an answer**, not so
it falls silent. A passing verdict carrying an `UNCOVERED` dimension MUST state
(a) which dimension, (b) the cause and its tracking row, and (c) what the
confidence rests on instead. **Whoever consumes such a verdict MUST refuse it when
any of (a)/(b)/(c) is missing, and that refusal is a `BLOCK`** — a recording duty
without a refusal duty produces an artifact that looks bound while nobody must
check it.

**Canonical grammar (W-370):** write one `[[uncovered]]` front-matter table per uncovered dimension.
Every value is nonempty, `tracking_row` is `W-N`, and the secret/PII
hard-stop dimension key is `secret_pii`.

```toml
[[uncovered]]
dimension = '<nonempty>'
cause = '''<nonempty>'''
tracking_row = 'W-N'
alternate_confidence_basis = '''<nonempty>'''
```

**Hard stop, decided from the diff rather than by the seat:** when the changed-file
list trips the security-sensitive or package-file trigger AND the secret/PII
dimension is `UNCOVERED`, the seat must not issue a passing verdict. Use the
project's mechanical policy check over the changed files (paths such as `.env*`,
`**/*.pem`, `**/*.key`, `**/*secret*`, `**/*credential*`, `infra/**`, `deploy/**`,
CI workflow and migration directories; plus dependency manifests). The point is that
**someone other than the seat can recompute the trigger** — asking the seat that
wants to pass whether the gap is "the primary risk" cannot be recomputed and takes
the baseline from inside the thing it binds. That hard stop is what stops the
allowance becoming a loophole.
`merge-gate.ts` carries the Guardian report to the policy backstop; W-370 consumes
the same parsed canonical block there rather than a seat-provided classification.

**Worked example:** a change touching only source and documentation files under a
project's tooling tree — no dependency manifest basename, no path under the
security-sensitive globs — trips neither trigger, so the hard stop does not fire and
a passing verdict carrying an uncovered dimension remains permitted (with the three
disclosures above). Apply the check to the changed-file list and record the result;
do not decide it by impression.

Rationale, kept because the rule is easy to re-tighten by accident: **turning an
environmental gap into a total gate stop is degradation-by-omission** (no gate is
strictly worse than a gate that passes while honestly marking one dimension
uncovered), and **a rule that prevents landing the fix for its own precondition is
self-defeating**. For the same reason, the rules governing a gate come from
outside the artifact being gated — judging a change by the doctrine introduced in
that change takes the baseline from inside its own subject.

**Delegation obliges a fix.** If the reason was config drift, the fix belongs to
the config and the delegated scan is a one-time bridge; if it was a mechanism gap,
file the reachability-fix row. Delegation is a measurement of a defect, not a
standing route — codifying it without the duty to fix makes the workaround
permanent.

Never label a delegated scan as degraded mode (or the reverse): one preserves
coverage, the other reduces it, and the verdict must say which happened. A seat
must never emit PASS for a scan that did not run, nor cite a probe's `READY` as
if it were a scan result.

**Degraded mode is entered ONLY by explicit PM configuration
(`secret_scan = off|none|disabled` AND
`block_when_required_scanner_unavailable = false`). No guard denial of any kind
is grounds for degraded mode.**

## Degraded mode when gitleaks cannot be used

If gitleaks is unavailable or cannot be allowed in the project environment, PM
may deliberately run Guardian without it:

```toml
[guardian_policy]
block_when_required_scanner_unavailable = false

[guardian_tools]
secret_scan = "off"
```

This is a degraded mode, not an equivalent scanner. Guardian still applies the
Librarian-owned policy with available git/Bun/text review and must record that
the default secret scanner was disabled. It must not write "secret scanner
passed" or imply full gitleaks-equivalent coverage. If it finds a likely secret
or PII anyway, it still emits **BLOCK**.

## Rules

- **Never** pass a "no redact" flag; **never** echo a matched secret.
- A **mandatory** scanner (secret / PII) unavailable + policy requires it →
  **BLOCK** (a missing scanner must not wave a secret through).
- A PM-approved degraded secret scan (`secret_scan = "off"` and
  `block_when_required_scanner_unavailable = false`) → continue with notes; do
  not claim full scanner coverage.
- A dependency / license scanner unavailable → **NO_OPINION** + notes.
- Point the report at the scanner **output file**; do not paste raw matches.
