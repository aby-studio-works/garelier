// Minimal GFM pipe-table extractor for the read-only Status Web Console
// parsers (overview/queue). Pure, dependency-free, and total: malformed input
// yields fewer/empty tables rather than throwing.

export interface MdTable {
  header: string[];
  rows: string[][];
}

// A separator row: |---|:--:|---| (the line under a table header). Needs at
// least one dash group AND a literal pipe (so a bare `---` is not a separator);
// the `*` lets a single-column table separator (`| --- |`) match.
const isSep = (s: string): boolean =>
  /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.includes("|");

// Split a single pipe row into trimmed cells, dropping the leading/trailing pipe.
const splitRow = (s: string): string[] =>
  s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

// Extract every (header + separator + data rows) table block from markdown.
// A table starts at a line containing "|" immediately followed by a separator
// row, and runs until the first blank/non-pipe line.
export function parsePipeTables(md: string): MdTable[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const tables: MdTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = splitRow(lines[i]);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      tables.push({ header, rows });
    }
  }
  return tables;
}

// Build a header-name -> column-index map (lowercased, trimmed) so a parser can
// address cells by name and tolerate column reordering. First match wins.
export function columnIndex(header: string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => {
    const key = h.toLowerCase().trim();
    if (key && !m.has(key)) m.set(key, i);
  });
  return m;
}

// Cell lookup by any of the candidate header names; returns "" when absent.
export function cell(row: string[], cols: Map<string, number>, ...names: string[]): string {
  for (const n of names) {
    const i = cols.get(n.toLowerCase());
    if (i != null && i < row.length) return row[i];
  }
  return "";
}
