import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReachability } from "./check_knowledge_reachability";

// Pins the 3 DEC-090 reachability routes (index Topic-table row / role_index
// read_first-on_demand / [[triggers]].read), the orphan-detection failure
// mode, and the index-less "consumption" fallback (external_operations has no
// index.md; a sibling doc's backtick-quoted mention substitutes for the
// Topic-table row it would otherwise carry).

let root: string;
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function templatesRoot(): string {
  root = mkdtempSync(join(tmpdir(), "garelier-knowledge-reach-"));
  return join(root, "skills", "garelier-librarian", "templates");
}

describe("computeReachability", () => {
  test("route (a): reachable via a Topic-table row in the category index.md", () => {
    const templates = templatesRoot();
    const eng = join(templates, "engineering");
    mkdirSync(eng, { recursive: true });
    writeFileSync(
      join(eng, "index.md"),
      "# Engineering Knowledge Index\n\n## Canonical files\n\n| Topic | File | Primary consumers |\n| --- | --- | --- |\n| Widget policy | `widget_policy.md` | Worker |\n",
    );
    writeFileSync(join(eng, "widget_policy.md"), "# Widget policy\n");
    writeFileSync(join(templates, "role_index.toml"), "schema_version = 1\n");

    const result = computeReachability(root);
    expect(result.orphans).not.toContain("engineering/widget_policy.md");
  });

  test("route (b): reachable via a role's read_first/on_demand entry", () => {
    const templates = templatesRoot();
    const eng = join(templates, "engineering");
    mkdirSync(eng, { recursive: true });
    writeFileSync(join(eng, "index.md"), "# Engineering Knowledge Index\n");
    writeFileSync(join(eng, "gadget_policy.md"), "# Gadget policy\n");
    writeFileSync(
      join(templates, "role_index.toml"),
      '[roles.worker]\nread_first = []\non_demand = [\n  "engineering/gadget_policy.md",\n]\n',
    );

    const result = computeReachability(root);
    expect(result.orphans).not.toContain("engineering/gadget_policy.md");
  });

  test("route (c): reachable via a [[triggers]].read entry", () => {
    const templates = templatesRoot();
    const eng = join(templates, "engineering");
    mkdirSync(eng, { recursive: true });
    writeFileSync(join(eng, "index.md"), "# Engineering Knowledge Index\n");
    writeFileSync(join(eng, "sprocket_policy.md"), "# Sprocket policy\n");
    writeFileSync(
      join(templates, "role_index.toml"),
      '[[triggers]]\nwhen = ["sprocket"]\nread = ["engineering/sprocket_policy.md"]\n',
    );

    const result = computeReachability(root);
    expect(result.orphans).not.toContain("engineering/sprocket_policy.md");
  });

  test("orphan: no index row, no read_first/on_demand, no trigger -> flagged", () => {
    const templates = templatesRoot();
    const eng = join(templates, "engineering");
    mkdirSync(eng, { recursive: true });
    writeFileSync(join(eng, "index.md"), "# Engineering Knowledge Index\n(no rows)\n");
    writeFileSync(join(eng, "forgotten_policy.md"), "# Forgotten policy\n");
    writeFileSync(join(templates, "role_index.toml"), "schema_version = 1\n");

    const result = computeReachability(root);
    expect(result.orphans).toContain("engineering/forgotten_policy.md");
  });

  test("index-less category: a sibling doc's backtick-quoted mention satisfies route (a)", () => {
    const templates = templatesRoot();
    const extops = join(templates, "external_operations");
    const runbooks = join(extops, "runbooks");
    mkdirSync(runbooks, { recursive: true });
    // external_operations ships no index.md; the hub policy doc plays that role.
    writeFileSync(
      join(extops, "external_operations_policy.md"),
      "# External Operations Policy\n\n## Files in this tree\n\n- `runbooks/create_widget.md`\n",
    );
    writeFileSync(join(runbooks, "create_widget.md"), "# Create widget runbook\n");
    writeFileSync(
      join(templates, "role_index.toml"),
      '[roles.concierge]\nread_first = [\n  "external_operations/external_operations_policy.md",\n]\n',
    );

    const result = computeReachability(root);
    expect(result.orphans).not.toContain("external_operations/runbooks/create_widget.md");
  });

  test("index-less category: a doc mentioned nowhere is still an orphan", () => {
    const templates = templatesRoot();
    const extops = join(templates, "external_operations");
    mkdirSync(extops, { recursive: true });
    writeFileSync(
      join(extops, "external_operations_policy.md"),
      "# External Operations Policy\n\nNo file inventory here.\n",
    );
    writeFileSync(join(extops, "orphan_policy.md"), "# Orphan policy\n");
    writeFileSync(
      join(templates, "role_index.toml"),
      '[roles.concierge]\nread_first = [\n  "external_operations/external_operations_policy.md",\n]\n',
    );

    const result = computeReachability(root);
    expect(result.orphans).toContain("external_operations/orphan_policy.md");
  });

  test("nested templates/ output-artifact dirs and index.md itself are out of scope", () => {
    const templates = templatesRoot();
    const extops = join(templates, "external_operations");
    const nestedTemplates = join(extops, "templates");
    mkdirSync(nestedTemplates, { recursive: true });
    writeFileSync(join(extops, "external_operations_policy.md"), "# hub\n");
    writeFileSync(join(nestedTemplates, "ticket_update.md"), "# fill-in template, not a knowledge doc\n");
    writeFileSync(
      join(templates, "role_index.toml"),
      '[roles.concierge]\nread_first = [\n  "external_operations/external_operations_policy.md",\n]\n',
    );

    const result = computeReachability(root);
    expect(result.scanned).toBe(1); // only external_operations_policy.md counted
    expect(result.orphans).toEqual([]);
  });
});
