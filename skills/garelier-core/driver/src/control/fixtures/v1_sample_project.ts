export const V1_SAMPLE_EXPECTED = {
  tables: 5,
  candidates: 277,
  parsed: 274,
  malformed: 3,
  malformedColumnCounts: [8, 10, 11],
} as const;

const HEADER = "| ID | Type | Priority | Status | Owner | Milestone | Outcome | Acceptance | Detail |";
const SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";

function canonicalIds(): string[] {
  return [
    ...Array.from({ length: 271 }, (_, i) => `W-${String(i + 1).padStart(3, "0")}`),
    "W-999",
    "W-1000",
    "W-100000",
  ];
}

function canonicalRow(id: string): string {
  const outcome = id === "W-001" ? "escaped \\| outcome" : `outcome ${id}`;
  const acceptance = id === "W-002" ? "`left | right` remains one cell" : `acceptance ${id}`;
  return `| ${id} | feature | normal | ready | - | m22 | ${outcome} | ${acceptance} | detail ${id} |`;
}

export function buildV1SampleFixture(): string {
  const ids = canonicalIds();
  const sizes = [55, 55, 55, 55, 54];
  const malformed = [
    "| W-100001 | feature | normal | ready | - | m22 | eight columns | acceptance |",
    "| W-100002 | feature | normal | ready | - | m22 | ten columns | acceptance | detail | extra |",
    "| W-100003 | feature | normal | ready | - | m22 | eleven columns | acceptance | detail | extra | extra-2 |",
  ];
  const blocks: string[] = [];
  let offset = 0;
  for (let i = 0; i < sizes.length; i++) {
    const rows = ids.slice(offset, offset + sizes[i]).map(canonicalRow);
    offset += sizes[i];
    if (i < malformed.length) rows.push(malformed[i]);
    blocks.push([`## Open work ${i + 1}`, "", HEADER, SEPARATOR, ...rows].join("\n"));
  }
  return `${blocks.join("\n\nInter-table prose.\n\n")}\n`;
}
