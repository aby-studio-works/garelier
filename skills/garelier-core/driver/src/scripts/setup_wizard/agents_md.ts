// W-083 ts-first: fresh-mode AGENTS.md templating.
//
// Faithful port of the AGENTS.md sed/awk templating in the FRESH body of
// setup_wizard.sh (lines 3387-3442): stack-derived language/build/test fill, the
// two sed passes (base + minimal), the awk collapse of the one multi-line
// {{...}} block, and the quality-gate line expansion. All placeholder patterns
// are literal in the template, so literal split/join reproduces sed exactly.

export interface AgentsMdOpts {
  projectName: string;
  target: string;
  targetSlug: string;
  pmId: string;
  stack: string;
  agentsPolicy: string; // strict | minimal
  qgCmds: string[];
}

function stackLangBuildTest(stack: string): [string, string, string] {
  switch (stack) {
    case "rust": return ["Rust", "cargo build --workspace", "cargo test --workspace"];
    case "typescript": return ["TypeScript", "npm run build", "npm test"];
    case "python": return ["Python", "python -m build", "pytest"];
    case "go": return ["Go", "go build ./...", "go test ./..."];
    default: return ["(edit: project language(s))", "(see Quality gate below)", "(see Quality gate below)"];
  }
}

// Render the AGENTS.md body from the template text.
export function renderAgentsMd(template: string, o: AgentsMdOpts): string {
  const [agLang, agBuild, agTest] = stackLangBuildTest(o.stack);

  let text = template;
  const sub = (find: string, replace: string): void => {
    text = text.split(find).join(replace);
  };
  // sed pass 1 (base fields).
  sub("{{project_name}}", o.projectName);
  sub("{{target_branch}}", o.target);
  sub("{{target_slug}}", o.targetSlug);
  sub("{{pm_id}}", o.pmId);
  sub("{{e.g., Rust, TypeScript, Python}}", agLang);
  sub("{{e.g., cargo build, npm run build}}", agBuild);
  sub("{{e.g., cargo test, npm test}}", agTest);
  sub("{{e.g., a project-specific asset/integrity check, or none}}", "(none — configure if this project has an asset check)");

  if (o.agentsPolicy === "minimal") {
    // sed pass 2 (project-specific placeholders).
    sub("{{file_path_or_glob}}", "(none initially)");
    sub("{{worker_id}}", "-");
    sub("{{reason}}", "add conflict-prone files here as they emerge");
    sub("{{convention_1}}", "Follow the existing project style and conventions.");
    sub("{{convention_2}}", "(add project-specific conventions as they emerge)");
    // awk collapse of the one multi-line {{...}} block (§8 bilingual policy).
    text = collapseMultilineBlock(text);
  }

  // Quality-gate line expansion: replace the {{quality_gate_command_1}} line
  // with the resolved command set, drop the {{quality_gate_command_2}} line.
  return expandQualityGate(text, o.qgCmds);
}

// awk:
//   skip==1 { if ($0 ~ /}}/) skip=0; next }
//   /{{[^}]*$/ { print "Follow the existing documentation language conventions."; skip=1; next }
//   { print }
function collapseMultilineBlock(text: string): string {
  const trailingNL = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNL) lines.pop();
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (skip) {
      if (/\}\}/.test(line)) skip = false;
      continue;
    }
    if (/\{\{[^}]*$/.test(line)) {
      out.push("Follow the existing documentation language conventions.");
      skip = true;
      continue;
    }
    out.push(line);
  }
  return trailingNL ? `${out.join("\n")}\n` : out.join("\n");
}

function expandQualityGate(text: string, qgCmds: string[]): string {
  const trailingNL = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNL) lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    if (line.includes("{{quality_gate_command_1}}")) {
      for (const c of qgCmds) out.push(c);
    } else if (line.includes("{{quality_gate_command_2}}")) {
      // dropped
    } else {
      out.push(line);
    }
  }
  // The bash writes each echoed line + "\n" (AGENTS_TMP ends with a newline so
  // every record is read); the file always ends with a trailing newline.
  return `${out.join("\n")}\n`;
}
