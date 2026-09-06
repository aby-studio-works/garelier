// Garelier dispatch (W-192 b) — the Guardian→Observer FACTS-ONLY evidence pack
// + its independence-preserving non-inclusion lint.
//
// A code-tier gate runs Guardian THEN Observer on the SAME diff. Today each
// re-discovers the diff from scratch (touched files, key hunks, line refs) — the
// second seat pays the first seat's reading cost again. W-192 lets the Guardian
// hand the Observer an EVIDENCE PACK of the shared FACTS (which files, which lines,
// which hunks) so the Observer skips the re-discovery — WITHOUT sharing any
// JUDGMENT. Independence is the whole point of the second seat (DEC-090): if the
// Guardian's verdict / reasoning / conclusion rode along, the two "independent"
// reads would collapse to one correlated sample (W-192 d, fresh-eyes principle).
//
// So the pack is facts-only by CONTRACT, and this lint ENFORCES it: it scans the
// pack's author PROSE for a leaked verdict token or judgment/recommendation
// language and fails closed. Quoted diff content is exempt — hunks live in fenced
// code blocks and file/symbol references live in inline `code`, both of which the
// lint strips before scanning, so a hunk that legitimately quotes the word "BLOCK"
// or a path like `src/security/x` is not a false positive; only the pack author's
// OWN prose is judged.
//
// Pure + CLI. Nothing here spawns; the CLI reads one file and lints it.

import { readFileSync } from "node:fs";

// The gate verdict vocabulary (gate_verdict.md). A whole-token appearance in the
// pack's prose is a leaked verdict — the Observer must reach its own.
export const VERDICT_TOKENS = ["PASS_WITH_NOTES", "PASS", "BLOCK", "REWORK_RECOMMENDED", "NO_OPINION"] as const;

// Judgment / recommendation / conclusion language (EN + JP). These leak the
// author's CONCLUSION even without a canonical token. Curated for precision: whole
// phrases, not broad single words, so a factual sentence is not over-flagged.
const JUDGMENT_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /\brecommend(?:s|ed|ing|ation)?\b/i, kind: "recommendation" },
  { re: /\bverdict\b/i, kind: "verdict-word" },
  { re: /\bin my opinion\b/i, kind: "opinion" },
  { re: /\bi (?:think|believe|feel)\b/i, kind: "opinion" },
  { re: /\blgtm\b/i, kind: "opinion" },
  { re: /\blooks (?:good|bad|safe|unsafe|fine|wrong|ok|clean)\b/i, kind: "judgment" },
  { re: /\b(?:is|are|seems?|appears?|looks?) (?:safe|unsafe|vulnerable|exploitable|fine|broken|wrong|correct|incorrect|a problem)\b/i, kind: "judgment" },
  { re: /\b(?:should|must)(?: be)? (?:block|rework|fix|reject|merg|revert|remov)/i, kind: "prescription" },
  { re: /\bno (?:issue|problem|concern)s?\b/i, kind: "clearance" },
  { re: /\bsafe to (?:merge|land|ship)\b/i, kind: "clearance" },
  { re: /判定|結論|推奨/, kind: "judgment-jp" },
  { re: /問題(?:ない|なし|あり)/, kind: "judgment-jp" },
  { re: /脆弱|危険です|安全です/, kind: "judgment-jp" },
  { re: /べきだ|べきで(?:す|ある)/, kind: "prescription-jp" },
];

/** Remove fenced code blocks, inline `code` spans, and HTML comments so ONLY the
 * author's PACK prose is scanned. HTML comments carry the template's own
 * instructions (which necessarily name verdict tokens to forbid them) and are not
 * pack content. Blanks each exempt region while preserving LINE count so reported
 * line numbers stay accurate. */
export function stripCodeForLint(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inComment = false;
  for (let raw of lines) {
    if (inComment) {
      const end = raw.indexOf("-->");
      if (end === -1) { out.push(""); continue; }
      raw = raw.slice(end + 3);
      inComment = false;
    }
    raw = raw.replace(/<!--.*?-->/g, ""); // same-line comments
    const open = raw.indexOf("<!--");
    if (open !== -1) { raw = raw.slice(0, open); inComment = true; }
    if (/^\s*```/.test(raw)) { inFence = !inFence; out.push(""); continue; }
    if (inFence) { out.push(""); continue; }
    // blank out inline `code` spans (file paths / symbols / quoted tokens are facts).
    out.push(raw.replace(/`[^`]*`/g, ""));
  }
  return out.join("\n");
}

export interface EvidencePackViolation {
  line: number;      // 1-based line in the ORIGINAL text
  kind: string;      // "verdict-token" | recommendation | judgment | …
  match: string;     // the offending substring
  snippet: string;   // the prose line (trimmed) for context
}

export interface EvidencePackLintResult {
  ok: boolean;
  violations: EvidencePackViolation[];
}

/** Fail-closed non-inclusion lint: the facts-only evidence pack must carry NO
 * verdict token and NO judgment/recommendation prose (independence, DEC-090 / W-192).
 * Scans author prose only (fenced hunks + inline-code refs are exempt). */
export function lintEvidencePack(text: string): EvidencePackLintResult {
  const scanned = stripCodeForLint(text);
  const originalLines = text.split("\n");
  const scannedLines = scanned.split("\n");
  const violations: EvidencePackViolation[] = [];
  const verdictRe = new RegExp(`\\b(${VERDICT_TOKENS.join("|")})\\b`);
  for (let i = 0; i < scannedLines.length; i++) {
    const prose = scannedLines[i];
    if (!prose.trim()) continue;
    const snippet = (originalLines[i] ?? "").trim();
    const v = verdictRe.exec(prose);
    if (v) violations.push({ line: i + 1, kind: "verdict-token", match: v[1], snippet });
    for (const { re, kind } of JUDGMENT_PATTERNS) {
      const m = re.exec(prose);
      if (m) violations.push({ line: i + 1, kind, match: m[0], snippet });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---- CLI --------------------------------------------------------------------

function main(argv: string[]): number {
  const path = argv.find((a) => !a.startsWith("-"));
  if (!path) { process.stderr.write("usage: evidence_pack.ts <pack.md>\n"); return 2; }
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { process.stderr.write(`evidence_pack: cannot read ${path}\n`); return 2; }
  const res = lintEvidencePack(text);
  if (res.ok) { process.stdout.write(`evidence_pack: ok (facts-only, no leaked judgment) — ${path}\n`); return 0; }
  process.stderr.write(`evidence_pack: ${res.violations.length} independence violation(s) in ${path} — the pack leaks the Guardian's judgment; keep it FACTS-ONLY (DEC-090):\n`);
  for (const v of res.violations) process.stderr.write(`  line ${v.line} [${v.kind}] "${v.match}": ${v.snippet}\n`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
