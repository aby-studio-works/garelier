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
| secret scan | `gitleaks dir --no-banner --redact` (gitleaks: MIT) |
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
  Verify with `gitleaks version`.
  - `gitleaks detect` is **deprecated since 8.19** (still runs, but hidden from
    `--help`). Modern equivalents: `gitleaks dir --no-banner --redact .` (working
    tree) and `gitleaks git ...` (history).

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
