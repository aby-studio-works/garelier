// W-121 (merge path layout-v2 + fail detection) + W-123 (Windows Bun env
// propagation) fixtures. Pure-function seams where possible; a couple of
// spawn-based checks where the CLI exit code / no-write behavior is the contract.

import { rmSync } from "../guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchPaths } from "./merge_land.ts";
import { resolveSetupConfig } from "./merge_request.ts";
import { gateEnv } from "./spawn_env.ts";

const HERE = import.meta.dir.replace(/\\/g, "/");
const MERGE_REQUEST = `${HERE}/merge_request.ts`;

const temps: string[] = [];
function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "w121-")).replace(/\\/g, "/");
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) {
    const d = temps.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("merge_land dispatchPaths — layout v2 (W-121)", () => {
  test("resolves the v2 _crew/dispatch<N> container when it exists", () => {
    const proj = tmpProject();
    mkdirSync(`${proj}/__garelier/pmx/_crew/dispatch7/checkout`, { recursive: true });
    const p = dispatchPaths(proj, "pmx", "7");
    expect(p.checkout).toBe(`${proj}/__garelier/pmx/_crew/dispatch7/checkout`);
    expect(p.context).toBe(`${proj}/__garelier/pmx/_crew/dispatch7/context.json`);
  });

  test("falls back to the legacy flat _dispatch<N> container", () => {
    const proj = tmpProject();
    mkdirSync(`${proj}/__garelier/pmx/_dispatch7/checkout`, { recursive: true });
    const p = dispatchPaths(proj, "pmx", "7");
    expect(p.checkout).toBe(`${proj}/__garelier/pmx/_dispatch7/checkout`);
  });
});

describe("merge_request resolveSetupConfig — layout v2 (W-121)", () => {
  test("resolves _crew/pm/setup_config.toml on v2", () => {
    const proj = tmpProject();
    mkdirSync(`${proj}/__garelier/pmx/_crew/pm`, { recursive: true });
    writeFileSync(`${proj}/__garelier/pmx/_crew/pm/setup_config.toml`, "");
    expect(resolveSetupConfig(proj, "pmx")).toBe(`${proj}/__garelier/pmx/_crew/pm/setup_config.toml`);
  });

  test("falls back to legacy _pm/setup_config.toml", () => {
    const proj = tmpProject();
    mkdirSync(`${proj}/__garelier/pmx/_pm`, { recursive: true });
    writeFileSync(`${proj}/__garelier/pmx/_pm/setup_config.toml`, "");
    expect(resolveSetupConfig(proj, "pmx")).toBe(`${proj}/__garelier/pmx/_pm/setup_config.toml`);
  });
});

describe("merge_request incomplete-request guard (W-121 sub 4)", () => {
  test("fails NON-ZERO and writes NO request when quality_gate_commands cannot be filled", () => {
    const proj = tmpProject();
    // v2 config exists (studio resolvable) but has NO merge_gate_commands.
    mkdirSync(`${proj}/__garelier/pmx/_crew/pm`, { recursive: true });
    writeFileSync(`${proj}/__garelier/pmx/_crew/pm/setup_config.toml`, '[branches]\nintegration = "studio"\n');
    const r = Bun.spawnSync(
      ["bun", MERGE_REQUEST, "--project", proj, "--pm-id", "pmx", "--branch", "wb/x", "--guardian", "PASS", "--no-poll"],
      { windowsHide: true, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).not.toBe(0);
    expect((r.stderr?.toString() ?? "")).toContain("quality_gate_commands");
    // no incomplete request file was left behind
    expect(existsSync(`${proj}/__garelier/pmx/runtime/merge_gate/requests`)).toBe(false);
  });

  test("writes a request with quality_gate_commands from a v2 config (positive path)", () => {
    const proj = tmpProject();
    mkdirSync(`${proj}/__garelier/pmx/_crew/pm`, { recursive: true });
    writeFileSync(
      `${proj}/__garelier/pmx/_crew/pm/setup_config.toml`,
      '[branches]\nintegration = "studio"\nmerge_gate_commands = ["bun test"]\n',
    );
    const r = Bun.spawnSync(
      ["bun", MERGE_REQUEST, "--project", proj, "--pm-id", "pmx", "--branch", "wb/x", "--guardian", "PASS", "--no-poll"],
      { windowsHide: true, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(0);
    const reqDir = `${proj}/__garelier/pmx/runtime/merge_gate/requests`;
    expect(existsSync(reqDir)).toBe(true);
  });
});

describe("gateEnv — Windows Bun env propagation (W-123)", () => {
  test("sets the commit marker / git prompt and drops the RUSTC wrappers", () => {
    process.env.RUSTC_WRAPPER = "sccache";
    process.env.RUSTC_WORKSPACE_WRAPPER = "sccache";
    const e = gateEnv();
    expect(e.GARELIER_MERGE_GATE_COMMIT).toBe("1");
    expect(e.GIT_TERMINAL_PROMPT).toBe("0");
    expect(e.RUSTC_WRAPPER).toBeUndefined();
    expect(e.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    delete process.env.RUSTC_WRAPPER;
    delete process.env.RUSTC_WORKSPACE_WRAPPER;
  });

  test("a spawnSync child SEES the marker and does NOT see RUSTC_WRAPPER", () => {
    // The whole point of W-123: a default-inherit child would miss both on
    // Windows Bun; an explicit gateEnv() carries the mutations through.
    process.env.RUSTC_WRAPPER = "sccache";
    const r = Bun.spawnSync(
      ["bash", "-c", "echo ${GARELIER_MERGE_GATE_COMMIT:-NONE}:${RUSTC_WRAPPER:-UNSET}"],
      { windowsHide: true, env: gateEnv(), stdout: "pipe" },
    );
    expect((r.stdout?.toString() ?? "").trim()).toBe("1:UNSET");
    delete process.env.RUSTC_WRAPPER;
  });
});
