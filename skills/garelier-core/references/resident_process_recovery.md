# Resident-process health and operator recovery

Use `resident_process_health.ts` before diagnosing a shared-process failure:

```bash
bun skills/garelier-core/driver/src/scripts/resident_process_health.ts \
  --project <control-root> --pm-id <pm-id> --format text
```

`--project` is the resolved Garelier control root: the directory that owns
`__garelier/`. In Plant-Crust this is the container/control root, not the target
repository under `target/`. The command is read-only. It reports `component`,
named `PID`, `owner`,
`provenance`, `health`, and `reason` for sccache, Status Web, fleet watch, the
long-job broker, and the active merge-gate request. Marker-backed components
report their recorded PID/owner/provenance; sccache has no framework marker and
is intentionally reported as unverifiable. `ENVIRONMENT_BLOCKED` means the
relevant resident boundary is unhealthy or unverifiable. During failure
classification, `RED` means captured output did not prove that exact boundary,
or the direct executable observation failed. The classifier never replays the
original command. Unavailable verification is never `PASS`.

The preflight never invokes a compiler or the sccache client: even `rustc -Vv`
is an active process, and a stats request may lazy-start the shared daemon. A standalone run has no captured failed-command
evidence, so its sccache row is intentionally unverifiable and the overall
diagnostic fails closed as `ENVIRONMENT_BLOCKED`. This is not proof that the
daemon is unhealthy. Merge-gate failure classification binds sccache only when
the captured output proves the exact mediated compiler path and its permission
boundary; ambiguous Rust failures remain `RED`.

A stale Status Web pidfile is a health failure only. It is not proof of a
source/code defect or of resident-process contamination.

## Operator-only recovery

Do not recover from a role seat. Do not change user Cargo configuration,
install a service, or issue a process-name-wide kill.

1. Record the exact component, PID, owner/provenance, marker path, captured
   command cwd/output, and any separately approved operator observation before changing anything.
2. Verify that the named PID still refers to the expected executable and PM
   namespace. If ownership is missing, mismatched, or unverifiable, stop and
   escalate; do not infer it from the image name.
3. Preserve state before recovery:
   - sccache: the user cache directory and `sccache --show-stats` output;
   - Status Web: pidfile and stdout log;
   - fleet watch: lock, state JSON, stop marker, and latest terminal result;
   - long-job broker: the complete ledger, broker/wake locks, child PID, and
     attempt log;
   - merge gate: active lock, request, result, and log.
4. Use only the component's operator-owned lifecycle. Prefer its stop-file or
   documented stop command and wait for the named PID to exit. For sccache, an
   operator may use the documented client stop/start sequence after confirming
   the exact server; stopping the server does not delete the disk cache.
5. If graceful recovery fails, obtain explicit operator approval before
   terminating the exact verified PID or its verified process tree. Never use
   `taskkill /IM`, `Get-Process <image> | Stop-Process`, `pkill <image>`, or an
   equivalent image-name-wide action.
6. Re-run the read-only preflight and the original whole command. Retain the
   before/after evidence; do not delete cache, logs, locks, request/result
   records, or long-job ledger entries to make the retry appear clean.
