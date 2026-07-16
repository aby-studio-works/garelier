#!/usr/bin/env bun
// Compatibility entry: historical CLI delegates to the consolidated command.
import { statusWebMain } from "./status_web_cli.ts";
statusWebMain(["start", ...process.argv.slice(2)]);
