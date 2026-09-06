---
knowledge_id: engineering.dispatch_worktree_build_cache
title: Dispatch Worktree Build Cache
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
  - smith
  - artisan
  - dock
source_ids:
  - project-original
last_reviewed_at: 2026-08-09
review_cycle: on-change
---

# Dispatch Worktree Build Cache

## Purpose

Role dispatches run in fresh, isolated git worktrees
(`__garelier/<pm_id>/_crew/dispatch<N>/checkout`). Isolation is correct for code,
but a fresh worktree can also mean a **cold build directory**. On compiled
stacks, rebuilding the same dependency graph can dominate role wall-time.
Use this document when dispatches need safe, evidence-backed reuse without
weakening worktree isolation or project trust boundaries.

- Owner: PM / engineering owner
- Maintainer: Librarian (applies PM-approved updates)
- Consumers: Worker, Smith, Artisan, Dock (dispatch planning)

## Rules

1. **Share compilation artifacts across dispatch worktrees when the stack
   supports it safely.** Two shapes, in order of preference:
   - a **compiler cache daemon/dir** (content-addressed object cache): safe
     under concurrency, survives worktree deletion, biggest win for
     dependency-heavy stacks;
   - a **shared build output directory** (e.g. one target/output dir set via
     the build tool's environment knob): simplest, but concurrent roles
     serialize on the build tool's own locks and dirty interleavings are
     possible — prefer it only for low-fan-out projects.
2. **Normalize volatile checkout paths only through the cache tool's documented
   base-directory or path-mapping facility.** Content-addressed caches can
   include source paths in their keys, so distinct ephemeral checkout prefixes
   can prevent otherwise equivalent worktrees from reusing entries. Enable a
   mapping only after a bounded before/after run of the same cacheable workload
   in the intended worktrees establishes that it improves reuse without changing
   the command, toolchain, or project configuration.
3. **Keep path normalization inside explicit trust fences.** Enumerate only the
   intended workspace-parent prefixes; never normalize to a broad home
   directory, filesystem root, or similarly broad ancestor. Do not share the
   mapping, cache, or its entries across projects or users. Follow the cache
   tool's documented precedence, platform, and path-syntax rules rather than
   inferring them from another tool.
4. **Configure the selected cache once, project-locally**: record the chosen
   knob (environment variable or build config) in `AGENTS.md` build notes or
   the project's build config so
   every role inherits it without remembering anything. Per-dispatch
   shell exports do not survive into other roles.
5. **The normal path stays cached and the quality gate stays authoritative.**
   A cache bypass or recache is diagnostic-only: after a surprising failure,
   make at most one equivalent retry using the cache tool's documented bypass
   or recache control, then record why cache involvement was suspected and both
   outcomes. Do not loop between cached and uncached runs or make a permanent
   bypass the workaround. If the failure was the project-declared one-shot full
   gate, retry only when project recovery policy authorizes that next attempt,
   and bind it to the failed attempt rather than launching an extra ad-hoc full
   suite.
6. **Interpret statistics in lifecycle context.** A daemon or machine restart
   can legitimately reset counters. Do not infer a cache failure or historical
   non-use from reset/zero counters alone; record daemon identity, start/restart
   evidence, cache configuration, and counters after an actual workload before
   drawing a conclusion.
7. **Cleanup interplay**: a shared cache keeps `dispatch_cleanup` fast (the
   worktree holds no huge build dir) and avoids the Windows MAX_PATH
   deep-tree deletion fallback. If a per-worktree build dir is unavoidable,
   expect cleanup to use the long-path fallback and budget the time.
8. **Respect execution and process authority.** The seat or client that invokes
   the build owns any cache daemon/process it starts and the related diagnostics.
   A sandboxed role may be unable to start, inspect, signal, or stop an
   operator-owned daemon; delegate to the declared gate/cache owner instead of
   changing permissions or killing processes by image name. Never stop another
   dispatch's process.
9. **Schedule by resource, not by agent count.** Independent read-only or
   isolated work may run concurrently. Commands contending for the same heavy
   compiler, output directory, daemon, or project gate lock stay serialized by
   the declared owner. Every build/cache subprocess has a finite timeout, and a
   timeout is reported separately from a compiler/test failure.

## Application

1. Keep the documented cache enabled for normal role and gate commands.
2. For a proposed path mapping, define the exact intended workspace parents and
   a bounded equivalent workload. Capture baseline and mapped results from the
   designated owner; retain enough command/configuration evidence to reproduce
   the comparison.
3. Enable the mapping only when the bounded evidence shows reusable entries and
   the review confirms the listed parents remain within one project/user trust
   boundary. Record the chosen setting in the project-local build notes.
4. Continue to distinguish a cache miss, cache-process lifecycle reset,
   compiler/test failure, and command timeout in reports. A lifecycle reset is
   an observation, not a failure diagnosis.

## Exceptions and escalation

- Do not enable or widen path normalization without bounded evidence and the
  declared engineering/cache owner's approval.
- Stop and escalate when the cache documentation cannot establish the mapping's
  scope or trust behavior, when a proposed parent is broad/ambiguous, or when
  the trial would cross a project or user boundary.
- Delegate daemon ownership or permission issues to the declared cache/gate
  owner; do not alter permissions or terminate another dispatch's process.

## References

- `engineering/index.md` — consumption rule for cold, cache-backed, or
  resource-contended dispatches.
- `role_index.toml` — narrow build-cache trigger for this document.
- Project-local cache documentation and the bounded before/after evidence record
  — authority for tool-specific mapping syntax and behavior.

## Stack notes (fill in per project)

| Stack | Knob | Chosen setting | Caveats |
| --- | --- | --- | --- |
| {{stack}} | {{cache_knob}} | {{setting}} | {{caveats}} |

(Example shape for a Rust workspace: a content-addressed compiler cache via
the wrapper env var, or a shared `target/` via the target-dir env var —
mutually exclusive; document which one this project uses and why.)
