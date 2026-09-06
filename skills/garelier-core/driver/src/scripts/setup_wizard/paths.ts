// W-083 ts-first: setup_wizard path/layout resolvers.
//
// Relative wizard paths and absolute driver paths now share the same pure
// resolver family in workspace.ts. A relative pmRoot stays relative, so the
// wizard's setup_config.toml output uses the same canonical crew resolver.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { git } from "../_lib.ts";
import {
  crewRoleContainerFromPmRoot,
  crewSubdirFromPmRoot,
  pointerFileFromPmRoot,
  resolveRoleContainerFromPmRoot,
  rolePlural,
  rolePointerKey,
  roleSingular,
} from "../../workspace.ts";

export { crewPathFromPmRoot, crewSubdirFromPmRoot } from "../../workspace.ts";

// Exile/home context needed by the create-side resolvers (ws_container etc.).
// The pure layout resolvers (the nine the crew test pins) only need pmId.
export interface WizardPaths {
  pmId: string;
  projectRoot: string;
  gitRoot: string;
  wsExile: boolean; // --exile / WS_EXILE=1
  garelierHome: string; // GARELIER_HOME env ("" when unset)
}

// ws_role_singular: plural container name -> singular pointer-key role.
export function wsRoleSingular(plural: string): string {
  return roleSingular(plural);
}

// ws_role_plural: inverse of ws_role_singular.
export function wsRolePlural(singular: string): string {
  return rolePlural(singular);
}

export function wsPointerFile(pmId: string): string {
  return pointerFileFromPmRoot(`__garelier/${pmId}`);
}

export function wsPointerKey(pmId: string, role: string, id: string): string {
  return rolePointerKey(role, id);
}

export function wsCrewContainer(pmId: string, role: string, id: string): string {
  return crewRoleContainerFromPmRoot(`__garelier/${pmId}`, role, id);
}

// ws_subdir: layout-resolved pm-root subdir for THIS pm.
export function wsSubdir(pmId: string, flatName: string): string {
  return crewSubdirFromPmRoot(`__garelier/${pmId}`, flatName);
}

// Resolve a role's container, pointer -> canonical crew, matching
// ws_resolve_container. The pointer lookup is "first line starting with
// <key>=", printing everything after the '='.
export function wsResolveContainer(pmId: string, role: string, id: string): string {
  const pf = wsPointerFile(pmId);
  const pointers = new Map<string, string>();
  if (existsSync(pf)) {
    let raw = "";
    try {
      raw = readFileSync(pf, "utf8");
    } catch {
      raw = "";
    }
    const prefix = `${wsPointerKey(pmId, role, id)}=`;
    for (const line of raw.split("\n")) {
      if (line.startsWith(prefix)) {
        const v = line.slice(prefix.length);
        if (v.length > 0) pointers.set(wsPointerKey(pmId, role, id), v);
        break;
      }
    }
  }
  return resolveRoleContainerFromPmRoot(`__garelier/${pmId}`, role, id, pointers);
}

// --- exile / home resolvers (create side; used by fresh/diff, not the nine) ---

function toMixedPath(p: string): string {
  // cygpath -m equivalent: /c/foo -> C:/foo. No-op when not an MSYS abs path.
  const m = p.match(/^\/([A-Za-z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p;
}

export function wsSha8(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

// ws_home_root: <home>/studios, normalized to a native mixed path.
export function wsHomeRoot(ctx: WizardPaths, homeRootFromConfig = ""): string {
  const home = process.env.HOME ?? "";
  let r = ctx.garelierHome;
  if (!r && homeRootFromConfig) r = homeRootFromConfig;
  if (!r) r = `${home}/.garelier`;
  if (r.startsWith("~/")) r = `${home}/${r.slice(2)}`;
  else if (r === "~") r = home;
  r = `${r}/studios`;
  return toMixedPath(r);
}

// ws_home_id: <sanitized project basename>-<sha1(abs git-dir)[:8]>-<pm_id>.
export function wsHomeId(ctx: WizardPaths): string {
  const base = basename(ctx.projectRoot)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const res = git(ctx.gitRoot, ["rev-parse", "--absolute-git-dir"]);
  const gitdir = res.exitCode === 0 ? res.stdout.trim() : `${ctx.gitRoot}/.git`;
  return `${base}-${wsSha8(gitdir)}-${ctx.pmId}`;
}

export function wsExileContainer(ctx: WizardPaths, role: string, id: string, homeRootFromConfig = ""): string {
  const root = wsHomeRoot(ctx, homeRootFromConfig);
  const hid = wsHomeId(ctx);
  return role === "artisan"
    ? `${root}/${hid}/artisan`
    : `${root}/${hid}/${role}/${id}`;
}

// ws_use_exile: exile (machine-local home outside the project) is OPT-IN. The
// caller supplies homeRootFromConfig (the [workspace] home_root) ONLY when the
// config exists, breaking the paths.ts <-> toml.ts import cycle; the bash reads
// it inline. Returns true iff the wizard should create in the exile home.
export function wsUseExile(ctx: WizardPaths, homeRootFromConfig = ""): boolean {
  let want = ctx.wsExile || ctx.garelierHome !== "";
  if (!want && homeRootFromConfig !== "" && homeRootFromConfig !== ":in-project:") want = true;
  if (!want) return false;
  const root = wsHomeRoot(ctx, homeRootFromConfig);
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    // best-effort; the writability probe below decides.
  }
  try {
    if (existsSync(root)) {
      accessSync(root, constants.W_OK);
      return true;
    }
  } catch {
    // not writable -> fall through to in-project.
  }
  process.stderr.write(`  ! exile home '${root}' not writable — using in-project layout (DEC-036)\n`);
  return false;
}

// ws_container: the container to CREATE for a role — exile (opt-in) else
// canonical in-project crew.
export function wsContainer(ctx: WizardPaths, role: string, id: string, homeRootFromConfig = ""): string {
  if (wsUseExile(ctx, homeRootFromConfig)) return wsExileContainer(ctx, role, id, homeRootFromConfig);
  return wsCrewContainer(ctx.pmId, role, id);
}

// ws_write_pointer: write/replace a pointer entry. Args: role id abs-container.
export function wsWritePointer(pmId: string, role: string, id: string, container: string): void {
  const pf = wsPointerFile(pmId);
  const key = wsPointerKey(pmId, role, id);
  mkdirSync(dirname(pf), { recursive: true });
  let lines: string[] = [];
  if (existsSync(pf)) {
    try {
      const raw = readFileSync(pf, "utf8");
      const arr = raw.split("\n");
      const hadTrailing = arr.length > 0 && arr[arr.length - 1] === "";
      if (hadTrailing) arr.pop();
      lines = arr.filter((l) => !l.startsWith(`${key}=`));
    } catch {
      lines = [];
    }
  } else {
    lines = [
      "# DEC-036 exile role-home pointer (gitignored, machine-local; only when exile opted in). <role>.<id>=<abs container>",
    ];
  }
  lines.push(`${key}=${container}`);
  writeFileSync(pf, `${lines.join("\n")}\n`);
}

// slugify_target: develop/soft -> develop-soft.
export function slugifyTarget(target: string): string {
  return target.replace(/\//g, "-");
}
