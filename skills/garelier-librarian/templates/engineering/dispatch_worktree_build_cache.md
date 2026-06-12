# Dispatch Worktree Build Cache

Producer dispatches run in fresh, isolated git worktrees
(`__garelier/<pm_id>/_dispatch<N>/checkout`). Isolation is correct for code,
but a fresh worktree also means a **cold build directory** — on compiled
stacks (Rust, C/C++, large TypeScript builds) the full rebuild typically
dominates producer wall-time, not the model. Observed in practice: a
two-producer tick where >80% of elapsed time was two independent cold builds
of the same dependency graph.

- Owner: PM / engineering owner
- Maintainer: Librarian (applies PM-approved updates)
- Consumers: Worker, Smith, Artisan, Dock (dispatch planning)

## Policy

1. **Share compilation artifacts across dispatch worktrees when the stack
   supports it safely.** Two shapes, in order of preference:
   - a **compiler cache daemon/dir** (content-addressed object cache): safe
     under concurrency, survives worktree deletion, biggest win for
     dependency-heavy stacks;
   - a **shared build output directory** (e.g. one target/output dir set via
     the build tool's environment knob): simplest, but concurrent producers
     serialize on the build tool's own locks and dirty interleavings are
     possible — prefer it only for low-fan-out projects.
2. **Configure it once, project-locally**: record the chosen knob (env var or
   build config) in `AGENTS.md` build notes or the project's build config so
   every producer inherits it without remembering anything. Per-dispatch
   shell exports do not survive into other producers.
3. **Never share caches across trust boundaries.** A cache shared between
   worktrees of the SAME project/PM is fine (everything in it came through
   the same gates). Do not point the cache at locations shared with other
   projects or users.
4. **The quality gate stays authoritative.** Caches can serve stale artifacts
   after toolchain or flag changes; when a gate failure looks impossible,
   re-run once with the cache disabled before deeper diagnosis, and record
   the outcome in the report.
5. **Cleanup interplay**: a shared cache keeps `dispatch_cleanup` fast (the
   worktree holds no huge build dir) and avoids the Windows MAX_PATH
   deep-tree deletion fallback. If a per-worktree build dir is unavoidable,
   expect cleanup to use the long-path fallback and budget the time.

## Stack notes (fill in per project)

| Stack | Knob | Chosen setting | Caveats |
| --- | --- | --- | --- |
| {{stack}} | {{cache_knob}} | {{setting}} | {{caveats}} |

(Example shape for a Rust workspace: a content-addressed compiler cache via
the wrapper env var, or a shared `target/` via the target-dir env var —
mutually exclusive; document which one this project uses and why.)
