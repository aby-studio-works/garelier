#!/usr/bin/env bun
// Project-owned, optional command_guard shim. A repository may track this file
// without requiring Garelier on every contributor machine: when the installed
// guard is absent it exits successfully; otherwise stdin/stdout and the exit
// code pass through unchanged.
import { existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const guard =
  process.env.GARELIER_COMMAND_GUARD ??
  join(home, ".claude", "skills", "garelier-core", "driver", "src", "guard", "command_guard.ts");

if (!existsSync(guard)) process.exit(0);

const child = Bun.spawnSync([process.execPath, guard], { windowsHide: true,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(child.exitCode);
