// Project file tree + safe Markdown rendering for the Status Web Console.
//
// "It's just TS displaying existing files" — this module reads the project's
// files and turns Markdown into HTML. No AI, no content generation.
//
// Safety by construction:
//   - The browsable set is `git ls-files --cached --others --exclude-standard`
//     (respecting .gitignore — so .git/ and gitignored secrets are excluded)
//     UNION a direct, symlink-skipping walk of this PM's __garelier/<pmId>/
//     subtree (so runtime reports/inboxes are viewable). Traversal is prevented
//     by membership PLUS a realpath-containment check and secret-name exclusion
//     in the server's /api/file handler — see status_server.ts.
//   - The Markdown renderer ESCAPES all text before inserting any markup, so a
//     repo document cannot inject <script> (no XSS), and link hrefs are
//     scheme-checked (http/https/mailto/anchor/relative only).
// Secret redaction (status_snapshot.redact) is still applied by the server to
// served content as a belt-and-suspenders measure for tracked-but-sensitive
// strings — important because the console may be bound to the LAN for viewing
// from another host.

export interface TreeNode {
  name: string;
  path: string; // repo-relative, forward slashes ("" for root)
  type: "dir" | "file";
  children?: TreeNode[];
}

// Build a nested tree from a flat list of repo-relative file paths. Pure.
export function buildTreeFromPaths(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirIndex = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (dirPath: string): TreeNode => {
    const existing = dirIndex.get(dirPath);
    if (existing) return existing;
    const slash = dirPath.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : dirPath.slice(0, slash);
    const name = slash === -1 ? dirPath : dirPath.slice(slash + 1);
    const parent = ensureDir(parentPath);
    const node: TreeNode = { name, path: dirPath, type: "dir", children: [] };
    parent.children!.push(node);
    dirIndex.set(dirPath, node);
    return node;
  };

  for (const raw of paths) {
    const p = raw.trim().replace(/\\/g, "/");
    if (!p) continue;
    const slash = p.lastIndexOf("/");
    const dirPath = slash === -1 ? "" : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    const parent = ensureDir(dirPath);
    parent.children!.push({ name, path: p, type: "file" });
  }

  // Sort each level: directories first, then files, alphabetically.
  const sortNode = (n: TreeNode): void => {
    if (!n.children) return;
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

// Flatten a tree to the set of file paths (for membership validation). Pure.
export function fileSet(root: TreeNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode): void => {
    if (n.type === "file") out.add(n.path);
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Allow only safe link schemes; everything else becomes inert text.
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[#/]/.test(u)) return u; // anchor or root-relative
  if (/^[\w./-]+$/.test(u)) return u; // bare relative path
  return null; // reject javascript:, data:, etc.
}

// Sentinel for protecting code-span contents during inline processing.
// U+FFFC (OBJECT REPLACEMENT CHARACTER) does not occur in real documents.
const SENT = "￼";

// Inline formatting on already-escaped text: code spans, bold, italic, links.
function renderInline(escaped: string): string {
  // Neutralize any author-written U+FFFC so it can't collide with the code-span
  // sentinel below (input is already HTML-escaped, so the entity is inert).
  escaped = escaped.replace(/￼/g, "&#65532;");
  const spans: string[] = [];
  // Protect `code` spans so ** / * / [] inside them are not reprocessed.
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    spans.push(`<code>${code}</code>`);
    return SENT + (spans.length - 1) + SENT;
  });
  // Links [text](href) — text already escaped; validate href.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const h = safeHref(String(href));
    if (!h) return text;
    return `<a href="${escapeHtml(h)}" rel="noopener noreferrer">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  // Restore code spans.
  s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_m, i) => spans[Number(i)]);
  return s;
}

// Compact, safe Markdown → HTML. Handles ATX headings, fenced code (incl.
// ```mermaid → <pre class="mermaid">), blockquotes, unordered/ordered lists,
// tables (GFM pipe), horizontal rules, and paragraphs. Pure.
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  // A separator row needs at least one dash group AND a literal pipe (so a bare
  // `---` stays a horizontal rule). The `*` allows a single-column table.
  const isTableSep = (s: string): boolean =>
    /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.includes("|");
  const splitRow = (s: string): string[] =>
    s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const escaped = escapeHtml(body.join("\n"));
      if (lang === "mermaid") {
        out.push(`<pre class="mermaid">${escaped}</pre>`);
      } else {
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        out.push(`<pre><code${cls}>${escaped}</code></pre>`);
      }
      continue;
    }

    // ATX heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Table (header row followed by a separator row).
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((c) => `<th>${renderInline(escapeHtml(c))}</th>`).join("");
      const trs = rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Blockquote (consecutive > lines).
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderInline(escapeHtml(buf.join(" ")))}</blockquote>`);
      continue;
    }

    // Lists (unordered or ordered); supports flat lists.
    const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
    const olItem = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ulItem || olItem) {
      const ordered = !!olItem;
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/) : lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${renderInline(escapeHtml(m[1]))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-structural lines).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(escapeHtml(para.join(" ")))}</p>`);
  }

  return out.join("\n");
}

// Extensions we always treat as viewable text (source/config/docs), so the
// LAN source viewer shows them even if a byte sniff is inconclusive.
const TEXT_EXT =
  /\.(md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonc|toml|yaml|yml|sh|ps1|bash|py|rs|go|java|c|h|cpp|hpp|css|scss|html|xml|sql|ini|cfg|conf|env|gitignore|dockerfile|mermaid|mmd|lock|svg|csv|tsv)$/i;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tar|7z|rar|exe|dll|so|dylib|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|class|jar|bin|o|a|node)$/i;

// Classify a file by extension first, then a NUL-byte sniff for unknowns. Pure.
export function classifyContent(name: string, bytes: Uint8Array): "markdown" | "text" | "binary" {
  if (/\.(md|markdown)$/i.test(name)) return "markdown";
  if (BINARY_EXT.test(name)) return "binary";
  if (TEXT_EXT.test(name)) return "text";
  // Unknown extension: a NUL byte in the first 8 KiB means binary.
  const n = Math.min(bytes.length, 8192);
  for (let k = 0; k < n; k++) if (bytes[k] === 0) return "binary";
  return "text";
}
