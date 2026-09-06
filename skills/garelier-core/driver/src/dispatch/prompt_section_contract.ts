// W-451: one executable contract for PM-authored gate prompts and task files.
// The human-readable policy is garelier-core/references/gate_field_manual.md
// §A-0. Keep the machine contract here only; every prompt-producing entry
// point imports this module instead of growing a local copy.
//
// W-708 (DEC-100 stage 0): the heading set below is the CANONICAL SET the
// mechanism generates and the manual documents — it is no longer a closed
// refusal allowlist. A PM-authored surface may carry any additional heading
// (`## QG-004`, `## Notes`, `## 経緯`): refusing them cost a dispatch round
// each without catching a blueprint duplication that the other checks miss.
// What stays closed is the pair of MECHANISM-OWNED headings: they must be
// absent from a PM-authored input (the mechanism writes them) and present in
// the composed gate prompt. Field shapes (`## Review SHA` / `## Dock gate`)
// are still validated whenever those headings appear, on every surface.

export type PromptSectionSurface = "gate_prompt" | "gate_prompt_input" | "task_file";

const SHARED_PROMPT_SECTION_HEADINGS = Object.freeze([
  "Seat",
  "Dispatch",
  "Blueprint",
  "Output",
  "Review SHA",
  "Verdict",
  "Dock gate",
] as const);

/** The two headings the mechanism composes for itself. This pair is the only
 * closed part of the section contract (W-708): refused in a PM-authored input,
 * because the mechanism — not the PM — writes them. */
export const MECHANISM_OWNED_SECTION_HEADINGS = Object.freeze([
  "Role source pointers",
  "Task",
] as const);

/** Of that pair, the heading EVERY composer emits. `## Task` is the task-file
 * envelope, so it appears only on the `dispatch_prepare --task-file` route; an
 * attended seat spawned with `--prompt-file` appends its PM tail without one.
 * Requiring `## Task` here would refuse that legitimate composition. */
export const COMPOSED_REQUIRED_SECTION_HEADINGS = Object.freeze([
  "Role source pointers",
] as const);

export const GATE_PROMPT_SECTION_HEADINGS = Object.freeze([
  ...MECHANISM_OWNED_SECTION_HEADINGS,
  ...SHARED_PROMPT_SECTION_HEADINGS,
] as const);

/** PM-authored attended input excludes the two mechanism-owned headings. */
export const GATE_PROMPT_INPUT_SECTION_HEADINGS = Object.freeze([
  ...SHARED_PROMPT_SECTION_HEADINGS,
] as const);

export const TASK_FILE_SECTION_HEADINGS = Object.freeze([
  ...SHARED_PROMPT_SECTION_HEADINGS,
  "Dispatch-specific facts",
] as const);

/** Field-shape rules live here; the bounded A-0 tables carry these identifiers
 * and the aggregate parity test rejects any one-sided doc/code change. */
export const PROMPT_FIELD_CONTRACTS = Object.freeze([
  { heading: "Review SHA", contract: "review_sha_40_hex_line" },
  { heading: "Dock gate", contract: "dock_gate_log_path_and_status" },
] as const);

export type PromptFieldContractId = typeof PROMPT_FIELD_CONTRACTS[number]["contract"];

const PROMPT_FIELD_VALIDATORS: Record<PromptFieldContractId, {
  valid: (lines: string[]) => boolean;
  message: string;
}> = {
  review_sha_40_hex_line: {
    valid: (lines) => lines.some((line) => /^\s*review_sha:\s*[0-9a-f]{40}\s*$/i.test(line)),
    message: "requires a standalone `review_sha: <40 hex>` line",
  },
  dock_gate_log_path_and_status: {
    valid: (lines) => {
      const hasStatus = lines.some((line) => /\b(?:GREEN|RED)\b/.test(line));
      const hasLogPath = lines.some((line) => {
        const match = /^\s*log(?:\s+path)?\s*:\s*([^\s;]+)/i.exec(line);
        if (!match) return false;
        const value = match[1]!;
        return !/^(?:GREEN|RED)$/i.test(value) && !/^<.*>$/.test(value);
      });
      return hasLogPath && hasStatus;
    },
    message: "requires `log: <path>` (or `log path: <path>`) and `GREEN` or `RED`",
  },
};

export interface PromptFieldViolation {
  heading: typeof PROMPT_FIELD_CONTRACTS[number]["heading"];
  contract: PromptFieldContractId;
  message: string;
}

export interface PromptSectionInspection {
  headings: string[];
  /** Mechanism-owned headings found in a PM-authored surface. */
  forbidden: string[];
  /** Mechanism-owned headings missing from a composed gate prompt. */
  missing: string[];
  invalidFields: PromptFieldViolation[];
  /** The canonical section set the mechanism generates for this surface. It
   * documents the shape; it is not a refusal allowlist (W-708). */
  allowed: readonly string[];
}

function mapUnfencedLines(markdown: string, transform: (line: string) => string): string {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  return markdown.split(/\r?\n/).map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~";
      const length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = null;
      return line;
    }
    return fence ? line : transform(line);
  }).join(newline);
}

function levelTwoHeadings(markdown: string): string[] {
  const headings: string[] = [];
  mapUnfencedLines(markdown, (line) => {
    const match = /^##(?!#)\s+(.+?)\s*$/.exec(line);
    if (match) headings.push(match[1]!.replace(/\s+#+\s*$/, "").trim());
    return line;
  });
  return headings;
}

interface MarkdownSection {
  heading: string;
  level: 2 | 3;
  parentLevelTwo: string | null;
  lines: string[];
}

function markdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  let parentLevelTwo: string | null = null;
  mapUnfencedLines(markdown, (line) => {
    const match = /^(#{2,3})(?!#)\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current) sections.push(current);
      const level = match[1]!.length as 2 | 3;
      const heading = match[2]!.replace(/\s+#+\s*$/, "").trim();
      if (level === 2) parentLevelTwo = heading;
      current = {
        heading,
        level,
        parentLevelTwo: level === 3 ? parentLevelTwo : null,
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    }
    return line;
  });
  if (current) sections.push(current);
  return sections;
}

function invalidPromptFields(
  markdown: string,
  surface: PromptSectionSurface,
): PromptFieldViolation[] {
  const violations: PromptFieldViolation[] = [];
  for (const section of markdownSections(markdown)) {
    const isFieldSection = section.level === 2 ||
      (surface === "gate_prompt" && section.level === 3 && section.parentLevelTwo === "Task");
    if (!isFieldSection) continue;
    const field = PROMPT_FIELD_CONTRACTS.find(({ heading }) => heading === section.heading);
    if (!field) continue;
    const validator = PROMPT_FIELD_VALIDATORS[field.contract];
    if (!validator.valid(section.lines)) {
      violations.push({ ...field, message: validator.message });
    }
  }
  return violations;
}

/** Keep a validated task file intact while placing its sections below the
 * generated `## Task` envelope. This is structural nesting, not heading
 * deletion: every task-file H2 and its content remain visible as H3. */
export function nestTaskFileSections(markdown: string): string {
  return mapUnfencedLines(markdown, (line) => line.replace(/^##(?!#)(\s+)/, "###$1"));
}

export function inspectPromptSections(
  markdown: string,
  surface: PromptSectionSurface,
): PromptSectionInspection {
  const allowed = surface === "gate_prompt"
    ? GATE_PROMPT_SECTION_HEADINGS
    : surface === "gate_prompt_input"
    ? GATE_PROMPT_INPUT_SECTION_HEADINGS
    : TASK_FILE_SECTION_HEADINGS;
  const headings = levelTwoHeadings(markdown);
  const mechanismOwned = new Set<string>(MECHANISM_OWNED_SECTION_HEADINGS);
  const composed = surface === "gate_prompt";
  return {
    headings,
    forbidden: composed ? [] : [...new Set(headings.filter((heading) => mechanismOwned.has(heading)))],
    missing: composed
      ? COMPOSED_REQUIRED_SECTION_HEADINGS.filter((heading) => !headings.includes(heading))
      : [],
    invalidFields: invalidPromptFields(markdown, surface),
    allowed,
  };
}

export function assertPromptSections(input: {
  markdown: string;
  surface: PromptSectionSurface;
  sourcePath: string;
  blueprintPath: string | null;
}): PromptSectionInspection {
  const inspection = inspectPromptSections(input.markdown, input.surface);
  if (inspection.forbidden.length === 0 && inspection.missing.length === 0
    && inspection.invalidFields.length === 0) {
    return inspection;
  }
  const forbidden = inspection.forbidden.map((heading) => `## ${heading}`).join(", ");
  const missing = inspection.missing.map((heading) => `## ${heading}`).join(", ");
  const owned = MECHANISM_OWNED_SECTION_HEADINGS.map((heading) => `## ${heading}`).join(", ");
  const blueprint = input.blueprintPath?.trim() || "<missing --blueprint path>";
  const details: string[] = [];
  if (forbidden) {
    details.push(
      `mechanism-owned section heading(s) in PM-authored input: ${forbidden}. ` +
      `The mechanism composes those; move that content to blueprint ${blueprint} or a free heading.`,
    );
  }
  if (missing) {
    details.push(`composed prompt is missing mechanism-owned section heading(s): ${missing}.`);
  }
  if (inspection.invalidFields.length > 0) {
    details.push(`invalid field shape(s): ${inspection.invalidFields.map((violation) =>
      `## ${violation.heading} [${violation.contract}] ${violation.message}`
    ).join("; ")}.`);
  }
  throw new Error(
    `W-451 ${input.surface} refused (${input.sourcePath}): ${details.join(" ")} ` +
    `Mechanism-owned section headings: ${owned}`,
  );
}
