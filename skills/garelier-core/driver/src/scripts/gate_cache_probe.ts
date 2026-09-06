#!/usr/bin/env bun

// Bounded gate-owned cache counterfactual. Each invocation runs the same two
// cacheable compiler calls from distinct checkout roots through the production
// gate_runner. `mapped` retains its injected checkout base directory;
// `unmapped` removes only that directory at the cache-client boundary.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRuntimeExecutable, resolveNativeExecutable } from "./_lib.ts";

type Mapping = "mapped" | "unmapped";

const scripts = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(process.cwd());
const mappingArg = Bun.argv[Bun.argv.indexOf("--mapping") + 1];
if (mappingArg !== "mapped" && mappingArg !== "unmapped") {
  throw new Error("usage: gate_cache_probe.ts --mapping mapped|unmapped");
}
const mapping: Mapping = mappingArg;
const sccache = resolveNativeExecutable("sccache");
if (!sccache) throw new Error("gate cache probe requires sccache on PATH");

const probeRoot = join(
  checkout,
  "__garelier",
  "_workshop",
  "showcase",
  "gate-cache-counterfactual",
  `${mapping}-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
const project = join(probeRoot, "project");
const studio = join(probeRoot, "studio");
const worktree = join(probeRoot, "worktree");
const staticRoot = join(probeRoot, "static-root");
const cacheDir = join(probeRoot, "cache");
const fixtureScript = join(probeRoot, "cache-workload.ts");
const compilerSource = join(probeRoot, "fake-clang.ts");
const compiler = join(probeRoot, process.platform === "win32" ? "fake-clang.exe" : "fake-clang");
const setup = join(project, "__garelier", "cachepm", "_crew", "pm", "setup_config.toml");
const sourceText = "int cache_probe(void) { return 1; }\n";
for (const root of [project, studio, worktree, staticRoot, cacheDir, dirname(setup)]) {
  mkdirSync(root, { recursive: true });
}
for (const root of [studio, worktree]) {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "target"), { recursive: true });
  writeFileSync(join(root, "src", "cache_probe.c"), sourceText);
}

writeFileSync(compilerSource, [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'import { basename } from "node:path";',
  'const args = process.argv.slice(2);',
  'const source = [...args].reverse().find((arg) => /\\.(?:c|i)$/i.test(arg));',
  'if (args.includes("-E")) {',
  '  const input = source ? readFileSync(source, "utf8") : "";',
  '  if (source && basename(source).toLowerCase() === "testfile.c" && input.includes("compiler_id=")) {',
  '    process.stdout.write("compiler_id=clang\\ncompiler_version=fake-clang 1.0\\n");',
  '  } else {',
  '    process.stdout.write(`# 1 "${source?.replaceAll("\\\\", "/") ?? "stdin"}"\\n${input}`);',
  '  }',
  '  process.exit(0);',
  '}',
  'if (args.includes("--version") || args.includes("-v")) {',
  '  process.stdout.write("clang version 21.0.0\\nTarget: x86_64-w64-windows-gnu\\n");',
  '  process.exit(0);',
  '}',
  'const outputFlag = args.indexOf("-o");',
  'if (outputFlag >= 0 && args[outputFlag + 1]) writeFileSync(args[outputFlag + 1], "deterministic-object\\n");',
  '',
].join("\n"));

const compilerBuild = Bun.spawnSync([
  process.execPath, "build", compilerSource, "--compile", "--outfile", compiler,
], { cwd: checkout, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
if (compilerBuild.exitCode !== 0 || !existsSync(compiler)) {
  throw new Error(`fake compiler build failed: ${compilerBuild.stderr.toString()}`);
}

writeFileSync(fixtureScript, [
  'const action = Bun.argv[2] ?? "";',
  'const mapping = Bun.argv[3] ?? "";',
  'const env = { ...process.env };',
  'if (mapping === "unmapped") env.SCCACHE_BASEDIRS = env.GARELIER_CACHE_PROBE_STATIC_BASEDIR;',
  'const tool = env.GARELIER_CACHE_PROBE_SCCACHE;',
  'if (!tool) throw new Error("GARELIER_CACHE_PROBE_SCCACHE is missing");',
  'let args: string[];',
  'if (action === "compile") args = [tool, env.GARELIER_CACHE_PROBE_COMPILER!, "-c", Bun.argv[4]!, "-o", Bun.argv[5]!];',
  'else if (action === "zero") args = [tool, "--zero-stats"];',
  'else if (action === "stats") args = [tool, "--show-stats"];',
  'else if (action === "stop") args = [tool, "--stop-server"];',
  'else throw new Error(`unknown cache workload action: ${action}`);',
  'const result = Bun.spawnSync(args, { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });',
  'process.stdout.write(result.stdout);',
  'process.stderr.write(result.stderr);',
  'process.exit(result.exitCode ?? 1);',
  '',
].join("\n"));

const port = 40_000 + ((process.pid + (mapping === "mapped" ? 0 : 10_000)) % 20_000);
const toml = (value: string): string => JSON.stringify(value.replaceAll("\\", "/"));
writeFileSync(setup, [
  "[project]", 'name = "gate-cache-probe"', "",
  "[branches]", 'target = "main"', 'integration = "garelier/main/cachepm/studio"', "",
  "[quality_gate]", "timeout_minutes_per_cmd = 2", "",
  "[heavy_compile]", "enabled = false", "",
  "[lane_env]",
  `SCCACHE_DIR = ${toml(cacheDir)}`,
  `SCCACHE_SERVER_PORT = ${toml(String(port))}`,
  `SCCACHE_BASEDIRS = ${toml(staticRoot)}`,
  `GARELIER_CACHE_PROBE_STATIC_BASEDIR = ${toml(staticRoot)}`,
  `GARELIER_CACHE_PROBE_SCCACHE = ${toml(sccache)}`,
  `GARELIER_CACHE_PROBE_COMPILER = ${toml(compiler)}`,
  "",
].join("\n"));

const writeSteps = (root: string, first: boolean): string => {
  const path = join(probeRoot, `${basename(root)}-steps.json`);
  const source = join(root, "src", "cache_probe.c").replaceAll("\\", "/");
  const output = join(root, "target", "cache_probe.o").replaceAll("\\", "/");
  const commands = [
    ...(first ? [{ name: "zero", cmd: `bun ${toml(fixtureScript)} zero ${mapping}` }] : []),
    { name: "compile", cmd: `bun ${toml(fixtureScript)} compile ${mapping} ${toml(source)} ${toml(output)}` },
    ...(first ? [
      { name: "stop", cmd: `bun ${toml(fixtureScript)} stop ${mapping}` },
    ] : [
      { name: "stats", cmd: `bun ${toml(fixtureScript)} stats ${mapping}` },
      { name: "stop", cmd: `bun ${toml(fixtureScript)} stop ${mapping}` },
    ]),
  ];
  writeFileSync(path, JSON.stringify({ steps: commands }, null, 2));
  return path;
};

const gateRunner = join(scripts, "gate_runner.ts");
const runGate = (root: string, call: number): string => {
  const steps = writeSteps(root, call === 1);
  const log = join(probeRoot, `${mapping}-${call}.log`);
  const command = [
    process.execPath, gateRunner,
    "--project", project, "--pm-id", "cachepm", "--cwd", root,
    "--steps", steps, "--log", log,
  ];
  process.stdout.write(`W558_COMMAND direction=${mapping} call=${call} command=${command.join(" ")}\n`);
  process.stdout.write(`W558_CWD direction=${mapping} call=${call} cwd=${root}\n`);
  const result = Bun.spawnSync(command, {
    cwd: root, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000,
    env: { ...process.env, GARELIER_HC_MAIN_ROOT: project },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.exitCode !== 0) throw new Error(`production gate_runner call ${call} failed with exit ${result.exitCode}`);
  return readFileSync(log, "utf8");
};

const candidate = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", checkout, "rev-parse", "HEAD"], {
  windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
}).stdout.toString().trim();
process.stdout.write(`W558_DIRECTION direction=${mapping} candidate=${candidate} cacheable_calls=2\n`);
process.stdout.write(`W558_INJECTION direction=${mapping} production=gate_runner.ts location=resolveLaneEnv->injectLaneEnv->runStep control=${mapping === "mapped" ? "retain-checkout-basedir" : "remove-checkout-basedir-at-cache-client"}\n`);
const firstEvidence = runGate(studio, 1);
const secondEvidence = runGate(worktree, 2);
const stat = (evidence: string, label: "hits" | "misses"): number => Number(
  evidence.match(new RegExp(`^Cache ${label}\\s+(\\d+)$`, "m"))?.[1] ?? -1,
);
const hits = stat(firstEvidence, "hits") + stat(secondEvidence, "hits");
const misses = stat(firstEvidence, "misses") + stat(secondEvidence, "misses");
const baseDirectories = [...secondEvidence.matchAll(/^Base directories\s+(.+)$/gm)].at(-1)?.[1]?.trim() ?? "<missing>";
const expectedHits = mapping === "mapped" ? 1 : 0;
const expectedMisses = mapping === "mapped" ? 1 : 2;
if (hits !== expectedHits || misses !== expectedMisses || baseDirectories === "<missing>") {
  throw new Error(`unexpected ${mapping} stats: hits=${hits} misses=${misses} base_directories=${baseDirectories}`);
}
process.stdout.write(`W558_STATS direction=${mapping} target_calls=2 Cache hits=${hits} Cache misses=${misses} Base directories=${baseDirectories}\n`);
