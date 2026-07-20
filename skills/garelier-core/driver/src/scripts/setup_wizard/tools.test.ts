import { rmSync } from "../../guard/path_guard.ts";
// W-083 ts-first: parity tests for pm_id validation and the Guardian gitleaks
// gate (the env-independent decision logic in tools.ts / pmid.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPmId, validatePmId } from "./pmid.ts";
import { guardianSecretScanRequiresGitleaksForTest } from "./tools.ts";

let temp = "";
let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("validate_pm_id parity", () => {
  test("accepts _workshop and well-formed ids", () => {
    expect(validatePmId("_workshop")).toBe(true);
    expect(validatePmId("acme")).toBe(true);
    expect(validatePmId("a")).toBe(true);
    expect(validatePmId("a-b_c9")).toBe(true);
    expect(defaultPmId()).toBe("_workshop");
  });
  test("rejects empty, over-long, and malformed ids", () => {
    expect(validatePmId("")).toBe(false);
    expect(validatePmId("A".repeat(21))).toBe(false); // > 20 and uppercase
    expect(validatePmId("-lead")).toBe(false);
    expect(validatePmId("trail-")).toBe(false);
    expect(validatePmId("UPPER")).toBe(false);
  });
});

describe("guardian_secret_scan_requires_gitleaks parity", () => {
  test("fresh (no config) defaults to gitleaks required", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-guard-"));
    prevCwd = process.cwd();
    process.chdir(temp);
    expect(
      guardianSecretScanRequiresGitleaksForTest({
        mode: "fresh",
        pmId: "pm1",
        guardians: "g1",
        guardiansSet: false,
        driverDir: "/unused",
      }),
    ).toBe(true);
  });
  test("diff reads secret_scan from the resolved config (off/gitleaks/other)", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-guard-"));
    prevCwd = process.cwd();
    process.chdir(temp);
    const pmRoot = join(temp, "__garelier", "pm1", "_crew", "pm");
    mkdirSync(pmRoot, { recursive: true });
    const cfg = join(pmRoot, "setup_config.toml");
    const base = { mode: "diff", pmId: "pm1", guardians: "", guardiansSet: false, driverDir: "/unused" };

    writeFileSync(cfg, '[guardian_tools]\nsecret_scan = "off"\n');
    expect(guardianSecretScanRequiresGitleaksForTest(base)).toBe(false);

    writeFileSync(cfg, '[guardian_tools]\nsecret_scan = "gitleaks dir --redact"\n');
    expect(guardianSecretScanRequiresGitleaksForTest(base)).toBe(true);

    writeFileSync(cfg, '[guardian_tools]\nsecret_scan = "trufflehog"\n');
    expect(guardianSecretScanRequiresGitleaksForTest(base)).toBe(false);
  });
});
