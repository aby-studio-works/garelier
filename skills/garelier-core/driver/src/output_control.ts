// Output Control (DEC-028) — bound provider final-response length and driver log
// growth WITHOUT touching the already-existing compact-handoff (DEC-005) or
// retention (DEC-009) machinery. This layer adds: a per-role output profile, a
// prompt directive that asks the provider to keep its FINAL response short (durable
// detail goes to official files), an excerpt cap on what the driver stores for
// `model_result`, an over-budget WARNING (observation, not failure), and the data
// shapes for usage-summary records.
//
// Hard rules baked into the directive text below:
//   - never abbreviate code, paths, commands, URLs, errors, dates, numbers, SHAs
//   - never hide risks, blockers, warnings, approvals, responsibility boundaries
//   - durable content lives in role files, not in the screen-facing final response
//
// This module is pure (no fs, no config import) so it stays cycle-free and unit-
// testable. config.ts owns normalization + ConfigError; this owns types + logic.

export type OutputProfileName = "normal" | "compact" | "micro";
export type OutputViolationMode = "warn" | "fail";

export const OUTPUT_PROFILE_NAMES: readonly OutputProfileName[] = ["normal", "compact", "micro"];

// Roles that have a per-role profile override. Mirrors prompts.ts RoleKind, but
// kept as a local runtime list so config.ts can validate role keys without an
// import cycle (it normalizes roles as Record<string, OutputProfileName>).
export const OUTPUT_CONTROL_ROLES = [
  "pm", "dock", "artisan", "worker", "scout",
  "smith", "librarian", "observer", "guardian", "concierge",
] as const;

export interface OutputProfileConfig {
  softResultChars: number;
  maxBullets: number;
}

// Language for the PROSE of human-facing artifacts. "auto" = do not force one
// (the role mirrors the project — legacy behavior). Set at setup. Machine tokens
// (status values, JSON sidecar keys, branch names, SHAs) stay verbatim regardless.
export type ArtifactLanguage = "auto" | "ja" | "en" | "both";

export interface OutputControlConfig {
  enabled: boolean;
  defaultProfile: OutputProfileName;
  violationMode: OutputViolationMode;
  modelResultLogChars: number;
  errorTailChars: number;
  driverLogMaxBytes: number;
  driverLogKeepFiles: number;
  usageSummary: boolean;
  profiles: Record<OutputProfileName, OutputProfileConfig>;
  // Per-role profile selection. Keyed by role name; validated in config.ts.
  roles: Record<string, OutputProfileName>;
  // Authoring control (DEC-049 — cost): the language of human-facing prose, and
  // whether roles write terse, symbol-dense artifacts. Smaller artifacts cost less
  // to author AND less to re-read each coordinator wake.
  language: ArtifactLanguage;
  terse: boolean;
}

export interface ResolvedOutputPolicy {
  profile: OutputProfileName;
  softResultChars: number;
  maxBullets: number;
}

export interface OutputBudgetCheck {
  resultChars: number;
  softResultChars: number;
  overBudget: boolean;
}

// Default profiles + role assignments. Safety-leaning roles (guardian, concierge)
// default to `normal` so warnings / approvals / responsibility boundaries are not
// pressured short; read-only investigators (scout, observer) default to `micro`.
export const DEFAULT_OUTPUT_PROFILES: Record<OutputProfileName, OutputProfileConfig> = {
  normal: { softResultChars: 1600, maxBullets: 8 },
  compact: { softResultChars: 900, maxBullets: 5 },
  micro: { softResultChars: 500, maxBullets: 3 },
};

export const DEFAULT_OUTPUT_ROLES: Record<string, OutputProfileName> = {
  pm: "normal",
  dock: "compact",
  worker: "compact",
  smith: "compact",
  artisan: "compact",
  scout: "micro",
  observer: "micro",
  librarian: "compact",
  guardian: "normal",
  concierge: "normal",
};

export const DEFAULT_OUTPUT_CONTROL: OutputControlConfig = {
  enabled: true,
  defaultProfile: "compact",
  violationMode: "warn",
  modelResultLogChars: 600,
  errorTailChars: 500,
  driverLogMaxBytes: 10 * 1024 * 1024,
  driverLogKeepFiles: 10,
  usageSummary: true,
  profiles: DEFAULT_OUTPUT_PROFILES,
  roles: DEFAULT_OUTPUT_ROLES,
  language: "auto",   // do not force a language unless setup picks one
  terse: true,        // cost-favoring default (DEC-049); the read-first surfaces stay terse
};

// Resolve the active policy for a role: its override profile (or the default),
// expanded with that profile's soft budget + bullet hint.
export function roleOutputPolicy(config: OutputControlConfig, role: string): ResolvedOutputPolicy {
  const profile = config.roles[role] ?? config.defaultProfile;
  const p = config.profiles[profile] ?? config.profiles[config.defaultProfile] ?? DEFAULT_OUTPUT_PROFILES.compact;
  return { profile, softResultChars: p.softResultChars, maxBullets: p.maxBullets };
}

const PROFILE_GUIDANCE: Record<OutputProfileName, string> = {
  normal:
    "Profile normal: be concise but complete — never drop a decision, warning, required approval, or external-action detail to save space.",
  compact:
    "Profile compact: use short bullets — prefer result + evidence pointer + next action over prose.",
  micro:
    "Profile micro: 1-3 lines when possible; detailed findings must live in the official artifact and be referenced by a read: pointer.",
};

// Build the output-control directive appended to the headless directive. Written
// as general operational writing — no external tool names, no copied phrasing.
export function buildOutputDirective(policy: ResolvedOutputPolicy): string {
  return [
    "Output control for this iteration:",
    `- Keep your final response within about ${policy.softResultChars} characters.`,
    "- Put durable detail in your role's official files (report.md, STATE.md, inspections, etc.), not in the final response.",
    "- The final response should carry only: the result, the state transition / action line, and pointers (path:line, task id, commit SHA, report path).",
    "- Do not paste diffs, full logs, full reports, or large evidence bodies into the final response.",
    "- Do not abbreviate code symbols, file paths, commands, URLs, error text, dates, numbers, or commit SHAs to fit the budget.",
    "- Do not hide risks, blockers, warnings, required approvals, or responsibility boundaries to fit the budget.",
    PROFILE_GUIDANCE[policy.profile],
  ].join("\n");
}

const LANG_NAME: Record<ArtifactLanguage, string | null> = {
  auto: null, ja: "Japanese", en: "English", both: "both Japanese and English (bilingual)",
};

// Authoring directive (DEC-049 — cost). Controls the LANGUAGE of human-facing
// prose and enforces the two-tier "terse read-first surface + complete full body"
// shape so coordinators re-read small structured summaries each cycle, not full
// markdown bodies. Returns "" when nothing is configured (legacy behavior).
export function buildAuthoringDirective(language: ArtifactLanguage, terse: boolean): string {
  const lines: string[] = [];
  const lang = LANG_NAME[language];
  if (lang) {
    lines.push(`- Write the PROSE of human-facing artifacts (blueprint / report.md / inspection / observation / knowledge docs / the narrative in manifest + STATE.md) in ${lang}.`);
    lines.push("- Keep machine tokens VERBATIM regardless of language: STATE.md '## Status' values, report.json keys/values, branch names, commands, file paths, identifiers, commit SHAs, error text.");
  }
  if (terse) {
    lines.push("- Two-tier authoring: the surfaces a coordinator re-reads EVERY cycle — the report.json sidecar `summary`, STATE.md status / current task / last activity, and the manifest's per-pass note — must be TERSE: symbol-dense (→ ✓ ✗ #id, `key: value`, dated fragments), fragments not full sentences, no restated context.");
    lines.push("- The FULL form (report.md body, blueprint, inspection) stays COMPLETE and readable — it is the on-demand fallback opened only when the terse form is insufficient. Don't pad it; don't drop detail needed to act or re-derive.");
    lines.push("- Never paste a diff / full log / report body into a coordinator-read surface; reference it by pointer (path:line / SHA / report path / task id).");
  }
  if (!lines.length) return "";
  return ["Authoring (human-facing artifacts):", ...lines].join("\n");
}

// Truncate a provider result to an excerpt for JSONL storage. Returns undefined
// for an empty/whitespace result. Appends a "[+N chars]" marker when truncated so
// the log reader knows the stored text is a prefix, not the whole response.
export function summarizeProviderResult(
  result: string | undefined,
  maxChars: number,
): string | undefined {
  if (!result) return undefined;
  const trimmed = result.trim();
  if (!trimmed) return undefined;
  const cap = Math.max(1, Math.floor(maxChars));
  if (trimmed.length <= cap) return trimmed;
  const omitted = trimmed.length - cap;
  return `${trimmed.slice(0, cap)}… [+${omitted} chars; full response is in the role's official files]`;
}

// Compare a provider result's length against the role's soft budget. This NEVER
// truncates the result used for role-state decisions — it only reports whether the
// response ran long. The caller decides what to do (warn by default).
export function checkOutputBudget(
  result: string | undefined,
  policy: ResolvedOutputPolicy,
): OutputBudgetCheck {
  const resultChars = result ? result.trim().length : 0;
  return {
    resultChars,
    softResultChars: policy.softResultChars,
    overBudget: resultChars > policy.softResultChars,
  };
}
