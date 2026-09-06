import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { canonicalPath, defaultFenceRoots, removeTreeSync, renameSync, rmSync, unlinkSync } from "../guard/path_guard.ts";
import {
  beginControlGeneration,
  ControlGenerationError,
  readControlGeneration,
  readControlGenerationSnapshot,
  readStableControl,
} from "./generation.ts";
import {
  applyGenerationRecovery,
  planGenerationRecovery,
  recoverMissingControlGeneration,
  writeGenerationRecoveryJournal,
} from "./generation_recovery.ts";
import {
  assertLifecycleV3ControlPath,
  planLifecycleV3Activation,
  type LifecycleV3CurrentAdapter,
  type LifecycleV3RecordAdapter,
} from "./lifecycle_v3.ts";
import { sha256 } from "./serialization.ts";
import {
  acquireNamespaceLock,
  ControlLockError,
  controlTreeSourceDigest,
  resolveControlNamespace,
  runControlFilePlanTransaction,
  type ControlFilePlanCallbacks,
} from "./transaction.ts";
import { writeV3Fixture } from "./fixtures/v3_control.ts";
import { residualControlStagingFindings } from "../scripts/control.ts";
import { assertControlCwdFence, runCli } from "../scripts/control.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import { planArtifactCreate, planArtifactUpdate, planGraphEvidenceReferences, planGraphTransactionCallbacks } from "./plan_graph_write.ts";
import { loadTaskMirrorSource } from "../dispatch/task_mirror.ts";
import { buildControl } from "../status_control.ts";
import { statusText } from "../status_public_control.ts";
import { renewDispatchClaimWithAudit } from "./claim_renewal_audit.ts";
import { claimWork, readControlClaim } from "./claims.ts";
import { openControlSession, readControlSession } from "./sessions.ts";
import { garelierControlRoots } from "./garelier_integration.ts";
import { planGraphRuntimeCallbacks } from "./plan_graph_write.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import {
  CONTROL_READ_COMMANDS,
  detectForeignControlRoot,
  isControlMutationCommand,
  resetPositionState,
  type ForeignRootInput,
  type WorktreeShape,
} from "./cwd_fence.ts";
import { validateGateEvidence } from "./evidence_validation.ts";
import { EVIDENCE_WRITER_STORAGE_KEY, type EvidenceReference } from "./types.ts";

const roots: string[] = [];
const now = () => new Date("2026-07-26T12:00:00.000Z");

interface RecordFixture {
  kind: "backlog" | "checkpoint";
  id: string;
  status: string;
  created: string;
  updated: string;
  statusChanged?: string;
  evidence: string[];
}

interface CurrentFixture {
  active: string[];
}

interface FixtureState {
  backlog: RecordFixture;
  checkpoint: RecordFixture | null;
  current: CurrentFixture;
}

const recordAdapter: LifecycleV3RecordAdapter<RecordFixture> = {
  inspect: (record) => ({
    kind: record.kind,
    id: record.id,
    status: record.status,
    created: record.created,
    updated: record.updated,
    statusChanged: record.statusChanged,
    evidenceCount: record.evidence.length,
  }),
  patch: (record, patch) => ({ ...record, ...patch }),
  render: (record) => `${JSON.stringify(record, null, 2)}\n`,
};

const currentAdapter: LifecycleV3CurrentAdapter<CurrentFixture> = {
  activeCheckpointIds: (current) => current.active,
  addCheckpoint: (current, id) => ({ active: [...current.active, id].sort() }),
  removeCheckpoint: (current, id) => ({ active: current.active.filter((candidate) => candidate !== id) }),
  render: (current) => `${JSON.stringify(current, null, 2)}\n`,
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function controlTreeBytes(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else files[rel] = readFileSync(abs).toString("base64");
    }
  };
  walk(root, "");
  return files;
}

function controlOk(root: string, args: string[]): Record<string, any> {
  const result = runCli([...args, "--project", root, "--pm-id", "pm1", "--format", "json"], root);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync(requireRuntimeExecutable("git"), args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function exerciseCwdFenceAggregate(): void {
  const primary = resolve("/repo");
  const lane = resolve("/repo/__garelier/pm1/_crew/dispatch267/checkout");
  const probe = (dir: string): WorktreeShape | null => {
    if (dir.startsWith(lane)) return { topLevel: lane, mainWorktreeRoot: primary };
    if (dir.startsWith(primary)) return { topLevel: primary, mainWorktreeRoot: primary };
    return null;
  };
  const detect = (over: Partial<ForeignRootInput> = {}) => detectForeignControlRoot({
    command: "backlog",
    garelierRoot: join(lane, "__garelier"),
    mode: "lithosphere",
    probe,
    exists: () => true,
    ...over,
  });

  expect(detect()).toMatchObject({
    foreign: true,
    mainWorktreeRoot: primary,
    canonicalGarelierRoot: join(primary, "__garelier"),
  });
  for (const command of CONTROL_READ_COMMANDS) {
    expect(isControlMutationCommand(command)).toBeFalse();
    expect(detect({ command }).foreign).toBeFalse();
  }
  for (const input of [
    { garelierRoot: join(primary, "__garelier") },
    { garelierRoot: join(primary, "sub", "__garelier") },
    { garelierRoot: resolve("/other/__garelier") },
    { mode: "crust" },
    { probe: () => null },
    { exists: () => false },
    { garelierRoot: null },
  ] satisfies Array<Partial<ForeignRootInput>>) expect(detect(input).foreign).toBeFalse();

  const root = mkdtempSync(join(tmpdir(), "w267-cwd-fence-v3-"));
  roots.push(root);
  const realPrimary = join(root, "repo");
  mkdirSync(realPrimary, { recursive: true });
  git(realPrimary, ["init", "-q", "-b", "main"]);
  git(realPrimary, ["config", "user.email", "t@example.com"]);
  git(realPrimary, ["config", "user.name", "t"]);
  writeV3Fixture(realPrimary);
  writeFileSync(join(realPrimary, "README.md"), "fixture\n", "utf8");
  git(realPrimary, ["add", "-A"]);
  git(realPrimary, ["commit", "-q", "-m", "init"]);
  const realLane = join(realPrimary, "__garelier", "pm1", "_crew", "dispatch267", "checkout");
  git(realPrimary, ["worktree", "add", "-q", "-b", "garelier/main/pm1/workbench/#267/cwd-fence", realLane]);
  const mutation = ["backlog", "create", "--title", "Fence fixture", "--session", "cs_fence", "--pm-id", "pm1"];

  delete process.env.GARELIER_CONTROL_CWD_FENCE;
  expect(runCli(mutation, realLane).stderr).not.toContain("W-267 cwd fence");
  process.env.GARELIER_CONTROL_CWD_FENCE = "1";
  const blocked = runCli(mutation, realLane);
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain("W-267 cwd fence");
  expect(blocked.stderr).toContain(realPrimary);
  expect(runCli([...mutation, "--allow-foreign-cwd"], realLane).stderr).not.toContain("W-267 cwd fence");
  expect(runCli(["list", "backlog", "--pm-id", "pm1"], realLane).stderr).not.toContain("W-267 cwd fence");
  expect(runCli(mutation, realPrimary).stderr).not.toContain("W-267 cwd fence");
  delete process.env.GARELIER_CONTROL_CWD_FENCE;

  // ── W-545 / W-354 / W-467 — the position a control mutation judges ──────────
  //
  // (a) W-545: an attended PM whose shell cwd was left inside a lane checkout,
  // addressing its OWN project with --project. A lane is a linked worktree whose
  // `.git` is a FILE, so `nearestRepoRoot` answered the lane and the default
  // fence covered only that lane — every write to the primary control tree was
  // refused as out-of-fence, while the byte-identical command run from the
  // project root succeeded. The predicate is OUTCOME PARITY between the two cwds,
  // not "exit 0": the command must not depend on where the shell was left.
  const pmMutation = [...mutation, "--project", realPrimary];
  const fromPrimary = runCli(pmMutation, realPrimary);
  const fromLaneCwd = runCli(pmMutation, realLane);
  expect(fromLaneCwd.code, "PM control mutation: lane cwd vs project cwd").toBe(fromPrimary.code);
  expect(fromLaneCwd.stderr, "PM control mutation from a lane cwd is not a fence refusal")
    .not.toContain("path_guard:");
  expect(fromPrimary.stderr, "PM control mutation from the project root is not a fence refusal")
    .not.toContain("path_guard:");

  // (b) W-354: the same cwd spelled the MSYS way. `path.resolve("/c/env")` used to
  // invent `C:\c\env`, so the identical directory produced a different verdict
  // depending on which shell reported it. Win32-host rule by construction.
  const posixSpelling = (path: string) => `/${path[0]!.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(realLane)) {
    const fromPosixCwd = runCli(pmMutation, posixSpelling(realLane));
    expect(fromPosixCwd.code, "PM control mutation: POSIX-spelled lane cwd").toBe(fromPrimary.code);
    expect(fromPosixCwd.stderr, "POSIX-spelled cwd is not a fence refusal").not.toContain("path_guard:");

    // W-354 AC-3, the exact 2026-08-04 incident: standing in the PRIMARY repo
    // root, spelled the MSYS way, with the cwd fence ON and NO `--project`. The
    // fence resolved `/c/env/...` to `C:\c\env\...`, found no control root there,
    // and refused a mutation made from the right directory; passing `--project`
    // in Windows spelling was the only way through.
    process.env.GARELIER_CONTROL_CWD_FENCE = "1";
    const posixPrimaryNoProject = runCli(mutation, posixSpelling(realPrimary));
    const windowsPrimaryNoProject = runCli(mutation, realPrimary);
    delete process.env.GARELIER_CONTROL_CWD_FENCE;
    // The two runs mutate shared state, so their exit codes are order-dependent
    // and are NOT the predicate. The predicate is that NEITHER is stopped by the
    // fence — that is what the incident was, and what the POSIX spelling used to
    // fail on its own.
    for (const [label, run] of [
      ["POSIX-spelled project root", posixPrimaryNoProject],
      ["Windows-spelled project root", windowsPrimaryNoProject],
    ] as const) {
      expect(run.stderr, `${label} is not a foreign-root refusal`).not.toContain("W-267 cwd fence");
      expect(run.stderr, `${label} is not a path-fence refusal`).not.toContain("path_guard:");
    }
  }

  // (c) W-467: the worktree-shape memo and the declared fence roots are module
  // state with no counterpart, so within ONE process a later operation inherited
  // an earlier one's answer. `execute()` drops both at its entry, so the SECOND
  // run of the refusing shape refuses exactly like the first — the accumulation
  // cannot turn a refusal into an allow.
  // (c2) W-545 r2 — the control route DECLARES the control root it resolved, and
  // that declaration is what lets a PM standing in a lane write its own control
  // tree. Asserted on `assertControlCwdFence` directly, because `execute()` clears
  // the declaration again at its own boundary (W-467) — reading the roots after
  // the CLI returns would measure the reset, not the declaration.
  {
    const key = (path: string) => canonicalPath(path).toLowerCase();
    resetPositionState();
    assertControlCwdFence("backlog", { project: realPrimary, pmId: "pm1", format: "json" } as never);
    const declared = defaultFenceRoots(realLane).map(key);
    resetPositionState();
    const undeclared = defaultFenceRoots(realLane).map(key);
    expect(declared, "the resolved control root is declared for this operation")
      .toContain(key(join(realPrimary, "__garelier")));
    expect(undeclared, "and dropped again at the operation boundary")
      .not.toContain(key(join(realPrimary, "__garelier")));
    // The declaration is the control root, NOT the repository root: a lane cwd
    // gains write access to the control tree it addressed and to nothing else.
    expect(declared, "the repository root itself is not declared").not.toContain(key(realPrimary));
  }

  process.env.GARELIER_CONTROL_CWD_FENCE = "1";
  const firstRefusal = runCli(mutation, realLane);
  const secondRefusal = runCli(mutation, realLane);
  expect(firstRefusal.stderr, "first foreign-root refusal").toContain("W-267 cwd fence");
  expect(secondRefusal.stderr, "second foreign-root refusal is not weakened by the first")
    .toContain("W-267 cwd fence");
  expect(secondRefusal.code, "second refusal keeps the same exit").toBe(firstRefusal.code);
  delete process.env.GARELIER_CONTROL_CWD_FENCE;

  // ── W-620 追記 (R-6) — a usage error must not read as a cwd-fence refusal ──
  //
  // USAGE's closing paragraph explains the W-267 fence, and a usage error used to
  // print the cause FIRST and then dump all of USAGE. A PM who omitted the entity
  // kind read the tail, took the fence for the cause, and spent five steps
  // checking cwd, repo root, --project and the env var — none of which were
  // involved, and the fence is opt-in and was off. Then, still reading tails,
  // they read six identical argv failures as "four rows transitioned". Whatever
  // the tail says is what gets read, so the tail has to be the answer.
  //
  // (a) the omission is named, and it is the LAST line.
  const missingKind = runCli(["transition", "W-461", "--to", "ready", "--pm-id", "pm1"], realPrimary);
  expect(missingKind.code).toBe(2);
  const kindTail = missingKind.stderr.trimEnd().split("\n").at(-1)!;
  expect(kindTail).toContain("transition requires <roadmap|milestone|backlog|checkpoint|decision|blueprint> <id>");
  expect(kindTail).not.toContain("cwd fence");

  // (b) BOTH directions on the fence itself. The env var is unset here, so no
  // usage error may mention it; the positive direction is asserted above, where
  // a real foreign-root mutation with the fence ON still refuses.
  expect(process.env.GARELIER_CONTROL_CWD_FENCE).toBeUndefined();
  expect(missingKind.stderr.split("\n").at(-2) ?? "").not.toContain("W-267 cwd fence");

  // (c) two missing preconditions are reported together, not one per round trip.
  const missingBoth = runCli(["transition", "backlog", "W-461", "--to", "ready", "--pm-id", "pm1"], realPrimary);
  expect(missingBoth.code).toBe(2);
  const bothTail = missingBoth.stderr.trimEnd().split("\n").at(-1)!;
  expect(bothTail).toContain("--session");
  expect(bothTail).toContain("--expect-control-revision");
  // R-4 — a single omission still reads as it always did; the collected form is
  // for the plural case only, so no existing message changed shape.
  const missingOne = runCli(
    ["transition", "backlog", "W-461", "--to", "ready", "--pm-id", "pm1", "--session", "cs_fence"],
    realPrimary,
  );
  expect(missingOne.stderr.trimEnd().split("\n").at(-1)!).toContain("--expect-control-revision is required");

  // W-667 F-6 — the SAME class on the entity flags. `backlog create`'s five
  // required flags were `requiredArg` calls inside the transaction callback, so
  // a PM creating one row learned `--type`, then `--outcome`, then
  // `--next-action`, one invocation each, after the session had been validated.
  const missingCreate = runCli(
    ["backlog", "create", "--title", "T", "--pm-id", "pm1", "--session", "cs_fence", "--expect-control-revision", "sha256:0"],
    realPrimary,
  );
  expect(missingCreate.code).toBe(2);
  const createTail = missingCreate.stderr.trimEnd().split("\n").at(-1)!;
  for (const flag of ["--type", "--priority", "--outcome", "--next-action"]) expect(createTail).toContain(flag);
  // The USAGE line has to name them too, or the collected message is the only
  // place the contract exists.
  expect(runCli(["backlog", "create", "--pm-id", "pm1"], realPrimary).stderr).toContain("control backlog create --title <t> --type <t>");
  process.stdout.write("W620_L1_L4 cause=tail fence_mentioned=false missing_reported=together single_unchanged=true create_flags=together\n");
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5);
  if (!existsSync(path)) throw new Error(`barrier not reached: ${path}`);
}

async function exerciseGenerationAtomicityAggregate(): Promise<void> {
  const gapRoot = fixture();
  const gapPaths = resolveControlNamespace({ targetRoot: gapRoot, pmId: "pm1" });
  const barriers = ["a.ready", "a.release", "b.ready", "b.release"].map((name) => join(gapRoot, name));
  const gapWriter = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures", "generation_gap_writer.ts"),
    gapPaths.runtimeRoot,
    ...barriers,
  ], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  try {
    for (const [ready, release] of [[barriers[0]!, barriers[1]!], [barriers[2]!, barriers[3]!]]) {
      await waitForFile(ready);
      expect(existsSync(join(gapPaths.runtimeRoot, "generation.json"))).toBeFalse();
      try {
        readControlGeneration(gapPaths.runtimeRoot, 1, gapPaths.controlRoot);
        throw new Error("replacement gap unexpectedly returned");
      } catch (error) {
        expect(error).toBeInstanceOf(ControlGenerationError);
        expect(["control-generation-busy", "control-generation-recovery-required"])
          .toContain((error as ControlGenerationError).code);
      }
      writeFileSync(release, "release\n", "utf8");
    }
    expect(await gapWriter.exited).toBe(0);
    expect(await new Response(gapWriter.stderr).text()).toBe("");
  } finally {
    if (gapWriter.exitCode === null) {
      gapWriter.kill();
      await gapWriter.exited;
    }
  }
  expect(readControlGeneration(gapPaths.runtimeRoot, 16, gapPaths.controlRoot)).toBe(6);

  const abaRoot = mkdtempSync(join(tmpdir(), "control-generation-v3-aba-"));
  roots.push(abaRoot);
  const abaControl = writeV3Fixture(abaRoot);
  const abaPaths = resolveControlNamespace({ targetRoot: abaRoot, pmId: "pm1" });
  const before = readControlGenerationSnapshot(abaPaths.runtimeRoot, 16, abaControl);
  let calls = 0;
  const value = readStableControl({ controlRoot: abaControl, runtimeRoot: abaPaths.runtimeRoot }, () => {
    calls++;
    if (calls === 1) {
      rmSync(abaPaths.runtimeRoot, { recursive: true });
      recoverMissingControlGeneration({
        targetRoot: abaRoot,
        pmId: "pm1",
        sessionId: "cs_recover",
        validateCanonical: (controlRoot) => { loadPlanGraphModel(controlRoot); },
      });
      return "stale";
    }
    return "fresh";
  });
  const after = readControlGenerationSnapshot(abaPaths.runtimeRoot, 16, abaControl);
  expect(value).toBe("fresh");
  expect(calls).toBe(2);
  expect(after.incarnation).not.toBe(before.incarnation);

  const orphanRoot = fixture();
  const orphanPaths = resolveControlNamespace({ targetRoot: orphanRoot, pmId: "pm1" });
  const generation = join(orphanPaths.runtimeRoot, "generation.json");
  const lockPath = join(orphanPaths.runtimeRoot, "locks", "namespace.lock");
  const recoveryPath = join(orphanPaths.runtimeRoot, "locks", ".namespace.lock.recovery");
  const deadPid = 2147483647;
  const deadOwner = {
    token: "00000000-0000-4000-8000-000000000001",
    session_id: "cs_crashed",
    operation: "crashed",
    acquired_at: "2026-07-22T00:00:00Z",
    pid: deadPid,
    hostname: hostname(),
  };
  writeFileSync(generation, `${JSON.stringify({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    incarnation: "00000000-0000-4000-8000-000000000001",
    generation: 1,
    state: "writing",
    operation: "crashed",
    session_id: "cs_crashed",
    updated_at: "2026-07-22T00:00:00Z",
  })}\n`);
  mkdirSync(join(orphanPaths.runtimeRoot, "locks"), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(deadOwner));
  const strandedRecoveryOwner = {
    ...deadOwner,
    token: "00000000-0000-4000-8000-000000000005",
    session_id: "cs_stranded_recovery",
    operation: "namespace-lock-recovery:crashed",
  };
  writeFileSync(recoveryPath, JSON.stringify(strandedRecoveryOwner));
  expect(() => readStableControl({
    controlRoot: orphanPaths.controlRoot,
    runtimeRoot: orphanPaths.runtimeRoot,
    attempts: 1,
  }, () => "partial")).toThrow(ControlGenerationError);

  const originalKill = process.kill;
  let publishedRecoveryOwner: Record<string, unknown> | null = null;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === deadPid) {
      if (existsSync(recoveryPath)) {
        try {
          const candidate = JSON.parse(readFileSync(recoveryPath, "utf8")) as Record<string, unknown>;
          if (candidate.pid === process.pid) publishedRecoveryOwner = candidate;
        } catch { /* malformed recovery leases remain fail-closed */ }
      }
      const error = new Error("dead fixture pid") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }
    return signal === undefined ? originalKill(pid) : originalKill(pid, signal);
  }) as typeof process.kill;
  try {
    const recovered = acquireNamespaceLock(orphanPaths, {
      sessionId: "cs_next",
      operation: "next",
      at: "2026-07-22T00:01:00Z",
    });
    expect(recovered.token).not.toBe(deadOwner.token);
    expect(existsSync(recoveryPath)).toBeFalse();
    expect(publishedRecoveryOwner).toMatchObject({
      session_id: "cs_next",
      operation: "namespace-lock-recovery:next",
      pid: process.pid,
      hostname: hostname(),
    });
    expect(() => beginControlGeneration(orphanPaths, {
      sessionId: "cs_next",
      operation: "next",
      at: "2026-07-22T00:01:00Z",
    })).toThrow(ControlGenerationError);
    recovered.release();
    const diagnostics = readdirSync(join(orphanPaths.runtimeRoot, "diagnostics"))
      .map((entry) => readFileSync(join(orphanPaths.runtimeRoot, "diagnostics", entry), "utf8"));
    expect(diagnostics.some((source) => source.includes("dead-owner recovered"))).toBeTrue();

    const liveRecoveryOwner = { ...strandedRecoveryOwner, token: "00000000-0000-4000-8000-000000000006", pid: process.pid };
    writeFileSync(lockPath, JSON.stringify(deadOwner));
    writeFileSync(recoveryPath, JSON.stringify(liveRecoveryOwner));
    expect(() => acquireNamespaceLock(orphanPaths, {
      sessionId: "cs_next", operation: "live-recovery-owner", at: "2026-07-22T00:01:30Z",
    })).toThrow(ControlLockError);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(deadOwner);
    expect(JSON.parse(readFileSync(recoveryPath, "utf8"))).toEqual(liveRecoveryOwner);
    rmSync(recoveryPath);

    for (const unsafeRecoverySource of ["", "{"]) {
      writeFileSync(lockPath, JSON.stringify(deadOwner));
      writeFileSync(recoveryPath, unsafeRecoverySource);
      expect(() => acquireNamespaceLock(orphanPaths, {
        sessionId: "cs_next", operation: "partial-recovery-owner", at: "2026-07-22T00:01:45Z",
      })).toThrow(ControlLockError);
      expect(readFileSync(lockPath, "utf8")).toBe(JSON.stringify(deadOwner));
      expect(readFileSync(recoveryPath, "utf8")).toBe(unsafeRecoverySource);
      rmSync(recoveryPath);
    }

    const orphanCandidate = `${recoveryPath}.00000000-0000-4000-8000-000000000007.candidate`;
    writeFileSync(orphanCandidate, "{");
    writeFileSync(lockPath, JSON.stringify(deadOwner));
    const recoveredWithOrphan = acquireNamespaceLock(orphanPaths, {
      sessionId: "cs_next", operation: "orphan-candidate", at: "2026-07-22T00:01:50Z",
    });
    recoveredWithOrphan.release();
    expect(readFileSync(orphanCandidate, "utf8")).toBe("{");
    rmSync(orphanCandidate);

    const unsafeCases = [
      { name: "live", owner: { ...deadOwner, token: "00000000-0000-4000-8000-000000000002", pid: process.pid } },
      { name: "foreign", owner: { ...deadOwner, token: "00000000-0000-4000-8000-000000000003", hostname: `${hostname()}-foreign` } },
      { name: "unversioned", owner: { pid: deadPid, hostname: hostname() } },
    ];
    for (const unsafe of unsafeCases) {
      writeFileSync(lockPath, JSON.stringify(unsafe.owner));
      expect(() => acquireNamespaceLock(orphanPaths, {
        sessionId: "cs_next", operation: unsafe.name, at: "2026-07-22T00:02:00Z",
      })).toThrow(ControlLockError);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(unsafe.owner);
    }

    writeFileSync(lockPath, "{");
    expect(() => acquireNamespaceLock(orphanPaths, {
      sessionId: "cs_next", operation: "malformed", at: "2026-07-22T00:03:00Z",
    })).toThrow(ControlLockError);
    expect(readFileSync(lockPath, "utf8")).toBe("{");

    rmSync(lockPath);
    mkdirSync(lockPath);
    expect(() => acquireNamespaceLock(orphanPaths, {
      sessionId: "cs_next", operation: "unreadable", at: "2026-07-22T00:04:00Z",
    })).toThrow();
    expect(existsSync(lockPath)).toBeTrue();
    rmSync(lockPath, { recursive: true });

    const changedOwner = { ...deadOwner, token: "00000000-0000-4000-8000-000000000004", session_id: "cs_replacement" };
    writeFileSync(lockPath, JSON.stringify(deadOwner));
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid) {
        writeFileSync(lockPath, JSON.stringify(changedOwner));
        const error = new Error("dead fixture pid") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return signal === undefined ? originalKill(pid) : originalKill(pid, signal);
    }) as typeof process.kill;
    expect(() => acquireNamespaceLock(orphanPaths, {
      sessionId: "cs_next", operation: "changing", at: "2026-07-22T00:05:00Z",
    })).toThrow(ControlLockError);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(changedOwner);
    const unsafeDiagnostics = readdirSync(join(orphanPaths.runtimeRoot, "diagnostics"))
      .map((entry) => readFileSync(join(orphanPaths.runtimeRoot, "diagnostics", entry), "utf8"));
    expect(unsafeDiagnostics.some((source) => source.includes("unsafe-to-reclaim"))).toBeTrue();
  } finally {
    process.kill = originalKill;
  }

  const churnRoot = fixture();
  const churnPaths = resolveControlNamespace({ targetRoot: churnRoot, pmId: "pm1" });
  const ready = join(churnRoot, "churn.ready");
  const start = join(churnRoot, "churn.start");
  const done = join(churnRoot, "churn.done");
  const churnWriter = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures", "generation_churn_writer.ts"),
    churnPaths.runtimeRoot,
    ready,
    start,
    done,
    "128",
  ], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  try {
    await waitForFile(ready);
    writeFileSync(start, "start\n", "utf8");
    let reads = 0;
    while (!existsSync(done) || reads < 256) {
      const observed = readControlGeneration(churnPaths.runtimeRoot, 2_000, churnPaths.controlRoot);
      expect(observed).toBeGreaterThanOrEqual(2);
      expect(observed % 2).toBe(0);
      reads++;
    }
    expect(await churnWriter.exited).toBe(0);
    expect(await new Response(churnWriter.stderr).text()).toBe("");
  } finally {
    if (churnWriter.exitCode === null) {
      churnWriter.kill();
      await churnWriter.exited;
    }
  }
}

function exerciseEvidenceAddAggregate(): void {
  setSystemTime(new Date("2026-07-22T11:00:00.000Z"));
  const root = mkdtempSync(join(tmpdir(), "garelier-control-v3-evidence-add-"));
  roots.push(root);
  const control = writeV3Fixture(root, 2);
  const backlogPath = join(control, "backlog", "open", "W-001-runtime.md");
  const terminalOpenPath = join(control, "backlog", "open", "W-002-runtime.md");
  const terminalArchivePath = join(control, "backlog", "archive", "2026", "W-002-runtime.md");
  mkdirSync(join(control, "backlog", "archive", "2026"), { recursive: true });
  renameSync(terminalOpenPath, terminalArchivePath);
  writeFileSync(
    terminalArchivePath,
    readFileSync(terminalArchivePath, "utf8")
      .replace('status = "ready"', 'status = "done"')
      // writeV3Fixture's rows already carry status_changed (W-409); only closed/archived are new here.
      .replace(
        'updated = "2026-07-22T11:00:00.000Z"',
        'updated = "2026-07-22T11:00:00.000Z"\nclosed = "2026-07-22T11:00:00.000Z"\narchived = "2026-07-22T11:00:00.000Z"',
      ),
  );
  const checkpointPath = join(control, "checkpoints", "active", "CP-001-runtime.md");
  writeFileSync(
    checkpointPath,
    readFileSync(checkpointPath, "utf8").replace('backlog = ["W-001", "W-002"]', 'backlog = ["W-001"]'),
  );
  const existingReference = {
    kind: "path",
    root: "control",
    path: "reports/existing.md",
    observed_at: "2026-07-22T10:30:00.000Z",
    writer: "manual",
    summary: "existing manual reference",
  } as const;
  const backlogSource = readFileSync(backlogPath, "utf8")
    .replace(
      'updated = "2026-07-22T11:00:00.000Z"',
      `updated = "2026-07-22T11:00:00.000Z"\nevidence_refs = [{ kind = "path", root = "control", path = "reports/existing.md", observed_at = "2026-07-22T10:30:00.000Z", ${EVIDENCE_WRITER_STORAGE_KEY} = "manual", summary = "existing manual reference" }]`,
    )
    .replace(
      "- None recorded.",
      "- None recorded.\n\nManual evidence paragraph.\n\n    preserved indentation",
    );
  writeFileSync(backlogPath, backlogSource.replace(/\n/g, "\r\n"));
  const gateRelative = "reports/gates/W-001/result.json";
  const gatePath = join(control, ...gateRelative.split("/"));
  mkdirSync(join(control, "reports", "gates", "W-001"), { recursive: true });
  writeFileSync(gatePath, '{"status":"passed","typed":true}\n');

  const opened = controlOk(root, ["session-open", "--agent", "codex", "--session-id", "cs_evidence"]);
  let revision = String((opened.session as Record<string, unknown>).base_control_revision);
  const commit = "a".repeat(40);
  const shorthands = [
    `gate:QG-control:${commit}:${gateRelative}`,
    "report:reports/W-001/report.md",
    "path:reports/W-001/request.json",
    "path:reports/W-001/request.json",
  ];
  let result = controlOk(root, [
    "evidence-add", "W-001",
    ...shorthands.flatMap((value) => ["--evidence", value]),
    "--session", "cs_evidence", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);

  let backlog = loadPlanGraphModel(control).backlog.get("W-001")!;
  const refs = planGraphEvidenceReferences(backlog);
  expect(refs[0]).toEqual(existingReference);
  expect(refs.slice(1).map((item) => item.summary)).toEqual(shorthands);
  expect(refs[1]).toMatchObject({
    kind: "gate",
    id: "QG-control",
    commit,
    root: "control",
    path: gateRelative,
    content_hash: sha256(readFileSync(gatePath)),
  });
  expect(backlog.evidence.startsWith("Manual evidence paragraph.\n\n    preserved indentation\n")).toBeTrue();
  expect(backlog.evidence).not.toContain("None recorded");
  for (const shorthand of shorthands) expect(backlog.evidence).toContain(`- ${shorthand}`);
  expect(backlog.evidence.split(shorthands[2]!).length - 1).toBe(2);
  const writtenBacklog = readFileSync(backlogPath, "utf8");
  const evidenceSource = writtenBacklog.slice(writtenBacklog.indexOf("## Evidence"));
  expect(evidenceSource).toContain("## Evidence\r\n\r\nManual evidence paragraph.\r\n\r\n    preserved indentation\r\n");
  expect(evidenceSource.replaceAll("\r\n", "")).not.toContain("\n");

  const beforeInvalid = controlTreeBytes(control);
  const invalid = runCli([
    "evidence-add", "W-001",
    "--evidence", "test:valid-first",
    "--evidence", "invalid-later",
    "--session", "cs_evidence", "--expect-control-revision", revision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(invalid.code).not.toBe(0);
  expect(invalid.stderr).toContain("invalid evidence shorthand: invalid-later");
  expect(controlTreeBytes(control)).toEqual(beforeInvalid);

  result = controlOk(root, [
    "evidence-add", "W-002", "--evidence", "test:terminal-append",
    "--session", "cs_evidence", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);
  const terminal = loadPlanGraphModel(control).backlog.get("W-002")!;
  expect(terminal.path).toMatch(/^backlog\/archive\/\d{4}\//);
  expect(planGraphEvidenceReferences(terminal).at(-1)?.summary).toBe("terminal-append");
  expect(terminal.evidence).toContain("test:terminal-append");

  result = controlOk(root, [
    "risk-create",
    "--title", "Risk evidence compatibility",
    "--severity", "low",
    "--likelihood", "low",
    "--risk", "Risk body append remains supported.",
    "--trigger", "Schema-3 evidence-add.",
    "--impact", "Compatibility regression.",
    "--mitigation", "Preserve the body-only path.",
    "--session", "cs_evidence", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);
  const riskId = String(result.entity);
  controlOk(root, [
    "evidence-add", riskId, "--evidence", "decision:DEC-999",
    "--session", "cs_evidence", "--expect-control-revision", revision,
  ]);
  const risk = loadPlanGraphModel(control).risks.get(riskId)!;
  expect(risk.evidence).toContain("decision:DEC-999");
  expect(risk.frontmatter.evidence_refs).toBeUndefined();

  const canonicalGate = {
    work_id: "W-001",
    gate_id: "QG-control",
    status: "pass",
    exit_code: 0,
    commit,
    observed_at: "2026-07-22T11:00:00.000Z",
    executed_at: "2026-07-22T11:00:00.000Z",
    [EVIDENCE_WRITER_STORAGE_KEY]: "test",
    summary: "all required checks passed",
  };
  const writeGate = (gate: unknown): string => {
    const source = JSON.stringify(gate);
    writeFileSync(gatePath, source);
    return source;
  };
  let gateSource = writeGate(canonicalGate);
  const gateEvidence: EvidenceReference = {
    kind: "gate",
    id: "QG-control",
    commit,
    root: "control",
    path: gateRelative,
    content_hash: sha256(gateSource),
    observed_at: canonicalGate.observed_at,
    writer: "test",
    summary: canonicalGate.summary,
  };
  expect(validateGateEvidence({ targetRoot: root, controlRoot: control }, "W-001", gateEvidence)).toEqual([]);
  gateSource = writeGate({ status: "pass", exit_code: 0, commit });
  let findings = validateGateEvidence(
    { targetRoot: root, controlRoot: control },
    "W-001",
    { ...gateEvidence, content_hash: sha256(gateSource) },
  );
  expect(findings.map((item) => item.code)).toEqual(expect.arrayContaining([
    "gate-result-scope-mismatch",
    "gate-result-time-missing",
  ]));
  gateSource = writeGate({ ...canonicalGate, work_id: "W-002", gate_id: "QG-other", commit: "b".repeat(40) });
  findings = validateGateEvidence(
    { targetRoot: root, controlRoot: control },
    "W-001",
    { ...gateEvidence, content_hash: sha256(gateSource) },
  );
  expect(findings.map((item) => item.code)).toEqual(expect.arrayContaining([
    "gate-result-scope-mismatch",
    "gate-result-id-mismatch",
    "gate-result-commit-mismatch",
  ]));
}

function exerciseBacklogAcceptanceAggregate(): void {
  setSystemTime(new Date("2026-07-31T09:00:00.000Z"));
  const root = mkdtempSync(join(tmpdir(), "garelier-control-v3-acceptance-"));
  roots.push(root);
  const control = writeV3Fixture(root, 1);
  const backlogPath = join(control, "backlog", "open", "W-001-runtime.md");
  const retiredMembership = [
    "[[milestone_memberships]]",
    'id = "rel-007"',
    'slug = "retired-milestone"',
    'state = "retired"',
    'added = "2026-07-29T09:00:00.000Z"',
    'updated = "2026-07-30T10:00:00.000Z"',
    'retired = "2026-07-30T10:00:00.000Z"',
    'retire_reason = "Superseded by cross-cutting classification."',
    'relation = "contributes"',
  ].join("\n");
  const revisionHistory = "## Revision history\n\n- 2026-07-30: Retired the obsolete membership after scope review.";
  mkdirSync(join(control, "milestones"), { recursive: true });
  writeFileSync(join(control, "milestones", "fixture-milestone.md"), [
    "+++",
    "schema_version = 3",
    'kind = "garelier_milestone"',
    'slug = "fixture-milestone"',
    'status = "active"',
    'created = "2026-07-31T09:00:00.000Z"',
    'updated = "2026-07-31T09:00:00.000Z"',
    "+++",
    "# Fixture milestone\n",
  ].join("\n"));
  writeFileSync(
    backlogPath,
    readFileSync(backlogPath, "utf8")
      .replace('updated = "2026-07-22T11:00:00.000Z"', `updated = "2026-07-22T11:00:00.000Z"\nmilestone = "none"\n\n${retiredMembership}`)
      .replace("## Acceptance criteria", "## AC")
      .replace("## Evidence\n\n- None recorded.", `## Evidence\n\n- None recorded.\n\n${revisionHistory}`),
  );
  const opened = controlOk(root, ["session-open", "--agent", "codex", "--session-id", "cs_acceptance"]);
  let revision = String((opened.session as Record<string, unknown>).base_control_revision);

  let result = controlOk(root, [
    "backlog", "update", "W-001",
    "--check-acceptance", "1",
    "--session", "cs_acceptance", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);
  let source = readFileSync(backlogPath, "utf8");
  expect(source).toContain("## Acceptance criteria\n\n- [x] Bind dispatch and merge evidence.");
  expect(source).not.toContain("## AC\n");

  const staleRevision = revision;
  result = controlOk(root, [
    "backlog", "update", "W-001",
    "--set-acceptance", "Preserve the first criterion.",
    "--set-acceptance", "Preserve the second criterion.",
    "--set-acceptance", "Preserve the unrelated criterion.",
    "--session", "cs_acceptance", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);
  source = readFileSync(backlogPath, "utf8");
  expect(source).toContain("## Acceptance criteria\n\n- [ ] AC-1: Preserve the first criterion.\n- [ ] AC-2: Preserve the second criterion.\n- [ ] AC-3: Preserve the unrelated criterion.");
  expect(source).not.toContain("## AC\n");
  expect(source).toContain("## Current position\n\nReady for dispatch.");
  expect(source).toContain("## Evidence\n\n- None recorded.");

  const beforeStale = controlTreeBytes(control);
  const stale = runCli([
    "backlog", "update", "W-001",
    "--set-acceptance", "Must not be written.",
    "--session", "cs_acceptance", "--expect-control-revision", staleRevision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain("expected control revision");
  expect(controlTreeBytes(control)).toEqual(beforeStale);

  result = controlOk(root, [
    "backlog", "update", "W-001",
    "--check-acceptance", "1",
    "--check-acceptance", "AC-2",
    "--session", "cs_acceptance", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);
  source = readFileSync(backlogPath, "utf8");
  expect(source).toContain("- [x] AC-1: Preserve the first criterion.");
  expect(source).toContain("- [x] AC-2: Preserve the second criterion.");
  expect(source).toContain("- [ ] AC-3: Preserve the unrelated criterion.");

  for (const selectors of [["1", "AC-1"], ["AC-4"], ["zero"]]) {
    const before = controlTreeBytes(control);
    const rejected = runCli([
      "backlog", "update", "W-001",
      ...selectors.flatMap((selector) => ["--check-acceptance", selector]),
      "--session", "cs_acceptance", "--expect-control-revision", revision,
      "--project", root, "--pm-id", "pm1", "--format", "json",
    ], root);
    expect(rejected.code).toBe(1);
    expect(controlTreeBytes(control)).toEqual(before);
  }

  for (const mutation of [
    ["--set-acceptance", "   "],
    ["--set-acceptance", "Replacement.", "--check-acceptance", "1"],
  ]) {
    const before = controlTreeBytes(control);
    const rejected = runCli([
      "backlog", "update", "W-001",
      ...mutation,
      "--session", "cs_acceptance", "--expect-control-revision", revision,
      "--project", root, "--pm-id", "pm1", "--format", "json",
    ], root);
    expect(rejected.code).not.toBe(0);
    expect(controlTreeBytes(control)).toEqual(before);
  }

  const canonicalAcceptanceSource = readFileSync(backlogPath, "utf8");
  writeFileSync(
    backlogPath,
    canonicalAcceptanceSource.replace(
      "## Current position",
      "## AC\n\n- [ ] Legacy duplicate must be rejected.\n\n## Current position",
    ),
  );
  revision = loadPlanGraphModel(control).revision;
  const beforeAmbiguousAcceptance = controlTreeBytes(control);
  const ambiguousAcceptance = runCli([
    "backlog", "update", "W-001",
    "--set-acceptance", "Must not be written.",
    "--session", "cs_acceptance", "--expect-control-revision", revision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(ambiguousAcceptance.code).toBe(1);
  expect(ambiguousAcceptance.stderr).toContain("ambiguous Markdown section headings");
  expect(controlTreeBytes(control)).toEqual(beforeAmbiguousAcceptance);
  writeFileSync(backlogPath, canonicalAcceptanceSource);

  writeFileSync(
    backlogPath,
    readFileSync(backlogPath, "utf8").replace(
      "## Evidence",
      "## Current position\n\nPreserve this unrelated duplicate.\n\n## Evidence",
    ),
  );
  revision = loadPlanGraphModel(control).revision;
  result = controlOk(root, [
    "backlog", "update", "W-001",
    "--current-position", "Update only the first matching section.",
    "--session", "cs_acceptance", "--expect-control-revision", revision,
  ]);
  revision = String(result.control_revision_after);
  source = readFileSync(backlogPath, "utf8");
  expect(source).toContain("## Current position\n\nUpdate only the first matching section.");
  expect(source).toContain("## Current position\n\nPreserve this unrelated duplicate.");

  // A Backlog explicitly marked cross-cutting must become normally bound
  // when the CLI adds an active milestone membership.  This stays in the
  // existing schema-3 transaction aggregate to preserve the test budget.
  result = controlOk(root, [
    "link", "backlog", "W-001", "milestone", "fixture-milestone",
    "--session", "cs_acceptance", "--expect-control-revision", revision,
  ]);
  expect(result.status).toBe("committed");
  const milestoneBound = loadPlanGraphModel(control).backlog.get("W-001")!;
  expect(milestoneBound.milestone).toBeNull();
  expect(milestoneBound.milestoneMemberships.find((membership) => membership.state === "active")).toEqual(expect.objectContaining({
    relationId: "rel-008",
    target: "fixture-milestone",
    state: "active",
    relation: "contributes",
  }));
  expect(milestoneBound.milestoneMemberships.find((membership) => membership.relationId === "rel-007")).toEqual(expect.objectContaining({
    target: "retired-milestone",
    state: "retired",
    added: "2026-07-29T09:00:00.000Z",
    updated: "2026-07-30T10:00:00.000Z",
    retired: "2026-07-30T10:00:00.000Z",
    retireReason: "Superseded by cross-cutting classification.",
    relation: "contributes",
  }));
  source = readFileSync(backlogPath, "utf8");
  expect(source).toContain(retiredMembership);
  expect(source).toContain(revisionHistory);
  expect(loadPlanGraphModel(control).findings.some((finding) => finding.code === "backlog-milestone-none-conflict")).toBeFalse();
}

function exerciseMilestoneDependencyAggregate(): void {
  setSystemTime(new Date("2026-08-01T03:00:00.000Z"));
  const root = mkdtempSync(join(tmpdir(), "garelier-control-v3-milestone-dependency-"));
  roots.push(root);
  const control = writeV3Fixture(root, 1);
  const [a, b, c] = ["m17-audio", "m23-3d", "m28-proof"];
  const opened = controlOk(root, ["session-open", "--agent", "codex", "--session-id", "cs_milestone_dependency"]);
  let revision = String((opened.session as Record<string, unknown>).base_control_revision);

  for (const slug of [a, b, c]) {
    const created = controlOk(root, [
      "create", "milestone", "--slug", slug, "--title", `Milestone ${slug.toUpperCase()}`,
      "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
    ]);
    revision = String(created.control_revision_after);
  }

  const missingSessionBytes = controlTreeBytes(control);
  const missingSession = runCli([
    "milestone", "update", a, "--add-dependency", b,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(missingSession.code).toBe(2);
  expect(missingSession.stderr).toContain("--session");
  expect(controlTreeBytes(control)).toEqual(missingSessionBytes);

  const staleRevision = revision;
  let updated = controlOk(root, [
    "milestone", "update", a, "--add-dependency", b,
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
  ]);
  revision = String(updated.control_revision_after);
  expect(loadPlanGraphModel(control).milestones.get(a)?.dependsOn).toEqual([b]);
  expect(readFileSync(join(control, "milestones", `${a}.md`), "utf8")).toContain("# Milestone M17-AUDIO");

  const beforeStale = controlTreeBytes(control);
  const stale = runCli([
    "milestone", "update", b, "--add-dependency", c,
    "--session", "cs_milestone_dependency", "--expect-control-revision", staleRevision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain("expected control revision");
  expect(controlTreeBytes(control)).toEqual(beforeStale);

  const beforeDirectCycle = controlTreeBytes(control);
  const directCycle = runCli([
    "milestone", "update", a, "--set-depends-on", a,
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(directCycle.code).toBe(1);
  expect(directCycle.stderr).toContain("milestone-dependency-cycle");
  expect(directCycle.stderr).toContain(`milestone:${a} -> milestone:${a}`);
  expect(controlTreeBytes(control)).toEqual(beforeDirectCycle);

  updated = controlOk(root, [
    "milestone-update", b, "--add-dependency", c,
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
  ]);
  revision = String(updated.control_revision_after);
  const beforeTransitiveCycle = controlTreeBytes(control);
  const transitiveCycle = runCli([
    "milestone", "update", c, "--add-dependency", a,
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(transitiveCycle.code).toBe(1);
  expect(transitiveCycle.stderr).toContain("milestone-dependency-cycle");
  expect(transitiveCycle.stderr).toContain(`milestone:${a} -> milestone:${b} -> milestone:${c} -> milestone:${a}`);
  expect(controlTreeBytes(control)).toEqual(beforeTransitiveCycle);

  const aPath = join(control, "milestones", `${a}.md`);
  const bPath = join(control, "milestones", `${b}.md`);
  const cPath = join(control, "milestones", `${c}.md`);
  const aSource = readFileSync(aPath, "utf8");
  const bSource = readFileSync(bPath, "utf8");
  const cSource = readFileSync(cPath, "utf8");
  writeFileSync(aPath, aSource.replace(`depends_on = [ "${b}" ]`, `depends_on = [ "${a}" ]`));
  const directDoctor = runCli(["doctor", "--profile", "strict", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
  expect(directDoctor.code).toBe(1);
  expect(JSON.parse(directDoctor.stdout).findings).toContainEqual(expect.objectContaining({
    code: "milestone-dependency-cycle",
    field: "depends_on",
    message: expect.stringContaining(`milestone:${a} -> milestone:${a}`),
  }));

  writeFileSync(aPath, aSource);
  writeFileSync(cPath, cSource.replace("depends_on = []", `depends_on = [ "${a}" ]`));
  const transitiveDoctor = runCli(["doctor", "--profile", "strict", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
  expect(transitiveDoctor.code).toBe(1);
  expect(JSON.parse(transitiveDoctor.stdout).findings).toContainEqual(expect.objectContaining({
    code: "milestone-dependency-cycle",
    field: "depends_on",
    message: expect.stringContaining(`milestone:${a} -> milestone:${b} -> milestone:${c} -> milestone:${a}`),
  }));

  writeFileSync(cPath, cSource.replace("depends_on = []", 'depends_on = []\ndependency_targets = [ "m17", "W-001" ]'));
  writeFileSync(bPath, bSource.replace(`depends_on = [ "${c}" ]`, `depends_on = [ "${c}", "missing" ]`));
  const legacyDoctor = runCli(["doctor", "--profile", "strict", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
  expect(legacyDoctor.code).toBe(1);
  const legacyFindings = JSON.parse(legacyDoctor.stdout).findings as Array<{ code: string; message: string }>;
  expect(legacyFindings).toContainEqual(expect.objectContaining({
    code: "milestone-dependency-cycle",
    message: expect.stringContaining(`milestone:${a} -> milestone:${b} -> milestone:${c} -> milestone:${a}`),
  }));
  expect(legacyFindings).toContainEqual(expect.objectContaining({
    code: "milestone-dependency-target-missing",
    message: expect.stringContaining("milestone:missing"),
  }));

  revision = loadPlanGraphModel(control).revision;
  const beforeFailedRepair = controlTreeBytes(control);
  const failedRepair = runCli([
    "milestone", "update", c, "--remove-dependency", "not-present",
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(failedRepair.code).toBe(1);
  expect(failedRepair.stderr).toContain(`Milestone dependency does not exist: ${c} -> not-present`);
  expect(controlTreeBytes(control)).toEqual(beforeFailedRepair);

  const currentPath = join(control, "project_dashboard", "current.md");
  const currentSource = readFileSync(currentPath, "utf8");
  writeFileSync(currentPath, currentSource.replace("checkpoint:CP-001", "checkpoint:CP-999"));
  revision = loadPlanGraphModel(control).revision;
  const otherStrictError = runCli([
    "milestone", "update", c, "--remove-dependency", "m17",
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
    "--project", root, "--pm-id", "pm1", "--format", "json",
  ], root);
  expect(otherStrictError.code).toBe(1);
  expect(otherStrictError.stderr).toContain("current-primary-not-candidate");
  writeFileSync(currentPath, currentSource);

  revision = loadPlanGraphModel(control).revision;
  updated = controlOk(root, [
    "milestone", "update", c,
    "--remove-dependency", "m17",
    "--remove-dependency", `${b}=missing`,
    "--session", "cs_milestone_dependency", "--expect-control-revision", revision,
  ]);
  expect(updated.status).toBe("committed");
  const repairedDoctor = runCli(["doctor", "--profile", "strict", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
  expect(repairedDoctor.code, repairedDoctor.stderr).toBe(0);
  expect(readFileSync(cPath, "utf8")).toContain('dependency_targets = [ "W-001" ]');
  expect(loadPlanGraphModel(control).milestones.get(c)?.dependsOn).toEqual([]);
  expect(loadPlanGraphModel(control).milestones.get(b)?.dependsOn).toEqual([c]);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "garelier-control-v3-transaction-"));
  roots.push(root);
  const control = join(root, "__garelier", "pm1", "control");
  const runtime = join(root, "__garelier", "pm1", "runtime", "control");
  mkdirSync(join(control, "backlog", "open"), { recursive: true });
  mkdirSync(join(control, "project_dashboard"), { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(control, "control.toml"), 'schema_version = 3\nstorage = "plan_graph_markdown"\npm_id = "pm1"\n');
  writeFileSync(join(control, "backlog", "open", "W-205-control.md"), `${JSON.stringify({
    kind: "backlog", id: "W-205", status: "ready", created: now().toISOString(), updated: now().toISOString(), evidence: [],
  }, null, 2)}\n`);
  writeFileSync(join(control, "project_dashboard", "current.md"), '{"active":[]}\n');
  writeFileSync(join(runtime, "generation.json"), `${JSON.stringify({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    incarnation: "00000000-0000-4000-8000-000000000001",
    generation: 2,
    state: "stable",
    operation: "seed",
    session_id: "cs_seed",
    updated_at: now().toISOString(),
  }, null, 2)}\n`);
  // W-211: this fixture seeds a generation that already had prior activity (generation 2,
  // not 0), so it must also carry the durable activation marker — otherwise a later
  // `rmSync(generation.json)` in a test would be misread as "never activated" (bootstrap-
  // safe) instead of the interrupted-writer scenario it is meant to simulate.
  writeFileSync(join(runtime, "generation.activated.json"), `${JSON.stringify({
    schema_version: 1, kind: "garelier_control_generation_activation",
    control_schema_version: 3, storage: "plan_graph_markdown", activated_at: now().toISOString(),
  }, null, 2)}\n`);
  return root;
}

function callbacks(): ControlFilePlanCallbacks<FixtureState> {
  return {
    normalizePath: assertLifecycleV3ControlPath,
    load: ({ controlRoot }) => {
      const backlog = readJson<RecordFixture>(join(controlRoot, "backlog", "open", "W-205-control.md"));
      const checkpointPath = join(controlRoot, "checkpoints", "active", "CP-205-control.md");
      const checkpoint = existsSync(checkpointPath) ? readJson<RecordFixture>(checkpointPath) : null;
      const current = readJson<CurrentFixture>(join(controlRoot, "project_dashboard", "current.md"));
      const active = backlog.status === "active";
      if (active !== Boolean(checkpoint) || active !== current.active.includes("CP-205")) {
        throw new Error("activation invariant is partial");
      }
      const digest = controlTreeSourceDigest(controlRoot);
      return {
        state: { backlog, checkpoint, current },
        revision: digest,
        sourceDigest: digest,
        entityRevision: (id) => id === "W-205" ? 1 : null,
      };
    },
  };
}

function activation(state: FixtureState, at: string) {
  return planLifecycleV3Activation({
    backlogPath: "backlog/open/W-205-control.md",
    backlog: state.backlog,
    checkpointPath: "checkpoints/active/CP-205-control.md",
    checkpoint: {
      kind: "checkpoint",
      id: "CP-205",
      status: "paused",
      created: at,
      updated: at,
      evidence: [],
    },
    currentPath: "project_dashboard/current.md",
    current: state.current,
    now: at,
    recordAdapter,
    currentAdapter,
  });
}

afterEach(() => {
  setSystemTime();
  delete process.env.GARELIER_CONTROL_CWD_FENCE;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("schema-3 generic file-plan transaction", () => {
  test("canonical binding and missing-generation recovery fail closed before strict recovery", async () => {
    const root = fixture();
    const paths = resolveControlNamespace({ targetRoot: root, pmId: "pm1" });
    for (const version of [1, 2]) {
      writeFileSync(join(paths.controlRoot, "control.toml"), `schema_version = ${version}\nstorage = "retired"\n`);
      expect(() => readControlGeneration(paths.runtimeRoot, 1, paths.controlRoot))
        .toThrow(`control schema_version ${version} is unsupported; only schema_version 3`);
    }

    const recoveryRoot = fixture();
    const recoveryPaths = resolveControlNamespace({ targetRoot: recoveryRoot, pmId: "pm1" });
    rmSync(join(recoveryPaths.runtimeRoot, "generation.json"));
    expect(() => recoverMissingControlGeneration({
      targetRoot: recoveryRoot,
      pmId: "pm1",
      sessionId: "cs_recover",
    })).toThrow("strict canonical validation callback");
    const recovered = recoverMissingControlGeneration({
      targetRoot: recoveryRoot,
      pmId: "pm1",
      sessionId: "cs_recover",
      validateCanonical: (controlRoot) => {
        expect(callbacks().load({
          targetRoot: recoveryRoot,
          pmId: "pm1",
          controlRoot,
          runtimeRoot: recoveryPaths.runtimeRoot,
          now: now(),
        }).state.backlog.status).toBe("ready");
      },
    });
    expect(recovered).toMatchObject({
      generation: 2,
      controlSchemaVersion: 3,
      storage: "plan_graph_markdown",
    });
    exerciseEvidenceAddAggregate();
    exerciseBacklogAcceptanceAggregate();
    exerciseMilestoneDependencyAggregate();
    exerciseCwdFenceAggregate();
    await exerciseGenerationAtomicityAggregate();
  }, 90_000);

  test("projects canonical titles and applies a 100-row reviewed triage batch atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "garelier-control-v3-cockpit-"));
    roots.push(root);
    const control = writeV3Fixture(root, 105);
    const dashboard = join(control, "project_dashboard", "current.md");
    writeFileSync(
      dashboard,
      readFileSync(dashboard, "utf8")
        .replaceAll("CP-001", "CP-002")
        .replace("Runtime integration fixture.", "Stale prose still names W-313 and CP-001."),
    );
    const checkpointOld = join(control, "checkpoints", "active", "CP-001-runtime.md");
    const checkpointNew = join(control, "checkpoints", "active", "CP-002-runtime.md");
    renameSync(checkpointOld, checkpointNew);
    const explicitFocusOrder = [
      "W-105",
      ...Array.from({ length: 104 }, (_, index) => `W-${String(index + 1).padStart(3, "0")}`),
    ];
    writeFileSync(
      checkpointNew,
      readFileSync(checkpointNew, "utf8")
        .replaceAll("CP-001", "CP-002")
        .replace(/backlog = \[[^\n]+\]/, `backlog = [${explicitFocusOrder.map((id) => `"${id}"`).join(", ")}]`),
    );
    const firstPath = join(control, "backlog", "open", "W-001-runtime.md");
    writeFileSync(
      firstPath,
      readFileSync(firstPath, "utf8")
        .replace(
          'updated = "2026-07-22T11:00:00.000Z"',
          `updated = "2026-07-22T11:00:00.000Z"\nevidence_refs = [{ kind = "commit", ${EVIDENCE_WRITER_STORAGE_KEY} = "garelier-merge-gate", observed_at = "2026-07-22T11:00:00.000Z", summary = "studio merge commit", commit = "1111111111111111111111111111111111111111" }]`,
        )
        .replace("- None recorded.", "- `commit:1111111111111111111111111111111111111111` — studio merge commit")
        .replace("# W-001: Runtime integration", "# W-001: Canonical projected title"),
    );
    const boundedFocusPath = join(control, "backlog", "open", "W-105-runtime.md");
    const boundedFocusTitle = "界".repeat(200);
    writeFileSync(
      boundedFocusPath,
      readFileSync(boundedFocusPath, "utf8")
        .replace("# W-105: Runtime integration", `# W-105: ${boundedFocusTitle}`),
    );
    const missingAcPath = join(control, "backlog", "open", "W-004-runtime.md");
    writeFileSync(
      missingAcPath,
      readFileSync(missingAcPath, "utf8")
        .replace("Bind dispatch and merge evidence.", "Define acceptance."),
    );
    const classPath = join(control, "backlog", "open", "W-005-runtime.md");
    writeFileSync(
      classPath,
      readFileSync(classPath, "utf8")
        .replace("# W-005: Runtime integration", "# W-005: Warning cleanup incident bypass visibility"),
    );
    const importedPath = join(control, "backlog", "open", "W-002-runtime.md");
    writeFileSync(
      importedPath,
      readFileSync(importedPath, "utf8")
        .replace('created = "2026-07-22T10:00:00.000Z"', 'created = "1970-01-01T00:00:00.000Z"')
        .replace('updated = "2026-07-22T11:00:00.000Z"', 'updated = "1970-01-01T00:00:00.000Z"')
        // status_changed must not follow updated (lifecycle-status-after-updated);
        // writeV3Fixture's rows carry it by default (W-409), so rewind it with updated.
        .replace('status_changed = "2026-07-22T11:00:00.000Z"', 'status_changed = "1970-01-01T00:00:00.000Z"'),
    );

    const mirrorTitle = loadTaskMirrorSource(root, "pm1").items.find((item) => item.id === "W-001")!.title;
    const statusProjection = buildControl(root, "pm1");
    const statusTitle = statusProjection.planGraph!.backlog.find((item) => item.id === "W-001")!.title;
    const boundedStatusTitle = statusProjection.planGraph!.backlog.find((item) => item.id === "W-105")!.title;
    const boundedStatusNodeTitle = statusProjection.nodes.find((item) => item.id === "backlog:W-105")!.title;
    const cockpitResult = runCli(["cockpit", "--top-n", "3", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(cockpitResult.code).toBe(0);
    const cockpit = JSON.parse(cockpitResult.stdout);
    expect(mirrorTitle).toBe("Canonical projected title");
    expect(statusTitle).toBe("Canonical projected title");
    expect(boundedStatusTitle).toBe(boundedStatusNodeTitle);
    expect(Buffer.byteLength(boundedStatusTitle, "utf8")).toBeLessThanOrEqual(240);
    expect(boundedStatusTitle).not.toContain("\ufffd");
    expect(cockpit.focus.backlog[0].id).toBe("W-105");
    expect(Buffer.byteLength(cockpit.focus.backlog[0].title, "utf8")).toBeLessThanOrEqual(240);
    expect(cockpit.focus.backlog[0].title).not.toContain("\ufffd");
    expect(statusText("界".repeat(3), 5)).toBe("界");
    expect(cockpit).toMatchObject({
      top_n: 3,
      counts: {
        open_backlog: 105,
        landed_state_drift: 1,
        focus_drift: 1,
        missing_ac: 1,
        legacy_import: 0,
        unblocked_ready: 105,
        warning: 1,
        cleanup: 1,
        incident: 1,
        bypass: 1,
      },
      focus: { checkpoint_id: "CP-002", backlog_count: 105, truncated: 102 },
    });
    expect(cockpit.indicators.unblocked_ready.samples).toHaveLength(3);
    expect(cockpit.indicators.focus_drift.samples[0]).toMatchObject({
      stale_refs: ["CP-001", "W-313"],
      stale_ref_count: 2,
      stale_refs_truncated: 0,
      checkpoint_id: "CP-002",
      projected_subject: { id: "W-105" },
    });

    const legacyTitlePath = join(control, "backlog", "open", "W-006-runtime.md");
    const legacyRawTitle = "界".repeat(300);
    writeFileSync(
      legacyTitlePath,
      readFileSync(legacyTitlePath, "utf8")
        .replace("# W-006: Runtime integration", `# ${legacyRawTitle}`),
    );
    const legacyTitleResult = runCli(["cockpit", "--top-n", "2", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(legacyTitleResult.code).toBe(0);
    expect(JSON.parse(legacyTitleResult.stdout)).toMatchObject({
      valid: true,
      counts: { legacy_import: 1, malformed_rows: 0 },
      indicators: {
        legacy_import: {
          samples: [{ path: "backlog/open/W-006-runtime.md", code: "backlog-title-legacy" }],
        },
      },
    });
    const legacySample = JSON.parse(legacyTitleResult.stdout).indicators.legacy_import.samples[0];
    expect(Buffer.byteLength(legacySample.message, "utf8")).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(legacySample.path, "utf8")).toBeLessThanOrEqual(320);
    writeFileSync(
      legacyTitlePath,
      readFileSync(legacyTitlePath, "utf8")
        .replace(`# ${legacyRawTitle}`, "# W-006: Runtime integration"),
    );

    const malformedPath = join(control, "backlog", "open", "W-999-legacy.md");
    writeFileSync(malformedPath, "---\n[work]\nid = \"W-999\"\n---\n# W-999: legacy\n");
    const malformedResult = runCli(["cockpit", "--top-n", "2", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(malformedResult.code).toBe(1);
    expect(JSON.parse(malformedResult.stdout)).toMatchObject({
      valid: false,
      counts: { legacy_import: 1, malformed_rows: 1 },
    });
    rmSync(malformedPath);

    mkdirSync(join(control, "roadmaps"), { recursive: true });
    mkdirSync(join(control, "milestones"), { recursive: true });
    writeFileSync(join(control, "roadmaps", "fixture-roadmap.md"), [
      "+++",
      "schema_version = 3",
      'kind = "garelier_roadmap"',
      'slug = "fixture-roadmap"',
      'status = "active"',
      'created = "2026-07-22T10:00:00.000Z"',
      'updated = "2026-07-22T11:00:00.000Z"',
      "",
      "[[milestone_links]]",
      'id = "rel-001"',
      'state = "active"',
      'added = "2026-07-22T10:00:00.000Z"',
      'updated = "2026-07-22T11:00:00.000Z"',
      'slug = "fixture-milestone"',
      "order = 0",
      'relation = "root"',
      "required = true",
      "+++",
      "# Fixture roadmap\n",
    ].join("\n"));
    writeFileSync(join(control, "milestones", "fixture-milestone.md"), [
      "+++",
      "schema_version = 3",
      'kind = "garelier_milestone"',
      'slug = "fixture-milestone"',
      'status = "active"',
      'created = "2026-07-22T10:00:00.000Z"',
      'updated = "2026-07-22T11:00:00.000Z"',
      "+++",
      "# Fixture milestone\n",
    ].join("\n"));

    const model = loadPlanGraphModel(control);
    const revisions = new Map([...model.backlog.values()].map((record) => [
      record.id,
      Math.floor(Date.parse(record.updated) / 1_000),
    ]));
    expect(revisions.get("W-002")).toBe(0);

    const rawBacklog = runCli(["get", "W-003", "--with-links", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    const typedBacklog = runCli(["get", "backlog:W-003", "--with-links", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(rawBacklog.code).toBe(0);
    expect(typedBacklog.code).toBe(0);
    expect(JSON.parse(typedBacklog.stdout)).toEqual(JSON.parse(rawBacklog.stdout));
    const rawRoadmap = runCli(["get", "fixture-roadmap", "--with-links", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    const typedRoadmap = runCli(["get", "roadmap:fixture-roadmap", "--with-links", "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(rawRoadmap.code).toBe(0);
    expect(typedRoadmap.code).toBe(0);
    expect(JSON.parse(typedRoadmap.stdout)).toEqual(JSON.parse(rawRoadmap.stdout));
    for (const [typed, message] of [
      ["unknown:W-003", "unknown typed entity kind: unknown"],
      ["backlog:CP-002", "typed entity kind/id mismatch: backlog:CP-002"],
      ["backlog:W-003:extra", "malformed typed entity reference: backlog:W-003:extra"],
    ]) {
      const rejected = runCli(["get", typed, "--project", root, "--pm-id", "pm1", "--format", "json"], root);
      expect(rejected.code).toBe(2);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(message);
    }

    const mixedBacklogBatch = join(root, "backlog-mixed-unknown-key.toml");
    writeFileSync(mixedBacklogBatch, [
      "[[row]]",
      'title = "valid row"',
      "",
      "[[row]]",
      'title = "invalid row"',
      'unknown_key = "must fail closed"',
      "",
    ].join("\n"));
    const batchBefore = controlTreeBytes(control);
    const rejectedBatch = runCli(["backlog", "create-batch", "--file", mixedBacklogBatch, "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(rejectedBatch.code).toBe(2);
    expect(rejectedBatch.stdout).toBe("");
    expect(rejectedBatch.stderr.startsWith('control: batch row 2 has unknown key: "unknown_key"\nusage:\n')).toBe(true);
    expect(controlTreeBytes(control)).toEqual(batchBefore);

    const escapedUnknownKeyBatch = join(root, "backlog-escaped-unknown-key.toml");
    writeFileSync(escapedUnknownKeyBatch, [
      "[[row]]",
      'title = "valid row"',
      "",
      "[[row]]",
      'title = "invalid row"',
      '"unknown\\nkey" = "must fail closed"',
      "",
    ].join("\n"));
    const escapedBatchBefore = controlTreeBytes(control);
    const rejectedEscapedBatch = runCli(["backlog", "create-batch", "--file", escapedUnknownKeyBatch, "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    expect(rejectedEscapedBatch.code).toBe(2);
    expect(rejectedEscapedBatch.stdout).toBe("");
    expect(rejectedEscapedBatch.stderr.startsWith('control: batch row 2 has unknown key: "unknown\\nkey"\nusage:\n')).toBe(true);
    expect(controlTreeBytes(control)).toEqual(escapedBatchBefore);

    const decision = join(root, "triage.toml");
    const rows = Array.from({ length: 101 }, (_, index) => {
      const id = `W-${String(index + 1).padStart(3, "0")}`;
      const action = id === "W-001" ? 'action = "cancel"\nreason = "reviewed cancellation"'
        : id === "W-002" ? 'action = "supersede"\nreason = "reviewed consolidation"\nreplacement = "W-003"'
          : 'action = "keep"';
      return `[[decision]]\nid = "${id}"\n${action}\nexpect_revision = ${revisions.get(id)}\n`;
    }).join("\n");
    writeFileSync(decision, [
      "schema_version = 1",
      'kind = "garelier_backlog_triage_batch"',
      'reviewed_by = "pm-test"',
      'reviewed_at = "2026-07-31T00:00:00.000Z"',
      "",
      rows,
    ].join("\n"));

    const decisionSource = readFileSync(decision, "utf8");
    const assertRejectedPlan = (path: string, message: string): void => {
      const before = controlTreeSourceDigest(control);
      const rejected = runCli([
        "backlog", "triage-batch", "--plan", "--file", path,
        "--project", root, "--pm-id", "pm1", "--format", "json",
      ], root);
      expect(rejected.code).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(message);
      expect(controlTreeSourceDigest(control)).toBe(before);
    };

    const mixed = join(root, "triage-invalid.toml");
    writeFileSync(mixed, decisionSource
      + `\n[[decision]]\nid = "W-001"\naction = "keep"\nexpect_revision = ${revisions.get("W-001")}\n`);
    assertRejectedPlan(mixed, "duplicate decision id: W-001");

    const unknownKey = join(root, "triage-unknown-key.toml");
    writeFileSync(unknownKey, decisionSource.replace(
      'action = "cancel"',
      'action = "cancel"\nunknown_key = "must fail closed"',
    ));
    assertRejectedPlan(unknownKey, "decision 0 has unknown key: unknown_key");

    const unsupportedAction = join(root, "triage-unsupported-action.toml");
    writeFileSync(unsupportedAction, decisionSource.replace(
      'action = "keep"',
      'action = "transition"\nto = "active"',
    ));
    assertRejectedPlan(unsupportedAction, "action must be keep, cancel, or supersede");

    const malformedDecision = join(root, "triage-malformed.toml");
    writeFileSync(malformedDecision, decisionSource.replace("[[decision]]", "[[decision]"));
    assertRejectedPlan(malformedDecision, "decision file is not valid TOML");

    const staleDecision = join(root, "triage-stale.toml");
    const w003Revision = revisions.get("W-003")!;
    writeFileSync(staleDecision, decisionSource.replace(
      `id = "W-003"\naction = "keep"\nexpect_revision = ${w003Revision}`,
      `id = "W-003"\naction = "keep"\nexpect_revision = ${w003Revision + 1}`,
    ));
    assertRejectedPlan(staleDecision, `stale Backlog W-003: expected revision ${w003Revision + 1}`);

    const planStarted = performance.now();
    const planned = runCli(["backlog", "triage-batch", "--plan", "--file", decision, "--project", root, "--pm-id", "pm1", "--format", "json"], root);
    const planElapsed = performance.now() - planStarted;
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout);
    expect(plan.counts).toEqual({
      decisions: 101,
      keep: 99,
      transition: 0,
      cancel: 1,
      supersede: 1,
      writes: 2,
    });
    expect(planElapsed).toBeLessThan(60_000);

    const assertRejectedApply = (
      path: string,
      message: string,
      expectedPlanDigest = plan.plan_digest,
      expectedControlRevision = plan.control_revision,
    ): void => {
      const before = controlTreeBytes(control);
      const rejected = runCli([
        "backlog", "triage-batch", "--apply", "--file", path,
        "--expect-plan-digest", expectedPlanDigest,
        "--expect-control-revision", expectedControlRevision,
        "--project", root, "--pm-id", "pm1", "--format", "json",
      ], root);
      expect(rejected.code).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(message);
      expect(controlTreeBytes(control)).toEqual(before);
    };

    const unknownApply = join(root, "triage-apply-unknown.toml");
    writeFileSync(unknownApply, [
      "schema_version = 1",
      'kind = "garelier_backlog_triage_batch"',
      'reviewed_by = "pm-test"',
      'reviewed_at = "2026-07-31T00:00:00.000Z"',
      "",
      "[[decision]]",
      'id = "W-999"',
      'action = "keep"',
      "expect_revision = 0",
      "",
    ].join("\n"));
    assertRejectedApply(unknownApply, "unknown Backlog: W-999");

    const missingReasonApply = join(root, "triage-apply-missing-reason.toml");
    writeFileSync(missingReasonApply, decisionSource.replace('reason = "reviewed cancellation"\n', ""));
    assertRejectedApply(missingReasonApply, "decision 0.reason is required for cancel");

    const missingReplacementApply = join(root, "triage-apply-missing-replacement.toml");
    writeFileSync(missingReplacementApply, decisionSource.replace('replacement = "W-003"\n', ""));
    assertRejectedApply(missingReplacementApply, "decision 1.replacement is required for supersede");

    const mixedInvalidApply = join(root, "triage-apply-mixed-invalid.toml");
    writeFileSync(mixedInvalidApply, decisionSource.replace(
      'id = "W-101"\naction = "keep"',
      'id = "W-101"\naction = "cancel"',
    ));
    assertRejectedApply(mixedInvalidApply, "decision 100.reason is required for cancel");

    const beforeRevisionMismatch = controlTreeSourceDigest(control);
    const revisionMismatch = runCli([
      "backlog", "triage-batch", "--apply", "--file", decision,
      "--expect-plan-digest", plan.plan_digest,
      "--expect-control-revision", `sha256:${"0".repeat(64)}`,
      "--project", root, "--pm-id", "pm1", "--format", "json",
    ], root);
    expect(revisionMismatch.code).toBe(1);
    expect(revisionMismatch.stderr).toContain("expected control revision");
    expect(controlTreeSourceDigest(control)).toBe(beforeRevisionMismatch);

    const beforeDigestMismatch = controlTreeSourceDigest(control);
    const digestMismatch = runCli([
      "backlog", "triage-batch", "--apply", "--file", decision,
      "--expect-plan-digest", `sha256:${"0".repeat(64)}`,
      "--expect-control-revision", plan.control_revision,
      "--project", root, "--pm-id", "pm1", "--format", "json",
    ], root);
    expect(digestMismatch.code).toBe(1);
    expect(digestMismatch.stderr).toContain("triage-batch plan digest mismatch");
    expect(controlTreeSourceDigest(control)).toBe(beforeDigestMismatch);

    const applyStarted = performance.now();
    const applied = runCli([
      "backlog", "triage-batch", "--apply", "--file", decision,
      "--expect-plan-digest", plan.plan_digest,
      "--expect-control-revision", plan.control_revision,
      "--project", root, "--pm-id", "pm1", "--format", "json",
    ], root);
    const applyElapsed = performance.now() - applyStarted;
    expect(applied.code).toBe(0);
    const result = JSON.parse(applied.stdout);
    expect(result.status).toBe("committed");
    expect(result.changed_paths).toEqual([
      "backlog/archive/2026/W-001-runtime.md",
      "backlog/archive/2026/W-002-runtime.md",
      "backlog/open/W-001-runtime.md",
      "backlog/open/W-002-runtime.md",
    ]);
    expect(applyElapsed).toBeLessThan(60_000);
    expect(existsSync(join(control, "backlog", "open", "W-001-runtime.md"))).toBeFalse();
    expect(existsSync(join(control, "backlog", "open", "W-002-runtime.md"))).toBeFalse();
    expect(existsSync(join(control, "backlog", "open", "W-003-runtime.md"))).toBeTrue();
    expect(readFileSync(join(control, "backlog", "archive", "2026", "W-001-runtime.md"), "utf8"))
      .toContain('status = "cancelled"');
    expect(readFileSync(join(control, "backlog", "archive", "2026", "W-002-runtime.md"), "utf8"))
      .toContain('replacement = "W-003"');

    const archivedModel = loadPlanGraphModel(control);
    const archivedW001 = archivedModel.backlog.get("W-001")!;
    expect(archivedW001.evidence).toContain("`commit:1111111111111111111111111111111111111111` — studio merge commit");
    expect(archivedW001.frontmatter.evidence_refs).toEqual([{
      kind: "commit",
      [EVIDENCE_WRITER_STORAGE_KEY]: "garelier-merge-gate",
      observed_at: "2026-07-22T11:00:00.000Z",
      summary: "studio merge commit",
      commit: "1111111111111111111111111111111111111111",
    }]);
    const invalidLifecycleApply = join(root, "triage-apply-invalid-lifecycle.toml");
    writeFileSync(invalidLifecycleApply, [
      "schema_version = 1",
      'kind = "garelier_backlog_triage_batch"',
      'reviewed_by = "pm-test"',
      'reviewed_at = "2026-07-31T00:00:00.000Z"',
      "",
      "[[decision]]",
      'id = "W-001"',
      'action = "cancel"',
      'reason = "duplicate terminal transition"',
      `expect_revision = ${Math.floor(Date.parse(archivedW001.updated) / 1_000)}`,
      "",
    ].join("\n"));
    assertRejectedApply(
      invalidLifecycleApply,
      "decision W-001 action cancel requires an open Backlog",
      plan.plan_digest,
      archivedModel.revision,
    );
  }, 15_000);

  // W-347: `transition-batch` moves N rows in ONE transaction. The three acceptance
  // criteria are asserted here: a single commit for N rows, all-or-nothing on any
  // partial failure, and the existing per-row validation (edge table, reason and
  // checkpoint requirements, chronology) still applying to every row.
  test("transitions N backlog rows in one transaction and rejects the whole batch on any invalid row", () => {
    setSystemTime(now());
    const root = mkdtempSync(join(tmpdir(), "garelier-control-v3-transition-batch-"));
    roots.push(root);
    const control = writeV3Fixture(root, 4);
    const backlogPath = (id: string): string => join(control, "backlog", "open", `${id}-runtime.md`);
    // W-747/754/755 shape: several rows sitting in triage that become ready together.
    for (const id of ["W-001", "W-002", "W-003"]) {
      writeFileSync(backlogPath(id), readFileSync(backlogPath(id), "utf8").replace('status = "ready"', 'status = "triage"'));
    }
    const untouchedBefore = readFileSync(backlogPath("W-004"), "utf8");
    const opened = controlOk(root, ["session-open", "--agent", "codex", "--session-id", "cs_batch"]);
    let revision = String((opened.session as Record<string, unknown>).base_control_revision);

    const batchFile = join(root, "transition-batch.toml");
    const writeBatch = (rows: string[][]): string => {
      writeFileSync(batchFile, rows.map((row) => ["[[row]]", ...row, ""].join("\n")).join("\n"));
      return batchFile;
    };
    const readyRows = ["W-001", "W-002", "W-003"].map((id) => [
      'kind = "backlog"', `id = "${id}"`, 'to = "ready"',
    ]);

    // Every rejection below must leave the canonical tree byte-identical: all-or-nothing
    // is structural (no row is written until every row has planned), not compensating.
    const assertRejected = (rows: string[][], message: string, code = 1): void => {
      const before = controlTreeBytes(control);
      const rejected = runCli([
        "transition-batch", "--file", writeBatch(rows),
        "--session", "cs_batch", "--expect-control-revision", revision,
        "--project", root, "--pm-id", "pm1", "--format", "json",
      ], root);
      expect(rejected.code).toBe(code);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain(message);
      expect(controlTreeBytes(control)).toEqual(before);
    };

    // Per-row edge table (STATE_MATRIX): triage -> active is legal, ready -> triage is not.
    assertRejected(
      [...readyRows.slice(0, 2), ['kind = "backlog"', 'id = "W-004"', 'to = "triage"']],
      "batch row 3 (backlog:W-004): backlog transition ready -> triage is not allowed",
    );
    // Per-row reason requirement.
    assertRejected(
      [...readyRows.slice(0, 2), ['kind = "backlog"', 'id = "W-004"', 'to = "deferred"']],
      "batch row 3 (backlog:W-004): deferred reason is required",
    );
    // Per-row activation requirement: --checkpoint has no batch-only bypass.
    assertRejected(
      [...readyRows.slice(0, 2), ['kind = "backlog"', 'id = "W-004"', 'to = "active"']],
      "batch row 3 (backlog:W-004): --checkpoint is required",
      2,
    );
    // Per-row existence check.
    assertRejected(
      [...readyRows, ['kind = "backlog"', 'id = "W-404"', 'to = "ready"']],
      "batch row 4 (backlog:W-404): backlog does not exist: W-404",
    );
    // Terminal transitions keep routing through the atomic terminal+archive plan.
    assertRejected(
      [...readyRows.slice(0, 2), ['kind = "backlog"', 'id = "W-004"', 'to = "done"']],
      "batch row 3 (backlog:W-004): terminal backlog transition must use the atomic terminal+archive plan",
    );
    // Two rows aimed at the same record are a batch-authoring mistake, not a merge.
    assertRejected([...readyRows, readyRows[0]!], "duplicate transition target within batch: backlog:W-001", 2);
    // File grammar mirrors backlog create-batch.
    assertRejected([['kind = "backlog"', 'id = "W-001"', 'to = "ready"', 'unknown_key = "x"']], 'batch row 1 has unknown key: "unknown_key"', 2);
    assertRejected([['kind = "backlog"', 'id = "W-001"']], "batch row 1 requires a non-empty to", 2);
    assertRejected([['kind = "note"', 'id = "N-001"', 'to = "ready"']], "unsupported transition kind: note", 2);
    assertRejected([['kind = "decision"', 'id = "DEC-900"', 'to = "accepted"', 'checkpoint = "CP-001"']], "transition decision does not accept --checkpoint", 2);

    // The batch that succeeds: three rows, one transaction, one control revision bump.
    const applied = controlOk(root, [
      "transition-batch", "--file", writeBatch(readyRows),
      "--session", "cs_batch", "--expect-control-revision", revision,
    ]);
    expect(applied.status).toBe("committed");
    // One transaction carrying all three rows: three semantic changes, one revision bump.
    expect((applied.changes as Array<{ path: string; operation: string }>).map((change) => change.path).sort()).toEqual([
      "backlog/open/W-001-runtime.md",
      "backlog/open/W-002-runtime.md",
      "backlog/open/W-003-runtime.md",
    ]);
    expect(String(applied.control_revision_before)).toBe(revision);
    expect(String(applied.control_revision_after)).not.toBe(revision);
    for (const id of ["W-001", "W-002", "W-003"]) {
      const source = readFileSync(backlogPath(id), "utf8");
      expect(source).toContain('status = "ready"');
      expect(source).toContain('status_changed = "2026-07-26T12:00:00.000Z"');
    }
    // A row outside the batch is not rewritten by it.
    expect(readFileSync(backlogPath("W-004"), "utf8")).toBe(untouchedBefore);
    revision = String(applied.control_revision_after);

    // A stale precondition rejects the whole batch, exactly like a single transition.
    const staleRows = [['kind = "backlog"', 'id = "W-004"', 'to = "deferred"', 'reason = "batched deferral"']];
    const beforeStale = controlTreeBytes(control);
    const stale = runCli([
      "transition-batch", "--file", writeBatch(staleRows),
      "--session", "cs_batch", "--expect-control-revision", String((opened.session as Record<string, unknown>).base_control_revision),
      "--project", root, "--pm-id", "pm1", "--format", "json",
    ], root);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("expected control revision");
    expect(controlTreeBytes(control)).toEqual(beforeStale);

    // Mixed kinds in one batch, with --dry-run leaving the tree untouched.
    const mixedRows = [
      ['kind = "backlog"', 'id = "W-004"', 'to = "deferred"', 'reason = "batched deferral"'],
      ['kind = "checkpoint"', 'id = "CP-001"', 'to = "paused"'],
    ];
    const beforeDryRun = controlTreeBytes(control);
    const dryRun = controlOk(root, [
      "transition-batch", "--file", writeBatch(mixedRows), "--dry-run",
      "--session", "cs_batch", "--expect-control-revision", revision,
    ]);
    expect(dryRun.status).toBe("dry_run");
    expect(controlTreeBytes(control)).toEqual(beforeDryRun);
    const mixed = controlOk(root, [
      "transition-batch", "--file", writeBatch(mixedRows),
      "--session", "cs_batch", "--expect-control-revision", revision,
    ]);
    expect(String(mixed.control_revision_after)).not.toBe(revision);
    expect(readFileSync(backlogPath("W-004"), "utf8")).toContain('status = "deferred"');
    expect(readFileSync(join(control, "checkpoints", "active", "CP-001-runtime.md"), "utf8")).toContain('status = "paused"');
    revision = String(mixed.control_revision_after);

    // Activation writes three files (Backlog, Checkpoint, current.md), so two activation
    // rows in one batch both derive current.md from its pre-batch state and the second
    // would silently drop the first. Every row plans against the same loaded model, so
    // this is caught by write-path ownership rather than committed last-writer-wins.
    for (const [id, title] of [["CP-002", "Second"], ["CP-003", "Third"]]) {
      writeFileSync(join(control, "checkpoints", "active", `${id}-batch.md`), [
        "+++",
        "schema_version = 3",
        'kind = "garelier_checkpoint"',
        `id = "${id}"`,
        'status = "paused"',
        'created = "2026-07-22T10:00:00.000Z"',
        'updated = "2026-07-22T11:00:00.000Z"',
        "backlog = []",
        'branch = "codex/w347-transition-batch"',
        `head = "${"2".repeat(40)}"`,
        'working_tree = "clean"',
        "+++",
        `# ${id}: ${title} batch checkpoint`,
        "",
        "## Current position",
        "",
        "### Last completed",
        "",
        "Prepared for activation.",
        "",
        "### Exact next action",
        "",
        `Activate ${id}.`,
        "",
        "## Blockers / external decisions",
        "",
        "- None.",
        "",
        "## Read first on resume",
        "",
        "- `backlog:W-001`",
        "",
        "## Resume verification",
        "",
        "Run the integration test.",
        "",
      ].join("\n"));
    }
    revision = loadPlanGraphModel(control).revision;
    assertRejected([
      ['kind = "backlog"', 'id = "W-001"', 'to = "active"', 'checkpoint = "CP-002"'],
      ['kind = "backlog"', 'id = "W-002"', 'to = "active"', 'checkpoint = "CP-003"'],
    ], "batch rows backlog:W-001 and backlog:W-002 both write project_dashboard/current.md; "
      + "a batch carries at most one Backlog activation because each one rewrites "
      + "project_dashboard/current.md — keep one activation in this batch and run the rest "
      + "as separate transitions", 2);

    // One activation alongside plain rows is fine — the write paths are disjoint.
    const activated = controlOk(root, [
      "transition-batch", "--file", writeBatch([
        ['kind = "backlog"', 'id = "W-001"', 'to = "active"', 'checkpoint = "CP-002"'],
        ['kind = "backlog"', 'id = "W-002"', 'to = "deferred"', 'reason = "batched with an activation"'],
      ]),
      "--session", "cs_batch", "--expect-control-revision", revision,
    ]);
    expect((activated.changes as Array<{ path: string }>).map((change) => change.path).sort()).toEqual([
      "backlog/open/W-001-runtime.md",
      "backlog/open/W-002-runtime.md",
      "checkpoints/active/CP-002-batch.md",
      "project_dashboard/current.md",
    ]);
    expect(readFileSync(backlogPath("W-001"), "utf8")).toContain('status = "active"');
    expect(readFileSync(backlogPath("W-002"), "utf8")).toContain('status = "deferred"');
    expect(readFileSync(join(control, "project_dashboard", "current.md"), "utf8")).toContain("checkpoint:CP-002");
  }, 15_000);

  test("commits lifecycle transactions atomically while preserving generation binding", () => {
    setSystemTime(now());
    const root = fixture();
    const control = join(root, "__garelier", "pm1", "control");
    const result = runControlFilePlanTransaction({
      targetRoot: root,
      pmId: "pm1",
      agent: "test",
      sessionId: "cs_v3",
      command: "activate",
      callbacks: callbacks(),
      now,
      mutate: ({ state, now: at }) => activation(state, at),
    });
    expect(result.status).toBe("committed");
    expect(readJson<RecordFixture>(join(control, "backlog", "open", "W-205-control.md")).status).toBe("active");
    expect(readJson<CurrentFixture>(join(control, "project_dashboard", "current.md")).active).toEqual(["CP-205"]);
    const generation = readJson<Record<string, unknown>>(join(root, "__garelier", "pm1", "runtime", "control", "generation.json"));
    expect(generation).toMatchObject({
      schema_version: 2,
      control_schema_version: 3,
      storage: "plan_graph_markdown",
      state: "stable",
    });

    // I0017 / W-600: a transaction may target a project outside the launcher's
    // cwd/default fence. Its own sibling staging directory must still be
    // removed on compensation, without sweeping an unrelated PM-root sibling.
    const cleanupRoot = fixture();
    const cleanupPmRoot = join(cleanupRoot, "__garelier", "pm1");
    const unrelatedSibling = join(cleanupPmRoot, "unrelated-sibling");
    const isolatedCwd = join(cleanupRoot, "isolated-session", "cwd");
    mkdirSync(unrelatedSibling, { recursive: true });
    mkdirSync(isolatedCwd, { recursive: true });
    writeFileSync(join(unrelatedSibling, "sentinel.txt"), "preserve\n");
    const originalCwd = process.cwd();
    const originalTemp = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
      GARELIER_PATH_GUARD_ROOTS: process.env.GARELIER_PATH_GUARD_ROOTS,
    };
    try {
      process.chdir(isolatedCwd);
      process.env.TEMP = isolatedCwd;
      process.env.TMP = isolatedCwd;
      process.env.TMPDIR = isolatedCwd;
      process.env.GARELIER_PATH_GUARD_ROOTS = JSON.stringify([
        join(cleanupRoot, "__garelier", "pm1", "runtime", "control"),
      ]);
      expect(() => runControlFilePlanTransaction({
        targetRoot: cleanupRoot,
        pmId: "pm1",
        agent: "test",
        sessionId: "cs_cleanup",
        command: "cleanup-counterfactual",
        callbacks: callbacks(),
        now,
        mutate: ({ state, now: at }) => activation(state, at),
        hooks: { afterStageWrite: () => { throw new Error("owned transaction cleanup counterfactual"); } },
      })).toThrow("owned transaction cleanup counterfactual");
      expect(() => removeTreeSync(unrelatedSibling)).toThrow("path_guard: delete denied outside fence roots");
    } finally {
      process.chdir(originalCwd);
      for (const [key, value] of Object.entries(originalTemp)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(readdirSync(cleanupPmRoot).filter((entry) => entry.startsWith(".control.txn-"))).toEqual([]);
    expect(readFileSync(join(unrelatedSibling, "sentinel.txt"), "utf8")).toBe("preserve\n");

    const artifactRoot = mkdtempSync(join(tmpdir(), "garelier-control-v3-artifact-lifecycle-"));
    roots.push(artifactRoot);
    const artifactControl = writeV3Fixture(artifactRoot, 2);
    mkdirSync(join(artifactControl, "decisions"), { recursive: true });
    mkdirSync(join(artifactControl, "blueprints"), { recursive: true });
    const artifactDocument = (frontmatter: string[], body: string): string =>
      `+++\n${frontmatter.join("\n")}\n+++\n${body}`;
    const decisionReadmePath = join(artifactControl, "decisions", "README.md");
    const blueprintReadmePath = join(artifactControl, "blueprints", "README.md");
    writeFileSync(decisionReadmePath, artifactDocument([
      "schema_version = 3",
      'kind = "garelier_decision"',
      'id = "README"',
      'title = "Decision README"',
      'status = "proposed"',
      'created = "1970-01-01T00:00:00.000Z"',
      'updated = "1970-01-01T00:00:00.000Z"',
      "related = []",
      "supersedes = []",
    ], "# Decision README\n"));
    writeFileSync(blueprintReadmePath, artifactDocument([
      "schema_version = 3",
      'kind = "garelier_blueprint"',
      'slug = "README"',
      'title = "Blueprint README"',
      'status = "draft"',
      'created = "1970-01-01T00:00:00.000Z"',
      'updated = "1970-01-01T00:00:00.000Z"',
      "related = []",
      "backlog_ids = []",
      "decision_ids = []",
      "acceptance_ids = []",
    ], "# Blueprint README\n"));
    const decisionPath = join(artifactControl, "decisions", "DEC-900-lifecycle.md");
    const blueprintPath = join(artifactControl, "blueprints", "artifact-lifecycle.md");
    writeFileSync(decisionPath, artifactDocument([
      "schema_version = 3",
      'kind = "garelier_decision"',
      'id = "DEC-900"',
      'status = "proposed"',
      'created = "2026-07-22T10:00:00.000Z"',
      'updated = "2026-07-22T11:00:00.000Z"',
      'related = ["backlog:W-001"]',
    ], "# DEC-900: Lifecycle\n\n## Context\n\nC\n\n## Decision\n\nD\n\n## Consequences\n\nE\n"));
    writeFileSync(blueprintPath, artifactDocument([
      "schema_version = 3",
      'kind = "garelier_blueprint"',
      'slug = "artifact-lifecycle"',
      'status = "draft"',
      'created = "2026-07-22T10:00:00.000Z"',
      'updated = "2026-07-22T11:00:00.000Z"',
      'related = ["backlog:W-001"]',
    ], "# Blueprint: Artifact lifecycle\n\n## Goal\n\nG\n\n## Acceptance criteria\n\n- A\n"));
    const reportRelatedBacklogPath = join(artifactControl, "backlog", "open", "W-002-runtime.md");
    writeFileSync(
      reportRelatedBacklogPath,
      readFileSync(reportRelatedBacklogPath, "utf8").replace(
        'status = "ready"',
        'status = "ready"\nrelated = ["report:reports/W-002/report.md"]',
      ),
    );
    mkdirSync(join(artifactControl, "reports", "W-002"), { recursive: true });
    writeFileSync(join(artifactControl, "reports", "W-002", "report.md"), "# Existing report\n");
    const crossKindModel = loadPlanGraphModel(artifactControl);
    expect(crossKindModel.findings.filter((finding) => finding.code === "artifact-identity-case-collision")).toEqual([]);

    // W-708 AC-4 (a): `related` is the one general cross-kind link, and it may
    // name a row this control graph does not own (another repository's `W-NNN`).
    // An unresolvable target is a WARNING, so it no longer refuses session-open
    // for every seat in the namespace.
    const foreignRelatedSource = readFileSync(reportRelatedBacklogPath, "utf8");
    writeFileSync(reportRelatedBacklogPath, foreignRelatedSource.replace(
      'related = ["report:reports/W-002/report.md"]',
      'related = ["W-077"]',
    ));
    const foreignRelated = loadPlanGraphModel(artifactControl).findings
      .filter((finding) => finding.entity === "backlog:W-002" && finding.message.includes("W-077"));
    expect(foreignRelated).toHaveLength(1);
    expect(foreignRelated[0]?.severity).toBe("warning");
    expect(foreignRelated[0]?.code).toBe("backlog-related-target-missing");
    expect(controlOk(artifactRoot, ["session-open", "--agent", "codex", "--session-id", "cs_w708_related"])
      .session).toBeDefined();

    // W-708 AC-4 (b): the backlog-scoped structural fields describe THIS graph,
    // so the same foreign id in `depends_on` is still an error and still stops
    // session-open.
    writeFileSync(reportRelatedBacklogPath, foreignRelatedSource.replace(
      'related = ["report:reports/W-002/report.md"]',
      'depends_on = ["W-077"]',
    ));
    const foreignDependsOn = loadPlanGraphModel(artifactControl).findings
      .filter((finding) => finding.entity === "backlog:W-002" && finding.message.includes("W-077"));
    expect(foreignDependsOn).toHaveLength(1);
    expect(foreignDependsOn[0]?.severity).toBe("error");
    expect(foreignDependsOn[0]?.code).toBe("backlog-target-missing");
    const refusedOpen = runCli([
      "session-open", "--agent", "codex", "--session-id", "cs_w708_depends",
      "--project", artifactRoot, "--pm-id", "pm1", "--format", "json",
    ], artifactRoot);
    expect(refusedOpen.code).not.toBe(0);
    expect(refusedOpen.stderr).toContain("backlog-target-missing");
    writeFileSync(reportRelatedBacklogPath, foreignRelatedSource);
    process.stdout.write("W708_AC4 related_foreign=warning+session_open_ok depends_on_foreign=error+session_open_refused\n");
    expect(planArtifactCreate({
      model: crossKindModel,
      kind: "blueprint",
      id: "DEC-900",
      metadata: { title: "Cross-kind identity", decisionIds: ["DEC-900"] },
      body: "# Cross-kind identity\n",
      now: now().toISOString(),
    }).writes[0]?.path).toBe("blueprints/DEC-900.md");
    expect(planArtifactUpdate({
      model: crossKindModel,
      record: crossKindModel.decisions.get("README")!,
      now: now().toISOString(),
    }).writes).toEqual([]);
    const sameKindCasePath = join(artifactControl, "blueprints", "readme-case.md");
    writeFileSync(sameKindCasePath, artifactDocument([
      "schema_version = 3",
      'kind = "garelier_blueprint"',
      'slug = "readme"',
      'title = "Case-folded Blueprint"',
      'status = "draft"',
      'created = "1970-01-01T00:00:00.000Z"',
      'updated = "1970-01-01T00:00:00.000Z"',
      "related = []",
      "backlog_ids = []",
      "decision_ids = []",
      "acceptance_ids = []",
    ], "# Case-folded Blueprint\n"));
    const sameKindCaseFindings = loadPlanGraphModel(artifactControl).findings.filter((finding) =>
      finding.code === "artifact-identity-case-collision"
    );
    expect(sameKindCaseFindings).toHaveLength(1);
    expect(sameKindCaseFindings[0]?.entity).toStartWith("blueprint:");
    expect(sameKindCaseFindings[0]?.message).toContain("blueprint:");
    unlinkSync(sameKindCasePath);
    expect(crossKindModel.findings.filter((finding) =>
      finding.code === "backlog-target-missing" && finding.entity === "backlog:W-002"
    )).toEqual([]);
    const opened = controlOk(artifactRoot, ["session-open", "--agent", "codex", "--session-id", "cs_artifact"]);
    const initialRevision = String((opened.session as Record<string, unknown>).base_control_revision);
    const decisionMetadata = join(artifactRoot, "decision-create.json");
    const decisionBody = join(artifactRoot, "decision-create.md");
    writeFileSync(decisionMetadata, JSON.stringify({
      title: "Created Decision",
      related: ["W-001"],
      supersedes: ["decision:DEC-900"],
    }));
    writeFileSync(decisionBody, "# # User-selected heading\n\n## Context\n\nC\n\n## Decision\n\nD\n");
    const createdDecision = controlOk(artifactRoot, [
      "artifact-create", "decision", "--id", "DEC-901",
      "--metadata-file", decisionMetadata, "--body-file", decisionBody,
      "--session", "cs_artifact", "--expect-control-revision", initialRevision,
    ]);
    const createdDecisionPath = join(artifactControl, "decisions", "DEC-901-created-decision.md");
    const createdDecisionSource = readFileSync(createdDecisionPath, "utf8");
    expect(createdDecision.entity_revision_after).toBe(Date.parse("2026-07-26T12:00:00.000Z"));
    expect(createdDecisionSource).toContain('kind = "garelier_decision"');
    expect(createdDecisionSource).toContain('status = "proposed"');
    expect(createdDecisionSource).toContain('related = [ "backlog:W-001" ]');
    expect(createdDecisionSource).toContain('supersedes = [ "decision:DEC-900" ]');
    expect(createdDecisionSource).not.toContain("integrity");
    expect(createdDecisionSource).not.toContain("revision =");

    const blueprintMetadata = join(artifactRoot, "blueprint-create.json");
    const blueprintBody = join(artifactRoot, "blueprint-create.md");
    writeFileSync(blueprintMetadata, JSON.stringify({
      title: "Created Blueprint",
      related: ["decision:DEC-901"],
      backlog_ids: ["W-001"],
      decision_ids: ["DEC-901"],
      acceptance_ids: ["AC-1", "AC-2"],
    }));
    writeFileSync(blueprintBody, "<!--\n# Hidden inside a valid HTML comment\n-->\n<script>\n# Hidden inside raw HTML\n</script>\n<div>\n# Hidden inside block HTML\n</div>\n\n```text\n# Hidden inside a valid fence\n```   \n   # Created Blueprint #\n\n## Goal\n\nG\n\n## Acceptance criteria\n\n- A\n");
    const createdBlueprint = controlOk(artifactRoot, [
      "artifact-create", "blueprint", "--id", "artifact-created",
      "--metadata-file", blueprintMetadata, "--body-file", blueprintBody,
      "--session", "cs_artifact", "--expect-control-revision", String(createdDecision.control_revision_after),
    ]);
    const createdBlueprintPath = join(artifactControl, "blueprints", "artifact-created.md");
    const createdBlueprintSource = readFileSync(createdBlueprintPath, "utf8");
    expect(createdBlueprintSource).toContain('backlog_ids = [ "W-001" ]');
    expect(createdBlueprintSource).toContain('decision_ids = [ "DEC-901" ]');
    expect(createdBlueprintSource).toContain('acceptance_ids = [ "AC-1", "AC-2" ]');
    expect(loadPlanGraphModel(artifactControl).findings.filter((finding) => finding.severity === "error")).toEqual([]);

    const updateMetadata = join(artifactRoot, "decision-update.json");
    const updateBody = join(artifactRoot, "decision-update.md");
    writeFileSync(updateMetadata, JSON.stringify({ title: "Retitled Decision", related: ["blueprint:artifact-created"] }));
    writeFileSync(updateBody, "# Heading does not own identity\n\n## Decision\n\nUpdated\n");
    const updatedDecision = controlOk(artifactRoot, [
      "artifact-update", "decision", "DEC-901",
      "--metadata-file", updateMetadata, "--body-file", updateBody,
      "--session", "cs_artifact", "--expect-control-revision", String(createdBlueprint.control_revision_after),
      "--expect-revision", String(createdDecision.entity_revision_after),
    ]);
    const updatedDecisionSource = readFileSync(createdDecisionPath, "utf8");
    expect(updatedDecision.entity_revision_after).toBe(Date.parse("2026-07-26T12:00:00.001Z"));
    expect(updatedDecisionSource).toContain('title = "Retitled Decision"');
    expect(updatedDecisionSource).toContain('status = "proposed"');
    expect(updatedDecisionSource).toContain('supersedes = [ "decision:DEC-900" ]');
    expect(updatedDecisionSource).toContain("# Heading does not own identity");
    expect(existsSync(join(artifactControl, "decisions", "DEC-901-retitled-decision.md"))).toBeFalse();

    const noOpMetadata = join(artifactRoot, "decision-no-op.json");
    writeFileSync(noOpMetadata, JSON.stringify({ title: "Retitled Decision", related: ["blueprint:artifact-created"] }));
    const noOpDecision = controlOk(artifactRoot, [
      "artifact-update", "decision", "DEC-901", "--metadata-file", noOpMetadata,
      "--session", "cs_artifact", "--expect-control-revision", String(updatedDecision.control_revision_after),
      "--expect-revision", String(updatedDecision.entity_revision_after),
    ]);
    expect(noOpDecision.control_revision_after).toBe(updatedDecision.control_revision_after);
    expect(noOpDecision.entity_revision_after).toBe(updatedDecision.entity_revision_after);
    expect(readFileSync(createdDecisionPath, "utf8")).toBe(updatedDecisionSource);

    const rejectWithoutMutation = (args: string[], message: string): void => {
      const before = controlTreeBytes(artifactControl);
      const result = runCli([
        ...args, "--project", artifactRoot, "--pm-id", "pm1", "--format", "json",
      ], artifactRoot);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(controlTreeBytes(artifactControl)).toEqual(before);
    };
    const currentRevision = String(noOpDecision.control_revision_after);
    rejectWithoutMutation([
      "artifact-update", "decision", "DEC-901", "--metadata-file", noOpMetadata,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
      "--expect-revision", String(Number(updatedDecision.entity_revision_after) - 1),
    ], "expected decision:DEC-901 revision");
    rejectWithoutMutation([
      "artifact-update", "decision", "DEC-901", "--metadata-file", noOpMetadata,
      "--session", "cs_artifact", "--expect-control-revision", `sha256:${"0".repeat(64)}`,
      "--expect-revision", String(updatedDecision.entity_revision_after),
    ], "expected control revision");
    const hiddenUpdateOwner = join(artifactControl, "decisions", "DEC-901-shadow.MD");
    writeFileSync(hiddenUpdateOwner, "loader-invisible duplicate Decision owner\n");
    rejectWithoutMutation([
      "artifact-update", "decision", "DEC-901", "--metadata-file", noOpMetadata,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
      "--expect-revision", String(updatedDecision.entity_revision_after),
    ], "identity has a hidden duplicate owner: decisions/DEC-901-shadow.MD");
    unlinkSync(hiddenUpdateOwner);

    const unresolvedMetadata = join(artifactRoot, "unresolved.json");
    writeFileSync(unresolvedMetadata, JSON.stringify({ related: ["report:missing"] }));
    rejectWithoutMutation([
      "artifact-update", "decision", "DEC-901", "--metadata-file", unresolvedMetadata,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
      "--expect-revision", String(updatedDecision.entity_revision_after),
    ], "does not resolve uniquely");
    const caseFoldedOwner = join(artifactControl, "blueprints", "case-folded-owner.MD");
    writeFileSync(caseFoldedOwner, "occupied by a noncanonical-cased owner path\n");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "case-folded-owner",
      "--metadata-file", blueprintMetadata, "--body-file", blueprintBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "owner path already exists or case-collides: blueprints/case-folded-owner.MD");
    const caseFoldedDecisionIdentity = join(artifactControl, "decisions", "DEC-902-old-title.MD");
    writeFileSync(caseFoldedDecisionIdentity, "occupied by a noncanonical-cased Decision owner\n");
    rejectWithoutMutation([
      "artifact-create", "decision", "--id", "DEC-902",
      "--metadata-file", decisionMetadata, "--body-file", decisionBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "identity already exists or case-collides: decisions/DEC-902-old-title.MD");
    const aliasModel = loadPlanGraphModel(artifactControl);
    const artifactAlias = join(artifactControl, "blueprints", "reparse-alias.MD");
    symlinkSync(createdBlueprintPath, artifactAlias, "file");
    expect(() => planArtifactCreate({
      model: aliasModel,
      kind: "blueprint",
      id: "alias-scan",
      metadata: { title: "Alias Scan" },
      body: readFileSync(blueprintBody, "utf8"),
      now: now().toISOString(),
    })).toThrow("artifact owner directory contains a symlink, junction, or reparse alias");
    unlinkSync(artifactAlias);

    const duplicateMetadata = join(artifactRoot, "duplicate.json");
    writeFileSync(duplicateMetadata, '{"title":"One","title":"Two"}');
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "duplicate",
      "--metadata-file", duplicateMetadata, "--body-file", blueprintBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "duplicate JSON key");
    const forbiddenMetadata = join(artifactRoot, "forbidden.json");
    writeFileSync(forbiddenMetadata, JSON.stringify({ title: "Forbidden", status: "active" }));
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "forbidden",
      "--metadata-file", forbiddenMetadata, "--body-file", blueprintBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "forbidden key");

    const invalidBody = join(artifactRoot, "invalid-body.md");
    writeFileSync(invalidBody, "  +++  \ntitle = \"injected\"\n+++\n# Body\n");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "frontmatter",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "must not contain TOML front matter");
    writeFileSync(invalidBody, "# One\n\n# Two\n");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "headings",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "exactly one non-empty H1");
    for (const [id, body] of [["closing-hash", "# #\n"], ["closing-hashes", "# ###  \n"]]) {
      writeFileSync(invalidBody, body);
      rejectWithoutMutation([
        "artifact-create", "blueprint", "--id", id,
        "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
        "--session", "cs_artifact", "--expect-control-revision", currentRevision,
      ], "exactly one non-empty H1");
    }
    writeFileSync(invalidBody, "```text\n```not-a-close\n# Hidden inside the fence\n```\n");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "fenced-heading",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "exactly one non-empty H1");
    for (const [id, body] of [
      ["html-raw", "<style>\n# Hidden inside raw HTML\n</style>\n"],
      ["html-comment", "<!--\n# Hidden inside an HTML comment\n-->\n"],
      ["html-processing", "<?target\n# Hidden inside a processing instruction\n?>\n"],
      ["html-declaration", "<!DOCTYPE\n# Hidden inside a declaration\n>\n"],
      ["html-cdata", "<![CDATA[\n# Hidden inside CDATA\n]]>\n"],
      ["html-block-tag", "<div>\n# Hidden inside block HTML\n</div>\n"],
    ]) {
      writeFileSync(invalidBody, body);
      rejectWithoutMutation([
        "artifact-create", "blueprint", "--id", id,
        "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
        "--session", "cs_artifact", "--expect-control-revision", currentRevision,
      ], "exactly one non-empty H1");
    }
    writeFileSync(invalidBody, "---\n<custom-element>\n# Hidden\n</custom-element>\n");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "html-type-7",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "must not contain standalone CommonMark type-7 HTML tags");
    writeFileSync(invalidBody, "# Visible heading\n\n<!-- malformed close stays fail-closed\n--!>\n");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "html-unclosed",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "unclosed CommonMark HTML block");
    writeFileSync(invalidBody, Buffer.from([0xff, 0xfe, 0xfd]));
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "utf8",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "must be valid UTF-8");
    writeFileSync(invalidBody, "# Body\n\0");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "nul",
      "--metadata-file", blueprintMetadata, "--body-file", invalidBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "must not contain NUL bytes");

    const oversizedMetadata = join(artifactRoot, "oversized.json");
    writeFileSync(oversizedMetadata, "x".repeat(64 * 1024 + 1));
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "oversized",
      "--metadata-file", oversizedMetadata, "--body-file", blueprintBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "exceeds 65536 bytes");
    const linkedMetadata = join(artifactRoot, "linked.json");
    symlinkSync(blueprintMetadata, linkedMetadata, "file");
    rejectWithoutMutation([
      "artifact-create", "blueprint", "--id", "linked",
      "--metadata-file", linkedMetadata, "--body-file", blueprintBody,
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ], "must not traverse a symlink, junction, or reparse point");

    const beforeRollback = controlTreeBytes(artifactControl);
    const rollbackModel = loadPlanGraphModel(artifactControl);
    const rollbackRecord = rollbackModel.decisions.get("DEC-901")!;
    expect(() => runControlFilePlanTransaction({
      targetRoot: artifactRoot,
      pmId: "pm1",
      agent: "codex",
      sessionId: "cs_artifact",
      command: "artifact-update",
      callbacks: planGraphTransactionCallbacks,
      expectedControlRevision: rollbackModel.revision,
      expectedEntityRevisions: { "decision:DEC-901": Date.parse(rollbackRecord.updated) },
      now,
      mutate: ({ state, now: at }) => planArtifactUpdate({
        model: state,
        record: state.decisions.get("DEC-901")!,
        metadata: { title: "Must Roll Back" },
        now: at,
      }),
      hooks: { afterAtomicReplace: () => { throw new Error("artifact replace crash"); } },
    })).toThrow("rolled back");
    expect(controlTreeBytes(artifactControl)).toEqual(beforeRollback);

    let transitioned = controlOk(artifactRoot, [
      "transition", "decision", "DEC-900", "--to", "accepted",
      "--session", "cs_artifact", "--expect-control-revision", currentRevision,
    ]);
    expect(readFileSync(decisionPath, "utf8")).toContain('status = "accepted"');
    expect(readFileSync(decisionPath, "utf8")).toContain('status_changed = "2026-07-26T12:00:00.000Z"');
    const afterDecision = String(transitioned.control_revision_after);
    transitioned = controlOk(artifactRoot, [
      "transition", "blueprint", "artifact-lifecycle", "--to", "active",
      "--session", "cs_artifact", "--expect-control-revision", afterDecision,
    ]);
    expect(readFileSync(blueprintPath, "utf8")).toContain('status = "active"');
    const activeBlueprintSource = readFileSync(blueprintPath, "utf8");
    const acceptedSource = readFileSync(decisionPath, "utf8");
    const stale = runCli([
      "transition", "decision", "DEC-900", "--to", "superseded", "--reason", "replaced",
      "--session", "cs_artifact", "--expect-control-revision", initialRevision,
      "--project", artifactRoot, "--pm-id", "pm1", "--format", "json",
    ], artifactRoot);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("expected control revision");
    expect(readFileSync(decisionPath, "utf8")).toBe(acceptedSource);
    const illegal = runCli([
      "transition", "decision", "DEC-900", "--to", "rejected", "--reason", "invalid",
      "--session", "cs_artifact", "--expect-control-revision", String(transitioned.control_revision_after),
      "--project", artifactRoot, "--pm-id", "pm1", "--format", "json",
    ], artifactRoot);
    expect(illegal.code).toBe(1);
    expect(illegal.stderr).toContain("decision transition accepted -> rejected is not allowed");
    expect(readFileSync(decisionPath, "utf8")).toBe(acceptedSource);
    const invalidDecisionArchiveSource = acceptedSource.replace('status = "accepted"', 'status = "archived"');
    writeFileSync(decisionPath, invalidDecisionArchiveSource);
    const invalidDecisionArchive = runCli([
      "transition", "decision", "DEC-900", "--to", "superseded", "--reason", "replaced",
      "--session", "cs_artifact", "--expect-control-revision", String(transitioned.control_revision_after),
      "--project", artifactRoot, "--pm-id", "pm1", "--format", "json",
    ], artifactRoot);
    expect(invalidDecisionArchive.code).toBe(1);
    expect(invalidDecisionArchive.stderr).toContain("status");
    expect(invalidDecisionArchive.stderr).toContain("must be one of: proposed, accepted, rejected, superseded");
    expect(readFileSync(decisionPath, "utf8")).toBe(invalidDecisionArchiveSource);
    writeFileSync(decisionPath, acceptedSource);
    const missingArchivedSource = activeBlueprintSource
      .replace('status = "active"', 'status = "archived"')
      .replace('status_changed = "2026-07-26T12:00:00.000Z"', [
        'status_changed = "2026-07-26T12:00:00.000Z"',
        'closed = "2026-07-26T12:00:00.000Z"',
      ].join("\n"));
    writeFileSync(blueprintPath, missingArchivedSource);
    const missingArchived = runCli([
      "transition", "decision", "DEC-900", "--to", "superseded", "--reason", "replaced",
      "--session", "cs_artifact", "--expect-control-revision", loadPlanGraphModel(artifactControl).revision,
      "--project", artifactRoot, "--pm-id", "pm1", "--format", "json",
    ], artifactRoot);
    expect(missingArchived.code).toBe(1);
    expect(missingArchived.stderr).toContain("lifecycle-archive-timestamp-missing");
    expect(readFileSync(blueprintPath, "utf8")).toBe(missingArchivedSource);
    expect(readFileSync(decisionPath, "utf8")).toBe(acceptedSource);

  }, 15_000);

  test("stale precondition and mid-replace failure leave all three canonical files unchanged", () => {
    const root = fixture();
    const control = join(root, "__garelier", "pm1", "control");
    const before = controlTreeSourceDigest(control);
    expect(() => runControlFilePlanTransaction({
      targetRoot: root,
      pmId: "pm1",
      agent: "test",
      sessionId: "cs_stale",
      command: "activate",
      callbacks: callbacks(),
      expectedControlRevision: `sha256:${"0".repeat(64)}`,
      now,
      mutate: ({ state, now: at }) => activation(state, at),
    })).toThrow("expected control revision");
    expect(() => runControlFilePlanTransaction({
      targetRoot: root,
      pmId: "pm1",
      agent: "test",
      sessionId: "cs_crash",
      command: "activate",
      callbacks: callbacks(),
      now,
      mutate: ({ state, now: at }) => activation(state, at),
      hooks: { afterAtomicReplace: (_path, index) => { if (index === 0) throw new Error("replace crash"); } },
    })).toThrow("rolled back");
    expect(controlTreeSourceDigest(control)).toBe(before);
    expect(existsSync(join(control, "checkpoints", "active", "CP-205-control.md"))).toBeFalse();
    expect(readControlGeneration(join(root, "__garelier", "pm1", "runtime", "control"), 16, control) % 2).toBe(0);

    const renewalRoot = mkdtempSync(join(tmpdir(), "garelier-control-v3-renewal-rollback-"));
    roots.push(renewalRoot);
    writeV3Fixture(renewalRoot, 2);
    const renewalRoots = garelierControlRoots(renewalRoot, renewalRoot, "pm1");
    openControlSession({
      targetRoot: renewalRoot,
      controlRoot: renewalRoots.controlRoot,
      runtimeRoot: renewalRoots.runtimeRoot,
      pmId: "pm1",
      sessionId: "cs_renewal",
      agent: "codex",
      cwd: renewalRoot,
      runtimeCallbacks: planGraphRuntimeCallbacks,
    });
    const expiredAt = new Date("2020-01-01T00:00:00.000Z");
    claimWork({
      targetRoot: renewalRoot,
      controlRoot: renewalRoots.controlRoot,
      runtimeRoot: renewalRoots.runtimeRoot,
      pmId: "pm1",
      workId: "W-001",
      sessionId: "cs_renewal",
      touches: ["skills/**"],
      now: () => expiredAt,
      runtimeCallbacks: planGraphRuntimeCallbacks,
    });
    const renewalNamespace = resolveControlNamespace(renewalRoots);
    const renewalClaimBefore = readControlClaim(renewalNamespace, "W-001");
    const renewalSessionBefore = readControlSession(renewalNamespace, "cs_renewal");
    const renewalControlBefore = controlTreeBytes(renewalRoots.controlRoot);
    const renewalBacklogBefore = loadPlanGraphModel(renewalRoots.controlRoot).backlog.get("W-001")!.source;
    const renewalLock = acquireNamespaceLock(renewalNamespace, {
      sessionId: "cs_renewal",
      operation: "test-renewal",
      at: now().toISOString(),
    });
    try {
      expect(() => renewDispatchClaimWithAudit({
        roots: renewalRoots,
        workId: "W-001",
        sessionId: "cs_renewal",
        touches: ["skills/**"],
        now: now(),
        namespaceLock: renewalLock,
        source: "dispatch-bind",
        reason: "same-session dispatch continuation",
        testHooks: { afterStageWrite: () => { throw new Error("renewal transaction failure"); } },
      })).toThrow("renewal transaction failure");
    } finally {
      renewalLock.release();
    }
    expect(controlTreeBytes(renewalRoots.controlRoot)).toEqual(renewalControlBefore);
    expect(readControlClaim(renewalNamespace, "W-001")).toEqual(renewalClaimBefore);
    expect(readControlSession(renewalNamespace, "cs_renewal")).toEqual(renewalSessionBefore);

    const runtimeFailureLock = acquireNamespaceLock(renewalNamespace, {
      sessionId: "cs_renewal",
      operation: "test-renewal-runtime-failure",
      at: now().toISOString(),
    });
    try {
      expect(() => renewDispatchClaimWithAudit({
        roots: renewalRoots,
        workId: "W-001",
        sessionId: "cs_renewal",
        touches: ["skills/**"],
        now: now(),
        namespaceLock: runtimeFailureLock,
        source: "dispatch-bind",
        reason: "same-session dispatch continuation",
        testHooks: { afterRuntimeClaimWrite: () => { throw new Error("renewal runtime failure"); } },
      })).toThrow("renewal runtime failure");
    } finally {
      runtimeFailureLock.release();
    }
    expect(readControlClaim(renewalNamespace, "W-001")).toEqual(renewalClaimBefore);
    expect(readControlSession(renewalNamespace, "cs_renewal")).toEqual(renewalSessionBefore);
    const authorizationDir = join(renewalRoots.controlRoot, "reports", "claim_renewals", "W-001");
    const authorizationPath = join(authorizationDir, readdirSync(authorizationDir)[0]!);
    const authorization = JSON.parse(readFileSync(authorizationPath, "utf8"));
    expect(authorization).toMatchObject({
      kind: "claim_renewal_authorization",
      authorization_status: "authorized",
      work_id: "W-001",
      session_id: "cs_renewal",
    });
    expect(authorization.renewed_expires_at).toBeUndefined();
    expect(loadPlanGraphModel(renewalRoots.controlRoot).backlog.get("W-001")!.source).toBe(renewalBacklogBefore);
  });

  test("recovers an exact schema-3 after-snapshot through the canonical parser", () => {
    const root = fixture();
    const paths = resolveControlNamespace({ targetRoot: root, pmId: "pm1" });
    const staging = mkdtempSync(join(paths.pmRoot, ".control.txn-v3-recovery-"));
    cpSync(paths.controlRoot, staging, { recursive: true });
    const beforeDigest = controlTreeSourceDigest(paths.controlRoot);
    const state = callbacks().load({
      targetRoot: root,
      pmId: "pm1",
      controlRoot: staging,
      runtimeRoot: paths.runtimeRoot,
      now: now(),
    }).state;
    const plan = activation(state, now().toISOString());
    const changes = plan.writes.map((write) => {
      const canonical = join(paths.controlRoot, write.path);
      const staged = join(staging, write.path);
      const before = existsSync(canonical) ? sha256(readFileSync(canonical)) : null;
      if (write.source === null) rmSync(staged);
      else {
        mkdirSync(join(staged, ".."), { recursive: true });
        writeFileSync(staged, write.source);
      }
      const after = write.source === null ? null : sha256(write.source);
      return { path: write.path, operation: before === null ? "create" as const : after === null ? "delete" as const : "update" as const, before, after };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const afterDigest = controlTreeSourceDigest(staging);
    const lock = acquireNamespaceLock(paths, { sessionId: "cs_crashed", operation: "activate", at: now().toISOString() });
    writeGenerationRecoveryJournal({
      paths,
      pmId: "pm1",
      lock,
      generation: 3,
      operation: "activate",
      sessionId: "cs_crashed",
      at: now().toISOString(),
      stagingRoot: staging,
      beforeRevision: beforeDigest,
      beforeSourceDigest: beforeDigest,
      afterRevision: afterDigest,
      afterSourceDigest: afterDigest,
      changes,
      controlBinding: { controlSchemaVersion: 3, storage: "plan_graph_markdown" },
      sourceDigestKind: "canonical_tree_v1",
    });
    beginControlGeneration(paths, { sessionId: "cs_crashed", operation: "activate", at: now().toISOString() });
    for (const change of changes) {
      const target = join(paths.controlRoot, change.path);
      const source = join(staging, change.path);
      if (change.operation === "delete") rmSync(target);
      else {
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, readFileSync(source));
      }
    }
    const token = lock.token;
    lock.release();
    mkdirSync(join(paths.runtimeRoot, "locks"), { recursive: true });
    writeFileSync(join(paths.runtimeRoot, "locks", "namespace.lock"), JSON.stringify({
      token,
      session_id: "cs_crashed",
      operation: "activate",
      acquired_at: now().toISOString(),
      pid: 2147483647,
      hostname: hostname(),
    }));
    const recovery = planGenerationRecovery({ targetRoot: root, pmId: "pm1" });
    expect(recovery).toMatchObject({
      canonical_state: "after",
      action: "settle_committed",
      control_schema_version: 3,
      storage: "plan_graph_markdown",
    });
    applyGenerationRecovery({
      targetRoot: root,
      pmId: "pm1",
      expectedPlanDigest: recovery.plan_digest,
      expectedGeneration: recovery.generation,
      sessionId: "cs_recover",
    });
    expect(readControlGeneration(paths.runtimeRoot, 16, paths.controlRoot)).toBe(4);
    expect(controlTreeSourceDigest(paths.controlRoot)).toBe(afterDigest);
    expect(existsSync(join(paths.pmRoot, basename(staging)))).toBeFalse();
  });
});

// ── W-621 [TX-3] — doctor sees a residual control staging directory ──────────
//
// A crashed transaction leaves `.<control>.txn-<random>/` beside the control
// root: a dotfile copy of the whole control tree, invisible to `ls`, showing as
// `??` in `git status`. One sat for 13 hours while `doctor --profile strict`
// reported zero findings the entire time — which reads as "the tree is clean".
// It is REPORTED, never removed: whether it belongs to a live transaction is
// exactly the judgement that must not be inferred from a timestamp, and deleting
// a live one destroys an in-flight mutation.
test("W-621: doctor reports a residual control staging directory without removing it", () => {
  const root = mkdtempSync(join(tmpdir(), "w621-staging-residue-"));
  roots.push(root);
  const controlRoot = join(root, "control");
  mkdirSync(join(controlRoot, "backlog", "open"), { recursive: true });

  // Clean tree: no finding. Without this half, always emitting one would pass.
  expect(residualControlStagingFindings(controlRoot)).toEqual([]);

  const staging = mkdtempSync(join(root, ".control.txn-"));
  writeFileSync(join(staging, "marker.txt"), "staged\n", "utf8");
  const findings = residualControlStagingFindings(controlRoot);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.severity).toBe("warning");
  expect(findings[0]!.code).toBe("control_staging_residue");
  expect(findings[0]!.path).toBe(staging);
  // The message has to carry why it matters and why it is not being deleted.
  expect(findings[0]!.message).toContain("git add -A");
  expect(findings[0]!.message).toContain("inspect before removing");
  expect(findings[0]!.suggested_command).toContain(staging);

  // Reporting is not removing: the directory and its contents survive the call.
  expect(existsSync(join(staging, "marker.txt"))).toBeTrue();

  // A neighbouring dotfile that is NOT a staging directory stays unreported —
  // the prefix is bound to this control root's own basename, so the finding
  // cannot become a catch-all for anything hidden next to it.
  mkdirSync(join(root, ".control.other"), { recursive: true });
  mkdirSync(join(root, ".unrelated.txn-abc"), { recursive: true });
  expect(residualControlStagingFindings(controlRoot).map((finding) => finding.path)).toEqual([staging]);
});
