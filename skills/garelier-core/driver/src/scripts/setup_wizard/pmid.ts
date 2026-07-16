// W-083 ts-first: pm_id validation + interactive resolution.
//
// Faithful port of validate_pm_id / default_pm_id / resolve_pm_id_interactively
// (setup_wizard.sh 1040-1064, 2163-2203). validatePmId prints the bash's exact
// stderr text (note the en-dash in "1–20 characters") and returns a boolean.

const PM_ID_RE = /^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$/;

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function validatePmId(id: string): boolean {
  if (id === "") {
    err("Error: pm_id is empty.");
    return false;
  }
  if (id === "_workshop") return true;
  if (id.length < 1 || id.length > 20) {
    err(`Error: pm_id '${id}' must be 1–20 characters.`);
    return false;
  }
  if (!PM_ID_RE.test(id)) {
    err(`Error: pm_id '${id}' must match [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?.`);
    err("       (lowercase ASCII + digits + internal hyphens, no leading/trailing hyphen)");
    return false;
  }
  return true;
}

export function defaultPmId(): string {
  return "_workshop";
}

// Read a single line synchronously from stdin (for the interactive prompt).
function readLineSync(): string {
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  const fs = require("node:fs") as typeof import("node:fs");
  while (true) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const c = buf[0];
    if (c === 0x0a) break; // \n
    bytes.push(c);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}

// resolve_pm_id_interactively — sets and returns the resolved pm_id or exits.
export function resolvePmIdInteractively(pmId: string, skipConfirm: boolean): string {
  if (pmId !== "") {
    if (!validatePmId(pmId)) process.exit(1);
    return pmId;
  }
  const defaultId = defaultPmId();
  if (!process.stdin.isTTY) {
    err("Error: --pm-id was not provided and stdin is not a terminal.");
    err("  Re-run with --pm-id _workshop for a single-user project,");
    err("  or a unique --pm-id <slug> for a shared/multi-user project.");
    process.exit(2);
  }
  if (skipConfirm) {
    if (defaultId === "") {
      err("Error: no default pm_id is available; pass --pm-id explicitly.");
      process.exit(1);
    }
    if (!validatePmId(defaultId)) process.exit(1);
    return defaultId;
  }
  while (true) {
    if (defaultId !== "") process.stderr.write(`PM identifier (default: ${defaultId}): `);
    else process.stderr.write("PM identifier: ");
    let entered = readLineSync();
    if (entered === "") entered = defaultId;
    if (validatePmId(entered)) return entered;
  }
}
