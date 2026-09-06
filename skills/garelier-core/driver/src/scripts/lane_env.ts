// Project-declared dispatch environment injection. Declarations live in the
// canonical setup_config.toml and are expanded only at a concrete child context.

import { delimiter } from "node:path";

export interface LaneEnvContext {
  /** Checkout that directly owns the child process cwd. */
  checkout: string;
  /** Project/control root supplied to the launcher or gate. */
  project: string;
  /** Dispatch/role container that owns the checkout, when applicable. */
  container: string;
  /** Canonical numeric dispatch id, when the child belongs to a dispatch. */
  dispatchId: string;
  /** Garelier role selected for this dispatch or gate request. */
  role: string;
  /** Human-readable dispatch slug selected by the PM. */
  slug: string;
}

export type DispatchEnvTarget = "producer" | "gate";

export interface DispatchEnvEntry {
  name: string;
  value: string;
  why: string;
  appliesTo: DispatchEnvTarget[];
}

/** Parsed declarations from [[dispatch.env]]. */
export type DispatchEnv = DispatchEnvEntry[];
/** Resolved environment passed to one child process. */
export type LaneEnv = Record<string, string>;

/** Overlay environment layers using Windows' case-insensitive name semantics.
 * The last layer wins and removes every earlier spelling of the same key. */
export function mergeEnvironmentCaseInsensitive(
  ...layers: Array<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const spellingByName = new Map<string, string>();
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      const folded = name.toUpperCase();
      const prior = spellingByName.get(folded);
      if (prior !== undefined) delete out[prior];
      spellingByName.set(folded, name);
      out[name] = value;
    }
  }
  return out;
}

/** A valid declaration omitted because this path cannot yet supply a placeholder. */
export interface SkippedLaneEnvEntry {
  name: string;
  why: string;
  appliesTo: DispatchEnvTarget[];
  unavailablePlaceholders: string[];
}

/** Resolution keeps omissions observable instead of treating them as malformed config. */
export interface LaneEnvResolution {
  values: LaneEnv;
  skipped: SkippedLaneEnvEntry[];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const VARIABLES: Readonly<Record<string, keyof LaneEnvContext>> = {
  checkout: "checkout",
  project: "project",
  container: "container",
  dispatch_id: "dispatchId",
  role: "role",
  slug: "slug",
};
const TARGETS = new Set<DispatchEnvTarget>(["producer", "gate"]);

/** Validate parsed [[dispatch.env]] declarations before a child process is considered.
 * The closed placeholder vocabulary deliberately prevents a typo from silently
 * becoming a literal child env value. */
export function normalizeLaneEnv(raw: unknown, configPath: string): DispatchEnv {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath}: [dispatch] must be a table containing [[dispatch.env]] declarations`);
  }
  const entries = (raw as Record<string, unknown>).env;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error(`${configPath}: [[dispatch.env]] must be an array of tables`);
  const names = new Set<string>();
  return entries.map((entry, index) => {
    const label = `${configPath}: [[dispatch.env]] #${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} must be a table`);
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    const value = typeof item.value === "string" ? item.value : "";
    const why = typeof item.why === "string" ? item.why.trim() : "";
    if (!ENV_KEY.test(name)) throw new Error(`${label}.name must be a valid environment variable name`);
    const foldedName = name.toUpperCase();
    if (names.has(foldedName)) throw new Error(`${label}.name duplicates ${JSON.stringify(name)} case-insensitively`);
    names.add(foldedName);
    if (typeof item.value !== "string") throw new Error(`${label}.value must be a string`);
    if (!why) throw new Error(`${label}.why is required and must not be empty`);
    const appliesTo = item.applies_to === undefined ? ["producer"] as DispatchEnvTarget[] : item.applies_to;
    if (!Array.isArray(appliesTo) || appliesTo.length === 0 || appliesTo.some((target) => typeof target !== "string" || !TARGETS.has(target as DispatchEnvTarget))) {
      throw new Error(`${label}.applies_to must be a non-empty array containing only "producer" and/or "gate"`);
    }
    const targets = [...new Set(appliesTo as DispatchEnvTarget[])];
    // Validate the closed placeholder vocabulary during prepare/config loading,
    // before any child can run with an accidentally literal value.
    expandTemplate(value, { checkout: "x", project: "x", container: "x", dispatchId: "x", role: "x", slug: "x" }, label);
    return { name, value, why, appliesTo: targets };
  });
}

function placeholderNames(template: string, label: string): string[] {
  let malformed = false;
  const names: string[] = [];
  const value = template.replace(PLACEHOLDER, (_match, name: string) => {
    const contextKey = VARIABLES[name];
    if (!contextKey) {
      malformed = true;
      return "";
    }
    names.push(name);
    return "x";
  });
  if (malformed || /[{}]/.test(value)) {
    throw new Error(`${label}.value has an unknown or malformed placeholder in ${JSON.stringify(template)}; allowed placeholders: {checkout}, {project}, {container}, {dispatch_id}, {role}, {slug}`);
  }
  return names;
}

function expandTemplate(template: string, context: LaneEnvContext, label: string): string {
  placeholderNames(template, label);
  const value = template.replace(PLACEHOLDER, (_match, name: string) => context[VARIABLES[name]!]);
  if (!value) throw new Error(`${label}.value expands to an empty string`);
  return value;
}

/** Resolve declarations for the exact child class. Core-owned env wins on name conflict.
 * A declaration that needs a context value this path has not established is
 * omitted and returned as `skipped`; invalid declarations and fully-resolved
 * empty values still fail fast. */
export function resolveLaneEnv(env: DispatchEnv, context: LaneEnvContext, target: DispatchEnvTarget): LaneEnvResolution {
  const values: LaneEnv = {};
  const skipped: SkippedLaneEnvEntry[] = [];
  for (const entry of env) {
    if (!entry.appliesTo.includes(target)) continue;
    const label = `[[dispatch.env]] ${JSON.stringify(entry.name)}`;
    const unavailablePlaceholders = [...new Set(placeholderNames(entry.value, label)
      .filter((name) => !context[VARIABLES[name]!]))];
    if (unavailablePlaceholders.length) {
      skipped.push({ name: entry.name, why: entry.why, appliesTo: entry.appliesTo, unavailablePlaceholders });
      continue;
    }
    values[entry.name] = expandTemplate(entry.value, context, label);
  }
  return { values, skipped };
}

/** Keep unavailable declarations visible at every production child boundary. */
export function skippedLaneEnvDiagnostics(skipped: readonly SkippedLaneEnvEntry[], path: string): string[] {
  return skipped.map((entry) =>
    `DISPATCH_ENV_SKIPPED name=${JSON.stringify(entry.name)} why=${JSON.stringify(entry.why)} unavailable_placeholders=${entry.unavailablePlaceholders.join(",")} unavailable_reason="placeholder context is not established on this ${path} path"`,
  );
}

/** Layer declarations after scrubbing but before core-owned invariants: core wins. */
export function injectLaneEnv(inherited: Record<string, string | undefined>, laneEnv: Record<string, string | undefined>, coreOwned: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return mergeEnvironmentCaseInsensitive(inherited, laneEnv, coreOwned);
}
