#!/usr/bin/env bun
import { resolve } from "node:path";
import { resolveControlRoots } from "../driver/src/control/roots.ts";
import { buildControl } from "../driver/src/status_control.ts";
import { readStableControl } from "../driver/src/control/generation.ts";

function expandEquals(argv: string[]): string[] {
  return argv.flatMap((arg) => {
    if (!arg.startsWith("--")) return [arg];
    const index = arg.indexOf("=");
    return index > 2 ? [arg.slice(0, index), arg.slice(index + 1)] : [arg];
  });
}

const argv = expandEquals(process.argv.slice(2));
let project = process.cwd();
let pmId = "_workshop";
let container: string | undefined;
let format = "summary";
let validate = false;
const valueAfter = (index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--project") { project = resolve(valueAfter(i, arg)); i++; }
  else if (arg === "--pm-id") { pmId = valueAfter(i, arg); i++; }
  else if (arg === "--container") { container = valueAfter(i, arg); i++; }
  else if (arg === "--format") { format = valueAfter(i, arg); i++; }
  else if (arg === "--validate") validate = true;
  else if (arg === "--help" || arg === "-h") {
    console.log("usage: control_graph.ts [--project <root>] [--container <id>] [--pm-id <id>] [--format summary|json|mermaid] [--validate]");
    process.exit(0);
  } else throw new Error(`unknown argument: ${arg}`);
}
if (!["summary", "json", "mermaid"].includes(format)) throw new Error(`--format must be summary, json, or mermaid (got ${format})`);
const roots = resolveControlRoots(project, pmId, container);
const info = readStableControl(
  { controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot },
  () => buildControl(resolve(roots.garelierRoot, ".."), pmId),
);
if (format === "json") console.log(JSON.stringify(info, null, 2));
else if (format === "mermaid") console.log(info.mermaid);
else {
  console.log(`control: ${info.present ? info.rootRel : "not present"}  mode=${info.mode ?? "unknown"}`);
  console.log(`nodes: ${info.nodes.length}  edges: ${info.edges.length}  findings: ${info.findings.length}`);
  for (const finding of info.findings) console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}${finding.rel ? ` (${finding.rel})` : ""}`);
}
if (validate && (!info.present || info.findings.some((finding) => finding.severity === "error"))) process.exit(1);
