---
knowledge_id: security.license_policy
title: License Policy (Garelier default — commercial-use friendly)
category: security
status: active
owners:
  - pm
consumers:
  - smith
  - guardian
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# License Policy (Garelier default — commercial-use friendly)

Garelier defaults to **permissive, commercial-use-friendly** licensing.
A dependency under the allowlist is fine; one under the denylist (strong
copyleft / non-commercial) is **BLOCK** unless PM / security owner records an
exception. Edit the registries for your project.

## Allowed (permissive)

MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, Zlib,
BSL-1.0, and CC0-1.0. See `registries/license_allowlist.toml`.

## Review before use (weak copyleft — not allowed by default)

LGPL, **MPL-2.0**, EPL-2.0, and CDDL-1.0 sit in the registry `review` tier:
not allowed by default; adopt only after a linking / distribution review is
recorded (file-level copyleft still imposes duties when you modify or
redistribute the covered files). See `registries/license_denylist.toml`.

## Forbidden / needs explicit approval (strong copyleft / non-commercial)

GPL-2.0 / GPL-3.0, AGPL-3.0, SSPL, Commons-Clause, CC-BY-NC, and other
non-commercial terms. See `registries/license_denylist.toml`.
**AGPL / SSPL** especially: avoid in a commercial or network-distributed
product without legal sign-off.

## Unknown licenses

Default: `PASS_WITH_NOTES` + a `knowledge_update_request` (not an auto-block),
so a missing SPDX field does not stall every merge. Set
`[guardian_policy].block_on_unknown_license = true` to require a known license.

## Why permissive-by-default

Garelier prefers permissive licensing so downstream **commercial** use stays
unencumbered; the default policy reflects that. Adjust if your project has
different obligations.
