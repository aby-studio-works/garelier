import { detachReparsePoints, removeTreeSync, rmSync, rmdirSync } from "../guard/path_guard.ts";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { die, git, printHelp, utcIsoSeconds, valueAfter } from "./_lib.ts";
import { posix, resolveLanePaths, type LanePaths } from "./lane_common.ts";
// W-240: an isolate lane's owner previously got only the lightweight owner
// lock below (`${slug}.json`) — no command_guard-readable permission record —
// so every git/test/build command run by that owner in the worktree found no
// dispatch record, fell to `baseline-destructive`, and every commit/test/build
// was denied (3 lanes in a row: W-235/236/237, root-caused here). --owner IS
// the agent name that will run those commands, so isolate now also writes the
// same role record dispatch_prepare/attended_record write for a PM-attended
// seat, at the location command_guard's agent-name scan already reads.
import { removeAttendedRecord, writeAttendedRecord } from "../guard/attended_record.ts";

const HELP = `#
# workspace_isolate.ts — lightweight role isolation for repos with no
# dispatch-native scaffolding (W-028).
# dispatch_prepare.ts/dispatch_cleanup.ts assume a target project's
# __garelier/<pm_id>/_crew/dispatch<N>/ scaffolding; such a repo can have none
# of that, so an attended PM dispatching 2+ role subagents in parallel has
# them share the ONE working tree and collide on the git index/HEAD. This gives
# the same "isolate -> role works alone -> collect" shape with \`git worktree\`
# while containing all lane files under the PM namespace.
#
# Modes:
#   workspace_isolate.ts --repo <path> --slug <kebab> [--pm-id <id>] [--base <branch>] [--owner <name>]
#       Cut a lightweight branch garelier/isolate/<slug> off <branch>
#       (default: repo's current branch) and create a worktree at
#       <repo>/__garelier/<pm_id>/_crew/lanes/<slug>/. Omit --pm-id only when
#       __garelier contains exactly one PM namespace. Prints one JSON line:
#         {"worktree":"...","branch":"...","base_sha":"..."}
#       The role does all its work (edits + commits) inside that worktree.
#       --owner <name> records WHO holds the lane (agent name) + a UTC timestamp
#       in the lane meta (W-095 owner lock), AND (W-240) writes a command_guard
#       permission record (profile role, fenced to this worktree) so the
#       owner's git/test/build commands in the worktree are not denied at
#       baseline-destructive. --owner MUST differ from --slug (it would collide
#       with lane_dispatch.ts's slug-keyed record at the same filename). Omit
#       --owner only for a lane no role's shell will run destructive
#       commands in (e.g. a PM-collected drop) — every other use prints a
#       warning that the lane's worker seat will be denied. A second isolate for
#       a slug whose worktree/branch already exists is refused (exit 2) as
#       before, but the refusal now NAMES the recorded owner + creation time —
#       so a PM assigning a second role to a busy lane sees the collision
#       (with the culprit) BEFORE the spawn, instead of a bare "already exists"
#       (real d1/d2 near-miss 2026-07-16). Read the lane's owner without
#       mutating anything with:
#         workspace_isolate.ts --owner-of --repo <path> --slug <kebab> [--pm-id <id>]
#
#   workspace_isolate.ts --collect --repo <path> --slug <kebab> [--pm-id <id>] [--base <branch>] [--force-collect]
#       Integrate the isolate branch's commits back into its base branch
#       (<repo> must be checked out ON that base branch, clean working tree):
#       fast-forward when possible, else cherry-pick commit by commit. Refuses
#       (exit 2) if the isolate WORKTREE itself has uncommitted changes — a
#       role may still be mid-edit there, and the old behavior removed the
#       worktree unconditionally, silently destroying that work (W-080; real
#       incident 2026-07-05). Pass --force-collect to discard the uncommitted
#       changes anyway. On a cherry-pick conflict, prints manual-resolution
#       steps and exits 3 WITHOUT touching the worktree/branch (no
#       auto-resolve — DEC-001 style: a conflict is a human/role
#       decision). On success, removes the worktree + isolate branch and
#       prints:
#         {"collected":true,"mode":"ff"|"cherry-pick","branch":"...","commits":N}
#
#   workspace_isolate.ts --abort --repo <path> --slug <kebab> [--pm-id <id>]
#       Discard the isolate branch's commits (never merged) and remove the
#       worktree + branch. Prints {"aborted":true,"branch":"..."}.
#
# Exit codes: 0 ok; 2 usage/precondition error (includes: isolate worktree has
# uncommitted changes and --force-collect was not given); 3 cherry-pick
# conflict (collect only — resolve by hand, then re-run --abort to clean up,
# or finish the cherry-pick sequence in <repo> yourself and re-run --collect).`;

function quietGit(repo: string, args: string[]): { code: number; out: string } {
  const result = git(repo, args);
  return { code: result.exitCode, out: result.stdout.replace(/\r?\n$/, "") };
}

function gitStdoutToStderr(
  repo: string,
  args: string[],
  stderr: "inherit" | "ignore",
): { exitCode: number } {
  const result = git(repo, args, { stderr });
  if (result.stdout) process.stderr.write(result.stdout);
  return result;
}

// Read the lane's recorded owner/creation from meta (W-095). Best-effort: an
// older meta (pre-owner) or a hand-made lane simply has no owner field.
function readLaneMeta(meta: string): { owner: string; created: string } {
  try {
    const raw = readFileSync(meta, "utf8");
    return {
      owner: raw.match(/"owner":"([^"]*)"/)?.[1] ?? "",
      created: raw.match(/"created":"([^"]*)"/)?.[1] ?? "",
    };
  } catch {
    return { owner: "", created: "" };
  }
}

// A human-readable "already owned by X" suffix for a lane-exists refusal, or ""
// when the meta records no owner (nothing extra to say).
function ownerSuffix(meta: string): string {
  const { owner, created } = readLaneMeta(meta);
  if (!owner) return "";
  return ` — lane is held by '${owner}'${created ? ` (claimed ${created})` : ""}; a second role would collide. Collect or --abort the existing lane first, or dispatch this work to a different slug.`;
}

function gitExclude(repo: string): string {
  const common = quietGit(repo, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0 || !common.out) return "";
  const commonDir = common.out.startsWith("/") || /^[A-Za-z]:\//.test(common.out)
    ? common.out
    : `${repo}/${common.out}`;
  return `${commonDir}/info/exclude`;
}

function addExclude(repo: string, entry: string): void {
  const exclude = gitExclude(repo);
  if (!exclude) return;
  try {
    mkdirSync(dirname(exclude), { recursive: true });
    const raw = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!raw.split(/\r?\n/).includes(entry)) {
      writeFileSync(exclude, `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${entry}\n`);
    }
  } catch { /* best-effort local hygiene */ }
}

function removeExclude(repo: string, entry: string): void {
  const exclude = gitExclude(repo);
  if (!exclude || !existsSync(exclude)) return;
  try {
    const kept = readFileSync(exclude, "utf8").split(/\r?\n/).filter((line) => line !== entry);
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    writeFileSync(exclude, kept.length ? `${kept.join("\n")}\n` : "");
  } catch { /* best-effort legacy cleanup */ }
}

function cleanup(repo: string, paths: LanePaths, slug: string, branch: string): void {
  // W-240: read the owner BEFORE the meta file (below) is deleted, so the
  // matching attended record (keyed by agent name, not slug) can be removed
  // too — a collected/aborted lane leaves no dangling role permission
  // record for a name that may be reassigned to a different worktree later.
  const { owner } = readLaneMeta(`${paths.metaDir}/${slug}.json`);
  // W-380: both removers below are recursive and git's follows a Windows
  // junction out of the lane worktree, so links are detached before either runs.
  const detachment = detachReparsePoints(paths.worktree);
  if (detachment.failed.length > 0) {
    // Only the REMOVAL is held back. The record/meta cleanup below still runs —
    // leaving a dangling permission record behind would trade this row's hazard
    // for the leaked-record one W-240 closed.
    process.stderr.write(
      `workspace_isolate: REFUSING to remove ${paths.worktree} — ${detachment.failed.length} reparse point(s) could not be detached first, and a recursive delete can follow a link out of the lane (the worktree is left in place; inspect and remove it by hand): ` +
      `${detachment.failed.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}\n`,
    );
  } else {
    const removed = gitStdoutToStderr(repo, ["worktree", "remove", "--force", paths.worktree], "ignore");
    if (removed.exitCode !== 0) removeTreeSync(paths.worktree);
    gitStdoutToStderr(repo, ["worktree", "prune"], "ignore");
    gitStdoutToStderr(repo, ["branch", "-D", branch], "ignore");
  }
  // W-240 rework: remove the attended record BEFORE the owner-lock meta, and
  // make a removal failure LOUD (never silent) — a leftover role record
  // for a worktree that no longer exists is exactly the leaked-record shape
  // the BYPASS-SPAWN detective (contract_check.ts scanBypassSpawns) exists to
  // catch, so an operator must see the failure, not have it swallowed.
  if (owner) {
    try {
      removeAttendedRecord({ agent: owner, garelierRoot: repo, pmId: paths.pmId }, repo);
    } catch (error) {
      process.stderr.write(`workspace_isolate: warning — could not remove the guard permission record for owner '${owner}' (it may now be a LEAKED record for a deleted worktree — check ${paths.metaDir}): ${(error as Error).message}\n`);
    }
  }
  rmSync(`${paths.metaDir}/${slug}.json`, { force: true });
  if (paths.legacy) {
    // The old root dotdir is temporary rescue state. Once its lane is safely
    // collected/aborted, remove that slug's sidecars and retire the old exclude
    // entry when no other legacy lane remains.
    try {
      for (const name of readdirSync(paths.metaDir)) {
        if (name.startsWith(`${slug}.`)) rmSync(`${paths.metaDir}/${name}`, { force: true });
      }
      if (readdirSync(paths.metaDir).length === 0) rmdirSync(paths.metaDir);
    } catch { /* missing/non-empty is fine */ }
    const legacyRoot = `${repo}/.garelier-work`;
    try {
      if (readdirSync(legacyRoot).length === 0) {
        rmdirSync(legacyRoot);
      }
    } catch { /* loose historical artifacts may remain */ }
    let anotherLegacyLane = false;
    try {
      anotherLegacyLane = readdirSync(paths.metaDir).some((name) => name.endsWith(".json"));
    } catch { /* no meta means no recorded lane */ }
    if (!anotherLegacyLane) {
      try {
        anotherLegacyLane = readdirSync(legacyRoot, { withFileTypes: true })
          .some((entry) => entry.isDirectory() && existsSync(`${legacyRoot}/${entry.name}/.git`));
      } catch { /* removed root means no remaining lane */ }
    }
    if (!anotherLegacyLane) removeExclude(repo, ".garelier-work/");
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let mode: "isolate" | "collect" | "abort" | "owner-of" = "isolate";
  let repo = "";
  let slug = "";
  let pmId = "";
  let base = "";
  let owner = "";
  let forceCollect = false;
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--collect": mode = "collect"; i++; break;
      case "--abort": mode = "abort"; i++; break;
      case "--owner-of": mode = "owner-of"; i++; break;
      case "--repo": repo = valueAfter(argv, i); i += 2; break;
      case "--slug": slug = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pmId = valueAfter(argv, i); i += 2; break;
      case "--base": base = valueAfter(argv, i); i += 2; break;
      case "--owner": owner = valueAfter(argv, i); i += 2; break;
      case "--force-collect": forceCollect = true; i++; break;
      case "-h": case "--help": printHelp(HELP);
      default:
        die(`workspace_isolate: unknown arg: ${argv[i]}\nworkspace_isolate: valid flags: --collect --abort --owner-of --repo --slug --pm-id --base --owner --force-collect -h/--help`);
    }
  }
  if (!repo || !slug) die("workspace_isolate: --repo and --slug are required");
  repo = posix(repo);
  if (!/^[a-z0-9-]*$/.test(slug)) die("workspace_isolate: --slug must be kebab-case [a-z0-9-]");
  if (git(repo, ["rev-parse", "--show-toplevel"]).exitCode !== 0) {
    die(`workspace_isolate: --repo is not a git repository: ${repo}`);
  }

  let paths: LanePaths;
  try {
    paths = resolveLanePaths(repo, slug, pmId, mode !== "isolate");
  } catch (error) {
    die(`workspace_isolate: ${(error as Error).message}`);
  }
  const { worktree, metaDir } = paths;
  const branch = `garelier/isolate/${slug}`;
  const meta = `${metaDir}/${slug}.json`;

  if (mode === "owner-of") {
    const { owner: heldBy, created } = readLaneMeta(meta);
    const held = existsSync(worktree) || git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
    process.stdout.write(`${JSON.stringify({ slug, held, owner: heldBy, created, worktree, branch })}\n`);
    // exit 0 when free, 2 when the lane is held — so a caller can gate a spawn
    // on the exit code alone (`workspace_isolate.ts --owner-of … || refuse`).
    return held ? 2 : 0;
  }

  if (mode === "isolate") {
    // W-240 rework (G N3): lane_dispatch.ts's own dispatch record lives at
    // `.meta/<slug>.dispatch.json` (lane_common.ts writeRecord); the attended
    // record this tool now writes for --owner lives at `.meta/<owner>.dispatch.json`
    // (attended_record.ts recordPathFor). If --owner were ever literally the
    // slug, both writers would target the SAME file and stomp each other —
    // silently corrupting owner-scoping. Refuse the collision up front.
    if (owner && owner === slug) {
      die(`workspace_isolate: --owner must not equal --slug ('${owner}') — it would collide with the slug-keyed dispatch record path (.meta/${slug}.dispatch.json). Use the seat's agent name (e.g. ga-worker-${slug}) instead.`);
    }
    if (existsSync(worktree)) die(`workspace_isolate: worktree already exists for slug '${slug}': ${worktree} (collect or --abort it first)${ownerSuffix(meta)}`);
    if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0) {
      die(`workspace_isolate: branch already exists for slug '${slug}': ${branch} (collect or --abort it first)${ownerSuffix(meta)}`);
    }
    if (!base) {
      base = quietGit(repo, ["branch", "--show-current"]).out;
      if (!base) die("workspace_isolate: --repo is on a detached HEAD; pass --base explicitly");
    }
    if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${base}`]).exitCode !== 0) {
      die(`workspace_isolate: --base branch not found: ${base}`);
    }

    addExclude(repo, "__garelier/*/_crew/lanes/");

    mkdirSync(metaDir, { recursive: true });
    const added = gitStdoutToStderr(repo, ["worktree", "add", worktree, "-b", branch, base], "inherit");
    if (added.exitCode !== 0) die("workspace_isolate: git worktree add failed", 1);
    const baseSha = quietGit(repo, ["rev-parse", "--short", base]).out;
    // "base" stays FIRST so collect's `"base":"([^"]*)"` regex is unaffected.
    // owner/created are additive (W-095 owner lock); both are "" when --owner
    // is omitted, keeping the lane usable exactly as before.
    const metaObj = { base, owner, created: owner ? utcIsoSeconds() : "" };
    writeFileSync(meta, `${JSON.stringify(metaObj)}\n`);
    // W-240: give the owner a command_guard-readable role record. Skipped
    // when --owner is omitted (unchanged legacy/ownerless behavior — nothing to
    // key the record on), but that now leaves the lane's worker seat denied at
    // baseline-destructive, so omission is warned rather than silent. Best-
    // effort: the git worktree above already exists, so a record-write failure
    // must not undo it or fail the whole isolate — it is reported loudly on
    // stderr instead (never silent).
    // W-240 rework (G N1 / O §2): deliberately NOT `executionRoute: "pm-direct"`.
    // This seat is not the DEC-093 PM-directed exception — it is a Dock-
    // untracked-but-worktree-sanctioned isolate role (scanBypassSpawns
    // already treats a live `_crew/lanes/<slug>` worktree as sanctioned on its
    // own). Tagging it pm-direct would (a) downgrade a LEAKED record's
    // BYPASS-SPAWN finding to merely advisory (W-139) and (b) demote its
    // command_guard process_kill protection from deny to ask, letting one
    // lane's worker bulk-kill ANOTHER lane's build (the #371 class) — both
    // real regressions caught in review. `spawnedVia: "workspace_isolate"`
    // alone is what suppresses attended_record's role-route nudge.
    if (owner) {
      try {
        writeAttendedRecord(
          { agent: owner, worktree, profile: "role", spawnedVia: "workspace_isolate", garelierRoot: repo, pmId: paths.pmId },
          repo,
        );
      } catch (error) {
        process.stderr.write(`workspace_isolate: warning — could not write the guard permission record for owner '${owner}': ${(error as Error).message}\n`);
      }
    } else {
      process.stderr.write("workspace_isolate: warning — no --owner given, so this lane's worker seat has no guard permission record; every git/test/build command it runs in the worktree will be denied at baseline-destructive (W-240). Pass --owner <agent-name> unless nothing will run destructive commands here.\n");
    }
    const template = `<type>(<scope>): <summary>  [<item-id>]\\n\\nGarelier: ${paths.pmId} isolate/${slug} <item-id>`;
    process.stdout.write(`{"worktree":"${worktree}","branch":"${branch}","base_sha":"${baseSha}","commit_template":"${template}"}\n`);
    return 0;
  }

  if (mode === "collect") {
    if (!existsSync(worktree)) die(`workspace_isolate: no worktree for slug '${slug}': ${worktree}`);
    if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode !== 0) {
      die(`workspace_isolate: no isolate branch for slug '${slug}': ${branch}`);
    }
    if (!forceCollect) {
      const dirty = git(worktree, ["status", "--porcelain"]).stdout.replace(/\r/g, "").trimEnd();
      if (dirty) {
        process.stderr.write(`workspace_isolate: isolate worktree for slug '${slug}' has uncommitted changes (${worktree}) — refusing to collect. Files:\n`);
        process.stderr.write(`${dirty.split("\n").slice(0, 5).map((line) => `  ${line}`).join("\n")}\n`);
        process.stderr.write("workspace_isolate: have the role commit its work, or re-run with --force-collect to discard the uncommitted changes.\n");
        return 2;
      }
    }
    if (!base && existsSync(meta)) {
      base = readFileSync(meta, "utf8").match(/"base":"([^"]*)"/)?.[1] ?? "";
    }
    if (!base) die(`workspace_isolate: no --base given and no meta at ${meta}; pass --base explicitly`);
    const current = quietGit(repo, ["branch", "--show-current"]).out;
    if (current !== base) {
      die(`workspace_isolate: <repo> must be checked out on base branch '${base}' to collect (currently '${current}'). Run: git -C ${repo} checkout ${base}`);
    }
    if (git(repo, ["status", "--porcelain"]).stdout.trim()) {
      die("workspace_isolate: <repo> working tree is not clean; commit or stash before collect");
    }
    const commitCount = quietGit(repo, ["rev-list", "--count", `${base}..${branch}`]).out;
    const ff = gitStdoutToStderr(repo, ["merge", "--ff-only", branch], "ignore");
    if (ff.exitCode === 0) {
      cleanup(repo, paths, slug, branch);
      process.stdout.write(`{"collected":true,"mode":"ff","branch":"${branch}","commits":${commitCount}}\n`);
      return 0;
    }

    const commits = git(repo, ["log", "--reverse", "--format=%H", `${base}..${branch}`]).stdout.trim().split(/\r?\n/).filter(Boolean);
    let picked = 0;
    for (const sha of commits) {
      const result = gitStdoutToStderr(repo, ["cherry-pick", sha], "inherit");
      if (result.exitCode !== 0) {
        // W-240 rework: the manual clean-up in step 4 must also remove the
        // attended record cleanup() would have removed — otherwise a manually-
        // resolved conflict leaves a LEAKED role record (a worktree that no
        // longer exists) for the BYPASS-SPAWN detective to (correctly) flag.
        const { owner: conflictOwner } = readLaneMeta(meta);
        process.stderr.write(`workspace_isolate: cherry-pick conflict at ${sha} collecting '${slug}' into '${base}' (${picked}/${commitCount} already applied). Resolve manually:\n`);
        process.stderr.write(`  1. cd ${repo} && git status                 # inspect the conflict\n`);
        process.stderr.write("  2. fix conflicts, then: git add <files>\n");
        process.stderr.write("  3. git cherry-pick --continue               # repeat if more commits remain\n");
        process.stderr.write("     (or: git cherry-pick --abort              # give up this collect attempt)\n");
        process.stderr.write(`  4. Once done, clean up by hand: git -C ${repo} worktree remove --force ${worktree} && git -C ${repo} branch -D ${branch} && rm -f ${meta}\n`);
        if (conflictOwner) {
          process.stderr.write(`     …and remove its guard permission record (leaving it leaks a role record for a deleted worktree): bun "${repo}/skills/garelier-core/driver/src/guard/attended_record.ts" --remove ${conflictOwner} --garelier-root ${repo} --pm-id ${paths.pmId}\n`);
        }
        process.stderr.write(`     (or re-run: workspace_isolate.ts --abort --repo ${repo} --slug ${slug}   -- only if you aborted the cherry-pick in step 3)\n`);
        return 3;
      }
      picked++;
    }
    cleanup(repo, paths, slug, branch);
    process.stdout.write(`{"collected":true,"mode":"cherry-pick","branch":"${branch}","commits":${picked}}\n`);
    return 0;
  }

  const exists = existsSync(worktree) || existsSync(meta) || git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
  if (!exists) die(`workspace_isolate: nothing to abort for slug '${slug}'`);
  cleanup(repo, paths, slug, branch);
  process.stdout.write(`{"aborted":true,"branch":"${branch}"}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main());
