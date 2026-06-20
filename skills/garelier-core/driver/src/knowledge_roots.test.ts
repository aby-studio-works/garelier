// DEC-077: two-layer knowledge resolution — shared-priority by default, with a
// per-topic `override_shared: true` letting a per-pm topic win.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveKnowledgeRef, hasOverrideShared, knowledgeRelPath } from "./knowledge_roots.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {} });

function project(): string { const r = mkdtempSync(join(tmpdir(), "kroots-")); dirs.push(r); return r; }
function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}
const pmRel = (pm: string, rel: string) => `__garelier/${pm}/knowledge/${rel}`;
const sharedRel = (rel: string) => `__garelier/__atmos/knowledge/${rel}`;

describe("knowledgeRelPath", () => {
  it("strips a knowledge-root prefix from either layer", () => {
    expect(knowledgeRelPath("__garelier/__atmos/knowledge/role_index.toml")).toBe("role_index.toml");
    expect(knowledgeRelPath("__garelier/acme/knowledge/engineering/index.md")).toBe("engineering/index.md");
    expect(knowledgeRelPath("security/index.md")).toBe("security/index.md");
  });
  it("rejects traversal/absolute refs", () => {
    expect(knowledgeRelPath("../escape.md")).toBeNull();
    expect(knowledgeRelPath("C:/abs.md")).toBeNull();
  });
});

describe("resolveKnowledgeRef precedence", () => {
  it("pm-only when shared is absent (the on-demand __atmos does not exist)", () => {
    const root = project();
    write(root, pmRel("acme", "engineering/index.md"), "# pm");
    const hit = resolveKnowledgeRef(root, "acme", "engineering/index.md");
    expect(hit?.layer).toBe("pm");
    expect(hit?.overridden).toBe(false);
  });

  it("shared wins by default when both layers have the topic", () => {
    const root = project();
    write(root, sharedRel("security/license_policy.md"), "# shared");
    write(root, pmRel("acme", "security/license_policy.md"), "# pm copy (no flag)");
    const hit = resolveKnowledgeRef(root, "acme", "security/license_policy.md");
    expect(hit?.layer).toBe("shared");
    expect(hit?.overridden).toBe(false);
  });

  it("per-pm topic with override_shared: true wins over shared", () => {
    const root = project();
    write(root, sharedRel("security/license_policy.md"), "# shared");
    write(root, pmRel("acme", "security/license_policy.md"), "---\noverride_shared: true\n---\n# pm override");
    const hit = resolveKnowledgeRef(root, "acme", "security/license_policy.md");
    expect(hit?.layer).toBe("pm");
    expect(hit?.overridden).toBe(true);
  });

  it("returns null when absent from every layer", () => {
    const root = project();
    expect(resolveKnowledgeRef(root, "acme", "nope/missing.md")).toBeNull();
  });
});

describe("hasOverrideShared", () => {
  it("true only for front matter with override_shared: true", () => {
    const root = project();
    write(root, "a.md", "---\noverride_shared: true\n---\n# x");
    write(root, "b.md", "---\noverride_shared: false\n---\n# x");
    write(root, "c.md", "# no front matter");
    expect(hasOverrideShared(join(root, "a.md"))).toBe(true);
    expect(hasOverrideShared(join(root, "b.md"))).toBe(false);
    expect(hasOverrideShared(join(root, "c.md"))).toBe(false);
    expect(hasOverrideShared(join(root, "missing.md"))).toBe(false);
  });
});
