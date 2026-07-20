// Pure text/TOML parsers for the Garelier Doctor (W-083 ts-first port).
//
// These are faithful ports of the ad-hoc awk/grep helpers embedded in the
// original doctor.ts. Doctor is a fault-tolerant DIAGNOSTIC that parses
// possibly-broken setup_config.toml (placeholder leakage, missing sections,
// malformed arrays) WITHOUT throwing — so it deliberately does NOT route
// through the driver's config.ts loader (which validates/normalizes and would
// throw on exactly the broken states doctor exists to detect). Every function
// mirrors its awk source line-for-line to preserve bit-exact CLI parity.
//
// A future dedup pass (W-083 §禁止 notes the shared-helper lane) may consolidate
// the generic bits; kept local here to avoid cross-lane conflicts.

/**
 * Split file content into awk-style records (RS="\n"): a trailing newline does
 * NOT create an empty final record, but an interior blank line does.
 */
export function toLines(content: string): string[] {
  if (content === "") return []; // awk: empty input yields zero records
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * read_toml: single scalar `key = ...` inside [section]. Strips the `key =`
 * prefix, a trailing `# comment`, and one layer of surrounding double-quotes.
 * Returns "" when absent.
 */
export function readToml(content: string, section: string, key: string): string {
  const secHeader = `[${section}]`;
  const keyRe = new RegExp("^" + key + "\\s*=");
  let inSection = false;
  for (const line of toLines(content)) {
    if (line === secHeader) {
      inSection = true;
      continue;
    }
    if (/^\[/.test(line)) inSection = false;
    if (inSection && keyRe.test(line)) {
      let v = line;
      v = v.replace(/^[^=]*=\s*/, "");
      v = v.replace(/\s*#.*$/, "");
      v = v.replace(/^"/, "").replace(/"$/, "");
      return v;
    }
  }
  return "";
}

/** toml_section_present: true if a bare [section] header line exists. */
export function tomlSectionPresent(content: string, section: string): boolean {
  const secHeader = `[${section}]`;
  return toLines(content).some((l) => l === secHeader);
}

/**
 * toml_array_body: raw lines of `key = [...]` inside [section], from the key
 * line through the first line containing a closing `]`.
 */
export function tomlArrayBody(content: string, section: string, key: string): string[] {
  const secHeader = `[${section}]`;
  const keyRe = new RegExp("^" + key + "\\s*=");
  let inSection = false;
  let capture = false;
  const out: string[] = [];
  for (const line of toLines(content)) {
    if (line === secHeader) {
      inSection = true;
      continue;
    }
    if (/^\[/.test(line)) {
      if (capture) return out; // awk: exit
      inSection = false;
      continue;
    }
    if (inSection && !capture && keyRe.test(line)) {
      capture = true;
      out.push(line);
      if (line.includes("]")) return out;
      continue;
    }
    if (capture) {
      out.push(line);
      if (line.includes("]")) return out;
    }
  }
  return out;
}

/**
 * toml_array_count: count non-comment quoted string elements in an array body
 * (per-line `#`-comment strip, then count of `"..."` occurrences).
 */
export function tomlArrayCount(content: string, section: string, key: string): number {
  let n = 0;
  for (const line of tomlArrayBody(content, section, key)) {
    const s = line.replace(/#.*$/, "");
    const m = s.match(/"[^"]*"/g);
    if (m) n += m.length;
  }
  return n;
}

/** first `"..."` inner value on a line, or "" (mirrors awk match/substr). */
function firstQuoted(line: string): string {
  const m = line.match(/"[^"]*"/);
  return m ? m[0].slice(1, -1) : "";
}

/** list_agent_ids: id values from every [[section]] block. */
export function listAgentIds(content: string, section: string): string[] {
  const header = `[[${section}]]`;
  let inSection = false;
  const out: string[] = [];
  for (const line of toLines(content)) {
    if (line === header) {
      inSection = true;
      continue;
    }
    if (/^\[/.test(line)) inSection = false;
    if (inSection && /^id\s*=/.test(line)) out.push(firstQuoted(line));
  }
  return out;
}

/**
 * Generic [[section]] block field walker with the awk flush() semantics: emits
 * `field` for every block whose id equals wantId and whose field is non-empty.
 */
function agentFieldForId(
  content: string,
  section: string,
  wantId: string,
  extract: (line: string) => string | undefined,
): string {
  const header = `[[${section}]]`;
  let inSection = false;
  let curId = "";
  let curField = "";
  let found = false;
  const results: string[] = [];
  const flush = () => {
    if (curId === wantId && curField !== "") {
      results.push(curField);
      found = true;
    }
  };
  for (const line of toLines(content)) {
    if (line === header) {
      if (inSection) flush();
      inSection = true;
      curId = "";
      curField = "";
      continue;
    }
    if (/^\[/.test(line)) {
      if (inSection) {
        flush();
        inSection = false;
      }
      continue;
    }
    if (inSection && /^id\s*=/.test(line)) curId = firstQuoted(line);
    if (inSection) {
      const f = extract(line);
      if (f !== undefined) curField = f;
    }
  }
  if (inSection && !found) flush();
  return results.join("\n");
}

/** agent_worktree_for_id: worktree value (first quoted) for a block id. */
export function agentWorktreeForId(content: string, section: string, wantId: string): string {
  return agentFieldForId(content, section, wantId, (line) =>
    /^worktree\s*=/.test(line) ? firstQuoted(line) : undefined,
  );
}

/** agent_checkout_for_id: bare `checkout` value (whitespace stripped, no quote logic). */
export function agentCheckoutForId(content: string, section: string, wantId: string): string {
  return agentFieldForId(content, section, wantId, (line) => {
    if (!/^checkout\s*=/.test(line)) return undefined;
    let v = line.replace(/^checkout\s*=\s*/, "");
    v = v.replace(/\s/g, "");
    return v;
  });
}

/** ws_pointer_key_d: plural-role + id -> "<role>.<id>" pointer key ("artisan" special). */
export function wsPointerKeyD(role: string, id: string): string {
  if (role === "artisan") return "artisan";
  let r: string;
  switch (role) {
    case "workers": r = "worker"; break;
    case "scouts": r = "scout"; break;
    case "smiths": r = "smith"; break;
    case "librarians": r = "librarian"; break;
    case "observers": r = "observer"; break;
    case "guardians": r = "guardian"; break;
    case "concierges": r = "concierge"; break;
    default: r = role.replace(/s$/, "");
  }
  return `${r}.${id}`;
}

/**
 * workspace_paths pointer lookup: value after `key=` on the first line that
 * STARTS with `key=` (awk index($0,k"=")==1). Returns undefined when unset.
 */
export function workspacePointerValue(content: string, key: string): string | undefined {
  const prefix = key + "=";
  for (const line of toLines(content)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

/** pid_from_file, operating on raw file content (command-sub strips trailing newlines). */
export function pidFromContent(content: string): string {
  const raw = content.replace(/\n+$/, "");
  const numericLine = raw.split("\n").some((l) => /^[ \t\r\f\v]*[0-9]+[ \t\r\f\v]*$/.test(l));
  if (numericLine) return raw.replace(/\s/g, "");
  const m = raw.match(/"(?:pid|child_pid)"\s*:\s*[0-9]+/);
  if (!m) return "";
  const num = m[0].match(/[0-9]+/);
  return num ? num[0] : "";
}

/** json_string_field: first `"field": "value"` string value across all lines. */
export function jsonStringField(content: string, field: string): string {
  const re = new RegExp('"' + field + '"\\s*:\\s*"([^"]*)"');
  for (const line of content.split("\n")) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return "";
}

/** crust_container_paths: [[containers]] -> array of {id, path} (path defaults to id). */
export function crustContainerPaths(content: string): Array<{ id: string; path: string }> {
  const clean = (v: string): string => {
    v = v.replace(/^[^=]*=\s*/, "");
    v = v.replace(/\s*#.*$/, "");
    v = v.replace(/^"/, "").replace(/"$/, "");
    return v;
  };
  const rows: Array<{ id: string; path: string }> = [];
  let inContainer = false;
  let id = "";
  let path = "";
  const flush = () => {
    if (id !== "") {
      rows.push({ id, path: path === "" ? id : path });
    }
  };
  for (const line of toLines(content)) {
    if (/^\[\[containers\]\]/.test(line)) {
      if (inContainer) flush();
      inContainer = true;
      id = "";
      path = "";
      continue;
    }
    if (/^\[/.test(line)) {
      if (inContainer) {
        flush();
        inContainer = false;
        id = "";
        path = "";
      }
      continue;
    }
    if (inContainer && /^\s*id\s*=/.test(line)) {
      id = clean(line);
      continue;
    }
    if (inContainer && /^\s*path\s*=/.test(line)) {
      path = clean(line);
      continue;
    }
  }
  if (inContainer) flush();
  return rows;
}

/** risky_provider_in_table: sorted-unique gemini/cursor provider values, each with a trailing space. */
export function riskyProviderInTable(content: string, section: string): string {
  const header = `[[${section}]]`;
  let inblk = false;
  const vals = new Set<string>();
  for (const line of toLines(content)) {
    if (line === header) {
      inblk = true;
      continue;
    }
    if (/^\[/.test(line)) inblk = false;
    if (inblk && /^\s*provider\s*=/.test(line)) {
      let v = line.replace(/^[^=]*=\s*/, "");
      v = v.replace(/["\x20]/g, "");
      if (/gemini|cursor/.test(v)) vals.add(v);
    }
  }
  return [...vals].sort().map((v) => v + " ").join("");
}
