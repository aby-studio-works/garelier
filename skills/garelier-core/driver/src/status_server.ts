// Read-only Status Web Console server.
//
// Bun built-ins only (Bun.serve + node:fs) — no third-party HTTP/UI
// dependency. This library defaults to loopback when no host is passed, but
// the status_web.ts CLI (and start_status.{sh,ps1}) pass 0.0.0.0 by default —
// LAN-reachable with a printed warning; --loopback restricts to 127.0.0.1
// (documented in web_console.md). It serves a JSON snapshot API + a small
// vanilla SPA, never mutates Garelier state, and never spawns a provider
// CLI. Served content is secret-redacted and the file set excludes
// gitignored paths — important when bound to the LAN.

import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import type { SetupConfig } from "./config.ts";
import { buildSnapshot, redact, type SnapshotOptions } from "./status_snapshot.ts";
import { buildTreeFromPaths, renderMarkdown, classifyContent } from "./docs_view.ts";
import { buildOverview } from "./status_overview.ts";
import { buildQueue } from "./status_queue.ts";
import { buildKnowledge } from "./status_knowledge.ts";
import { buildControl } from "./status_control.ts";

// Max bytes the file viewer will read/serve (keeps a truly huge file from
// blowing up the response or the renderer). Larger files return a notice.
// Raised 512K -> 4M so large reports/inspections are viewable in-console.
const MAX_VIEW_BYTES = 4 * 1024 * 1024;

// High-risk filenames never offered for browsing/serving, regardless of where
// they sit — defense in depth so the LAN-bound viewer can't disclose key
// material even if redaction misses a format. Matched on the basename.
const SECRET_FILE = /(^\.env($|\.)|(^|[._-])id_[a-z0-9]+$|\.(pem|key|p12|pfx|keystore|jks)$|(^|[._-])(secret|secrets|credentials?)(\.|$))/i;
const isSecretFile = (rel: string): boolean => SECRET_FILE.test(rel.split("/").pop() ?? rel);

// The browsable file set = `git ls-files --cached --others --exclude-standard`
// run in the project root. git itself applies .gitignore, so .git/, runtime/,
// and gitignored secrets are excluded — and a served path must be a member of
// this set (plus a realpath-containment check in /api/file), which is what
// prevents path traversal.
function projectFiles(root: string): string[] {
  try {
    const r = Bun.spawnSync(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"]);
    if (r.exitCode !== 0) return [];
    return new TextDecoder().decode(r.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// This PM's coordination subtree: __garelier/<pmId>/ minus the role worktrees.
// git ls-files can't see it — runtime/ is gitignored and the role checkouts are
// separate worktrees — so we walk it directly to make reports, inboxes, the
// manifest, blueprints, and STATE files browsable. We PRUNE every `checkout/`
// dir (each is a full-project worktree duplicate) and `.git`/`node_modules`, and
// we use lstat + skip ALL symlinks so a symlink under the (gitignored, machine-
// local) runtime/ can't be descended to escape the project and serve arbitrary
// targets. Secret-named files are excluded outright. Returns repo-relative
// forward-slash paths; secret redaction is also applied when content is served.
function garelierFiles(root: string, pmId: string): string[] {
  const base = join(root, "__garelier", pmId);
  if (!existsSync(base)) return [];
  const rootFwd = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const out: string[] = [];
  const PRUNE = new Set(["checkout", ".git", "node_modules"]);
  const MAX = 5000; // safety cap on entries listed
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || out.length >= MAX) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= MAX) return;
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;           // never follow a symlink (traversal guard)
      if (st.isDirectory()) {
        if (PRUNE.has(name)) continue;
        walk(abs, depth + 1);
      } else if (st.isFile()) {
        const rel = abs.replace(/\\/g, "/");
        if (rel.startsWith(rootFwd + "/")) {
          const r = rel.slice(rootFwd.length + 1);
          if (!isSecretFile(r)) out.push(r);
        }
      }
    }
  };
  walk(base, 0);
  return out;
}

// Cached union of the two browsable sets (git-tracked ∪ __garelier subtree),
// keyed per (root, pmId) with a short TTL so /api/tree and /api/file don't spawn
// `git ls-files` and re-walk the FS on every request (matters under --lan).
interface BrowseCache { at: number; set: Set<string>; list: string[]; }
const browseCache = new Map<string, BrowseCache>();
const BROWSE_TTL_MS = 4000;
function browsable(root: string, pmId: string): BrowseCache {
  const key = `${root}\u0000${pmId}`;
  const now = Date.now();
  const hit = browseCache.get(key);
  if (hit && now - hit.at < BROWSE_TTL_MS) return hit;
  const list = [...new Set([...projectFiles(root), ...garelierFiles(root, pmId)])];
  const entry: BrowseCache = { at: now, set: new Set(list), list };
  browseCache.set(key, entry);
  return entry;
}

// Non-internal IPv4 addresses, for building the LAN URL shown to remote viewers.
function lanIPv4(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// Loopback hosts get no LAN URL. 0.0.0.0 / a specific LAN IP are NOT loopback.
const isLoopbackHost = (h: string): boolean => /^(127\.|::1$|localhost$)/.test(h);

export interface StatusServerOptions {
  projectRoot: string;
  pmId: string;
  config: SetupConfig | null;
  host?: string;            // forced to a loopback address
  port?: number;
  autoRefreshSeconds?: number;
  showSourceUrls?: boolean;
}

// driver/src/ -> driver/static and -> the garelier-core skill root.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(SRC_DIR, "..", "static");
const SKILL_CORE_DIR = join(SRC_DIR, "..", "..");
const STATIC_ALLOW = new Set(["index.html", "app.css", "app.js"]);
// Optional vendored assets under static/vendor/, fetched on demand (NOT
// committed — the bundles inline third-party deps under their own licenses).
// Allowlisted by exact name; a missing file 404s harmlessly (the client
// falls back to showing diagram source).
const VENDOR_ALLOW = new Set(["mermaid.min.js"]);

// Docs the /api/docs/:name endpoint may serve, mapped to paths under the
// garelier-core SKILL (so they ship with the install and are present whatever
// the target project is — the old target-relative docs/ lookup 404'd because
// the framework docs live with the skill, not the target). Allowlist only.
const DOC_ALLOW: Record<string, string> = {
  "web_console": "web_console.md",
  "pipeline_flow": "pipeline_flow.md",
  "protocol": "protocol.md",
  "state_machine": "state_machine.md",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function contentType(name: string): string {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function staticResponse(name: string): Response {
  if (!STATIC_ALLOW.has(name)) return new Response("Not found", { status: 404 });
  const p = join(STATIC_DIR, name);
  if (!existsSync(p)) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(p), {
    headers: { "content-type": contentType(name), "cache-control": "no-store" },
  });
}

function vendorResponse(name: string): Response {
  if (!VENDOR_ALLOW.has(name)) return new Response("Not found", { status: 404 });
  const p = join(STATIC_DIR, "vendor", name);
  if (!existsSync(p)) return new Response("Not found", { status: 404 }); // not vendored → client uses source fallback
  return new Response(readFileSync(p), {
    headers: { "content-type": contentType(name), "cache-control": "no-store" },
  });
}

export function startStatusServer(opts: StatusServerOptions) {
  // Default to loopback. A non-loopback host (e.g. 0.0.0.0 / a LAN IP) is
  // honored only when the caller passes it explicitly — that is the LAN
  // opt-in. The CLI warns when binding off-host.
  const host = opts.host && opts.host.trim() ? opts.host.trim() : "127.0.0.1";
  const wantPort = opts.port ?? 3787;
  const snapOpts: SnapshotOptions = { showSourceUrls: opts.showSourceUrls };

  const snapshot = () => buildSnapshot(opts.projectRoot, opts.pmId, opts.config, snapOpts);

  // Resolved at bind time; the /api/config handler reports it so the client
  // can show the correct LAN URL even after a port auto-bump.
  let boundPort = wantPort;

  const handler = (req: Request): Response => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

      // ---- JSON API (read-only) ----
      if (path === "/api/health") return json({ ok: true, pmId: opts.pmId });
      if (path === "/api/status") return json(snapshot());
      if (path === "/api/roles") return json({ ok: true, roles: snapshot().roles });
      if (path === "/api/branches") return json({ ok: true, branches: snapshot().branches });
      if (path === "/api/lanes") return json({ ok: true, lane: snapshot().lane });
      if (path === "/api/reports") return json({ ok: true, reports: snapshot().recentReports });
      if (path === "/api/routines") return json({ ok: true, routines: snapshot().routines });
      if (path === "/api/sources") return json({ ok: true, sources: snapshot().sources });
      if (path === "/api/dispatch") return json({ ok: true, dispatch: snapshot().dispatch });
      if (path === "/api/overview") return json({ ok: true, overview: buildOverview(opts.projectRoot, opts.pmId, opts.config) });
      if (path === "/api/queue") return json({ ok: true, queue: buildQueue(opts.projectRoot, opts.pmId, opts.config) });
      if (path === "/api/knowledge") return json({ ok: true, knowledge: buildKnowledge(opts.projectRoot, opts.pmId) });
      if (path === "/api/control") return json({ ok: true, control: buildControl(opts.projectRoot, opts.pmId) });
      if (path === "/api/config") {
        // LAN URLs so a remote viewer sees the address to use. Only when bound
        // off-loopback (--lan / explicit --host); empty for loopback binds.
        const lanUrls = isLoopbackHost(host) ? [] : lanIPv4().map((ip) => `http://${ip}:${boundPort}/`);
        return json({
          ok: true,
          pmId: opts.pmId,
          projectRoot: opts.projectRoot,
          autoRefreshSeconds: opts.autoRefreshSeconds ?? 5,
          jigFanOutCap: opts.config?.jig?.fanOutCap ?? null,
          host,
          port: boundPort,
          loopback: isLoopbackHost(host),
          lanUrls,
        });
      }
      if (path.startsWith("/api/docs/")) {
        const name = path.slice("/api/docs/".length);
        // hasOwnProperty guard so prototype keys (__proto__, constructor, …) miss.
        const rel = Object.prototype.hasOwnProperty.call(DOC_ALLOW, name) ? DOC_ALLOW[name] : undefined;
        if (typeof rel !== "string") return json({ ok: false, error: "unknown doc" }, 404);
        // The console's EN/JP toggle requests ?lang=ja: prefer a "<base>.ja.md"
        // translation, falling back to the canonical English doc when absent.
        const lang = url.searchParams.get("lang") === "ja" ? "ja" : "en";
        const variants = lang === "ja" ? [rel.replace(/\.md$/, ".ja.md"), rel] : [rel];
        // Resolve against the skill (bundled with the install), then fall back
        // to the target project's docs/ for human-authored copies if present.
        const candidates: string[] = [];
        for (const v of variants) { candidates.push(join(SKILL_CORE_DIR, v), join(opts.projectRoot, "docs", v)); }
        const p = candidates.find((c) => existsSync(c));
        if (!p) return json({ ok: false, error: "not present", name }, 404);
        try {
          const text = redact(readFileSync(p, "utf8"));
          return json({ ok: true, name, html: renderMarkdown(text) });
        } catch (e) {
          return json({ ok: false, error: (e as Error).message }, 500);
        }
      }
      // ---- Project file tree (git-backed + this PM's __garelier subtree) ----
      if (path === "/api/tree") {
        return json({ ok: true, tree: buildTreeFromPaths(browsable(opts.projectRoot, opts.pmId).list) });
      }
      // ---- A single file, rendered (md → HTML) or escaped text ----
      if (path === "/api/file") {
        const rel = (url.searchParams.get("path") ?? "").replace(/\\/g, "/");
        // Cheap rejections first (before any membership computation): empty,
        // traversal token, or a secret-named file.
        if (!rel || rel.includes("..")) return json({ ok: false, error: "bad path" }, 400);
        if (isSecretFile(rel)) return json({ ok: false, error: "not a project file" }, 404);
        // Must be a member of the browsable set (git-tracked ∪ this PM's
        // __garelier subtree). Membership plus the realpath-containment check
        // below is what prevents traversal; secret redaction still applies.
        if (!browsable(opts.projectRoot, opts.pmId).set.has(rel)) {
          return json({ ok: false, error: "not a project file" }, 404);
        }
        const abs = join(opts.projectRoot, rel);
        if (!existsSync(abs)) return json({ ok: false, error: "not present", path: rel }, 404);
        // Defense in depth: canonicalize and verify the resolved path is still
        // inside the project root, so a symlink anywhere in the chain cannot
        // escape (covers both membership sources and any future one).
        try {
          const realAbs = realpathSync(abs);
          const realRoot = realpathSync(opts.projectRoot);
          if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
            return json({ ok: false, error: "not a project file" }, 404);
          }
        } catch {
          return json({ ok: false, error: "not present", path: rel }, 404);
        }
        try {
          const bytes = readFileSync(abs);
          if (bytes.length > MAX_VIEW_BYTES) {
            return json({ ok: true, path: rel, kind: "too_large", bytes: bytes.length });
          }
          const kind = classifyContent(rel, bytes);
          if (kind === "binary") return json({ ok: true, path: rel, kind: "binary", bytes: bytes.length });
          const text = redact(new TextDecoder().decode(bytes));
          if (kind === "markdown") return json({ ok: true, path: rel, kind: "markdown", html: renderMarkdown(text) });
          return json({ ok: true, path: rel, kind: "text", text });
        } catch (e) {
          return json({ ok: false, error: (e as Error).message }, 500);
        }
      }
      if (path.startsWith("/api/")) return json({ ok: false, error: "unknown endpoint" }, 404);

      // ---- Static assets ----
      if (path === "/" ) return staticResponse("index.html");
      if (path.startsWith("/static/vendor/")) return vendorResponse(basename(path));
      if (path.startsWith("/static/")) return staticResponse(basename(path));

      // ---- SPA fallback: any non-API route renders the app shell ----
      return staticResponse("index.html");
  };

  // Bind, auto-bumping the port if it's already taken (multiple Garelier
  // projects/PMs on one machine each run their own console — they must not
  // collide). Try up to 40 ports starting at the requested one.
  let server: ReturnType<typeof Bun.serve> | null = null;
  let lastErr: unknown = null;
  for (let p = wantPort; p < wantPort + 40; p++) {
    try {
      server = Bun.serve({ hostname: host, port: p, fetch: handler });
      boundPort = p;
      break;
    } catch (e) {
      lastErr = e;
      // EADDRINUSE (or similar) → try the next port.
    }
  }
  if (!server) {
    throw new Error(
      `could not bind a port in ${wantPort}..${wantPort + 39} on ${host}: ${(lastErr as Error)?.message ?? "unknown error"}`,
    );
  }

  return server;
}
