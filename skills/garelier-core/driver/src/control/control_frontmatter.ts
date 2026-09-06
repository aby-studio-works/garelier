import { parse as parseToml } from "smol-toml";

export class ControlFrontmatterError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "ControlFrontmatterError";
  }
}

export interface ParsedControlFrontmatter {
  data: Record<string, unknown>;
  frontmatterSource: string;
  body: string;
}

function firstLineEnd(source: string): number {
  const index = source.indexOf("\n");
  return index < 0 ? source.length : index + 1;
}

export function parseControlFrontmatter(source: string, path: string): ParsedControlFrontmatter {
  const openingEnd = firstLineEnd(source);
  const opening = source.slice(0, openingEnd).replace(/\r?\n$/, "");
  if (opening !== "+++") throw new ControlFrontmatterError("TOML front matter opening delimiter must be the first line", path);

  let cursor = openingEnd;
  let closingStart = -1;
  let closingEnd = -1;
  while (cursor <= source.length) {
    const next = source.indexOf("\n", cursor);
    const end = next < 0 ? source.length : next + 1;
    const line = source.slice(cursor, end).replace(/\r?\n$/, "");
    if (line === "+++") {
      closingStart = cursor;
      closingEnd = end;
      break;
    }
    if (next < 0) break;
    cursor = end;
  }
  if (closingStart < 0) throw new ControlFrontmatterError("unterminated TOML front matter", path);

  const frontmatterSource = source.slice(openingEnd, closingStart);
  let parsed: unknown;
  try {
    parsed = parseToml(frontmatterSource);
  } catch (error) {
    throw new ControlFrontmatterError(`malformed TOML: ${(error as Error).message}`, path);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlFrontmatterError("TOML front matter must decode to a table", path);
  }
  return {
    data: parsed as Record<string, unknown>,
    frontmatterSource,
    body: source.slice(closingEnd),
  };
}

export function markdownSections(source: string): import("./plan_graph_types.ts").MarkdownSection[] {
  const lines = source.split(/\r?\n/);
  const headings: Array<{ level: 2 | 3; heading: string; line: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^(##|###)\s+(.+?)\s*$/);
    if (match) headings.push({ level: match[1]!.length as 2 | 3, heading: match[2]!, line: index });
  }
  return headings.map((heading, index) => {
    const next = headings[index + 1]?.line ?? lines.length;
    const body = lines.slice(heading.line + 1, next).join("\n").replace(/^\n+|\n+$/g, "");
    return {
      level: heading.level,
      heading: heading.heading,
      startLine: heading.line + 1,
      endLine: next,
      body,
      related: typedReferences(body),
    };
  });
}

export function typedReferences(source: string): string[] {
  const matches = source.matchAll(/\b(roadmap:[a-z0-9][a-z0-9._-]*|milestone:[a-z0-9][a-z0-9._-]*|backlog:W-\d{3,}|checkpoint:CP-\d{3,}|decision:DEC-\d{3,}|blueprint:[A-Za-z0-9][A-Za-z0-9._/-]*|note:N-\d{3,}|report:[A-Za-z0-9][A-Za-z0-9._/-]*)\b/gi);
  return [...new Set([...matches].map((match) => match[1]!))];
}

export function sectionBody(
  sections: import("./plan_graph_types.ts").MarkdownSection[],
  heading: string,
): string {
  return sections.find((section) => section.heading.trim().toLowerCase() === heading.trim().toLowerCase())?.body ?? "";
}
