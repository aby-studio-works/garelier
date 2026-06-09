#!/usr/bin/env bun
// PM history validator (DEC-051 fixed-schema, kills per-AI/session variance).
//
// Non-mandatory + non-retroactive: NEW-format entries (those that carry a
// "- Reason:" line) are validated strictly; pre-existing legacy entries are only
// reported as warnings, so adopting the schema does not fail an existing history.
// Run by Garelier's pipeline / framework ci.sh / opt-in. A no-op when the file
// is absent.
//
// Usage: bun lint_history.ts <history.md> [--strict-legacy]
// Exit 0 = pass, 1 = new-format violations.

const OUTCOMES = ["in-progress", "shipped", "abandoned", "aborted", "setup-only", "setup-change", "promoted", "merge-resolution", "blocked"];
const REASON_CODES = ["user-request", "scheduled", "escalation-resolved", "rework-complete", "setup", "promote-approved", "conflict-resolved", "abort-user", "abort-blocker", "autonomous-decision"];
const REQUIRED = ["Blueprint", "Milestone", "Outcome", "Reason", "Decision", "Escalation", "Commits", "Follow-up"];
const NOTES_MAX_LINES = 4;

export interface HistoryIssue { entry: string; level: "error" | "warn"; msg: string }

export function lintHistory(text: string): HistoryIssue[] {
  const issues: HistoryIssue[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Split into entry blocks at "## #NNN — …" (NNN = unbounded, min 3 per ID rule).
  const heads: { idx: number; id: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^##\s+#([0-9]{3,})\b/);
    if (m) heads.push({ idx: i, id: `#${m[1]}` });
  });
  if (heads.length === 0) return issues;
  let prevNum = -1;
  for (let h = 0; h < heads.length; h++) {
    const { idx, id } = heads[h];
    const end = h + 1 < heads.length ? heads[h + 1].idx : lines.length;
    const block = lines.slice(idx, end);
    const head = block[0];
    if (!/^##\s+#[0-9]{3,}\s+—\s+\S.*\s+—\s+\S/.test(head)) {
      issues.push({ entry: id, level: "error", msg: 'head must be "## #NNN — <ISO timestamp> — <title>"' });
    }
    const num = parseInt(id.slice(1), 10);
    if (prevNum >= 0 && num <= prevNum) issues.push({ entry: id, level: "warn", msg: `non-increasing entry number after #${prevNum}` });
    prevNum = num;

    const field = (name: string) => block.find((l) => l.startsWith(`- ${name}:`))?.slice(name.length + 3).trim();
    const isNew = block.some((l) => l.startsWith("- Reason:"));
    const lvl: "error" | "warn" = isNew ? "error" : "warn";

    for (const r of REQUIRED) {
      if (!block.some((l) => l.startsWith(`- ${r}:`))) {
        issues.push({ entry: id, level: r === "Reason" ? "warn" : lvl, msg: `missing required field "- ${r}:"${isNew ? "" : " (legacy entry)"}` });
      }
    }
    const outcome = field("Outcome");
    if (outcome && !OUTCOMES.includes(outcome)) issues.push({ entry: id, level: lvl, msg: `Outcome "${outcome}" not in enum` });
    const reason = field("Reason");
    if (reason) {
      const code = reason.split(/\s+—\s+|\s+-\s+/)[0]?.trim();
      if (!code || !REASON_CODES.includes(code)) issues.push({ entry: id, level: "error", msg: `Reason must start with a reason-code (${REASON_CODES.join("|")}) — got "${reason.slice(0, 40)}"` });
    }
    // Notes budget + no pasted diffs/logs.
    const nIdx = block.findIndex((l) => l.startsWith("- Notes:"));
    if (nIdx >= 0) {
      const notes = block.slice(nIdx).join("\n");
      const noteLines = block.slice(nIdx).filter((l) => l.trim() !== "");
      if (noteLines.length > NOTES_MAX_LINES) issues.push({ entry: id, level: lvl, msg: `Notes is ${noteLines.length} lines > ${NOTES_MAX_LINES} (WHY-only, no narrative)` });
      if (/^(diff --git |@@ |index [0-9a-f]{4,}\.\.)/m.test(notes) || /\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?\].*\b(driver|worker|dock):/.test(notes)) {
        issues.push({ entry: id, level: lvl, msg: "Notes looks like pasted diff/log output — reference a path/SHA instead" });
      }
    }
  }
  return issues;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) { process.stderr.write("usage: lint_history.ts <history.md>\n"); process.exit(2); }
  if (!(await Bun.file(file).exists())) { process.stdout.write("history lint: no file (no-op)\n"); process.exit(0); }
  const issues = lintHistory(await Bun.file(file).text());
  const errors = issues.filter((i) => i.level === "error");
  for (const i of issues) process.stderr.write(`  [${i.level === "error" ? "ERROR" : "warn"}] ${i.entry}: ${i.msg}\n`);
  if (errors.length > 0) { process.stderr.write(`history lint: ${errors.length} error(s) in new-format entries\n`); process.exit(1); }
  process.stdout.write(`history lint: ok (${issues.length} warning(s))\n`);
}

if (import.meta.main) main();
