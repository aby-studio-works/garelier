// Provider smoke (DEC-026). Builds a provider's command via its adapter,
// spawns it on a one-line prompt, and verifies it exits 0 and a result can be
// parsed — the full build → spawn → parse round-trip. Used two ways:
//   - the test (provider_smoke.test.ts) runs all five against a mock provider;
//   - run directly to smoke a REAL CLI:
//       bun run src/providers/provider_smoke.ts --provider gemini-cli
//     (optionally GARELIER_PROVIDER_<KIND>_CMD=... to override the command).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getProviderAdapter } from "./index.ts";
import type { ProviderBuildOptions } from "./types.ts";
import type { ProviderKind, PermissionProfile } from "../config.ts";

export interface ProviderSmokeResult {
  kind: ProviderKind;
  ok: boolean;
  result?: string;
  exitCode: number | null;
  error?: string;
}

export interface ProviderSmokeOptions {
  tmpDir: string;
  prompt?: string;
  permissionProfile?: PermissionProfile;
  // Override the spawn command (the test points this at the mock provider).
  providerCommand?: string[];
}

export async function runProviderSmoke(
  kind: ProviderKind,
  opts: ProviderSmokeOptions,
): Promise<ProviderSmokeResult> {
  const adapter = getProviderAdapter(kind);
  await mkdir(opts.tmpDir, { recursive: true });
  const promptFile = join(opts.tmpDir, `smoke-${kind}.prompt`);
  await writeFile(promptFile, opts.prompt ?? "Smoke check: reply with OK.", "utf8");
  const overrideFile = join(opts.tmpDir, "smoke-override.txt");
  await writeFile(overrideFile, "headless smoke", "utf8");

  const buildOpts: ProviderBuildOptions = {
    cwd: opts.tmpDir,
    role: "scout",
    projectRoot: opts.tmpDir,
    skillCoreDir: opts.tmpDir,
    skillRootDir: opts.tmpDir,
    tmpDir: opts.tmpDir,
    promptFile,
    overrideFile,
    permissionProfile: opts.permissionProfile ?? "safe",
    providerCommand: opts.providerCommand,
  };

  let cmd;
  try {
    cmd = await adapter.buildCommand(buildOpts);
  } catch (e) {
    return { kind, ok: false, exitCode: null, error: `buildCommand: ${(e as Error).message}` };
  }

  const stdinFile = cmd.stdinFile ?? promptFile;
  const stdinBytes = await Bun.file(stdinFile).arrayBuffer();
  let proc;
  try {
    proc = Bun.spawn([...cmd.cmd, ...cmd.args], {
      cwd: opts.tmpDir,
      stdin: new Uint8Array(stdinBytes),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(cmd.env ?? {}) },
    });
  } catch (e) {
    return { kind, ok: false, exitCode: null, error: `spawn: ${(e as Error).message}` };
  }

  const stdoutRaw = await new Response(proc.stdout).text();
  const stderrRaw = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const parsed = await adapter.parseOutput({ stdoutRaw, stderrRaw, resultFile: cmd.resultFile });
  const ok = exitCode === 0 && !!(parsed.result && parsed.result.trim());
  return {
    kind,
    ok,
    result: parsed.result,
    exitCode,
    error: ok ? undefined : (stderrRaw.slice(-300) || `exit ${exitCode}, no result`),
  };
}

// Direct run: smoke one real provider CLI.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--provider");
  const kind = (i >= 0 ? argv[i + 1] : undefined) as ProviderKind | undefined;
  if (!kind) {
    console.error("usage: provider_smoke.ts --provider <claude-code|codex-cli|gemini-cli|copilot-cli|cursor-cli>");
    process.exit(2);
  }
  const dir = join(tmpdir(), `symph-provsmoke-${kind}`);
  const res = await runProviderSmoke(kind, { tmpDir: dir });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
