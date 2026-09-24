#!/usr/bin/env bun
import { migrateControlReportLogs } from "../control/report_retention.ts";

const HELP = `migrate_control_report_logs.ts --project <root> --pm-id <id> --inspection <control-relative-path> [--target-root <root>] [--apply]

Without --apply, prints the planned file count and before/after bytes. The PM
must choose the durable inspection path and explicitly apply the one-time
migration. Full raw bytes move to runtime retention; tracked logs become bounded
excerpts carrying SHA-256 and the runtime pointer.`;

export function main(argv = process.argv.slice(2)): number {
  let project = "", targetRoot = "", pmId = "", inspection = "", apply = false;
  const value = (index: number): string => {
    const result = argv[index + 1];
    if (!result) throw new Error(`${argv[index]} requires a value`);
    return result;
  };
  try {
    for (let index = 0; index < argv.length;) {
      switch (argv[index]) {
        case "--project": project = value(index); index += 2; break;
        case "--target-root": targetRoot = value(index); index += 2; break;
        case "--pm-id": pmId = value(index); index += 2; break;
        case "--inspection": inspection = value(index); index += 2; break;
        case "--apply": apply = true; index += 1; break;
        case "-h": case "--help": process.stdout.write(`${HELP}\n`); return 0;
        default: throw new Error(`unknown arg: ${argv[index]}`);
      }
    }
    if (!project || !pmId || !inspection) throw new Error("--project, --pm-id, and --inspection are required");
    const result = migrateControlReportLogs({ project, targetRoot: targetRoot || undefined, pmId, inspectionPath: inspection, apply });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`migrate_control_report_logs: ${(error as Error).message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exit(main());
