# Public release pipeline

Run the attended release pipeline from a clean development checkout:

```bash
bun skills/garelier-core/driver/src/scripts/release.ts --publish-repo /path/to/garelier-publish --repo owner/garelier
```

The publish clone must already exist, be clean, and be checked out on `main`.
`--publish-repo` may instead be supplied through `GARELIER_PUBLISH_REPO` or a
JSON `--config` file (`publishRepo` and optional `githubRepo`). Use `--yes` only
when the operator has reviewed the planned public actions. `--dry-run` runs the
export and validates the version, changelog section, and public clone without
syncing, pushing, tagging, or creating a release.

## Required order

The script reads `VERSION`, creates and mode-checks a history-free export,
synchronizes it to the public clone with `tar --exclude=.git`, creates the
public sync commit when needed, and pushes `main` after confirmation. It then
finds the workflow for that exact pushed SHA and runs `gh run watch --exit-status`.

**Create the tag only after that CI run is green.** The script stops when CI is
red or no run is found; it does not create or push a tag, and it does not create
a GitHub release. Only after green CI does it prompt separately for tag creation,
tag push, and `gh release create`. Release notes are the matching `CHANGELOG.md`
section, not an ad-hoc copy of terminal output.

## Recovery

- Export or mode self-check failure: fix the development source, commit it, run
  the normal repository gates, then restart. Do not repair executable bits only
  in the public clone.
- Push failure: leave the public clone at its last safe local commit, inspect
  the remote and retry only after confirming whether the push landed.
- Public CI red: stop before tagging. Fix the defect in development, rerun the
  export pipeline, push the corrected public `main`, and wait for a green run.
  This is the v2.13.0 hotfix pattern; never tag the known-red commit.
- Tag or release failure after CI green: record the exact public SHA and tag
  state. Never force-push, move, or delete a public tag/release without explicit
  user approval. Prefer a forward patch release when a published release is bad.
