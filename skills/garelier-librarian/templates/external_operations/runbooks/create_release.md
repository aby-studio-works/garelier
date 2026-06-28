# Runbook: create_release (Garelier default — edit per project)

> Librarian-owned runbook the Concierge follows (DEC-025, Phase 2). Installed at
> the `external_operations/runbooks/create_release.md` knowledge file. See
> `release_policy.md` for policy and `rollback_policy.md` for recovery.
> Default-disabled; runs only when `allowed_operation_kinds` includes
> `create_release`.
> If the public release must be made from a history-free exported repository,
> follow `publish_public_export_release.md` instead of tagging the development
> repository directly.

## Inputs (from assignment.md, fixed by PM)

`provider` (github|gitlab), `tag` (`v<version>`), `target_sha`,
`release_notes` source, `artifact_manifest` (list of files), optional
`return_branch`, the passing `guardian_report_path` (+ verdict), and the
artifact-scan command (or policy).

## Steps (Concierge, in its own worktree)

1. **Provider check (parity-safe).** `command -v gh` / `glab`. Absent → `NO_OP`
   report naming the missing CLI + BLOCK. Never publish partially.
2. **Gate check.** Guardian `PASS`/`PASS_WITH_NOTES`, `review_sha` covers
   `target_sha` (not stale). Else BLOCK.
3. **Tag clobber check.** `git ls-remote --tags origin <tag>` — if it already
   exists remotely, BLOCK (no clobber).
4. **Artifact scan.** Scan the `artifact_manifest` files for secrets / forbidden
   files. Fail or required-scanner-missing → BLOCK. Record artifact hashes
   (`sha256`) for the report.
5. **Lock.** Acquire the target-scoped lock `runtime/concierge/locks/release__<tag>.lock` (SKILL §5).
6. **Build the note.** Generate from `templates/release_note.md` (pointer-only).
7. **Tag + push.** `git tag -a "<tag>" <target_sha> -m "<title>"`;
   `git push origin "<tag>"` (no force).
8. **Create a draft release.**
   - GitHub: `gh release create "<tag>" <artifacts...> --notes-file <note> --title "<title>" --draft --verify-tag`.
   - GitLab: `glab release create "<tag>" <artifacts...> --notes-file <note>`.
9. **Inspect and publish.** Verify tag, title, body, target commit, and assets.
   Publish only after inspection passes.
   - GitHub: `gh release edit "<tag>" --draft=false --verify-tag`.
   - GitLab: use the provider's publish step for the draft, or BLOCK if the
     CLI cannot publish an inspected draft safely.
10. **Return branch.** If the assignment fixed a `return_branch`, switch the
    local checkout back to it and verify `git status --short` is clean.
11. **Verify + report.** Capture release URL, tag SHA, artifact hashes; write
   `concierge_report.md` + the promote/release record (pointer-only) with a
   rollback note. Release the lock; → REPORTING.

## On any stop

Leave the remote at the last safe point (a pushed tag with no release is
recorded for cleanup), release the lock, BLOCK to PM. Never force, never clobber
an existing tag/release, never silently retry.
