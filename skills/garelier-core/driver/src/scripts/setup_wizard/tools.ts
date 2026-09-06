// setup_wizard executable prerequisite checks. Garelier resolves tools but
// never installs, downloads, vendors, or suggests installing them.
//
// The Guardian policy decides whether gitleaks is mandatory; the resolver only
// checks executable paths and exits before project mutation when one is absent.

import { existsSync, readFileSync } from "node:fs";
import { crewSubdirFromPmRoot } from "./paths.ts";
import { tomlScalarValue } from "./toml.ts";
import { resolveRuntimeExecutable } from "../_lib.ts";

export interface ToolSetupCtx {
  mode: string;
  pmId: string;
  guardians: string;
  guardiansSet: boolean;
  driverDir: string; // GARELIER_DRIVER_DIR
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

// guardian_setup_config_path: the setup_config.toml that governs Guardian tools,
// or "" when none is resolvable for the current mode.
function guardianSetupConfigPath(ctx: ToolSetupCtx): string {
  const crewPm = () => `${crewSubdirFromPmRoot(`__garelier/${ctx.pmId}`, "pm")}/setup_config.toml`;
  if (ctx.mode === "diff") {
    if (ctx.pmId && existsSync(crewPm())) return crewPm();
  }
  return "";
}

// guardian_secret_scan_requires_gitleaks
function guardianSecretScanRequiresGitleaks(ctx: ToolSetupCtx): boolean {
  const configPath = guardianSetupConfigPath(ctx);
  if (!configPath) return true; // fresh: no config yet -> default scanner is gitleaks
  const scan = tomlScalarValue(configPath, "guardian_tools", "secret_scan").toLowerCase().trim();
  if (scan === "" || scan === "off" || scan === "none" || scan === "disabled") return false;
  return scan.includes("gitleaks");
}

function configHasGuardiansBlock(path: string): boolean {
  try {
    return readFileSync(path, "utf8").split("\n").some((l) => /^\[\[guardians\]\]/.test(l));
  } catch {
    return false;
  }
}

// guardian_tools_needed
function guardianToolsNeeded(ctx: ToolSetupCtx): boolean {
  const crewPmConfig = `${crewSubdirFromPmRoot(`__garelier/${ctx.pmId}`, "pm")}/setup_config.toml`;
  switch (ctx.mode) {
    case "fresh":
      return ctx.guardians !== "" && guardianSecretScanRequiresGitleaks(ctx);
    case "diff":
      if (ctx.guardiansSet) return ctx.guardians !== "" && guardianSecretScanRequiresGitleaks(ctx);
      if (ctx.pmId && existsSync(crewPmConfig)) {
        return configHasGuardiansBlock(crewPmConfig) && guardianSecretScanRequiresGitleaks(ctx);
      }
      return false;
    default:
      return false;
  }
}

// tool_setup_missing: ordered list of missing tooling (Bun first).
function toolSetupMissing(ctx: ToolSetupCtx): string[] {
  const missing: string[] = [];
  if (!resolveRuntimeExecutable("bun")) {
    missing.push("Bun");
  }
  if (guardianToolsNeeded(ctx) && !resolveRuntimeExecutable("gitleaks")) {
    missing.push("gitleaks");
  }
  return missing;
}

function printToolSetupMissing(missing: string[]): void {
  for (const item of missing) {
    if (item) out(`  - ${item}`);
  }
}

// maybe_setup_garelier_tools (module-level call in the bash). Returns nothing;
// exits 3 before project mutation when a mandatory executable is unresolved.
export function maybeSetupGarelierTools(ctx: ToolSetupCtx): void {
  const missing = toolSetupMissing(ctx);
  if (missing.length === 0) return;
  err("Garelier prerequisite check failed. Required executable paths are unresolved:");
  printToolSetupMissing(missing);
  err("Garelier does not install, download, vendor, or recommend tools.");
  process.exit(3);
}

// Test-only accessor for the env-independent Guardian scanner decision.
export function guardianSecretScanRequiresGitleaksForTest(ctx: ToolSetupCtx): boolean {
  return guardianSecretScanRequiresGitleaks(ctx);
}
