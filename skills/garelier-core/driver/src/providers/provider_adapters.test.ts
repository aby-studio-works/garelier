import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderAdapter, registeredProviderKinds } from "./index.ts";
import { claudeCodeAdapter, GARELIER_GIT_ALLOWED_TOOLS, GARELIER_GUARDIAN_ALLOWED_TOOLS, autofixAllowedTools } from "./claude_code.ts";
import { codexCliAdapter } from "./codex_cli.ts";
import type { ProviderBuildOptions } from "./types.ts";

function baseOpts(over: Partial<ProviderBuildOptions> = {}): ProviderBuildOptions {
  return {
    cwd: "/proj/cwd",
    role: "worker",
    projectRoot: "/proj",
    skillCoreDir: "/skills/garelier-core",
    skillRootDir: "/skills",
    tmpDir: "/tmp/x",
    promptFile: "/tmp/x/worker.prompt",
    overrideFile: "/tmp/x/headless_override.txt",
    permissionProfile: "reviewed",
    ...over,
  };
}

function addDirs(args: string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add-dir" && args[i + 1]) dirs.push(args[++i]);
  }
  return dirs;
}

describe("provider adapter registry", () => {
  test("registry exposes all providers, each reporting its own kind", () => {
    const kinds = registeredProviderKinds().sort();
    expect(kinds).toEqual(["claude-code", "codex-cli", "copilot-cli", "cursor-cli", "gemini-cli"]);
    for (const k of kinds) expect(getProviderAdapter(k).kind).toBe(k);
  });
  test("unknown provider throws", () => {
    // @ts-expect-error intentionally invalid kind
    expect(() => getProviderAdapter("does-not-exist")).toThrow();
  });
});

describe("claude-code adapter (behavior lock)", () => {
  test("default command + reviewed profile args are preserved", async () => {
    const c = await claudeCodeAdapter.buildCommand(baseOpts());
    expect(c.cmd).toEqual(["claude"]);
    expect(c.args).toEqual([
      "--add-dir", "/proj",
      "--add-dir", "/skills/garelier-core",
      "--permission-mode", "acceptEdits",
      "--allowedTools", GARELIER_GIT_ALLOWED_TOOLS.join(","),
      "--append-system-prompt-file", "/tmp/x/headless_override.txt",
      "--output-format", "json",
      "-p",
    ]);
  });
  test("safe → default permission, dangerous → skip-permissions", async () => {
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ permissionProfile: "safe" }))).args)
      .toContain("default");
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ permissionProfile: "dangerous" }))).args)
      .toContain("--dangerously-skip-permissions");
  });
  test("reviewed profile grants the protocol git command set (merge/checkout) but not push/rebase", async () => {
    const list = (await claudeCodeAdapter.buildCommand(baseOpts())).args.join(" ");
    expect(list).toContain("Bash(git merge:*)");
    expect(list).toContain("Bash(git checkout:*)");
    expect(list).toContain("Bash(git commit:*)");
    expect(list).not.toContain("git push");
    expect(list).not.toContain("git rebase");
    // dangerous mode skips permissions entirely → no allowedTools needed
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ permissionProfile: "dangerous" }))).args)
      .not.toContain("--allowedTools");
  });
  test("guardian reviewed profile also grants mandatory scanner tools", async () => {
    const guardian = (await claudeCodeAdapter.buildCommand(baseOpts({ role: "guardian" }))).args.join(" ");
    expect(guardian).toContain(GARELIER_GUARDIAN_ALLOWED_TOOLS.join(","));
    expect(guardian).toContain("Bash(gitleaks:*)");
    const worker = (await claudeCodeAdapter.buildCommand(baseOpts({ role: "worker" }))).args.join(" ");
    expect(worker).not.toContain("gitleaks");
  });
  test("autofixAllowedTools maps formatter commands to scoped Bash grants (DEC-049 C1)", () => {
    expect(autofixAllowedTools(["cargo fmt --all"])).toEqual(["Bash(cargo fmt:*)"]);
    expect(autofixAllowedTools(["go fmt ./..."])).toEqual(["Bash(go fmt:*)"]);
    expect(autofixAllowedTools(["ruff format ."])).toEqual(["Bash(ruff format:*)"]);
    expect(autofixAllowedTools(["gofmt -w ."])).toEqual(["Bash(gofmt:*)"]); // flag arg dropped
    expect(autofixAllowedTools([])).toEqual([]);
    expect(autofixAllowedTools(undefined)).toEqual([]);
    // AF-2: a prefix with a comma/paren would corrupt the comma-joined
    // --allowedTools string — such a grant is dropped, not emitted malformed.
    expect(autofixAllowedTools(["a,b fmt"])).toEqual([]);
    expect(autofixAllowedTools(["ok fmt", "bad,cmd"])).toEqual(["Bash(ok fmt:*)"]);
  });
  test("EVERY producer is granted its declared formatter; non-producers never are (F5)", async () => {
    const af = { autofixCommands: ["cargo fmt --all"] };
    for (const role of ["worker", "smith", "artisan"] as const) {
      const args = (await claudeCodeAdapter.buildCommand(baseOpts({ role, ...af }))).args.join(" ");
      expect(args).toContain("Bash(cargo fmt:*)");
      expect(args).toContain("Bash(git commit:*)");           // git set still present
    }
    // a producer WITHOUT a declared formatter keeps just the git set
    const plain = (await claudeCodeAdapter.buildCommand(baseOpts({ role: "worker" }))).args.join(" ");
    expect(plain).not.toContain("cargo fmt");
    // non-producer worktree roles never get the autofix grant even if passed
    for (const role of ["scout", "guardian"] as const) {
      const args = (await claudeCodeAdapter.buildCommand(baseOpts({ role, ...af }))).args.join(" ");
      expect(args).not.toContain("cargo fmt");
    }
    // guardian still gets its scanner grant
    const guardian = (await claudeCodeAdapter.buildCommand(baseOpts({ role: "guardian", ...af }))).args.join(" ");
    expect(guardian).toContain("Bash(gitleaks:*)");
  });
  test("worktree producers add their container instead of the whole project", async () => {
    for (const role of ["worker", "smith", "artisan"] as const) {
      const coordDir = role === "artisan"
        ? "/proj/__garelier/pm/_artisan"
        : `/proj/__garelier/pm/_${role}s/r1`;
      const dirs = addDirs((await claudeCodeAdapter.buildCommand(baseOpts({
        role,
        cwd: `${coordDir}/checkout`,
        coordDir,
      }))).args);
      expect(dirs).toContain(coordDir);
      expect(dirs).toContain("/skills/garelier-core");
      expect(dirs).not.toContain("/proj");
    }
  });
  test("checkout=false read-only roles keep projectRoot for source inspection", async () => {
    const dirs = addDirs((await claudeCodeAdapter.buildCommand(baseOpts({
      role: "scout",
      cwd: "/proj/__garelier/pm/_scouts/s1",
      coordDir: "/proj/__garelier/pm/_scouts/s1",
      checkout: false,
    }))).args);
    expect(dirs).toContain("/proj");
    expect(dirs).toContain("/skills/garelier-core");
  });
  test("exile coordination containers are still added explicitly", async () => {
    const workerDirs = addDirs((await claudeCodeAdapter.buildCommand(baseOpts({
      role: "worker",
      cwd: "/home/.garelier/studios/h/_workers/w1/checkout",
      coordDir: "/home/.garelier/studios/h/_workers/w1",
    }))).args);
    expect(workerDirs).toContain("/home/.garelier/studios/h/_workers/w1");
    expect(workerDirs).not.toContain("/proj");

    const scoutDirs = addDirs((await claudeCodeAdapter.buildCommand(baseOpts({
      role: "scout",
      cwd: "/home/.garelier/studios/h/_scouts/s1",
      coordDir: "/home/.garelier/studios/h/_scouts/s1",
      checkout: false,
    }))).args);
    expect(scoutDirs).toContain("/proj");
    expect(scoutDirs).toContain("/home/.garelier/studios/h/_scouts/s1");
  });
  test("explicit model is prepended; provider-name model is not", async () => {
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ model: "opus" }))).args.slice(0, 2))
      .toEqual(["--model", "opus"]);
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ model: "claude-code" }))).args)
      .not.toContain("--model");
  });
  test("providerCommand overrides spawnCmd overrides default", async () => {
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ spawnCmd: ["my-claude"] }))).cmd)
      .toEqual(["my-claude"]);
    expect((await claudeCodeAdapter.buildCommand(baseOpts({ spawnCmd: ["a"], providerCommand: ["b", "c"] }))).cmd)
      .toEqual(["b", "c"]);
  });
  test("parseOutput reads Claude JSON; falls back to raw on bad JSON", async () => {
    const ok = await claudeCodeAdapter.parseOutput({
      stdoutRaw: JSON.stringify({ result: "hi", total_cost_usd: 0.1, num_turns: 2, usage: { input_tokens: 5 } }),
      stderrRaw: "",
    });
    expect(ok.result).toBe("hi");
    expect(ok.costUsd).toBe(0.1);
    expect(ok.usage?.input_tokens).toBe(5);
    const bad = await claudeCodeAdapter.parseOutput({ stdoutRaw: "not json", stderrRaw: "" });
    expect(bad.result).toBe("not json");
  });
  test("looksRateLimited matches 429 / overloaded / provider session limits", () => {
    expect(claudeCodeAdapter.looksRateLimited("got a 429")).toBe(true);
    expect(claudeCodeAdapter.looksRateLimited("Overloaded")).toBe(true);
    expect(claudeCodeAdapter.looksRateLimited("You've hit your session limit · resets 1:40pm (Asia/Tokyo)")).toBe(true);
    expect(claudeCodeAdapter.looksRateLimited("all good")).toBe(false);
    expect(claudeCodeAdapter.looksRateLimited(undefined)).toBe(false);
  });
});

describe("codex-cli adapter (behavior lock)", () => {
  const dirs: string[] = [];
  function tmp() { const d = mkdtempSync(join(tmpdir(), "provadp-")); dirs.push(d); return d; }
  function cleanup() { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); }

  test("default command + workspace-write + result file + .codex stdin", async () => {
    const td = tmp();
    const promptFile = join(td, "worker.prompt");
    writeFileSync(promptFile, "ROLE PROMPT BODY", "utf8");
    const c = await codexCliAdapter.buildCommand(baseOpts({ cwd: "/proj/cwd", tmpDir: td, promptFile }));
    expect(c.cmd).toEqual(["codex"]);
    expect(c.args.slice(0, 2)).toEqual(["exec", "--cd"]);
    expect(c.args).toContain("workspace-write");
    expect(c.args).toContain("-c");
    expect(c.args).toContain('approval_policy="never"');
    expect(c.args).not.toContain("--ask-for-approval");
    expect(c.args[c.args.length - 1]).toBe("-");
    expect(c.stdinFile).toBe(`${promptFile}.codex`);
    expect(c.resultFile).toBe(join(td, "codex-last-message.txt"));
    // the .codex stdin file prepends the headless directive to the prompt
    expect(existsSync(c.stdinFile!)).toBe(true);
    expect(readFileSync(c.stdinFile!, "utf8")).toContain("ROLE PROMPT BODY");
    cleanup();
  });
  test("safe → read-only, dangerous → danger-full-access; effort + model", async () => {
    const td = tmp();
    const promptFile = join(td, "w.prompt"); writeFileSync(promptFile, "x", "utf8");
    expect((await codexCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "safe" }))).args)
      .toContain("read-only");
    expect((await codexCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "dangerous" }))).args)
      .toContain("danger-full-access");
    const withModel = await codexCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, model: "gpt-5-codex", effort: "xhigh" }));
    expect(withModel.args).toContain("gpt-5-codex");
    expect(withModel.args.join(" ")).toContain('model_reasoning_effort="xhigh"');
    cleanup();
  });
  test("parseOutput prefers the result file, falls back to stdout", async () => {
    const td = tmp();
    const rf = join(td, "codex-last-message.txt");
    writeFileSync(rf, "  final message  ", "utf8");
    expect((await codexCliAdapter.parseOutput({ stdoutRaw: "noise", stderrRaw: "", resultFile: rf })).result)
      .toBe("final message");
    expect((await codexCliAdapter.parseOutput({ stdoutRaw: "  only stdout ", stderrRaw: "", resultFile: join(td, "missing.txt") })).result)
      .toBe("only stdout");
    cleanup();
  });
});

import { geminiCliAdapter } from "./gemini_cli.ts";
import { copilotCliAdapter } from "./copilot_cli.ts";
import { cursorCliAdapter } from "./cursor_cli.ts";

describe("gemini-cli adapter (v1)", () => {
  test("default command + JSON output; model handling", async () => {
    expect(geminiCliAdapter.defaultCommand()).toEqual(["gemini"]);
    const c = await geminiCliAdapter.buildCommand(baseOpts());
    expect(c.args).toContain("--output-format");
    expect(c.args).toContain("json");
    expect(c.stdinFile).toBeUndefined(); // full prompt via stdin (role.ts promptFile)
    expect((await geminiCliAdapter.buildCommand(baseOpts({ model: "gemini-2.0" }))).args.slice(0, 2))
      .toEqual(["--model", "gemini-2.0"]);
    expect((await geminiCliAdapter.buildCommand(baseOpts({ model: "gemini-default" }))).args)
      .not.toContain("--model");
  });
  test("permission profile → approval-mode + sandbox (DEC-033)", async () => {
    const reviewed = (await geminiCliAdapter.buildCommand(baseOpts({ permissionProfile: "reviewed" }))).args.join(" ");
    expect(reviewed).toContain("--approval-mode auto_edit");
    expect(reviewed).toContain("--sandbox");
    expect((await geminiCliAdapter.buildCommand(baseOpts({ permissionProfile: "safe" }))).args.join(" "))
      .toContain("--approval-mode default");
    expect((await geminiCliAdapter.buildCommand(baseOpts({ permissionProfile: "dangerous" }))).args)
      .toContain("--yolo");
  });
  test("GARELIER_PROVIDER_GEMINI_CLI_PERMISSION=off disables the permission flags", async () => {
    process.env.GARELIER_PROVIDER_GEMINI_CLI_PERMISSION = "off";
    try {
      const args = (await geminiCliAdapter.buildCommand(baseOpts({ permissionProfile: "reviewed" }))).args.join(" ");
      expect(args).not.toContain("--approval-mode");
      expect(args).not.toContain("--sandbox");
      expect(args).toContain("--output-format"); // still functional
    } finally {
      delete process.env.GARELIER_PROVIDER_GEMINI_CLI_PERMISSION;
    }
  });
  test("parseOutput reads response/result; defensive on bad JSON", async () => {
    expect((await geminiCliAdapter.parseOutput({ stdoutRaw: JSON.stringify({ response: "hi" }), stderrRaw: "" })).result).toBe("hi");
    expect((await geminiCliAdapter.parseOutput({ stdoutRaw: "plain text", stderrRaw: "" })).result).toBe("plain text");
  });
});

describe("copilot-cli adapter (v1, strict tools)", () => {
  const dirs2: string[] = [];
  function tmp2() { const d = mkdtempSync(join(tmpdir(), "cpadp-")); dirs2.push(d); return d; }
  function clean2() { for (const d of dirs2.splice(0)) rmSync(d, { recursive: true, force: true }); }

  test("reviewed args: no-ask-user, no-remote, deny git push/pull, wrapper stdin, model auto", async () => {
    const td = tmp2();
    const promptFile = join(td, "w.prompt"); writeFileSync(promptFile, "BODY", "utf8");
    const c = await copilotCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile }));
    expect(c.cmd).toEqual(["copilot"]);
    expect(c.args).toContain("--no-ask-user");
    expect(c.args).toContain("--no-remote");
    expect(c.args).toContain("shell(git push)");
    expect(c.args).toContain("shell(git pull)");
    expect(c.args).toContain("--disable-builtin-mcps");
    expect(c.args.slice(-2)).toEqual(["--model", "auto"]);
    expect(c.stdinFile).toBe(`${promptFile}.wrapper`);
    expect(readFileSync(c.stdinFile!, "utf8")).toContain(promptFile);
    expect(existsSync(c.stdinFile!)).toBe(true);
    clean2();
  });
  test("safe profile = plan + deny write/shell; never --allow-all/--yolo", async () => {
    const td = tmp2();
    const promptFile = join(td, "w.prompt"); writeFileSync(promptFile, "x", "utf8");
    const c = await copilotCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "safe" }));
    expect(c.args).toContain("plan");
    expect(c.args).toContain("write"); // as a deny-tool target
    expect(c.args.join(" ")).not.toContain("--allow-all");
    expect(c.args.join(" ")).not.toContain("--yolo");
    clean2();
  });
  test("parseOutput keeps last JSONL message; raw fallback", async () => {
    const jsonl = '{"type":"x"}\n{"result":"first"}\nnoise\n{"result":"final"}';
    expect((await copilotCliAdapter.parseOutput({ stdoutRaw: jsonl, stderrRaw: "" })).result).toBe("final");
    expect((await copilotCliAdapter.parseOutput({ stdoutRaw: "just text", stderrRaw: "" })).result).toBe("just text");
  });
});

describe("cursor-cli adapter (experimental)", () => {
  const dirs3: string[] = [];
  function tmp3() { const d = mkdtempSync(join(tmpdir(), "curadp-")); dirs3.push(d); return d; }
  function clean3() { for (const d of dirs3.splice(0)) rmSync(d, { recursive: true, force: true }); }

  test("default command cursor-agent; wrapper stdin; model handling", async () => {
    expect(cursorCliAdapter.defaultCommand()).toEqual(["cursor-agent"]);
    const td = tmp3();
    const promptFile = join(td, "w.prompt"); writeFileSync(promptFile, "x", "utf8");
    const c = await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile }));
    expect(c.stdinFile).toBe(`${promptFile}.wrapper`);
    expect((await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, model: "auto" }))).args).not.toContain("--model");
    expect((await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, model: "sonnet" }))).args).toContain("sonnet");
    clean3();
  });
  test("permission profile → auto-run --force; safe omits it; env off disables (DEC-033)", async () => {
    const td = tmp3();
    const promptFile = join(td, "w.prompt"); writeFileSync(promptFile, "x", "utf8");
    expect((await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "reviewed" }))).args).toContain("--force");
    expect((await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "dangerous" }))).args).toContain("--force");
    expect((await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "safe" }))).args).not.toContain("--force");
    process.env.GARELIER_PROVIDER_CURSOR_CLI_PERMISSION = "0";
    try {
      expect((await cursorCliAdapter.buildCommand(baseOpts({ tmpDir: td, promptFile, permissionProfile: "reviewed" }))).args).not.toContain("--force");
    } finally {
      delete process.env.GARELIER_PROVIDER_CURSOR_CLI_PERMISSION;
    }
    clean3();
  });
  test("parseOutput JSON or raw fallback", async () => {
    expect((await cursorCliAdapter.parseOutput({ stdoutRaw: JSON.stringify({ result: "ok" }), stderrRaw: "" })).result).toBe("ok");
    expect((await cursorCliAdapter.parseOutput({ stdoutRaw: "raw", stderrRaw: "" })).result).toBe("raw");
  });
});
