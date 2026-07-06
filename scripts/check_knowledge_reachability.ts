// W-074: reverse reachability lint for the Librarian knowledge trees.
//
// DEC-090 (role_index.toml:36-51, knowledge_contract.md §Maintenance) names the
// "orphan knowledge doc" failure mode: a doc ships with no read path and is
// never found by any role. The existing DEC-029 check in ci.sh ("role
// knowledge trees lint") only validates the FORWARD direction — every doc path
// role_index.toml names must exist as a template file. This script is the
// missing REVERSE direction: every doc under the six templates trees must be
// reachable via at least one of the 3 routes DEC-090 prescribes:
//   (a) a Topic-table row in its own category's index.md ("Canonical files");
//   (b) a role's read_first/on_demand entry (role_index.toml);
//   (c) a [[triggers]].read entry (role_index.toml).
// (b) and (c) are checked with one scan: both are `"tree/file.md"` array
// entries in the same role_index.toml, in the same quoted-path shape the
// existing forward check already parses (ci.sh's DEC-029 step).
//
// external_operations ships no index.md (the DEC-025 default set never added
// one). Its `external_operations_policy.md` "Files in this tree" section
// (itself role_index-reachable via Concierge's read_first) enumerates every
// sibling doc by backtick-quoted path, playing the same role a Topic-table row
// would. Route (a) treats a backtick-quoted match (relative-to-category path,
// or bare basename) in any OTHER doc of an index-less category as satisfying
// the same "index consumption" route so this default set is not flagged.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORIES = ["engineering", "quality", "review", "security", "system", "external_operations"];

export interface ReachabilityResult {
  scanned: number;
  orphans: string[]; // tree-relative paths, e.g. "external_operations/runbooks/create_pr.md"
}

// Nested "templates/" directories (external_operations/templates/,
// security/templates/) hold fill-in-the-blank output artifacts (PR bodies,
// release notes, ...), not knowledge docs a role reads for guidance — they are
// out of this lint's scope, same as index.md itself.
function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "templates") continue;
      out.push(...walkMarkdown(full));
    } else if (entry.toLowerCase().endsWith(".md") && entry.toLowerCase() !== "index.md") {
      out.push(full);
    }
  }
  return out;
}

// role_index entries are knowledge-relative (`<tree>/<file>.md`), quoted in
// TOML arrays (read_first / on_demand / [[triggers]].read all share this
// shape) — matching only quoted paths keeps prose mentions in comments from
// counting as a route, mirroring ci.sh's existing forward-check extraction.
function parseRoleIndexPaths(text: string): Set<string> {
  const set = new Set<string>();
  const re = /"([A-Za-z0-9_/.-]+\.md)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    set.add(m[1].replace(/^__garelier\/[^/]+\/knowledge\//, ""));
  }
  return set;
}

export function computeReachability(root: string): ReachabilityResult {
  const templatesDir = join(root, "skills", "garelier-librarian", "templates");
  const roleIndexPath = join(templatesDir, "role_index.toml");
  const roleIndexPaths = parseRoleIndexPaths(
    existsSync(roleIndexPath) ? readFileSync(roleIndexPath, "utf8") : "",
  );

  const orphans: string[] = [];
  let scanned = 0;

  for (const category of CATEGORIES) {
    const categoryDir = join(templatesDir, category);
    const indexPath = join(categoryDir, "index.md");
    const hasIndex = existsSync(indexPath);
    const indexText = hasIndex ? readFileSync(indexPath, "utf8") : "";

    const files = walkMarkdown(categoryDir);
    const fileTexts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

    for (const file of files) {
      scanned++;
      const treeRelative = relative(templatesDir, file).split("\\").join("/");
      const categoryRelative = relative(categoryDir, file).split("\\").join("/");
      const base = basename(file);

      const routeB = roleIndexPaths.has(treeRelative);

      let routeA = false;
      if (hasIndex) {
        routeA = indexText.includes("`" + base + "`");
      } else {
        for (const [otherFile, text] of fileTexts) {
          if (otherFile === file) continue;
          if (text.includes("`" + categoryRelative + "`") || text.includes("`" + base + "`")) {
            routeA = true;
            break;
          }
        }
      }

      if (!routeA && !routeB) {
        orphans.push(treeRelative);
      }
    }
  }

  return { scanned, orphans: orphans.sort() };
}

export function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { scanned, orphans } = computeReachability(root);
  if (orphans.length) {
    console.error("knowledge doc reachability: FAIL");
    for (const o of orphans) {
      console.error(`  - orphan (no index-row / read_first / on_demand / trigger route): ${o}`);
    }
    process.exit(1);
  }
  console.log(`knowledge doc reachability: ok (${scanned} docs scanned, 0 orphans)`);
}

if (import.meta.main) main();
