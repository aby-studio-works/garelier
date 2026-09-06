import { describe, expect, mock, test } from "bun:test";
import { optionalNonEmptyArg, requireNonEmpty, type BoundaryString } from "../guard/non_empty.ts";
import {
  assertLifecycleV3Transition,
  planLifecycleV3Activation,
  planLifecycleV3BacklogReopen,
  planLifecycleV3BeginAction,
  planLifecycleV3FinishAction,
  planLifecycleV3Purge,
  planLifecycleV3RelationRetirement,
  planLifecycleV3TerminalArchive,
  planLifecycleV3Transition,
  type LifecycleV3CheckpointAdapter,
  type LifecycleV3CurrentAdapter,
  type LifecycleV3RecordAdapter,
  type LifecycleV3RecordPatch,
} from "./lifecycle_v3.ts";

interface RecordFixture {
  kind: "backlog" | "checkpoint" | "decision" | "blueprint";
  id: string;
  status: string;
  created: string;
  updated: string;
  statusChanged?: string;
  closed?: string;
  archived?: string;
  evidence: string[];
  backlog?: string[];
  replacement?: string;
  action?: {
    token: string;
    preparedAt: string;
    exactNextAction: string;
    before: string;
    success: string;
    targets: string[];
    lastCompleted?: string;
    result?: string;
    changedFiles?: string[];
    after?: string;
    finishedAt?: string;
  };
}

interface CurrentFixture {
  active: string[];
}

interface RelationOwner {
  relations: Array<{
    id: string;
    state: "active" | "retired";
    added: string;
    updated: string;
    retired?: string;
    retireReason?: string;
  }>;
}

const at = "2026-07-26T12:00:00.000Z";
const recordAdapter: LifecycleV3RecordAdapter<RecordFixture> = {
  inspect: (record) => ({
    kind: record.kind,
    id: record.id,
    status: record.status,
    created: record.created,
    updated: record.updated,
    statusChanged: record.statusChanged,
    closed: record.closed,
    archived: record.archived,
    evidenceCount: record.evidence.length,
    replacement: record.replacement,
    backlogIds: record.backlog,
  }),
  patch: (record, patch: LifecycleV3RecordPatch) => {
    const { backlogIds, clearClosed, clearArchived, clearReplacement, ...rest } = patch;
    const next = { ...record, ...rest, ...(backlogIds ? { backlog: backlogIds } : {}) };
    if (clearClosed) delete next.closed;
    if (clearArchived) delete next.archived;
    if (clearReplacement) delete next.replacement;
    return next;
  },
  render: (record) => `${JSON.stringify(record, null, 2)}\n`,
};

const checkpointAdapter: LifecycleV3CheckpointAdapter<RecordFixture> = {
  ...recordAdapter,
  inspectAction: (record) => ({
    token: record.action?.token,
    exactNextAction: record.action?.exactNextAction,
  }),
  beginAction: (record, action) => ({ ...record, action }),
  finishAction: (record, action) => ({
    ...record,
    action: {
      ...record.action!,
      finishedAt: action.finishedAt,
      lastCompleted: action.lastCompleted,
      result: action.result,
      changedFiles: action.changedFiles,
      after: action.repositoryState,
      exactNextAction: action.exactNextAction,
    },
  }),
};

const currentAdapter: LifecycleV3CurrentAdapter<CurrentFixture> = {
  activeCheckpointIds: (current) => current.active,
  addCheckpoint: (current, checkpointId) => ({ active: [...current.active, checkpointId].sort() }),
  removeCheckpoint: (current, checkpointId) => ({ active: current.active.filter((id) => id !== checkpointId) }),
  render: (current) => `${JSON.stringify(current, null, 2)}\n`,
};

function backlog(status = "ready", evidence: string[] = []): RecordFixture {
  return { kind: "backlog", id: "W-205", status, created: at, updated: at, evidence };
}

function checkpoint(status = "active", backlog: string[] = []): RecordFixture {
  return { kind: "checkpoint", id: "CP-205", status, created: at, updated: at, evidence: [], backlog };
}

describe("schema-3 lifecycle state matrices", () => {
  test("enforces non-empty boundary and lifecycle transition preconditions", () => {
    const state = { filesystem: "unchanged", ref: "refs/heads/main", control: "ready" };
    const processTool = mock((_executable: string, _cwd: string, _arg: string) => {
      state.ref = "refs/heads/changed";
    });
    const filesystemTool = mock((_source: string, _destination: string) => {
      state.filesystem = "changed";
      state.control = "changed";
    });
    const rejected: BoundaryString[] = [undefined, null, "", "   "];

    for (const value of rejected) {
      const processBoundaries: Array<[string, () => void]> = [
        ["executable", () => processTool(requireNonEmpty(value, "executable"), requireNonEmpty("cwd", "cwd"), requireNonEmpty("--flag", "argv[0]"))],
        ["cwd", () => processTool(requireNonEmpty("bun", "executable"), requireNonEmpty(value, "cwd"), requireNonEmpty("--flag", "argv[0]"))],
        ["argv[0]", () => processTool(requireNonEmpty("bun", "executable"), requireNonEmpty("cwd", "cwd"), requireNonEmpty(value, "argv[0]"))],
      ];
      const filesystemBoundaries: Array<[string, () => void]> = [
        ["source", () => filesystemTool(requireNonEmpty(value, "source"), requireNonEmpty("destination", "destination"))],
        ["destination", () => filesystemTool(requireNonEmpty("source", "source"), requireNonEmpty(value, "destination"))],
      ];

      for (const [label, invoke] of [...processBoundaries, ...filesystemBoundaries]) {
        expect(invoke).toThrow(label);
      }
      expect(optionalNonEmptyArg(value)).toEqual([]);
    }

    expect(processTool).toHaveBeenCalledTimes(0);
    expect(filesystemTool).toHaveBeenCalledTimes(0);
    expect(state).toEqual({ filesystem: "unchanged", ref: "refs/heads/main", control: "ready" });
    expect(requireNonEmpty("  bun  ", "executable")).toBe("bun");
    expect(optionalNonEmptyArg("  --flag  ")).toEqual(["--flag"]);

    expect(() => assertLifecycleV3Transition({
      kind: "backlog", from: "ready", to: "active", evidenceCount: 0,
    })).toThrow("active Checkpoint");
    expect(() => assertLifecycleV3Transition({
      kind: "backlog", from: "active", to: "done", evidenceCount: 0,
    })).toThrow("evidence");
    expect(() => assertLifecycleV3Transition({
      kind: "backlog", from: "active", to: "superseded", evidenceCount: 1, reason: "replaced",
    })).toThrow("replacement");
    expect(() => assertLifecycleV3Transition({
      kind: "backlog", from: "active", to: "cancelled", evidenceCount: 0,
    })).toThrow("reason");
    expect(() => assertLifecycleV3Transition({
      kind: "checkpoint", from: "completed", to: "active", evidenceCount: 0,
    })).toThrow("not allowed");
    expect(() => assertLifecycleV3Transition({
      kind: "decision", from: "proposed", to: "accepted", evidenceCount: 0,
    })).not.toThrow();
    expect(() => assertLifecycleV3Transition({
      kind: "decision", from: "accepted", to: "rejected", evidenceCount: 0, reason: "invalidated",
    })).toThrow("not allowed");
    expect(() => assertLifecycleV3Transition({
      kind: "blueprint", from: "draft", to: "active", evidenceCount: 0,
    })).not.toThrow();
    expect(() => assertLifecycleV3Transition({
      kind: "blueprint", from: "draft", to: "shipped", evidenceCount: 0,
    })).toThrow("not allowed");
  });

  test("non-terminal transitions persist reason and reject terminal archive bypass", () => {
    const blocked = planLifecycleV3Transition({
      path: "backlog/open/W-205-control.md",
      record: backlog("active"),
      to: "blocked",
      reason: "awaiting schema review",
      now: "2026-07-26T13:00:00.000Z",
      adapter: recordAdapter,
    });
    expect(JSON.parse(blocked.writes[0]!.source!)).toMatchObject({
      status: "blocked",
      transitionReason: "awaiting schema review",
      statusChanged: "2026-07-26T13:00:00.000Z",
    });
    expect(() => planLifecycleV3Transition({
      path: "backlog/open/W-205-control.md",
      record: backlog("verification", ["gate"]),
      to: "done",
      now: "2026-07-26T13:00:00.000Z",
      adapter: recordAdapter,
    })).toThrow("terminal+archive");
    const archived = planLifecycleV3Transition({
      path: "blueprints/artifact-lifecycle.md",
      record: {
        ...backlog("active"),
        kind: "blueprint" as const,
        id: "artifact-lifecycle",
      },
      to: "archived",
      reason: "scope retired",
      now: "2026-07-26T13:00:00.000Z",
      adapter: recordAdapter,
    });
    expect(JSON.parse(archived.writes[0]!.source!)).toMatchObject({
      status: "archived",
      closed: "2026-07-26T13:00:00.000Z",
      archived: "2026-07-26T13:00:00.000Z",
    });
  });

  test("activation produces one three-file plan and no partial subset", () => {
    const plan = planLifecycleV3Activation({
      backlogPath: "backlog/open/W-205-control.md",
      backlog: backlog(),
      checkpointPath: "checkpoints/active/CP-205-control.md",
      checkpoint: checkpoint("paused"),
      currentPath: "project_dashboard/current.md",
      current: { active: [] },
      now: at,
      recordAdapter,
      currentAdapter,
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      "backlog/open/W-205-control.md",
      "checkpoints/active/CP-205-control.md",
      "project_dashboard/current.md",
    ]);
    expect(JSON.parse(plan.writes[0]!.source!).status).toBe("active");
    expect(JSON.parse(plan.writes[1]!.source!).status).toBe("active");
    expect(JSON.parse(plan.writes[1]!.source!).backlog).toEqual(["W-205"]);
    expect(JSON.parse(plan.writes[2]!.source!).active).toEqual(["CP-205"]);
    expect(() => planLifecycleV3Activation({
      backlogPath: "backlog/open/W-205-control.md",
      backlog: backlog(),
      checkpointPath: "checkpoints/active/CP-205-control.md",
      checkpoint: checkpoint("active"),
      currentPath: "project_dashboard/current.md",
      current: { active: [] },
      now: at,
      recordAdapter,
      currentAdapter,
    })).toThrow("prepared paused or blocked");
  });

  test("terminal transition and archive move are inseparable", () => {
    const active = backlog("verification", ["gate:QG-control"]);
    const plan = planLifecycleV3TerminalArchive({
      sourcePath: "backlog/open/W-205-control.md",
      archivePath: "backlog/archive/2026/W-205-control.md",
      record: active,
      to: "done",
      evidenceCount: 1,
      now: at,
      adapter: recordAdapter,
    });
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes).toContainEqual({ path: "backlog/open/W-205-control.md", source: null });
    const archived = JSON.parse(plan.writes.find((write) => write.source !== null)!.source!);
    expect(archived).toMatchObject({ status: "done", closed: at, archived: at });

    const reopen = planLifecycleV3BacklogReopen({
      sourcePath: "backlog/archive/2026/W-205-control.md",
      openPath: "backlog/open/W-205-control.md",
      record: { ...backlog("superseded", ["test:reopen"]), replacement: "backlog:W-204", closed: at, archived: at },
      to: "ready",
      reason: "terminal state was recorded in error",
      evidenceCount: 1,
      now: "2026-07-26T13:00:00.000Z",
      adapter: recordAdapter,
    });
    expect(reopen.writes).toContainEqual({ path: "backlog/archive/2026/W-205-control.md", source: null });
    expect(JSON.parse(reopen.writes.find((write) => write.source !== null)!.source!)).toMatchObject({
      status: "ready",
      updated: "2026-07-26T13:00:00.000Z",
      transitionReason: "terminal state was recorded in error",
    });
    const reopened = JSON.parse(reopen.writes.find((write) => write.source !== null)!.source!);
    expect(reopened.closed).toBeUndefined();
    expect(reopened.archived).toBeUndefined();
    expect(reopened.replacement).toBeUndefined();
    expect(() => planLifecycleV3TerminalArchive({
      sourcePath: "backlog/open/W-205-control.md",
      archivePath: "backlog/archive/2026/W-205-control.md",
      record: reopened,
      to: "superseded",
      reason: "new replacement is required",
      evidenceCount: 1,
      now: "2026-07-26T14:00:00.000Z",
      adapter: recordAdapter,
    })).toThrow("replacement");
    const rearchived = planLifecycleV3TerminalArchive({
      sourcePath: "backlog/open/W-205-control.md",
      archivePath: "backlog/archive/2026/W-205-control.md",
      record: reopened,
      to: "superseded",
      reason: "new replacement selected",
      replacement: "backlog:W-206",
      evidenceCount: 1,
      now: "2026-07-26T14:00:00.000Z",
      adapter: recordAdapter,
    });
    expect(JSON.parse(rearchived.writes.find((write) => write.source !== null)!.source!)).toMatchObject({
      status: "superseded",
      replacement: "backlog:W-206",
    });
    expect(() => planLifecycleV3BacklogReopen({
      sourcePath: "backlog/archive/2026/W-205-control.md",
      openPath: "backlog/open/W-205-control.md",
      record: { ...backlog("cancelled"), closed: at, archived: at },
      to: "ready",
      reason: "missing evidence",
      evidenceCount: 0,
      now: "2026-07-26T13:00:00.000Z",
      adapter: recordAdapter,
    })).toThrow("current evidence");
  });

  test("checkpoint archive removes current pointer in the same plan", () => {
    const plan = planLifecycleV3TerminalArchive({
      sourcePath: "checkpoints/active/CP-205-control.md",
      archivePath: "checkpoints/archive/2026/CP-205-control.md",
      record: checkpoint(),
      to: "completed",
      evidenceCount: 0,
      now: at,
      adapter: recordAdapter,
      current: { path: "project_dashboard/current.md", record: { active: ["CP-205"] }, adapter: currentAdapter },
    });
    expect(plan.writes).toHaveLength(3);
    expect(JSON.parse(plan.writes.find((write) => write.path === "project_dashboard/current.md")!.source!).active).toEqual([]);
  });

  test("paused checkpoint archives without inventing a Current pointer", () => {
    const plan = planLifecycleV3TerminalArchive({
      sourcePath: "checkpoints/active/CP-205-control.md",
      archivePath: "checkpoints/archive/2026/CP-205-control.md",
      record: { ...checkpoint(), status: "paused" },
      to: "completed",
      evidenceCount: 0,
      now: at,
      adapter: recordAdapter,
      current: { path: "project_dashboard/current.md", record: { active: [] }, adapter: currentAdapter },
    });
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes.some((write) => write.path === "project_dashboard/current.md")).toBeFalse();
  });
});

describe("schema-3 lifecycle plans", () => {
  test("relation retirement preserves history metadata", () => {
    const owner: RelationOwner = { relations: [{ id: "rel-001", state: "active", added: at, updated: at }] };
    const plan = planLifecycleV3RelationRetirement({
      ownerPath: "roadmaps/control.md",
      owner,
      relationId: "rel-001",
      reason: "replaced by rel-002",
      now: "2026-07-26T13:00:00.000Z",
      adapter: {
        inspect: (value) => value.relations,
        retire: (value, relationId, patch) => ({
          relations: value.relations.map((relation) => relation.id === relationId ? { ...relation, ...patch } : relation),
        }),
        render: (value) => `${JSON.stringify(value, null, 2)}\n`,
      },
    });
    expect(JSON.parse(plan.writes[0]!.source!).relations[0]).toMatchObject({
      id: "rel-001",
      state: "retired",
      retired: "2026-07-26T13:00:00.000Z",
      retireReason: "replaced by rel-002",
    });
  });

  test("purge fails closed and always pairs deletion with a manifest", () => {
    const base = {
      targetPath: "notes/N-205-typo.md",
      targetHash: `sha256:${"1".repeat(64)}`,
      manifestPath: "reports/purge/2026/N-205.json",
      classification: "typo_duplicate" as const,
      sharing: "unknown" as const,
      reachability: "proven_unreachable" as const,
      inboundRelations: 0,
      outboundRelations: 0,
      referenceCount: 0,
      usedAsAuthority: false,
      hasUniqueInformation: false,
      reason: "duplicate created in error",
      agent: "codex",
      now: at,
    };
    expect(() => planLifecycleV3Purge(base)).toThrow("approval");
    expect(() => planLifecycleV3Purge({ ...base, sharing: "shared", userApprovalRef: "user:approval-205" })).toThrow("shared");
    expect(() => planLifecycleV3Purge({ ...base, reachability: "unknown", userApprovalRef: "user:approval-205" })).toThrow("reachability");
    const plan = planLifecycleV3Purge({ ...base, userApprovalRef: "user:approval-205" });
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes[0]).toEqual({ path: "notes/N-205-typo.md", source: null });
    expect(JSON.parse(plan.writes[1]!.source!)).toMatchObject({
      kind: "garelier_control_purge_manifest",
      control_schema_version: 3,
      path: "notes/N-205-typo.md",
    });
  });

  test("begin/finish action bind the finish to the durable write-ahead token", () => {
    const begun = planLifecycleV3BeginAction({
      checkpointPath: "checkpoints/active/CP-205-control.md",
      checkpoint: checkpoint(),
      exactNextAction: "run focused lifecycle tests",
      repositoryState: "branch=codex/w205-lifecycle head=abc dirty",
      successCondition: "tests pass",
      targets: ["skills/garelier-core/driver/src/control/lifecycle_v3.ts"],
      now: at,
      adapter: checkpointAdapter,
    });
    const persisted = JSON.parse(begun.writes[0]!.source!) as RecordFixture;
    expect(persisted.action?.token).toStartWith("sha256:");
    expect(persisted.action?.preparedAt).toBe(at);
    expect(() => planLifecycleV3FinishAction({
      checkpointPath: "checkpoints/active/CP-205-control.md",
      checkpoint: persisted,
      expectedActionToken: `sha256:${"0".repeat(64)}`,
      result: "pass",
      changedFiles: ["skills/garelier-core/driver/src/control/lifecycle_v3.ts"],
      repositoryState: "branch=codex/w205-lifecycle head=def clean",
      exactNextAction: "report",
      now: "2026-07-26T13:00:00.000Z",
      adapter: checkpointAdapter,
    })).toThrow("stale");
    const finished = planLifecycleV3FinishAction({
      checkpointPath: "checkpoints/active/CP-205-control.md",
      checkpoint: persisted,
      expectedActionToken: persisted.action!.token,
      result: "pass",
      changedFiles: ["skills/garelier-core/driver/src/control/lifecycle_v3.ts"],
      repositoryState: "branch=codex/w205-lifecycle head=def clean",
      exactNextAction: "report",
      now: "2026-07-26T13:00:00.000Z",
      adapter: checkpointAdapter,
    });
    expect(JSON.parse(finished.writes[0]!.source!).action).toMatchObject({
      lastCompleted: "run focused lifecycle tests",
      result: "pass",
      exactNextAction: "report",
      finishedAt: "2026-07-26T13:00:00.000Z",
    });
  });
});
