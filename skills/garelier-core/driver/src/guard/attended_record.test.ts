import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { rmSync } from "./path_guard.ts";
import { evaluate, findDispatchPermissionRecord, DEFAULT_POLICY, type GuardInput, type GuardPolicy } from "./command_guard.ts";
import {
  writeAttendedRecord,
  removeAttendedRecord,
  recordPathFor,
  resolvePmId,
  resolveGarelierDir,
  validateWorktree,
  parseArgs,
  runCli,
} from "./attended_record.ts";

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PM = "aby_works";

/** A temp filesystem root with a `.git` marker and an attended worktree nested
 * under `__garelier/<pm>/_crew/lanes/<lane>/checkout`. */
function makeWorkspace(lane = "w-attended"): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "attended-record-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  const worktree = join(root, "__garelier", PM, "_crew", "lanes", lane, "checkout");
  mkdirSync(worktree, { recursive: true });
  return { root, worktree };
}

// W-179 (第 6 報) flipped the shipped default resolution mode to "pm" (a family/unknown
// ask → deny). These record-resolution tests assert the raw baseline outcome (…→ ask),
// so pin the "ask" opt-out here; the pm-mode conversion is covered in command_guard.test.
const act = (over: Partial<GuardInput>) => evaluate({
  command: "", role: "worker", cwd: over.worktree ?? "/w", policy: { ...DEFAULT_POLICY, resolution_mode: "ask" }, ...over,
}).action;

/** A standalone temp repo (its own `.git`) used as a cross-repo target (W-183). */
function makeRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}
const posix = (p: string) => p.split("\\").join("/");

test("W-122: attended record round-trips — write resolves producer + fence → allow; remove → baseline ask", () => {
  const { root, worktree } = makeWorkspace();

  const { path } = writeAttendedRecord(
    { agent: "ga-attended-1", worktree, profile: "producer", fenceRoots: [worktree], garelierRoot: root, pmId: PM },
  );
  expect(existsSync(path)).toBe(true);

  // The guard's agent-name scan discovers it from an ordinary project cwd.
  const record = findDispatchPermissionRecord(root, "ga-attended-1", {});
  expect(record?.permission_profile).toBe("producer");
  expect(record?.fence_roots?.length).toBe(1);
  expect(record?.agent_name).toBe("ga-attended-1");

  // With that record, a bulk in-fence command proceeds (W-122 unknown-allow).
  expect(act({ command: "python gen.py", profile: record?.permission_profile, worktree, fenceRoots: record?.fence_roots })).toBe("allow");

  // Remove → the seat resolves nothing and falls back to baseline ask.
  const removed = removeAttendedRecord({ agent: "ga-attended-1", garelierRoot: root, pmId: PM });
  expect(removed.removed).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(findDispatchPermissionRecord(root, "ga-attended-1", {})).toBeNull();
  expect(act({ command: "python gen.py", profile: "baseline-destructive", worktree, fenceRoots: [worktree] })).toBe("ask");
});

test("W-122: attended record supports a gate seat (record-backed, still read-only)", () => {
  const { root, worktree } = makeWorkspace("w-gate");
  writeAttendedRecord({ agent: "ga-gate-1", worktree, profile: "gate", fenceRoots: [worktree], garelierRoot: root, pmId: PM });
  const record = findDispatchPermissionRecord(root, "ga-gate-1", {});
  expect(record?.permission_profile).toBe("gate");
  // A gate seat keeps unknown → deny even with a fence (no W-122 relaxation).
  expect(act({ command: "python inspect.py", profile: record?.permission_profile, worktree, fenceRoots: record?.fence_roots })).toBe("deny");
  // ...but its fenced verdict write is still allowed.
  expect(act({ command: "echo PASS > verdict.md", profile: record?.permission_profile, worktree, fenceRoots: record?.fence_roots })).toBe("allow");
});

test("W-159: --quality-gate commands ride the whole-command verbatim allow on a gate seat; unlisted still deny", () => {
  const { root, worktree } = makeWorkspace("w-gate-qg");
  const verify = "bash scripts/census.sh --full";
  writeAttendedRecord({
    agent: "ga-gate-qg",
    worktree,
    profile: "gate",
    fenceRoots: [worktree],
    garelierRoot: root,
    pmId: PM,
    qualityGateCommands: [verify, "bun test"],
  });
  const record = findDispatchPermissionRecord(root, "ga-gate-qg", {});
  expect(record?.permission_profile).toBe("gate");
  // The record carries the verbatim verify list command_guard reads.
  expect(record?.quality_gate_commands).toEqual([verify, "bun test"]);
  // With the record's commands threaded (the hook path), the declared non-preset
  // script is allowed on the fail-closed gate profile.
  expect(act({ command: verify, profile: "gate", worktree, cwd: worktree, fenceRoots: record?.fence_roots, qualityGateCommands: record?.quality_gate_commands })).toBe("allow");
  // An unlisted script still fails closed.
  expect(act({ command: "bash scripts/evil.sh", profile: "gate", worktree, cwd: worktree, fenceRoots: record?.fence_roots, qualityGateCommands: record?.quality_gate_commands })).toBe("deny");
});

test("W-159: buildRecord dedupes and drops blank --quality-gate entries", () => {
  const { root, worktree } = makeWorkspace("w-gate-qg-dedupe");
  writeAttendedRecord({
    agent: "ga-gate-qg-dedupe",
    worktree,
    profile: "gate",
    fenceRoots: [worktree],
    garelierRoot: root,
    pmId: PM,
    qualityGateCommands: ["bun test", "  ", "bun test", "tsc --noEmit"],
  });
  const record = findDispatchPermissionRecord(root, "ga-gate-qg-dedupe", {});
  expect(record?.quality_gate_commands).toEqual(["bun test", "tsc --noEmit"]);
});

// W-183: a declared cross-repo binding (`--additional-root`) merges into the
// effective fence, so a PM-direct seat working from repo A can operate on the
// DECLARED repo B (an absolute cd into it) instead of falling to a baseline-
// destructive ask-storm — while an UNdeclared repo stays out-of-fence and fails
// closed, and a seat without the binding is unchanged (regression baseline).
const FENCE_ENFORCE: GuardPolicy = { ...DEFAULT_POLICY, resolution_mode: "ask", path_fence_guard_enabled: true };
const actFenced = (over: Partial<GuardInput>) => evaluate({
  command: "", role: "producer", policy: FENCE_ENFORCE, ...over,
}).action;

test("W-183: a declared --additional-root authorizes cross-repo work; undeclared stays fail-closed", () => {
  const { root, worktree } = makeWorkspace("w-xrepo");
  const repoB = makeRepo("w183-repoB-");
  const repoC = makeRepo("w183-repoC-");

  writeAttendedRecord({
    agent: "ga-xrepo", worktree, profile: "producer",
    fenceRoots: [worktree], garelierRoot: root, pmId: PM, laneKind: "pm-direct",
    additionalRoots: [repoB],
  });
  const record = findDispatchPermissionRecord(root, "ga-xrepo", {});
  // The binding is retained and merged into the effective fence.
  expect(record?.additional_roots?.length).toBe(1);
  expect(record?.fence_roots?.length).toBe(2);

  // An absolute cd into the DECLARED repo B is in-fence.
  expect(actFenced({
    command: `cd ${posix(repoB)} && touch z.ts`,
    profile: "producer", worktree: record?.worktree, cwd: worktree, fenceRoots: record?.fence_roots,
  })).toBe("allow");
  // An absolute cd into an UNdeclared repo C is out-of-fence → deny (不退行).
  expect(actFenced({
    command: `cd ${posix(repoC)} && touch z.ts`,
    profile: "producer", worktree: record?.worktree, cwd: worktree, fenceRoots: record?.fence_roots,
  })).toBe("deny");
});

test("W-183: a seat WITHOUT --additional-root still denies the same cross-repo write (regression baseline)", () => {
  const { root, worktree } = makeWorkspace("w-xrepo-none");
  const repoB = makeRepo("w183-none-repoB-");
  writeAttendedRecord({
    agent: "ga-xrepo-none", worktree, profile: "producer",
    fenceRoots: [worktree], garelierRoot: root, pmId: PM, laneKind: "pm-direct",
  });
  const record = findDispatchPermissionRecord(root, "ga-xrepo-none", {});
  expect(record?.additional_roots ?? []).toEqual([]);
  expect(actFenced({
    command: `cd ${posix(repoB)} && touch z.ts`,
    profile: "producer", worktree: record?.worktree, cwd: worktree, fenceRoots: record?.fence_roots,
  })).toBe("deny");
});

test("W-183: CLI --additional-root parses (repeatable) and writes guard.additional_roots", () => {
  const { root, worktree } = makeWorkspace("w-xrepo-cli");
  const repoB = makeRepo("w183-cli-repoB-");
  const parsed = parseArgs(["--agent", "ga-xrepo-cli", "--worktree", worktree, "--profile", "producer",
    "--additional-root", repoB, "--pm-direct"]);
  expect(parsed.additionalRoots).toEqual([repoB]);

  const write = runCli(["--agent", "ga-xrepo-cli", "--worktree", worktree, "--profile", "producer",
    "--additional-root", repoB, "--pm-direct", "--garelier-root", root, "--pm-id", PM]);
  expect(write.code).toBe(0);
  const record = findDispatchPermissionRecord(root, "ga-xrepo-cli", {});
  expect(record?.additional_roots?.length).toBe(1);
});

// ── W-139: producer-profile preventive warning ────────────────────────────────
// A producer-profile attended_record is a sanctioned PM-direct-lane exception,
// but the live incident (2026-07-18) was a PM reusing the gate-only
// attended_record pattern for a worker task, bypassing dispatch_prepare.ts /
// workspace_isolate.ts entirely. The write must still succeed (never a block —
// a PM-direct lane IS a legitimate use); only a stderr nudge is added.
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk: string) => { captured += chunk; return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return captured;
}

test("writeAttendedRecord: --profile producer emits a dispatch_prepare/workspace_isolate stderr nudge, but still writes (W-139)", () => {
  const { root, worktree } = makeWorkspace("w-producer-warn");
  let result: { path: string } | undefined;
  const stderr = captureStderr(() => {
    result = writeAttendedRecord({ agent: "ga-producer-warn", worktree, profile: "producer", fenceRoots: [worktree], garelierRoot: root, pmId: PM });
  });
  expect(stderr).toContain("dispatch_prepare");
  expect(stderr).toContain("workspace_isolate");
  expect(existsSync(result!.path)).toBe(true);
});

test("writeAttendedRecord: --profile gate emits NO stderr nudge (ordinary, expected pattern) (W-139)", () => {
  const { root, worktree } = makeWorkspace("w-gate-warn");
  const stderr = captureStderr(() => {
    writeAttendedRecord({ agent: "ga-gate-warn", worktree, profile: "gate", fenceRoots: [worktree], garelierRoot: root, pmId: PM });
  });
  expect(stderr).toBe("");
});

test("validateWorktree rejects a missing path, a drive/root path, and a non-repo path", () => {
  const { worktree } = makeWorkspace();
  expect(validateWorktree(worktree)).toBeTruthy(); // happy path (inside the .git repo)

  expect(() => validateWorktree(join(worktree, "does", "not", "exist"))).toThrow(/does not exist/);
  // Filesystem root is shallow (depth < 3) → refused by the path_guard fence.
  expect(() => validateWorktree(parse(tmpdir()).root)).toThrow(/shallow\/root/);
  // A bare temp dir with no .git anywhere up the chain is not a controlled repo.
  const bare = mkdtempSync(join(tmpdir(), "attended-record-norepo-"));
  tempRoots.push(bare);
  expect(() => validateWorktree(bare)).toThrow(/not inside a git repository/);
});

test("writeAttendedRecord refuses a bad profile and a missing worktree", () => {
  const { root, worktree } = makeWorkspace();
  expect(() => writeAttendedRecord({ agent: "a", worktree, profile: "scout" as any, garelierRoot: root, pmId: PM }))
    .toThrow(/producer.*gate/);
  expect(() => writeAttendedRecord({ agent: "a", garelierRoot: root, pmId: PM })).toThrow(/--worktree is required/);
});

test("pm id and garelier dir derive from the worktree path when not passed", () => {
  const { root, worktree } = makeWorkspace();
  const garelierDir = resolveGarelierDir(worktree);
  expect(garelierDir).toBe(join(root, "__garelier"));
  expect(resolvePmId(garelierDir, worktree)).toBe(PM);
  expect(recordPathFor(garelierDir, PM, "ga-x")).toBe(join(garelierDir, PM, "_crew", "lanes", ".meta", "ga-x.dispatch.json"));

  // Deriving with no worktree hint falls back to the sole pm under __garelier.
  expect(resolvePmId(garelierDir, undefined)).toBe(PM);
});

test("CLI parses flags and runs a write/remove round-trip", () => {
  const { root, worktree } = makeWorkspace("w-cli");
  const parsed = parseArgs(["--agent", "ga cli", "--worktree", worktree, "--profile", "producer", "--fence-root", worktree]);
  expect(parsed.agent).toBe("ga cli");
  expect(parsed.fenceRoots).toEqual([worktree]);

  const write = runCli(["--agent", "ga-cli-1", "--worktree", worktree, "--profile", "producer", "--fence-root", worktree, "--garelier-root", root, "--pm-id", PM]);
  expect(write.code).toBe(0);
  expect(findDispatchPermissionRecord(root, "ga-cli-1", {})?.permission_profile).toBe("producer");

  const remove = runCli(["--remove", "ga-cli-1", "--garelier-root", root, "--pm-id", PM]);
  expect(remove.code).toBe(0);
  expect(findDispatchPermissionRecord(root, "ga-cli-1", {})).toBeNull();

  // A sanitized agent name maps to a filesystem-safe record file.
  expect(runCli(["--agent", "ga/../evil", "--worktree", worktree, "--garelier-root", root, "--pm-id", PM]).code).toBe(0);
  expect(runCli(["--bogus"]).code).toBe(2);
});

test("W-159: CLI parses repeatable --quality-gate and writes the verbatim list", () => {
  const { root, worktree } = makeWorkspace("w-cli-qg");
  const parsed = parseArgs(["--agent", "ga-cli-qg", "--worktree", worktree, "--profile", "gate",
    "--quality-gate", "bun test", "--quality-gate", "bash scripts/census.sh --full"]);
  expect(parsed.qualityGateCommands).toEqual(["bun test", "bash scripts/census.sh --full"]);

  const write = runCli(["--agent", "ga-cli-qg", "--worktree", worktree, "--profile", "gate",
    "--quality-gate", "bun test", "--quality-gate", "bash scripts/census.sh --full",
    "--fence-root", worktree, "--garelier-root", root, "--pm-id", PM]);
  expect(write.code).toBe(0);
  const record = findDispatchPermissionRecord(root, "ga-cli-qg", {});
  expect(record?.quality_gate_commands).toEqual(["bun test", "bash scripts/census.sh --full"]);
});

// ── W-150: the record must land on the repo MAIN root, not the lane worktree's ──
// inner committed __garelier. A garelier lane worktree is a full checkout, so it
// carries a committed __garelier copy; the old nearest-first walk-up stopped there
// and wrote the record into a nested tree the guard's reader never scans, so every
// command fell to baseline-destructive and asked (the live 2026-07-18 incident).

/** A temp "main repo" with a fake `.git` (forces resolveControlRoot's walk-up
 * fallback) whose lane worktree carries a COMMITTED inner `__garelier` — the exact
 * shape that made the writer target the nested tree. */
function makeNestedLaneWorkspace(pm = "_workshop", lane = "w150-nested"): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "attended-record-nested-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  const worktree = join(root, "__garelier", pm, "_crew", "lanes", lane);
  mkdirSync(join(worktree, "__garelier", pm, "_crew", "lanes", ".meta"), { recursive: true }); // inner committed copy
  return { root, worktree };
}

test("W-150: writeAttendedRecord anchors the record on the repo MAIN root, not the lane's inner committed __garelier", () => {
  const { root, worktree } = makeNestedLaneWorkspace();
  const { path } = writeAttendedRecord(
    { agent: "ga-release-v2131-prep", worktree, profile: "producer", fenceRoots: [worktree] },
  );
  // Exactly ONE __garelier segment = main-root anchored. The reverted (nearest)
  // walk-up writes under `<worktree>/__garelier/...`, which has TWO — RED on revert.
  expect(path.split("__garelier").length - 1).toBe(1);
  expect(path.includes(join("w150-nested", "__garelier"))).toBe(false);
  expect(path.endsWith(join("_workshop", "_crew", "lanes", ".meta", "ga-release-v2131-prep.dispatch.json"))).toBe(true);
  expect(existsSync(path)).toBe(true);
});

test("W-150: a record written for a lane worktree is found by a cross-repo `git -C <repo>` lookup (round-trip)", () => {
  const { root, worktree } = makeNestedLaneWorkspace("_workshop", "w150-roundtrip");
  const { path } = writeAttendedRecord(
    { agent: "ga-release-v2131-prep", worktree, profile: "producer", fenceRoots: [worktree] },
  );

  // A session whose cwd is an UNRELATED repo (its own __garelier holds no record)
  // guards a cross-repo `git -C <root> …`: the record resolves from the command's
  // TARGET repo, not the hook cwd. (Post-copy the PM saw ask persist precisely
  // because the reader scanned only the cwd's ancestors — W-150.)
  const otherCwd = mkdtempSync(join(tmpdir(), "attended-record-other-cwd-"));
  tempRoots.push(otherCwd);
  mkdirSync(join(otherCwd, "__garelier", "otherpm"), { recursive: true });

  expect(findDispatchPermissionRecord(otherCwd, "ga-release-v2131-prep", {})).toBeNull(); // cwd alone: nothing
  const record = findDispatchPermissionRecord(otherCwd, "ga-release-v2131-prep", {}, `git -C ${root} commit -m x`);
  expect(record?.agent_name).toBe("ga-release-v2131-prep");
  expect(record?.permission_profile).toBe("producer");
  expect(realpathSync(record!.source)).toBe(realpathSync(path)); // the exact file the writer produced
});

// ── W-155: spawn-helper — a PM-direct lane declares itself with a lane_kind marker ──
// The PM-direct seat works the primary checkout (no dispatch container, no isolate
// lane), so its producer record needs a top-level `lane_kind: "pm-direct"` marker
// that the W-139 bypass-spawn detective reads to downgrade the seat to advisory
// (DEC-093). The record otherwise round-trips exactly like any attended record, so
// the guard resolves the producer/fence seat and command_guard can stay ON.

test("W-155: --pm-direct writes a top-level lane_kind marker and still round-trips to producer+fence", () => {
  const { root, worktree } = makeWorkspace("w-pmdirect");
  const { path, record } = writeAttendedRecord(
    { agent: "ga-design-x", worktree, profile: "producer", fenceRoots: [worktree], garelierRoot: root, pmId: PM, laneKind: "pm-direct" },
  );
  // The marker sits at the TOP level, beside `source` (where the detective reads it).
  expect((record as { lane_kind?: string }).lane_kind).toBe("pm-direct");
  expect((record as { source?: string }).source).toBe("attended_record");
  expect(JSON.parse(readFileSync(path, "utf8")).lane_kind).toBe("pm-direct"); // persisted, not just in-memory

  // The guard reader resolves the same producer/fence seat — the guard-ON path.
  const resolved = findDispatchPermissionRecord(root, "ga-design-x", {});
  expect(resolved?.permission_profile).toBe("producer");
  expect(resolved?.fence_roots?.length).toBe(1);
  expect(resolved?.agent_name).toBe("ga-design-x");
});

test("W-155: an ordinary attended record (no --pm-direct) carries NO lane_kind marker", () => {
  const { root, worktree } = makeWorkspace("w-no-pmdirect");
  const { record } = writeAttendedRecord(
    { agent: "ga-plain", worktree, profile: "producer", fenceRoots: [worktree], garelierRoot: root, pmId: PM },
  );
  expect("lane_kind" in record).toBe(false); // omitted ⇒ still a hard BYPASS-SPAWN if unsanctioned
});

test("W-155: --pm-direct suppresses the W-139 producer nudge (the sanctioned path is not nagged)", () => {
  const { root, worktree } = makeWorkspace("w-pmdirect-nudge");
  const stderr = captureStderr(() => {
    writeAttendedRecord({ agent: "ga-pmdirect-nudge", worktree, profile: "producer", fenceRoots: [worktree], garelierRoot: root, pmId: PM, laneKind: "pm-direct" });
  });
  expect(stderr).toBe(""); // vs the un-declared producer write above, which DOES nudge (W-139 test)
});

test("W-155: pm-id inference with >1 candidate enumerates the candidates and shows a --pm-id example", () => {
  const { root } = makeWorkspace(); // creates __garelier/aby_works
  mkdirSync(join(root, "__garelier", "otherpm"), { recursive: true }); // a second PM namespace
  const garelierDir = join(root, "__garelier");
  let msg = "";
  try { resolvePmId(garelierDir, undefined); } catch (err) { msg = String(err); }
  expect(msg).toContain("2 candidates:");
  expect(msg).toContain("aby_works");
  expect(msg).toContain("otherpm");
  expect(msg).toContain("--pm-id"); // the flag + a concrete example so the operator can recover
  expect(msg).toContain("e.g. --pm-id aby_works");
});

test("W-155: CLI --pm-direct parses and writes a lane_kind record (round-trip)", () => {
  const { root, worktree } = makeWorkspace("w-pmdirect-cli");
  const parsed = parseArgs(["--agent", "ga-cli-pd", "--worktree", worktree, "--pm-direct", "--pm-id", PM]);
  expect(parsed.pmDirect).toBe(true);

  const write = runCli(["--agent", "ga-cli-pd", "--worktree", worktree, "--pm-direct", "--garelier-root", root, "--pm-id", PM]);
  expect(write.code).toBe(0);
  expect(findDispatchPermissionRecord(root, "ga-cli-pd", {})?.permission_profile).toBe("producer"); // default profile
  const onDisk = JSON.parse(readFileSync(recordPathFor(join(root, "__garelier"), PM, "ga-cli-pd"), "utf8"));
  expect(onDisk.lane_kind).toBe("pm-direct");
});
