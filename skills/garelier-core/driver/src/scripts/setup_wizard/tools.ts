// W-083 ts-first: setup_wizard best-effort local tooling setup.
//
// Faithful port of the tool-setup chain in setup_wizard.sh (lines 768-1031):
// is_windows_shell / refresh_tool_path / guardian_* gates / tool_setup_missing /
// try_install_* / setup_driver_assets / run_garelier_tool_setup /
// maybe_setup_garelier_tools. Runs once (module-level `maybe_setup_garelier_tools`
// in the bash) after the teardown early-exit and before the mode body. In the
// oracle environment (bun present, driver deps + Mermaid bundle vendored) the
// missing set is empty and this emits nothing — the byte-parity contract.

import { existsSync, readFileSync, readSync } from "node:fs";
import { delimiter } from "node:path";
import { commandExists, cygpathMixed } from "./env.ts";
import { crewSubdirFromPmRoot } from "./paths.ts";
import { tomlScalarValue } from "./toml.ts";
import { run } from "../_lib.ts";

export interface ToolSetupCtx {
  mode: string;
  pmId: string;
  guardians: string;
  guardiansSet: boolean;
  installTools: boolean;
  skipConfirm: boolean;
  driverDir: string; // GARELIER_DRIVER_DIR
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

// is_windows_shell
function isWindowsShell(): boolean {
  const r = run(["uname", "-s"]);
  const s = r.exitCode === 0 ? r.stdout.trim() : "";
  return /^(MINGW|MSYS|CYGWIN)/.test(s);
}

// refresh_tool_path: prepend the user-local bun/go bin dirs so a freshly
// installed tool is discoverable. Uses the platform PATH delimiter (";" on native
// Windows/Bun) rather than the MSYS ":" the bash relies on.
function refreshToolPath(): void {
  const home = process.env.HOME ?? "";
  process.env.PATH = `${home}/.bun/bin${delimiter}${home}/go/bin${delimiter}${process.env.PATH ?? ""}`;
  const userProfile = process.env.USERPROFILE;
  if (userProfile && commandExists("cygpath")) {
    const r = run(["cygpath", "-u", userProfile]);
    const winHome = r.exitCode === 0 ? r.stdout.trim() : "";
    if (winHome) {
      process.env.PATH = `${winHome}/.bun/bin${delimiter}${winHome}/go/bin${delimiter}${process.env.PATH ?? ""}`;
    }
  }
}

// guardian_setup_config_path: the setup_config.toml that governs Guardian tools,
// or "" when none is resolvable for the current mode.
function guardianSetupConfigPath(ctx: ToolSetupCtx): string {
  const crewPm = () => `${crewSubdirFromPmRoot(`__garelier/${ctx.pmId}`, "_pm")}/setup_config.toml`;
  if (ctx.mode === "diff") {
    if (ctx.pmId && existsSync(crewPm())) return crewPm();
  } else if (ctx.mode === "migrate") {
    if (ctx.pmId && existsSync(crewPm())) return crewPm();
    if (existsSync("__garelier/_pm/setup_config.toml")) return "__garelier/_pm/setup_config.toml";
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
  const crewPmConfig = `${crewSubdirFromPmRoot(`__garelier/${ctx.pmId}`, "_pm")}/setup_config.toml`;
  switch (ctx.mode) {
    case "fresh":
      return ctx.guardians !== "" && guardianSecretScanRequiresGitleaks(ctx);
    case "diff":
      if (ctx.guardiansSet) return ctx.guardians !== "" && guardianSecretScanRequiresGitleaks(ctx);
      if (ctx.pmId && existsSync(crewPmConfig)) {
        return configHasGuardiansBlock(crewPmConfig) && guardianSecretScanRequiresGitleaks(ctx);
      }
      return false;
    case "migrate":
      if (ctx.pmId && existsSync(crewPmConfig)) {
        return configHasGuardiansBlock(crewPmConfig) && guardianSecretScanRequiresGitleaks(ctx);
      }
      if (existsSync("__garelier/_pm/setup_config.toml")) {
        return configHasGuardiansBlock("__garelier/_pm/setup_config.toml") && guardianSecretScanRequiresGitleaks(ctx);
      }
      return false;
    default:
      return false;
  }
}

// tool_setup_missing: ordered list of missing tooling (Bun first).
function toolSetupMissing(ctx: ToolSetupCtx): string[] {
  refreshToolPath();
  const missing: string[] = [];
  if (!commandExists("bun")) {
    missing.push("Bun");
  } else {
    if (existsSync(ctx.driverDir) && !existsSync(`${ctx.driverDir}/node_modules`)) {
      missing.push("driver dependencies");
    }
    if (existsSync(ctx.driverDir) && !existsSync(`${ctx.driverDir}/static/vendor/mermaid.min.js`)) {
      missing.push("offline Mermaid bundle");
    }
  }
  if (guardianToolsNeeded(ctx) && !commandExists("gitleaks")) {
    missing.push("gitleaks");
  }
  return missing;
}

function printToolSetupMissing(missing: string[]): void {
  for (const item of missing) {
    if (item) out(`  - ${item}`);
  }
}

// try_install_bun
function tryInstallBun(): boolean {
  refreshToolPath();
  if (commandExists("bun")) return true;
  out("==> Installing Bun (best effort)...");
  if (!commandExists("bun") && commandExists("brew")) {
    run(["brew", "install", "bun"], { stdout: "inherit", stderr: "inherit" });
    refreshToolPath();
  }
  if (!commandExists("bun") && commandExists("curl")) {
    // curl -fsSL https://bun.com/install | bash : fetch the installer, feed it to bash.
    const r = run(["curl", "-fsSL", "https://bun.com/install"], { stderr: "inherit" });
    if (r.exitCode === 0) run(["bash", "-c", r.stdout], { stdout: "inherit", stderr: "inherit" });
    refreshToolPath();
  }
  return commandExists("bun");
}

// try_install_gitleaks
function tryInstallGitleaks(): boolean {
  if (commandExists("gitleaks")) return true;
  out("==> Installing gitleaks (best effort)...");
  const win = isWindowsShell();
  if (win && commandExists("winget.exe")) {
    run(
      ["winget.exe", "install", "--exact", "--id", "Gitleaks.Gitleaks", "--accept-source-agreements", "--accept-package-agreements"],
      { stdout: "inherit", stderr: "inherit" },
    );
    refreshToolPath();
  }
  if (!commandExists("gitleaks") && win && commandExists("choco.exe")) {
    run(["choco.exe", "install", "gitleaks", "-y"], { stdout: "inherit", stderr: "inherit" });
    refreshToolPath();
  }
  if (!commandExists("gitleaks") && commandExists("brew")) {
    run(["brew", "install", "gitleaks"], { stdout: "inherit", stderr: "inherit" });
    refreshToolPath();
  }
  if (!commandExists("gitleaks") && commandExists("go")) {
    run(["go", "install", "github.com/gitleaks/gitleaks/v8@latest"], { stdout: "inherit", stderr: "inherit" });
    refreshToolPath();
  }
  return commandExists("gitleaks");
}

// setup_driver_assets
function setupDriverAssets(ctx: ToolSetupCtx): void {
  if (!existsSync(ctx.driverDir)) {
    err(`  ! driver directory not found: ${ctx.driverDir}`);
    return;
  }
  if (!commandExists("bun")) {
    err("  ! Bun is not available; skipping driver dependencies and Mermaid bundle.");
    return;
  }
  out("==> Setting up Garelier driver dependencies...");
  if (run(["bun", "install", "--frozen-lockfile"], { cwd: ctx.driverDir, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
    err(`  ! bun install failed; run it manually in ${ctx.driverDir}`);
  }
  out("==> Vendoring offline Mermaid bundle for Status Web...");
  if (run(["bun", "run", "vendor:mermaid"], { cwd: ctx.driverDir, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
    err("  ! Mermaid vendoring failed; Status Web will show diagram source until this succeeds.");
  }
}

// run_garelier_tool_setup
function runGarelierToolSetup(ctx: ToolSetupCtx): void {
  if (!commandExists("bun")) {
    if (!tryInstallBun()) {
      err("  ! Bun installation did not make 'bun' available on PATH.");
      err(`    Install Bun manually, then rerun setup_wizard or run 'bun install --frozen-lockfile' in ${ctx.driverDir}.`);
    }
  }
  refreshToolPath();
  setupDriverAssets(ctx);
  if (guardianToolsNeeded(ctx) && !commandExists("gitleaks")) {
    if (!tryInstallGitleaks()) {
      err(
        '  ! gitleaks is still unavailable; Guardian secret_scan gates will fail until it is installed or [guardian_tools].secret_scan is set to "off" with block_when_required_scanner_unavailable = false.',
      );
    }
  }
}

// Blocking single-line read from stdin (fd 0), matching bash `read -r response`.
function readLineSync(): string {
  const buf = Buffer.alloc(1);
  let s = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch !== "\r") s += ch;
  }
  return s;
}

// maybe_setup_garelier_tools (module-level call in the bash). Returns nothing;
// may exit(3) in the non-interactive no-approval branch.
export function maybeSetupGarelierTools(ctx: ToolSetupCtx): void {
  const missing = toolSetupMissing(ctx);
  if (missing.length === 0) return;

  if (ctx.installTools) {
    out("Garelier tool setup requested. Missing:");
    printToolSetupMissing(missing);
    runGarelierToolSetup(ctx);
    return;
  }

  if (ctx.skipConfirm) {
    out("Garelier tool setup skipped. Missing:");
    printToolSetupMissing(missing);
    out("Rerun setup_wizard with --install-tools, or install them manually.");
    return;
  }

  if (!process.stdin.isTTY) {
    out("Garelier tool setup needs user approval before project changes. Missing:");
    printToolSetupMissing(missing);
    out("Ask the user whether to install/setup these tools, then rerun with --install-tools.");
    out("Use --skip-confirm only when you intentionally want to continue without tool setup.");
    process.exit(3);
  }

  out("Garelier can set up missing local tooling:");
  printToolSetupMissing(missing);
  process.stdout.write("Install/setup these now? [y/N] ");
  const response = readLineSync();
  if (response === "y" || response === "Y" || response === "yes" || response === "YES") {
    runGarelierToolSetup(ctx);
  } else {
    out("Tool setup skipped. Rerun with --install-tools if you want the wizard to do this later.");
  }
}

// Test-only accessor for the env-independent Guardian scanner decision.
export function guardianSecretScanRequiresGitleaksForTest(ctx: ToolSetupCtx): boolean {
  return guardianSecretScanRequiresGitleaks(ctx);
}
