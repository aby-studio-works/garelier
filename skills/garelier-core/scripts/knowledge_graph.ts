#!/usr/bin/env bun
import { resolve } from "node:path";
import { buildKnowledgeGraph } from "../driver/src/status_knowledge_graph.ts";

let project = process.cwd();
let format = "summary";
let validate = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--project") project = resolve(process.argv[++i]);
  else if (a === "--pm-id") i++; // accepted for command parity; graph is project-wide
  else if (a === "--format") format = process.argv[++i];
  else if (a === "--validate") validate = true;
  else if (a === "--help" || a === "-h") {
    console.log("usage: knowledge_graph.ts [--project <root>] [--pm-id <id>] [--format summary|json|mermaid] [--validate]");
    process.exit(0);
  } else throw new Error(`unknown argument: ${a}`);
}
const graph = buildKnowledgeGraph(project);
if (format === "json") console.log(JSON.stringify(graph, null, 2));
else if (format === "mermaid") console.log(graph.mermaid);
else {
  console.log(`knowledge nodes: ${graph.nodes.length}  edges: ${graph.edges.length}  findings: ${graph.findings.length}`);
  for (const f of graph.findings) console.log(`${f.severity.toUpperCase()} ${f.code}: ${f.message}${f.rel ? ` (${f.rel})` : ""}`);
}
if (validate && graph.findings.some((f) => f.severity === "error")) process.exit(1);
