// DEC-036: role homes are IN-PROJECT by default; exile is opt-in.
//
// Worktree roles (worker/scout/smith/librarian/observer/guardian/concierge/
// artisan) keep their container (mailbox + checkout/) IN the project at
// <proj>/__garelier/<pmId>/_crew/<role>/<id>/ by default. When the operator opts
// into EXILE (--exile / GARELIER_HOME / [workspace] home_root), the container
// is instead a machine-local "studio home" OUTSIDE the project, and the wizard
// records it in a gitignored pointer. This resolver returns the pointer's path
// when present, else the in-project path — so the in-project default needs no
// pointer at all. (DEC-035 made exile the default; DEC-036 reverted that.)
//
// When exile IS opted in, the wizard writes a single gitignored pointer
//   <proj>/__garelier/<pmId>/runtime/workspace_paths
// with flat, shell-and-TS-parseable lines:
//   worker.claude-a=/abs/home/workers/claude-a
//   artisan=/abs/home/artisan
// Every tool resolves a role's container through `roleContainer`, which reads
// that pointer (mtime-cached) and otherwise uses the canonical in-project path.

import { existsSync, readFileSync, statSync } from "node:fs";

// DEC-094 canonical layout: role containers live under a stable
// `_crew/` directory so the pm_id root only ever shows a fixed set of siblings
// (`_crew / control / runtime / knowledge / showcase / gallery`). The crew name
// for a worktree role has no leading underscore:
//   _crew/workers/<id>   _crew/artisan
const CREW_DIR = "_crew";
/** Normalize a plural container name to the role name used by pointers. */
export function roleSingular(role: string): string {
  switch (role) {
    case "workers": return "worker";
    case "scouts": return "scout";
    case "smiths": return "smith";
    case "librarians": return "librarian";
    case "observers": return "observer";
    case "guardians": return "guardian";
    case "concierges": return "concierge";
    case "artisan": return "artisan";
    default: return role.replace(/s$/, "");
  }
}

/** Normalize a pointer role name to its crew plural container name. */
export function rolePlural(role: string): string {
  switch (roleSingular(role)) {
    case "worker": return "workers";
    case "scout": return "scouts";
    case "smith": return "smiths";
    case "librarian": return "librarians";
    case "observer": return "observers";
    case "guardian": return "guardians";
    case "concierge": return "concierges";
    case "artisan": return "artisan";
    default: return `${roleSingular(role)}s`;
  }
}

export function crewPathFromPmRoot(pmRoot: string, flatName: string): string {
  return `${pmRoot}/${CREW_DIR}/${flatName.replace(/^_/, "")}`;
}

export function crewSubdirFromPmRoot(pmRoot: string, flatName: string): string {
  return crewPathFromPmRoot(pmRoot, flatName);
}

export interface PmSetupConfigResolution {
  path: string | null;
  canonical: string;
}

/** Resolve the canonical PM config as a file. */
export function resolvePmSetupConfigFromPmRoot(pmRoot: string): PmSetupConfigResolution {
  const canonical = `${crewPathFromPmRoot(pmRoot, "pm")}/setup_config.toml`;
  try {
    if (statSync(canonical).isFile()) return { path: canonical, canonical };
  } catch {
    // Absent or unreadable canonical config.
  }
  return { path: null, canonical };
}

export function pointerFileFromPmRoot(pmRoot: string): string {
  return `${pmRoot}/runtime/workspace_paths`;
}

export function rolePointerKey(role: string, id: string): string {
  const singular = roleSingular(role);
  return singular === "artisan" ? "artisan" : `${singular}.${id}`;
}

export function crewRoleContainerFromPmRoot(pmRoot: string, role: string, id: string): string {
  const plural = rolePlural(role);
  const base = crewPathFromPmRoot(pmRoot, `_${plural}`);
  return plural === "artisan" ? base : `${base}/${id}`;
}

/** Shared pointer -> crew resolver used by both the driver and wizard. */
export function resolveRoleContainerFromPmRoot(
  pmRoot: string,
  role: string,
  id: string,
  pointers: ReadonlyMap<string, string> = new Map(),
): string {
  const pointed = pointers.get(rolePointerKey(role, id));
  if (pointed) return pointed;
  return crewRoleContainerFromPmRoot(pmRoot, role, id);
}

// The v2 crew container for a worktree role. Artisan is a singleton (no <id>).
export function crewRoleContainer(
  projectRoot: string,
  pmId: string,
  role: string,
  id: string,
): string {
  return crewRoleContainerFromPmRoot(`${projectRoot}/__garelier/${pmId}`, role, id);
}

// Resolve a non-worktree pm-root subdir under `_crew/`.
export function crewSubdir(projectRoot: string, pmId: string, flatName: string): string {
  return crewSubdirFromPmRoot(`${projectRoot}/__garelier/${pmId}`, flatName);
}

export function resolvePmSetupConfig(projectRoot: string, pmId: string): PmSetupConfigResolution {
  return resolvePmSetupConfigFromPmRoot(`${projectRoot}/__garelier/${pmId}`);
}

/**
 * Resolve an ephemeral dispatch container at `_crew/dispatch<N>`.
 */
export function dispatchContainer(projectRoot: string, pmId: string, id: string | number): string {
  const normalized = String(id).replace(/^dispatch/, "");
  return crewSubdir(projectRoot, pmId, `dispatch${normalized}`);
}

export function workspacePointerPath(projectRoot: string, pmId: string): string {
  return pointerFileFromPmRoot(`${projectRoot}/__garelier/${pmId}`);
}

// Pointer key for a role instance. Artisan is a singleton (no <id>).
function pointerKey(role: string, id: string): string {
  return rolePointerKey(role, id);
}

interface CacheEntry {
  mtimeMs: number;
  map: Map<string, string>;
}
const cache = new Map<string, CacheEntry>();

function loadMap(projectRoot: string, pmId: string): Map<string, string> {
  const p = workspacePointerPath(projectRoot, pmId);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    // Pointer absent: use the canonical in-project container.
  }
  const cacheKey = `${projectRoot} ${pmId}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) return hit.map;

  const map = new Map<string, string>();
  if (mtimeMs >= 0) {
    try {
      for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k && v) map.set(k, v);
      }
    } catch {
      // Unreadable: treat as absent and use the canonical in-project container.
    }
  }
  cache.set(cacheKey, { mtimeMs, map });
  return map;
}

/**
 * Absolute container (mailbox) directory for a worktree role.
 * Two-tier resolution (W-086 / DEC-094):
 *   1. the machine-local exile home from the gitignored `workspace_paths`
 *      pointer (DEC-036), when an entry exists for this role/id; else
 *   2. the canonical `_crew/<role>s/<id>` container.
 */
export function roleContainer(
  projectRoot: string,
  pmId: string,
  role: string,
  id: string,
): string {
  return resolveRoleContainerFromPmRoot(
    `${projectRoot}/__garelier/${pmId}`,
    role,
    id,
    loadMap(projectRoot, pmId),
  );
}

/**
 * The git worktree (= provider cwd, target of all git ops) for a
 * checkout-bearing role: `<container>/checkout`.
 */
export function roleCheckout(
  projectRoot: string,
  pmId: string,
  role: string,
  id: string,
): string {
  return `${roleContainer(projectRoot, pmId, role, id)}/checkout`;
}

// Full parsed pointer map (`<role>.<id>` / `artisan` -> absolute container).
// Empty when no pointer exists (the in-project default). Used by tools that must
// ENUMERATE exiled containers, e.g. dock_pulse's role-status scan (DEC-081).
export function readWorkspacePointer(projectRoot: string, pmId: string): Map<string, string> {
  return loadMap(projectRoot, pmId);
}

// Test-only: drop the mtime cache so a rewritten pointer is re-read.
export function _resetWorkspaceCache(): void {
  cache.clear();
}
