# Public release pipeline

Framework public release is a PM-approved Concierge external operation. First
use `dispatch_prepare.ts --attended-seat --role concierge --approved-remote
origin=<exact-public-url>` and record its `record_path` in the Concierge
assignment. The PM-authored approval ledger must bind the user approval,
framework source SHA, public-clone path and expected `HEAD`, GitHub `owner/name`,
exact `origin` URL, PM namespace, shared Git common directory, attended agent,
permission record, Guardian report, and `v<VERSION>` tag. The ledger path is
canonical and PM-owned:
`control_root/__garelier/<pm_id>/runtime/concierge/requests/framework_release__<request_id>.approval.json`.
The permission record must be the exact dispatch_prepare record under
`_crew/lanes/.meta/`, and the Guardian report must be under that PM's
`runtime/guardian/results/`.

Prove the complete plan from a clean development checkout:

```bash
GARELIER_ROLE=concierge \
GARELIER_PM_ID=<pm_id> \
GARELIER_AGENT_NAME=<attended-agent> \
bun skills/garelier-core/driver/src/scripts/concierge_release.ts \
  --approval-ledger control_root/__garelier/<pm_id>/runtime/concierge/requests/framework_release__<request_id>.approval.json \
  --permission-record control_root/__garelier/<pm_id>/_crew/lanes/.meta/<attended-agent>.dispatch.json \
  --guardian-report control_root/__garelier/<pm_id>/runtime/guardian/results/<guardian-verdict>.md \
  --publish-repo /path/to/garelier-publish \
  --repo owner/garelier \
  --dry-run
```

The publish clone must already exist, be clean, and be checked out on `main`.
Dry-run validates the role, approval ledger, attended Concierge permission,
exact destination, source/public SHA, Guardian freshness, export, version,
changelog section, and public clone. It does not acquire an external lock and
does not sync, push, tag, or create a release. The privileged engine is private
to `concierge_release.ts`; `release.ts` exposes only non-privileged tree helpers
and refuses direct CLI execution.

Only after reviewing that output, run the same Concierge command without
`--dry-run`. Set `GARELIER_PM_ID` and pass the derived canonical lock path:

```text
control_root/__garelier/<pm_id>/runtime/concierge/locks/release__v<VERSION>.lock
```

The wrapper atomically creates that exact immutable owner file with
`pid=process.pid` and a random nonce before the first external write.
Finalization atomically creates `<lock>.done`, bound to the same request, PID,
and nonce; it never overwrites the owner record. Callers do not pre-create
either file. An arbitrary path, an already-finalized tag, another live owner,
or an unrecovered stale lock fails closed. Use `--yes` only when
`allow_unattended_confirmations = true` is present in the recorded approval.

## Required order

The guarded Concierge entrypoint reads `VERSION`, creates and mode-checks a history-free export,
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
