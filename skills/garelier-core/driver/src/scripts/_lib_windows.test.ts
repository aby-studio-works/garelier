import { expect, test } from "bun:test";
import { compileProcessCount, probePidLiveness, resolveBashExecutable, resolveBashLaunch, resolveCommand, resolveRuntimeExecutable, type CommandRunner, type RunResult } from "./_lib.ts";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (): RunResult => ({ exitCode: 1, stdout: "", stderr: "" });

// W-169: a Git Bash `$$` MSYS pid is invisible to Windows tasklist. The probe
// must fall back to `ps` (MSYS PID = column 1) so a live git-bash lock owner is
// never mis-read as dead and reclaimed. `kill` throwing ESRCH forces the fall-
// through past the OS-signal fast path (an MSYS pid is not a live Windows PID).
const notAWindowsPid = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
const PS_WITH = (msysPid: number) =>
  ok(`    PID    PPID    PGID     WINPID  TTY         UID    STIME COMMAND\n   ${msysPid}    1758    1758      28104  ?         197610 09:20:11 /usr/bin/bash\n`);

test("W-169: a live MSYS pid missed by tasklist is found alive via ps (no false reclaim)", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    if (command[0] === "tasklist") return ok('INFO: No tasks are running which match the specified criteria.');
    return PS_WITH(1620); // MSYS `ps` column 1 carries the git-bash pid
  };
  expect(probePidLiveness(1620, { platform: "win32", runner, kill: notAWindowsPid }))
    .toEqual({ alive: true, via: "msys-ps" });
  expect(calls[0]).toEqual(["tasklist", "/FI", "PID eq 1620"]);
  expect(calls[1]).toEqual(["ps"]);
});

test("W-169: a genuinely dead pid (tasklist AND ps both miss) reads dead → reclaimable", () => {
  const runner: CommandRunner = (command) =>
    command[0] === "tasklist" ? ok("INFO: No tasks are running") : PS_WITH(9999);
  expect(probePidLiveness(1620, { platform: "win32", runner, kill: notAWindowsPid }))
    .toEqual({ alive: false, via: "dead" });
});

test("W-169: a live Windows pid is found via tasklist (ps not consulted)", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    return ok('"cargo.exe","1620","Console","1","10,000 K"');
  };
  expect(probePidLiveness(1620, { platform: "win32", runner, kill: notAWindowsPid }))
    .toEqual({ alive: true, via: "tasklist" });
  expect(calls).toEqual([["tasklist", "/FI", "PID eq 1620"]]); // no ps fallback needed
});

test("W-169: an OS-signal hit short-circuits before any process list", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => { calls.push(command); return ok(""); };
  expect(probePidLiveness(1620, { platform: "win32", runner, kill: () => {} }))
    .toEqual({ alive: true, via: "os-signal" });
  expect(calls).toEqual([]);
});

test("W-169(b): an unprobeable pid (no tasklist AND no ps) is grace-alive, not reclaimed", () => {
  // Neither Windows nor MSYS process tooling can run -> we cannot prove the owner
  // is gone, so fail ALIVE (grace) rather than false-reclaim on an unproven pid.
  const runner: CommandRunner = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  expect(probePidLiveness(1620, { platform: "win32", runner, kill: notAWindowsPid }))
    .toEqual({ alive: true, via: "unknown" });
});

test("W-169: a non-positive / non-integer pid is dead without probing", () => {
  expect(probePidLiveness(0).via).toBe("dead");
  expect(probePidLiveness("unknown").via).toBe("dead");
  expect(probePidLiveness(-5).alive).toBe(false);
});

test("Windows Git Bash resolution survives a PATH without bash", () => {
  const installed = "C:\\Program Files\\Git\\bin\\bash.exe";
  const resolved = resolveBashExecutable({
    platform: "win32",
    env: { PATH: "C:\\tools\\codex-only", ProgramFiles: "C:\\Program Files", SystemDrive: "C:" },
    isFile: (path) => path.toLowerCase() === installed.toLowerCase(),
  });
  expect(resolved).toBe(installed);
});

test("Windows Git Bash resolution prefers the explicit override before PATH", () => {
  const pathBash = "D:\\portable\\git\\bash.exe";
  const override = "E:\\custom\\bash.exe";
  const both = new Set([pathBash.toLowerCase(), override.toLowerCase()]);
  expect(resolveBashExecutable({
    platform: "win32", env: { PATH: "D:\\portable\\git", GARELIER_BASH: override },
    isFile: (path) => both.has(path.toLowerCase()),
  })).toBe(override);
  expect(resolveBashExecutable({
    platform: "win32", env: { PATH: "D:\\missing", GARELIER_BASH: override },
    isFile: (path) => path.toLowerCase() === override.toLowerCase(),
  })).toBe(override);
});

test("relative overrides and relative PATH entries are never executable authorities", () => {
  expect(resolveRuntimeExecutable("git", {
    platform: "win32",
    env: { GARELIER_GIT: ".\\attacker\\git.exe", PATH: ".\\attacker" },
    canonicalizeFile: () => null,
  })).toBeNull();
  expect(resolveBashExecutable({
    platform: "win32",
    env: { GARELIER_BASH: "tools\\bash.exe", PATH: "tools" },
    canonicalizeFile: () => null,
  })).toBeNull();
});

test("reparse shims return only their canonical absolute regular target", () => {
  const shim = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe";
  const target = "C:\\Program Files\\Codex\\codex.exe";
  expect(resolveRuntimeExecutable("codex", {
    platform: "win32",
    env: { PATH: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links" },
    canonicalizeFile: (path) => path.toLowerCase() === shim.toLowerCase() ? target : null,
  })).toBe(target);
  expect(resolveRuntimeExecutable("codex", {
    platform: "win32",
    env: { PATH: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links" },
    canonicalizeFile: () => null,
  })).toBeNull();
});

test("cygpath derives from the canonical Git Bash root", () => {
  const bashShim = "C:\\Program Files\\Git\\bin\\bash.exe";
  const bashTarget = "D:\\Git\\bin\\bash.exe";
  const cygpath = "D:\\Git\\usr\\bin\\cygpath.exe";
  expect(resolveRuntimeExecutable("cygpath", {
    platform: "win32",
    env: { GARELIER_BASH: bashShim, PATH: "C:\\Empty" },
    canonicalizeFile: (path) => {
      if (path.toLowerCase() === bashShim.toLowerCase()) return bashTarget;
      if (path.toLowerCase() === cygpath.toLowerCase()) return cygpath;
      return null;
    },
  })).toBe(cygpath);
});

test("POSIX resolves Bash to an absolute PATH entry", () => {
  expect(resolveBashExecutable({
    platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" },
    isFile: (path) => path === "/usr/bin/bash",
  })).toBe("/usr/bin/bash");
});

test("Windows Bash launch prepends the resolved standard or override bin to sanitized PATH", () => {
  const standard = "C:\\Program Files\\Git\\bin\\bash.exe";
  const bun = "C:\\Runtime Tools\\Bun\\bun.exe";
  const fromStandard = resolveBashLaunch({
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" },
    processExecPath: bun,
    isFile: (path) => [standard, bun].some((candidate) => path.toLowerCase() === candidate.toLowerCase()),
  });
  expect(fromStandard?.executable).toBe(standard);
  expect(fromStandard?.env.PATH).toBe("C:\\Runtime Tools\\Bun;C:\\Program Files\\Git\\bin;C:\\Windows\\System32");

  const override = "D:\\portable tools\\Git Bash\\bash.exe";
  const fromOverride = resolveBashLaunch({
    platform: "win32",
    env: { Path: "C:\\Windows\\System32", GARELIER_BASH: override },
    processExecPath: bun,
    isFile: (path) => [override, bun].some((candidate) => path.toLowerCase() === candidate.toLowerCase()),
  });
  expect(fromOverride?.executable).toBe(override);
  expect(fromOverride?.env.Path).toBe("C:\\Runtime Tools\\Bun;D:\\portable tools\\Git Bash;C:\\Windows\\System32");
  expect(fromOverride?.env.PATH).toBeUndefined();
});

test("runtime resolution is override then PATH then Windows standard location", () => {
  const override = "D:\\Pinned Tools\\git.exe";
  const pathGit = "E:\\Path Tools\\git.exe";
  const standard = "C:\\Program Files\\Git\\cmd\\git.exe";
  const files = new Set([override, pathGit, standard].map((path) => path.toLowerCase()));
  const base = { platform: "win32" as const, isFile: (path: string) => files.has(path.toLowerCase()) };
  expect(resolveRuntimeExecutable("git", { ...base, env: { GARELIER_GIT: override, PATH: "E:\\Path Tools" } })).toBe(override);
  expect(resolveRuntimeExecutable("git", { ...base, env: { PATH: "E:\\Path Tools" } })).toBe(pathGit);
  expect(resolveRuntimeExecutable("git", { ...base, env: { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" } })).toBe(standard);
});

test("configured command resolves arbitrary executables from sanitized PATH", () => {
  const gate = "C:\\Gate Tools\\custom-check.exe";
  expect(resolveCommand(["custom-check", "--strict", "value with spaces"], {
    platform: "win32", env: { PATH: "C:\\Gate Tools", PATHEXT: ".EXE" },
    isFile: (path) => path.toLowerCase() === gate.toLowerCase(),
  })).toEqual([gate, "--strict", "value with spaces"]);
  expect(resolveCommand(["missing-check"], {
    platform: "win32", env: { PATH: "C:\\Empty", PATHEXT: ".EXE" }, isFile: () => false,
  })).toBeNull();
});

test("configured bunx resolves only an existing local executable", () => {
  const bunx = "C:\\Runtime Tools\\bunx.exe";
  expect(resolveCommand(["bunx", "tsc", "--noEmit"], {
    platform: "win32", env: { PATH: "C:\\Runtime Tools", PATHEXT: ".EXE" },
    isFile: (path) => path.toLowerCase() === bunx.toLowerCase(),
  })).toEqual([bunx, "tsc", "--noEmit"]);
});

test("configured Windows gate tools resolve override then sanitized PATH then standard location", () => {
  const cargo = "C:\\Users\\tester\\.cargo\\bin\\cargo.exe";
  const override = "D:\\Pinned Tools\\cargo.exe";
  const files = new Set([cargo, override].map((path) => path.toLowerCase()));
  const base = { platform: "win32" as const, isFile: (path: string) => files.has(path.toLowerCase()) };
  expect(resolveRuntimeExecutable("cargo", { ...base, env: { GARELIER_CARGO: override, PATH: "C:\\Empty", USERPROFILE: "C:\\Users\\tester" } })).toBe(override);
  expect(resolveRuntimeExecutable("cargo", { ...base, env: { PATH: "C:\\Empty", USERPROFILE: "C:\\Users\\tester" } })).toBe(cargo);
});

test("Windows compile enumeration uses native tasklist and counts image names", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    return ok([
      '"cargo.exe","120","Console","1","10,000 K"',
      '"sccache.exe","121","Console","1","9,000 K"',
      '"rustc.exe","122","Console","1","20,000 K"',
      '"editor.exe","123","Console","1","30,000 K"',
    ].join("\r\n"));
  };
  expect(compileProcessCount("cargo(\\.exe)?|rustc(\\.exe)?|sccache(\\.exe)?", { platform: "win32", runner })).toBe(2);
  expect(calls).toEqual([["tasklist", "/FO", "CSV", "/NH"]]);
});

test("Windows compile enumeration fails open when tasklist is unavailable", () => {
  expect(compileProcessCount("cargo(\\.exe)?", { platform: "win32", runner: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } })).toBe(0);
});

test("W-166: Windows falls back to ps when tasklist enumerates no matching compile", () => {
  // tasklist lists native PE image names only; MSYS/cygwin build helpers (and the
  // dispatch_watch oracle's `sleep` proxy) are invisible to it by their POSIX name.
  // When tasklist matches nothing, consult Git Bash `ps` so those still register —
  // a strict superset that can only raise a zero to the true count.
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    if (command[0] === "tasklist") return ok('"explorer.exe","1","Console","1","10 K"');
    return ok("  1761  1758  1758  2820  ?  197610 23:28:58 /usr/bin/sleep\n");
  };
  expect(compileProcessCount("sleep", { platform: "win32", runner })).toBe(1);
  expect(calls).toEqual([["tasklist", "/FO", "CSV", "/NH"], ["ps", "-W"]]);
});

test("W-166: Windows does NOT consult ps once tasklist already found a native compile", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    return ok('"cargo.exe","120","Console","1","10,000 K"');
  };
  expect(compileProcessCount("cargo(\\.exe)?", { platform: "win32", runner })).toBe(1);
  expect(calls).toEqual([["tasklist", "/FO", "CSV", "/NH"]]); // fallback skipped when a match exists
});

test("W-143 (N-3): tasklist ERRORING (non-zero exit) falls through to ps", () => {
  // A tasklist that returns a non-zero exit (not a throw — e.g. a filtered query
  // error / access-denied) is not exitCode===0, so the native branch is skipped
  // and the ps probe still registers an MSYS build. Distinct from the exitCode===0
  // + no-match case (W-166 above) and the throw case (fails-open below).
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    if (command[0] === "tasklist") return { exitCode: 1, stdout: "", stderr: "ERROR: Access is denied." };
    return ok("  1761  1758  1758  2820  ?  197610 23:28:58 /usr/bin/sleep\n");
  };
  expect(compileProcessCount("sleep", { platform: "win32", runner })).toBe(1);
  expect(calls).toEqual([["tasklist", "/FO", "CSV", "/NH"], ["ps", "-W"]]);
});

test("W-143 (N-3): tasklist THROWING but ps working still counts the MSYS build", () => {
  // The catch path (tasklist binary missing / spawn error) must not zero out a real
  // MSYS compile when ps IS available — it only fails open when ps also cannot run
  // (the pre-existing 'fails open when tasklist is unavailable' case throws for ALL).
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    if (command[0] === "tasklist") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return ok("  1761  1758  1758  2820  ?  197610 23:28:58 /usr/bin/sleep\n");
  };
  expect(compileProcessCount("sleep", { platform: "win32", runner })).toBe(1);
  expect(calls).toEqual([["tasklist", "/FO", "CSV", "/NH"], ["ps", "-W"]]);
});

test("POSIX compile enumeration preserves ps fallback behavior", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    if (command[1] === "-W") return fail();
    return ok("  10 /usr/bin/cargo build\n  11 /usr/bin/sccache\n  12 /usr/bin/rustc crate.rs\n");
  };
  expect(compileProcessCount("cargo|rustc|sccache", { platform: "linux", runner })).toBe(2);
  expect(calls).toEqual([["ps", "-W"], ["ps", "-e"]]);
});
