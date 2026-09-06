import type { BacklogRecord } from "./plan_graph_types.ts";
import { mutateDocument } from "./plan_graph_write.ts";
import type { LifecycleV3FilePlan } from "./lifecycle_v3.ts";

const LANDING_INPUT_STATES = new Set(["triage", "ready", "active"]);

export function planLandingVerification(options: {
  backlog: BacklogRecord;
  now: string;
}): LifecycleV3FilePlan {
  const { backlog, now } = options;
  if (!LANDING_INPUT_STATES.has(backlog.status)) {
    throw new Error(`Backlog ${backlog.id} cannot be landing-finalized from ${backlog.status}`);
  }
  if (!backlog.path.startsWith("backlog/open/")) {
    throw new Error(`Backlog ${backlog.id} is not in the canonical open layout`);
  }
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(backlog.updated)) {
    throw new Error(`Backlog ${backlog.id} landing-finalize time cannot move updated backwards`);
  }
  const updated = mutateDocument(backlog, (data) => {
    data.status = "verification";
    data.updated = now;
    data.status_changed = now;
  });
  return {
    entity: backlog.id,
    summary: `landing-finalize ${backlog.id}: ${backlog.status} -> verification`,
    writes: [{ path: backlog.path, source: updated.source }],
  };
}
