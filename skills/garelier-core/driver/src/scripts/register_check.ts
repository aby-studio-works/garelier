#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { inspectCapturedRegister, readCapturedRegisterInput } from "./provider_session.ts";

function usage(): never {
  throw new Error("usage: register_check.ts <register-path> --instructions <instructions.md>");
}

export function main(argv = process.argv.slice(2)): number {
  if (argv.length !== 3 || argv[1] !== "--instructions" || !argv[0] || !argv[2]) usage();
  const registerPath = resolve(argv[0]);
  const instructionsPath = resolve(argv[2]);
  const container = dirname(instructionsPath);
  const canonicalInstructions = resolve(container, "instructions.md");
  if (canonicalInstructions !== instructionsPath) {
    throw new Error(`--instructions must name the dispatch record at ${canonicalInstructions}`);
  }

  // The launcher's capture reader derives commit shape from the pre-launch
  // dispatch fact pack. The standalone validator supplies no proxy switch and
  // therefore cannot drift from capture or Dock proxy admission (W-807).
  const findings = inspectCapturedRegister(readCapturedRegisterInput({
    container,
    resultFile: registerPath,
  }));
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding.code}: ${finding.message}\n`);
    return 2;
  }
  process.stdout.write("register_check: PASS\n");
  return 0;
}

if (import.meta.main) {
  try { process.exit(main()); }
  catch (error) {
    process.stderr.write(`register_check: ${(error as Error).message}\n`);
    process.exit(2);
  }
}
