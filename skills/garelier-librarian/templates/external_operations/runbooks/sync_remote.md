# Runbook: sync_remote (Garelier default — edit per project)

> Librarian-owned runbook the Concierge follows (DEC-025). Installed at
> the `external_operations/runbooks/sync_remote.md` knowledge file. See
> `git_remote_policy.md` for the push/sync rules.

`sync_remote` has two tiers. The **read-only** tier is the Phase 1 default; the
**write** tier is Phase 2 and runs only when the assignment explicitly names the
write command.

## Read-only (Phase 1, always available to a configured Concierge)

```bash
git fetch --prune origin
git status
git log --oneline <ref>..origin/<ref>
git diff <ref>..origin/<ref>
git merge-base <ref> origin/<ref>
```

No merge / rebase / push. Reports the divergence (ahead/behind, commits, diff
summary) so PM can decide. This needs no Guardian gate (it writes nothing).

## Write tier (Phase 2, explicit assignment line required)

A merge / rebase / push is an external-affecting write, so it requires the same
gates as any Phase-2 operation:

1. **Explicit assignment** naming the exact command (e.g. `git merge
   origin/<target>` into a named local ref, or `git push origin
   <local>:<allowed-prefix>/...`). No command runs that the assignment did not name.
2. **Provider/auth + drift check.** `git fetch origin`; confirm the remote tip
   matches the assignment's expected SHA (drift → BLOCK).
3. **Guardian gate** for anything that publishes (`PASS` / `PASS_WITH_NOTES`,
   not stale).
4. **Execute the named command only.** Never `git pull` (use `fetch` + the named
   merge/rebase). Never `--force`. Never push a `garelier/*` branch — remote-
   visible pushes use `publish/` / `pr/` / `release/` prefixes only.
5. **Report** the before/after refs and the result; record a rollback note.

## Stop conditions

- The assignment does not name the exact write command (read-only stays the cap).
- Drift, missing auth, a `git pull` would be needed, a force-push, or a
  `garelier/*` push → BLOCK.
