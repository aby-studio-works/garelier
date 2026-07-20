// W-111: register the 16 former shell parity oracles under the canonical
// `cd skills/garelier-core/driver && bun test` entrypoint. Each imported module
// retains its original assertions while invoking the Garelier CLI through Bun.
import "../../../hooks/runtime_recovery_hook.test.ts";
import "../../../hooks/task_mirror_hook.test.ts";
import "../../../scripts/dispatch_cleanup.test.ts";
import "../../../scripts/dispatch_codex_producer.test.ts";
import "../../../scripts/dispatch_watch.test.ts";
import "../../../scripts/fleet_watch.test.ts";
import "../../../scripts/gate_result_waiter.test.ts";
import "../../../scripts/merge_gate_landed_check.test.ts";
import "../../../scripts/merge_gate_robustness.test.ts";
import "../../../scripts/merge_land.test.ts";
import "../../../scripts/merge_request_id_recover.test.ts";
import "../../../scripts/pm_commit.test.ts";
import "../../../scripts/worker_finalize.test.ts";
import "../../../scripts/workspace_isolate.test.ts";
import "../../../../garelier-pm/scripts/blueprint_ship.test.ts";
import "../../../../garelier-pm/scripts/setup_wizard_crew.test.ts";
