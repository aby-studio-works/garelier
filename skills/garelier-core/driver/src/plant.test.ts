import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCrustContainer,
  hashCrustContainerEntry,
  listCrustContainers,
  parseContainerLockToml,
  parseCrustToml,
  resolvePlant,
  validateContainerLock,
  validateCrustConfig,
  writeContainerLock,
} from "./plant.ts";

const crustToml = `
[plant]
kind = "crust"
schema_version = 1
workfolder_id = "wf"

[[containers]]
id = "client-a"
`;

function lockToml(hash: string): string {
  return `
[lock]
schema_version = 1
plant_kind = "crust"
workfolder_id = "wf"
container_id = "client-a"
crust_container_hash = "${hash}"

[paths]
container_path = "client-a"
garelier_path = "__garelier"
target_path = "target"

[target]
remote = "git@example.com:team/app.git"
branch = "main"
count = 1

[policy]
garelier_files_in_target = "forbidden"
read_sibling_containers = "forbidden"
default_write_mode = "patch"
push_mode = "explicit_only"
`;
}

describe("Plant-Crust config and locks", () => {
  test("validates minimal crust.toml and deterministic container lock hash", () => {
    const crust = parseCrustToml(crustToml);
    expect(validateCrustConfig(crust).filter((i) => i.level === "error")).toHaveLength(0);
    expect(crust.containers[0].path).toBe("client-a");
    const hash = hashCrustContainerEntry(crust.containers[0]);
    const lock = parseContainerLockToml(lockToml(hash));
    expect(validateContainerLock(lock, crust).filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("rejects extra crust fields, duplicated containers, mismatched locks, and unsafe paths", () => {
    const driftCrustToml = `
[plant]
kind = "crust"
schema_version = 1
workfolder_id = "wf"

[defaults]
target_count = 1

[[containers]]
id = "client-a"
target_branch = "main"

[[containers]]
id = "client-a"
`;
    const crust = parseCrustToml(driftCrustToml);
    const crustIssues = validateCrustConfig(crust);
    expect(crustIssues.some((i) => i.code === "crust-extra-keys")).toBe(true);
    expect(crustIssues.some((i) => i.code === "container-extra-keys")).toBe(true);
    expect(crustIssues.some((i) => i.code === "container-duplicate")).toBe(true);

    const valid = parseCrustToml(crustToml);
    const lock = parseContainerLockToml(lockToml("sha256:wrong"));
    expect(validateContainerLock(lock, valid).some((i) => i.code === "lock-hash")).toBe(true);

    const unsafe = parseContainerLockToml(lockToml(hashCrustContainerEntry(valid.containers[0])).replace('target_path = "target"', 'target_path = "../target"'));
    expect(validateContainerLock(unsafe, valid).some((i) => i.code === "lock-relative-path")).toBe(true);
  });

  test("rejects unsafe ids, non-child paths, and non-v1 lock paths/policies", () => {
    const badCrust = parseCrustToml(`
[plant]
kind = "crust"
schema_version = 1
workfolder_id = "wf"

[[containers]]
id = ".hidden"
path = "."
`);
    const crustIssues = validateCrustConfig(badCrust);
    expect(crustIssues.some((i) => i.code === "container-id")).toBe(true);
    expect(crustIssues.some((i) => i.code === "container-path")).toBe(true);

    const valid = parseCrustToml(crustToml);
    const base = lockToml(hashCrustContainerEntry(valid.containers[0]));
    expect(validateContainerLock(parseContainerLockToml(base.replace('garelier_path = "__garelier"', 'garelier_path = "control"')), valid).some((i) => i.code === "lock-garelier-path")).toBe(true);
    expect(validateContainerLock(parseContainerLockToml(base.replace('target_path = "target"', 'target_path = "."')), valid).some((i) => i.code === "lock-target-path")).toBe(true);
    expect(validateContainerLock(parseContainerLockToml(base.replace('default_write_mode = "patch"', 'default_write_mode = "replace"')), valid).some((i) => i.code === "lock-write-policy")).toBe(true);
  });

  test("add-container preserves existing containers and rejects duplicate ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-crust-add-"));
    const crustPath = join(root, "crust.toml");
    await writeFile(crustPath, crustToml);

    const added = addCrustContainer(crustPath, {
      workfolderId: "wf",
      containerId: "client-b",
      containerPath: "client-b",
    });
    expect(added.containerCount).toBe(2);

    const text = await Bun.file(crustPath).text();
    expect(text).not.toContain("target_remote");
    expect(text).not.toContain("target_branch");
    expect(text).not.toContain("default_pm_id");
    const crust = parseCrustToml(await Bun.file(crustPath).text());
    expect(crust.containers.map((c) => c.id)).toEqual(["client-a", "client-b"]);
    expect(validateCrustConfig(crust).filter((i) => i.level === "error")).toHaveLength(0);
    expect(() => addCrustContainer(crustPath, {
      workfolderId: "wf",
      containerId: "client-a",
      containerPath: "client-a",
    })).toThrow(/container already exists/);
  });

  test("write-lock centralizes TOML escaping and validates the generated lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-lock-write-"));
    const crustPath = join(root, "crust.toml");
    const lockPath = join(root, "client-a", "container.lock.toml");
    await mkdir(join(root, "client-a"), { recursive: true });
    await writeFile(crustPath, crustToml);

    writeContainerLock(crustPath, {
      lockPath,
      containerId: "client-a",
      targetRemote: 'https://example.com/team/"quoted"\\repo.git',
      targetBranch: "main",
    });

    const crust = parseCrustToml(await Bun.file(crustPath).text());
    const lock = parseContainerLockToml(await Bun.file(lockPath).text());
    expect(lock.targetRemote).toBe('https://example.com/team/"quoted"\\repo.git');
    expect(validateContainerLock(lock, crust).filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("lists and validates registered containers without a workfolder control root", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-crust-registry-"));
    const crustPath = join(root, "crust.toml");
    await writeFile(crustPath, crustToml);
    const crust = parseCrustToml(crustToml);
    const hash = hashCrustContainerEntry(crust.containers[0]);
    await mkdir(join(root, "client-a"), { recursive: true });
    await writeFile(join(root, "client-a", "container.lock.toml"), lockToml(hash));

    const listed = listCrustContainers(crustPath);
    expect(listed.workfolderRoot).toBe(root);
    expect(listed.containers).toHaveLength(1);
    expect(listed.containers[0].garelierRoot.endsWith("client-a/__garelier") || listed.containers[0].garelierRoot.endsWith("client-a\\__garelier")).toBe(true);
    expect(listed.containers[0].issues.filter((i) => i.level === "error")).toHaveLength(0);

    const res = resolvePlant(root);
    expect(res.mode).toBe("crust");
    expect(res.controlRoot).toBeNull();
    expect(res.garelierRoot).toBeNull();
    expect(res.targetRoot).toBeNull();
    expect(res.containers?.map((c) => c.id)).toEqual(["client-a"]);
    expect(res.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("reports malformed container locks without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-crust-bad-lock-"));
    const crustPath = join(root, "crust.toml");
    await writeFile(crustPath, crustToml);
    await mkdir(join(root, "client-a"), { recursive: true });
    await writeFile(join(root, "client-a", "container.lock.toml"), "[lock\n");

    const listed = listCrustContainers(crustPath);
    expect(listed.containers[0].issues.some((i) => i.code === "container-lock-parse")).toBe(true);

    const res = resolvePlant(join(root, "client-a"), "client-a");
    expect(res.issues.some((i) => i.code === "container-lock-parse")).toBe(true);
  });

  test("reports malformed crust ledgers without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-crust-bad-ledger-"));
    const crustPath = join(root, "crust.toml");
    await writeFile(crustPath, "[plant\n");

    const listed = listCrustContainers(crustPath);
    expect(listed.issues.some((i) => i.code === "crust-parse")).toBe(true);
    expect(listed.containers).toHaveLength(0);

    const res = resolvePlant(root);
    expect(res.issues.some((i) => i.code === "crust-parse")).toBe(true);
    expect(res.containers).toEqual([]);
  });
});

describe("resolvePlant", () => {
  test("resolves Plant-Lithosphere with control and target collapsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-lithosphere-"));
    await mkdir(join(root, "__garelier", "_workshop", "control"), { recursive: true });

    const res = resolvePlant(root);
    expect(res.mode).toBe("lithosphere");
    expect(res.workfolderRoot).toBeNull();
    expect(res.containerRoot).toBeNull();
    expect(res.controlRoot).toBe(root);
    expect(res.garelierRoot).toBe(join(root, "__garelier"));
    expect(res.targetRoot).toBe(root);
    expect(res.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("resolves an active Plant-Crust container and separates control from target", async () => {
    const root = await mkdtemp(join(tmpdir(), "garelier-crust-"));
    const crust = parseCrustToml(crustToml);
    const hash = hashCrustContainerEntry(crust.containers[0]);
    await writeFile(join(root, "crust.toml"), crustToml);
    await mkdir(join(root, "client-a", "__garelier", "_workshop", "control"), { recursive: true });
    await mkdir(join(root, "client-a", "target", ".git"), { recursive: true });
    await writeFile(join(root, "client-a", "container.lock.toml"), lockToml(hash));

    const res = resolvePlant(join(root, "client-a", "__garelier"), "client-a");
    expect(res.mode).toBe("crust");
    if (!res.controlRoot || !res.targetRoot) throw new Error("expected active container roots");
    expect(res.controlRoot.endsWith("client-a")).toBe(true);
    expect(res.targetRoot.endsWith("client-a/target") || res.targetRoot.endsWith("client-a\\target")).toBe(true);
    expect(res.controlRoot).not.toBe(res.targetRoot);
    expect(res.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
});
