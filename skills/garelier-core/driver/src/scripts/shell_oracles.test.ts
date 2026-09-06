// W-111/W-327: register the risk-selected shell parity oracles under the canonical
// `cd skills/garelier-core/driver && bun test` entrypoint. Each imported module
// retains its boundary/fail-closed assertions while invoking the CLI through Bun.
import "../../../hooks/runtime_recovery_hook.test.ts";
import "../../../hooks/task_mirror_hook.test.ts";
import "../../../scripts/dispatch_cleanup.test.ts";
import "../../../scripts/dispatch_codex_provider.test.ts";
import "../../../scripts/merge_gate_robustness.test.ts";
import "../../../scripts/merge_land.test.ts";
import "../../../scripts/merge_request_id_recover.test.ts";
import "../../../scripts/worker_finalize.test.ts";
