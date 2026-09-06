// One machine face for every dispatch artifact a script parses.
//
// Before this module every machine field lived in the artifact BODY and was
// extracted with a regex over free prose. That put the machine field and the
// role's own sentences on the same surface, so writing evidence WELL broke the
// parse (a nested `)` inside `(consumed: ...)`, a register heading ahead of the
// `STATE=` line, a `verdict:` string quoted inside an explanation). The one
// artifact kind that never broke is the control row, because its machine fields
// live in `+++` TOML front matter and its prose lives below.
//
// So this module carries that same shape to the rest: front matter holds typed
// TOML under `[section]` / `[[array]]` tables, the body stays free prose, and
// both live in ONE file. A value's content can no longer break the parse -
// parentheses, backticks, quotes and newlines are just string bytes inside TOML.
//
// Fail-closed: an artifact without front matter is the retired body-regex form
// and is REJECTED by name. There is no compatibility read, no fallback, and no
// migration window (legacy-deletion-is-default).

import { parseControlFrontmatter, ControlFrontmatterError } from "../control/control_frontmatter.ts";

/** Why a machine read could not produce a value. The cases are distinct on
 * purpose: a role told "the field is absent" when the file actually failed to
 * parse cannot tell what to fix. */
export type MachineArtifactFault =
  /** No source at all (file missing or empty). */
  | "missing"
  /** Retired body-regex form: no `+++` front matter opens the file. */
  | "legacy_form"
  /** Front matter present but not decodable / not shaped as sectioned tables. */
  | "malformed"
  /** Front matter decoded fine; the requested field is simply not there. */
  | "absent"
  /** Front matter decoded fine; the field is present with a wrong type or value. */
  | "invalid";

export class MachineArtifactError extends Error {
  constructor(readonly fault: MachineArtifactFault, readonly label: string, detail: string) {
    super(`${label}: ${detail}`);
    this.name = "MachineArtifactError";
  }
}

export interface MachineArtifact {
  /** Decoded front matter. Every top-level value is a table or array of tables. */
  readonly data: Record<string, unknown>;
  /** Everything after the closing `+++`. Never parsed for machine fields. */
  readonly body: string;
}

export const MACHINE_ARTIFACT_DELIMITER = "+++";

/** The one sentence every role-facing surface quotes, so the contract is stated
 * in exactly one place and cannot drift between prompt text and manual text. */
export const MACHINE_ARTIFACT_CONTRACT =
  "Machine fields live in `+++` TOML front matter at the top of the file, under `[section]` / `[[array]]` tables only (never a top-level bare key); prose goes below the closing `+++` and no machine value is read from it. (One check still reads the prose: a Guardian verdict carrying the retired `uncovered_<field>:` disclosure lines is refused rather than read.) Values are TOML strings, so parentheses, backticks, quotes and newlines need no escaping - use `'''...'''` for anything multi-line.";

function isTable(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * User ruling 2026-09-02: every value sits under `[section]` / `[[array]]`.
 * A top-level bare key makes appending unsafe (a later `[section]` swallows it),
 * which is exactly how the body-regex forms drifted. Enforced structurally
 * rather than by grepping for `^key =`, so a `key = ...` line inside a
 * multi-line string is not a false positive and a bare key written as
 * `key = { a = 1 }` is not a false negative.
 */
export function assertSectionedTables(data: Record<string, unknown>, label: string): void {
  const bare = Object.entries(data)
    .filter(([, value]) => !(isTable(value) || (Array.isArray(value) && value.every(isTable))))
    .map(([key]) => key);
  if (bare.length > 0) {
    throw new MachineArtifactError("malformed", label,
      `front matter has ${bare.length} top-level bare key(s) (${bare.join(", ")}); every value must sit under a [section] or [[array]] table`);
  }
}

/**
 * Decode one machine artifact. Throws a typed MachineArtifactError whose
 * `fault` separates "there is no file", "this is the retired body-regex form",
 * and "the front matter is there but broken".
 */
export function parseMachineArtifact(source: string | null, label: string): MachineArtifact {
  if (source === null || source.trim() === "") {
    throw new MachineArtifactError("missing", label, "no artifact content to read");
  }
  const opening = source.split(/\r?\n/, 1)[0] ?? "";
  if (opening.trim() !== MACHINE_ARTIFACT_DELIMITER) {
    throw new MachineArtifactError("legacy_form", label,
      `retired body-regex form - the first line is ${JSON.stringify(opening.slice(0, 60))}, expected \`${MACHINE_ARTIFACT_DELIMITER}\`. ${MACHINE_ARTIFACT_CONTRACT}`);
  }
  let parsed;
  try {
    parsed = parseControlFrontmatter(source, label);
  } catch (error) {
    const detail = error instanceof ControlFrontmatterError ? error.message : String(error);
    throw new MachineArtifactError("malformed", label, `front matter did not decode (${detail})`);
  }
  assertSectionedTables(parsed.data, label);
  return { data: parsed.data, body: parsed.body };
}

/** Non-throwing decode for read surfaces that must degrade rather than abort
 * (status snapshots, lane listings). The fault is preserved so the caller can
 * still report WHY, instead of silently reporting an absent value. */
export function tryParseMachineArtifact(
  source: string | null,
  label: string,
): { ok: true; artifact: MachineArtifact } | { ok: false; fault: MachineArtifactFault; message: string } {
  try {
    return { ok: true, artifact: parseMachineArtifact(source, label) };
  } catch (error) {
    if (error instanceof MachineArtifactError) return { ok: false, fault: error.fault, message: error.message };
    throw error;
  }
}

function table(artifact: MachineArtifact, section: string): Record<string, unknown> | null {
  const value = artifact.data[section];
  return isTable(value) ? value as Record<string, unknown> : null;
}

/** Read `[section] key` as a string. `absent` and `invalid` stay distinct from
 * the decode faults above so every caller can report the real cause. */
export function machineString(
  artifact: MachineArtifact,
  section: string,
  key: string,
  label: string,
  options: { pattern?: RegExp; allowed?: ReadonlySet<string> } = {},
): string {
  const found = table(artifact, section);
  if (!found || !(key in found)) {
    throw new MachineArtifactError("absent", label, `front matter has no [${section}] ${key}`);
  }
  const value = found[key];
  if (typeof value !== "string" || value === "") {
    throw new MachineArtifactError("invalid", label, `[${section}] ${key} must be a non-empty TOML string`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new MachineArtifactError("invalid", label, `[${section}] ${key} does not match ${options.pattern.source}`);
  }
  if (options.allowed && !options.allowed.has(value)) {
    throw new MachineArtifactError("invalid", label,
      `[${section}] ${key} is ${JSON.stringify(value)}, expected one of ${[...options.allowed].join(" | ")}`);
  }
  return value;
}

/** Same as machineString but returns null when the field is simply not there.
 * A decode fault still throws - "unreadable" must never look like "unset". */
export function optionalMachineString(
  artifact: MachineArtifact,
  section: string,
  key: string,
  label: string,
  options: { pattern?: RegExp; allowed?: ReadonlySet<string> } = {},
): string | null {
  const found = table(artifact, section);
  if (!found || !(key in found)) return null;
  return machineString(artifact, section, key, label, options);
}

export function machineBoolean(
  artifact: MachineArtifact,
  section: string,
  key: string,
  label: string,
): boolean {
  const found = table(artifact, section);
  if (!found || !(key in found)) {
    throw new MachineArtifactError("absent", label, `front matter has no [${section}] ${key}`);
  }
  const value = found[key];
  if (typeof value !== "boolean") {
    throw new MachineArtifactError("invalid", label, `[${section}] ${key} must be a TOML boolean`);
  }
  return value;
}

/** Read `[[section]]` as an ordered list of tables. Absent is an empty list;
 * a present-but-wrong-shape value is `invalid`, never an empty list. */
export function machineArray(
  artifact: MachineArtifact,
  section: string,
  label: string,
): Record<string, unknown>[] {
  const value = artifact.data[section];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTable)) {
    throw new MachineArtifactError("invalid", label, `[[${section}]] must be an array of tables`);
  }
  return value as Record<string, unknown>[];
}

// -- emitter --------------------------------------------------------------
// Every writer goes through here so both provider flows emit byte-identical
// front matter, and so no writer has to hand-quote a value.

// TOML forbids raw control characters (other than tab, plus newline inside a
// multi-line string) in every string form, so a value carrying one takes the
// escaping branch. U+007F (DEL) is forbidden raw as well.
const RAW_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/** Quote one TOML string value without asking the writer to pick characters.
 * Literal strings (`'...'` / `'''...'''`) escape NOTHING, so parentheses,
 * backticks, quotes and newlines pass through untouched. The cases a literal
 * string cannot carry - an embedded `'''`, a trailing `'`, a raw control
 * character, and a line that would look like the front-matter delimiter - fall
 * back to a basic string where the encoder escapes. Every branch round-trips
 * byte-exactly, so no writer ever has to choose characters. */
export function tomlValue(value: string): string {
  const delimiterCollision = value.split("\n").some((line) => line.trim() === MACHINE_ARTIFACT_DELIMITER);
  const literalSafe = !value.includes("'''")
    && !value.endsWith("'")
    && !delimiterCollision
    && !RAW_CONTROL.test(value);
  if (literalSafe) {
    if (!value.includes("\n") && !value.includes("'")) return `'${value}'`;
    // A newline directly after the opening delimiter is trimmed by TOML, so the
    // decoded value is exactly `value`.
    return `'''\n${value}'''`;
  }
  let escaped = "";
  for (const character of value) {
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (RAW_CONTROL.test(character)) escaped += `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else escaped += character;
  }
  return `"${escaped}"`;
}

export type MachineFieldValue = string | boolean | number;

export interface MachineSection {
  /** Table name. `array: true` emits `[[name]]` instead of `[name]`. */
  readonly name: string;
  readonly array?: boolean;
  readonly fields: ReadonlyArray<readonly [string, MachineFieldValue]>;
}

function renderField(key: string, value: MachineFieldValue): string {
  if (typeof value === "string") return `${key} = ${tomlValue(value)}`;
  return `${key} = ${String(value)}`;
}

/** One table, without the `+++` wrapper - for quoting a single section into a
 * prompt so a role sees exactly the block it has to write. */
export function renderMachineSection(section: MachineSection): string {
  const heading = section.array ? `[[${section.name}]]` : `[${section.name}]`;
  return [heading, ...section.fields.map(([key, value]) => renderField(key, value))].join("\n");
}

function fieldsOf(row: Record<string, unknown>, label: string): Array<readonly [string, MachineFieldValue]> {
  return Object.entries(row).map(([key, value]) => {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      return [key, value] as const;
    }
    throw new MachineArtifactError("invalid", label, `${key} is not a TOML string, boolean or number`);
  });
}

/** Decode an artifact, let the caller edit its decoded front matter in place,
 * and re-render the whole file with the prose body untouched.
 *
 * One writer path for every field update. Before this, each writer inserted its
 * own line "near the top" of the prose and then re-scanned the document to check
 * what it had done - three different guesses at where the machine face began. */
export function rewriteMachineArtifact(
  source: string,
  label: string,
  mutate: (data: Record<string, unknown>) => void,
): string {
  const artifact = parseMachineArtifact(source, label);
  const data: Record<string, unknown> = { ...artifact.data };
  mutate(data);
  const sections = Object.entries(data).flatMap(([name, value]): MachineSection[] => {
    if (Array.isArray(value)) {
      return value.map((row) => ({ name, array: true, fields: fieldsOf(row as Record<string, unknown>, label) }));
    }
    if (value && typeof value === "object") {
      return [{ name, fields: fieldsOf(value as Record<string, unknown>, label) }];
    }
    throw new MachineArtifactError("invalid", label, `top-level ${name} must be a table or array of tables`);
  });
  return renderMachineArtifact(sections, artifact.body);
}

/** Render one artifact: `+++` front matter, then the prose body verbatim. */
export function renderMachineArtifact(sections: readonly MachineSection[], body: string): string {
  if (sections.length === 0) throw new Error("a machine artifact must declare at least one [section]");
  const front = sections.map((section) => {
    const heading = section.array ? `[[${section.name}]]` : `[${section.name}]`;
    return [heading, ...section.fields.map(([key, value]) => renderField(key, value))].join("\n");
  }).join("\n\n");
  const prose = body.replace(/^\n+/, "");
  return `${MACHINE_ARTIFACT_DELIMITER}\n${front}\n${MACHINE_ARTIFACT_DELIMITER}\n${prose ? `\n${prose.replace(/\n*$/, "\n")}` : ""}`;
}
