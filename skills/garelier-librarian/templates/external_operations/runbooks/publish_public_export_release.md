# Runbook: publish_public_export_release (history-free public release)

> Librarian-owned runbook the Concierge follows after explicit PM assignment.
> Installed at the
> `external_operations/runbooks/publish_public_export_release.md` knowledge file.
> Use this when the source repository is private or history-sensitive, and the
> public repository must receive a clean export instead of the development
> repository history. See `release_policy.md`, `git_remote_policy.md`, and
> `rollback_policy.md`.
>
> Default-disabled; run only when `allowed_operation_kinds` includes
> `create_release` / `publish_artifact` and the PM assignment fixes every input
> below.

## Inputs (from assignment.md, fixed by PM)

- `version` and `tag` (`v<version>`).
- `dev_repo` path and exact `dev_release_sha`.
- `public_repo` path and exact `public_remote`.
- Export command or script, including its sensitive-content gate.
- Quality-gate commands for both repositories.
- Release-note source and provider (`github` / `gitlab`).
- Passing Guardian report covering the exportable tree and release notes.
- Explicit user approval for the external writes: public-repo push, tag push,
  and provider release publication.

## Stop conditions

- The export gate reports a secret, PII, private project name, real email, or
  link into an excluded private tree.
- The export command is missing, or its deny-list / allow-list configuration is
  unknown.
- `public_repo` is dirty before mirroring, or its `origin` is not the expected
  public remote.
- The public tag already exists and points at a different commit.
- The provider CLI (`gh` / `glab`) is unavailable or not authenticated.
- The release note contains secrets, PII, internal runtime paths, private issue
  titles, or long logs.
- Any fixed SHA, path, tag, or remote in the assignment differs from reality.

## Procedure

1. **Record fixed state.** Capture:
   - development branch / SHA,
   - public branch / SHA,
   - intended tag,
   - public remote URL,
   - release-note file path,
   - quality-gate commands.
2. **Run development gates.** In `dev_repo`, run the assignment's normal quality
   gates and the public export gate. If the export gate finds publish-blocking
   content, BLOCK; fix the development source through the normal producer lane
   and re-run from step 1.
3. **Create a clean export.** Export the tracked development tree into a fresh
   temporary directory, excluding dogfooding/control/runtime state and producing
   a single neutral-author commit. Do not copy `.git` from `dev_repo`.
4. **Mirror into `public_repo`.** Copy only the export working tree into
   `public_repo`, preserving the public repository's `.git` directory. Remove
   files that no longer exist in the export. Never copy excluded private trees.
5. **Restore executable bits.** Reapply required executable bits for scripts and
   command shims, because cross-platform copy tools may drop them.
6. **Run public gates.** In `public_repo`, install ignored local test
   dependencies only when required by the gate, then run the public quality gate.
   Generated dependencies must remain ignored and unstaged.
7. **Commit public release.** Commit the mirrored export in `public_repo` with a
   release commit message. Confirm `git status --short` is clean after commit.
8. **Tag parity check.** Verify the public tag set for the release series. If a
   historical public release commit is missing a tag, only create that tag when
   the exact commit is known and the PM assignment explicitly authorizes it.
9. **Create the new public tag.** Tag the public release commit with `tag`.
   Push the public branch and tag without force.
10. **Create a draft provider release.** Generate notes from the release-note
    template / changelog into a local file. Create a draft release first.
11. **Inspect the draft.** Verify tag, title, release URL, body, draft status,
    target commit, and absence of private details.
12. **Publish.** Publish the draft only after the inspection passes and the user
    instruction covers publication.
13. **Verify and report.** Record:
    - development release SHA and tag,
    - public release SHA and tag,
    - public branch remote SHA,
    - provider release URL,
    - quality gates run,
    - export-gate result,
    - tag parity result,
    - rollback / recovery note.

## Recovery

- If the draft release is wrong, edit or delete the draft before publication.
- If the public push failed before the tag was created, fix locally and retry
  from the public-gate step.
- If the tag was pushed to the wrong commit, BLOCK. Moving or deleting a remote
  tag is a destructive external write and needs a new explicit user instruction.
- If a published release is wrong, prefer a forward patch release. Do not delete
  a public release or rewrite published history without explicit user
  instruction and a rollback record.
