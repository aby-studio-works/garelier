import { test, expect } from "bun:test";
import {
  renderMarkdown,
  buildTreeFromPaths,
  fileSet,
  classifyContent,
} from "./docs_view.ts";

test("renderMarkdown escapes HTML (no XSS)", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("renderMarkdown headings and inline", () => {
  expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
  expect(renderMarkdown("a **b** c")).toContain("<strong>b</strong>");
  expect(renderMarkdown("a *b* c")).toContain("<em>b</em>");
  expect(renderMarkdown("use `code` here")).toContain("<code>code</code>");
});

test("renderMarkdown code fence escapes content", () => {
  const html = renderMarkdown("```ts\nconst x = a < b && c > d;\n```");
  expect(html).toContain('<pre><code class="language-ts">');
  expect(html).toContain("a &lt; b &amp;&amp; c &gt; d");
});

test("renderMarkdown mermaid fence → <pre class=mermaid>", () => {
  const html = renderMarkdown("```mermaid\ngraph TD; A-->B\n```");
  expect(html).toContain('<pre class="mermaid">');
  expect(html).toContain("A--&gt;B"); // escaped; mermaid reads textContent (decoded)
  expect(html).not.toContain("<code");
});

test("renderMarkdown safe link, rejects javascript: scheme", () => {
  expect(renderMarkdown("[ok](https://example.com)")).toContain('<a href="https://example.com"');
  const bad = renderMarkdown("[x](javascript:alert(1))");
  expect(bad).not.toContain("href");
  expect(bad).toContain("x");
});

test("renderMarkdown lists and table", () => {
  expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  const t = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |");
  expect(t).toContain("<table>");
  expect(t).toContain("<th>A</th>");
  expect(t).toContain("<td>1</td>");
});

test("buildTreeFromPaths nests and sorts dirs-first", () => {
  const root = buildTreeFromPaths(["docs/b.md", "docs/a.md", "README.md", "src/x/y.ts"]);
  // top level: docs (dir), src (dir), README.md (file) — dirs first, then files
  expect(root.children!.map((c) => c.name)).toEqual(["docs", "src", "README.md"]);
  const docs = root.children!.find((c) => c.name === "docs")!;
  expect(docs.type).toBe("dir");
  expect(docs.children!.map((c) => c.name)).toEqual(["a.md", "b.md"]); // sorted
  const src = root.children!.find((c) => c.name === "src")!;
  expect(src.children![0].name).toBe("x");
  expect(src.children![0].children![0].path).toBe("src/x/y.ts");
});

test("fileSet returns only file paths for membership checks", () => {
  const root = buildTreeFromPaths(["docs/a.md", "src/x/y.ts"]);
  const set = fileSet(root);
  expect(set.has("docs/a.md")).toBe(true);
  expect(set.has("src/x/y.ts")).toBe(true);
  expect(set.has("docs")).toBe(false); // dir, not a file
  expect(set.has("../etc/passwd")).toBe(false); // traversal not a member
});

test("classifyContent: markdown / text / binary", () => {
  const enc = new TextEncoder();
  expect(classifyContent("a.md", enc.encode("# hi"))).toBe("markdown");
  expect(classifyContent("a.txt", enc.encode("plain"))).toBe("text");
  expect(classifyContent("a.bin", new Uint8Array([1, 2, 0, 3]))).toBe("binary");
});
