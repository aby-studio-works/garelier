#!/usr/bin/env bash
#
# Make a publishable, HISTORY-FREE export of the Garelier framework.
#
# Why: the development repo's git history and commit authors carry personal
# info (author email, pre-genericization diffs). Rather than rewrite history,
# this exports the CURRENT tracked tree as a single commit with a neutral
# author into a fresh directory — so the published repo has no history to leak.
#
# It refuses to export if, in the to-be-published tree, it finds: a secret, a
# real email, a private identifier (the project name / a dev handle), a leftover
# personal-or-other-project term, or a reference/link INTO the excluded
# __garelier/ tree (which would become a dead link after publish). The repo's
# own self-PM dashboard (__garelier/) is excluded by default — it is dogfooding
# state, not part of the distributed framework — so scans for things that should
# not LEAVE the repo only inspect the publish set.
#
# Usage:
#   scripts/make-public-export.sh <dest-dir> [author-name] [author-email]
#
# Example:
#   scripts/make-public-export.sh /tmp/garelier-public "Garelier" "noreply@example.com"
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: make-public-export.sh <dest-dir> [author-name] [author-email]}"
AUTHOR_NAME="${2:-Garelier}"
AUTHOR_EMAIL="${3:-noreply@example.com}"
VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo "0.0.0")"

cd "$ROOT"

echo "==> Publish gate: scanning tracked tree for sensitive content"
fail=0
note() { echo ""; echo "  !! $1"; echo "$2" | sed 's/^/     /'; fail=1; }

# 1. Secret-shaped strings. Known redact()-test dummies are excluded so the
#    secret-redaction tests don't trip the gate; everything else is fatal.
secrets="$(git grep -nIE \
  'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{20,}' \
  -- . ':(exclude)*.test.ts' 2>/dev/null \
  | grep -v 'AKIAIOSFODNN7EXAMPLE' || true)"
  # AKIAIOSFODNN7EXAMPLE is AWS's published, non-functional documentation example
  # key, used here only as a scanner test fixture — allowlisted like the example
  # emails below (genuine false positive, not a real secret).
[ -n "$secrets" ] && note "secret-shaped strings found:" "$secrets"

# 2. Real email addresses (generic/example/noreply ones are fine).
emails="$(git grep -nIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . 2>/dev/null \
  | grep -viE 'example\.(com|org)|noreply|anthropic|@ci|ci@ci|your-?(domain|email)|@company|@host|@garelier|@<' || true)"
[ -n "$emails" ] && note "non-generic email addresses found:" "$emails"

# 3. Optional project-local deny regex for private identifiers. Keep the regex
#    outside this repo so the gate does not itself leak the terms it checks.
if [ -n "${GARELIER_PUBLIC_EXPORT_DENY_RE:-}" ]; then
  terms="$(git grep -nIiE "$GARELIER_PUBLIC_EXPORT_DENY_RE" -- . 2>/dev/null || true)"
  [ -n "$terms" ] && note "leftover personal/other-project terms found:" "$terms"
else
  echo "  (no GARELIER_PUBLIC_EXPORT_DENY_RE set; skipped custom private-term scan)"
fi

# Scans 4 and 5 inspect only the PUBLISH SET (the tree the export below ships):
# the __garelier/ dogfooding tree is excluded at export time, so references to it
# and private terms that live only inside it are not published and not our concern
# here. They scope with the same ':(exclude)__garelier' pathspec git archive uses.
PUB=':(exclude)__garelier'

# 4. Built-in private-identifier deny (always on; complements the optional regex
#    above). Catches bare developer usernames and the private project name that
#    are not email-shaped — case-insensitive whole-word so generic prose is safe.
#    This gate script itself is excluded: it necessarily spells the deny terms as
#    code, like section 1 excludes its own secret-redaction test dummies. Its
#    repo-relative path is resolved from its own location, not $0 / cwd.
SELF="$(git -C "$ROOT" ls-files --full-name -- "$0" 2>/dev/null || true)"
[ -n "$SELF" ] || SELF="scripts/$(basename "$0")"
builtin="$(git grep -nIiwE 'suture|rifu' -- . "$PUB" ":(exclude)$SELF" 2>/dev/null || true)"
[ -n "$builtin" ] && note "private identifiers (project name / dev handle) found in a to-be-published file:" "$builtin"

# 5. Link-check: a published file must not reference/link INTO the excluded
#    __garelier/ tree (those become dead links in the public repo). Catches
#    markdown links '](__garelier/', the dogfood pm_id '__garelier/_workshop',
#    and concrete '__garelier/<id>/control' paths. The framework legitimately
#    documents the '__garelier/<pm_id>/' CONCEPT, so the placeholder '<pm_id>'
#    form is intentionally not matched — only concrete paths into the tree are.
#    This gate script is excluded ($SELF): it spells the path patterns as code.
deadlinks="$(git grep -nIE '\]\(__garelier/|__garelier/_workshop|__garelier/[A-Za-z0-9_-]+/control' -- . "$PUB" ":(exclude)$SELF" 2>/dev/null || true)"
[ -n "$deadlinks" ] && note "references/links into the EXCLUDED __garelier/ tree (dead links after publish — fix these before export):" "$deadlinks"

if [ "$fail" -ne 0 ]; then
    echo ""
    echo "ABORT: sensitive content in the tracked tree — not exporting."
    echo "Fix the findings above (or extend the allowlist if they are genuine"
    echo "false positives) and re-run."
    exit 1
fi
echo "  ok (no secrets / real emails / private identifiers / leftover terms / dead links into __garelier/)"

# Refuse to clobber a non-empty destination.
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
    echo "ABORT: destination '$DEST' exists and is not empty." >&2
    exit 1
fi
mkdir -p "$DEST"

echo "==> Exporting tracked tree (excluding __garelier/ dogfooding state)"
# git archive emits only tracked files; the pathspec drops the self-PM tree.
git archive --format=tar HEAD -- . ':(exclude)__garelier' | tar -x -C "$DEST"

echo "==> Initializing a single-commit history with a neutral author"
(
    cd "$DEST"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git add -A
    # Conventional-commits compliant so the published repo's own ci.sh commit
    # lint (lint_commits.ts --last) passes on the first public CI run.
    git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" \
        commit -qm "chore(release): Garelier v$VERSION"
)

echo ""
echo "==================================================================="
echo "Exported a clean, history-free Garelier v$VERSION to:"
echo "  $DEST"
echo "  (single commit, author: $AUTHOR_NAME <$AUTHOR_EMAIL>)"
echo "==================================================================="
echo "Next: review it, then publish from there (e.g. add a public remote and"
echo "push). The development repo's history (with personal info) stays local."
