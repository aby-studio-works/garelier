// W-083 ts-first: setup_wizard TOML readers + setup-state detection.
//
// Faithful ports of the awk/grep helpers from setup_wizard.sh
// (read_toml_value_from / read_toml_value / read_toml_bare /
// toml_scalar_value / read_existing_block_ids / read_existing_agent_effort /
// emit_effort_line / detect_setup_state). Behaviour is matched line-for-line so
// the wizard's generated/rewritten TOML and its plan output stay byte-identical.

import { existsSync, readFileSync } from "node:fs";
import { wsSubdir, crewSubdirFromPmRoot } from "./paths.ts";

function readLines(path: string): string[] | null {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// read_toml_value_from: first double-quoted value of `key =` inside exact
// `[section]`. Returns "" when absent (or key line has no quoted value).
export function readTomlValueFrom(toml: string, section: string, key: string): string {
  const lines = readLines(toml);
  if (!lines) return "";
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*=`);
  let inSection = false;
  for (const line of lines) {
    if (line === `[${section}]`) {
      inSection = true;
      continue;
    }
    if (/^\[/.test(line)) inSection = false;
    if (inSection && keyRe.test(line)) {
      const m = line.match(/"[^"]*"/);
      return m ? m[0].slice(1, -1) : "";
    }
  }
  return "";
}

export function readTomlValue(pmId: string, section: string, key: string): string {
  return readTomlValueFrom(`${wsSubdir(pmId, "_pm")}/setup_config.toml`, section, key);
}

// read_toml_bare: unquoted scalar (e.g. a boolean) of `key =` inside exact
// `[section]`, with trailing comment and all whitespace stripped.
export function readTomlBareFrom(toml: string, section: string, key: string): string {
  const lines = readLines(toml);
  if (!lines) return "";
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*=`);
  let inSection = false;
  for (const line of lines) {
    if (line === `[${section}]`) {
      inSection = true;
      continue;
    }
    if (/^\[/.test(line)) inSection = false;
    if (inSection && keyRe.test(line)) {
      let v = line;
      v = v.replace(/^[^=]*=\s*/, "");
      v = v.replace(/\s*#.*$/, "");
      v = v.replace(/\s/g, "");
      return v;
    }
  }
  return "";
}

export function readTomlBare(pmId: string, section: string, key: string): string {
  return readTomlBareFrom(`${wsSubdir(pmId, "_pm")}/setup_config.toml`, section, key);
}

// toml_scalar_value: heading may carry surrounding whitespace; value has its
// surrounding quotes stripped. Returns "" when absent.
export function tomlScalarValue(file: string, section: string, key: string): string {
  const lines = readLines(file);
  if (!lines) return "";
  const headRe = /^\s*\[([^\]]+)\]\s*$/;
  const secRe = new RegExp(`^\\s*\\[${escapeRe(section)}\\]\\s*$`);
  const keyRe = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  let inSection = false;
  for (const line of lines) {
    if (headRe.test(line)) {
      inSection = secRe.test(line);
      continue;
    }
    if (inSection && keyRe.test(line)) {
      let v = line.replace(new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*`), "");
      v = v.replace(/\s*(#.*)?$/, "");
      v = v.replace(/^"|"$/g, "");
      return v;
    }
  }
  return "";
}

// read_existing_block_ids: one "id:provider:model" per [[section]] array block.
export function readExistingBlockIds(pmId: string, section: string): string[] {
  const toml = `${wsSubdir(pmId, "_pm")}/setup_config.toml`;
  const lines = readLines(toml);
  if (!lines) return [];
  const out: string[] = [];
  let inSection = false;
  let curId = "";
  let curProvider = "";
  let curModel = "";
  const flush = () => {
    if (inSection && curId !== "") {
      out.push(`${curId}:${curProvider !== "" ? curProvider : "claude-code"}:${curModel}`);
    }
  };
  const quoted = (line: string): string => {
    const m = line.match(/"[^"]*"/);
    return m ? m[0].slice(1, -1) : "";
  };
  for (const line of lines) {
    if (line === `[[${section}]]`) {
      flush();
      inSection = true;
      curId = "";
      curProvider = "";
      curModel = "";
      continue;
    }
    if (/^\[\[/.test(line) || /^\[/.test(line)) {
      flush();
      inSection = false;
      curId = "";
      curProvider = "";
      curModel = "";
      continue;
    }
    if (inSection && /^id\s*=/.test(line)) curId = quoted(line);
    else if (inSection && /^provider\s*=/.test(line)) curProvider = quoted(line);
    else if (inSection && /^model\s*=/.test(line)) curModel = quoted(line);
  }
  flush();
  return out;
}

// read_existing_agent_effort: the `effort` value of the [[section]] block whose
// id matches wanted (first match only).
export function readExistingAgentEffort(pmId: string, section: string, wantedId: string): string {
  const toml = `${wsSubdir(pmId, "_pm")}/setup_config.toml`;
  const lines = readLines(toml);
  if (!lines) return "";
  let inSection = false;
  let curId = "";
  let curEffort = "";
  let found = "";
  const quoted = (line: string): string => {
    const m = line.match(/"[^"]*"/);
    return m ? m[0].slice(1, -1) : "";
  };
  const flush = () => {
    if (found === "" && inSection && curId === wantedId && curEffort !== "") {
      found = curEffort;
    }
  };
  for (const line of lines) {
    if (line === `[[${section}]]`) {
      flush();
      inSection = true;
      curId = "";
      curEffort = "";
      continue;
    }
    if (/^\[\[/.test(line) || /^\[/.test(line)) {
      flush();
      inSection = false;
      curId = "";
      curEffort = "";
      continue;
    }
    if (inSection && /^id\s*=/.test(line)) {
      curId = quoted(line);
      continue;
    }
    if (inSection && /^effort\s*=/.test(line)) {
      curEffort = quoted(line);
      continue;
    }
  }
  flush();
  return found;
}

// emit_effort_line: the config line for a roster block's effort (real value or
// the commented placeholder).
export function emitEffortLine(pmId: string, section: string, id: string): string {
  const effort = readExistingAgentEffort(pmId, section, id);
  return effort !== "" ? `effort = "${effort}"` : `# effort = "xhigh"`;
}

// detect_setup_state: complete | partial | starter | absent.
export function detectSetupState(pmId: string): string {
  const pmRoot = `__garelier/${pmId}`;
  const pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");
  const toml = `${pmDir}/setup_config.toml`;
  const tomlLines = readLines(toml);
  if (tomlLines !== null) {
    const hasSetupHeading = tomlLines.some((l) => /^\[setup\]/.test(l));
    if (hasSetupHeading) {
      let inSetup = false;
      let complete = false;
      for (const line of tomlLines) {
        if (line === "[setup]") {
          inSetup = true;
          continue;
        }
        if (/^\[/.test(line)) inSetup = false;
        if (inSetup && /^complete\s*=\s*true/.test(line)) {
          complete = true;
          break;
        }
      }
      if (complete) return "complete";
    }
    const hasBranches = tomlLines.some((l) => /^\[branches\]/.test(l));
    if (
      hasBranches &&
      existsSync(`${pmRoot}/runtime/manifest.md`) &&
      existsSync(`${pmDir}/history.md`)
    ) {
      return "complete";
    }
    return "partial";
  }
  const controlToml = `${pmRoot}/control/control.toml`;
  const controlLines = readLines(controlToml);
  if (
    controlLines !== null &&
    controlLines.some((l) => /^kind\s*=\s*"garelier_control"\s*$/.test(l)) &&
    controlLines.some((l) => /^mode\s*=\s*"control_only"\s*$/.test(l))
  ) {
    return "starter";
  }
  for (const d of ["runtime", "control", "_crew", "_dock", "_workers", "_scouts", "_smiths"]) {
    if (existsSync(`${pmRoot}/${d}`)) return "partial";
  }
  return "absent";
}
