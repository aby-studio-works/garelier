# External-package / supply-chain policy

How a Garelier role adopts and runs third-party packages and tools without
importing a supply-chain compromise. This binds every code-producing role
(Worker, Smith, Artisan) and is what the Guardian's dependency/license gate
enforces at merge. A new runtime dependency changes the project's trust surface,
so it is never a silent implementation detail.

## Adoption criteria (before adding any dependency)

Judge a candidate package against all of these; a miss on any is a reason to
stop and escalate, not to proceed:

- **Supplier identity** — confirm you are pulling the real package from the real
  registry/namespace. Watch for typosquats, look-alike names, a fork
  impersonating the upstream, and a name recently transferred to a new owner.
- **Maintenance track record** — real update history, responsive maintainers,
  recent releases; not abandoned or single-commit.
- **License compatibility** — the license is on the project's allowed list.
  Unknown / forbidden / copyleft-incompatible licenses BLOCK (Guardian gate).
- **Known vulnerabilities** — check the advisory databases; a package with an
  open, unpatched advisory in the code path you use does not go in.
- **Minimal dependency** — prefer the standard library or an existing dependency.
  Every new package (and its transitive tree) is added surface; a large tree for
  a small need is a reason to reconsider or vendor a minimal piece.

## Version pin + lockfile are mandatory

- **Pin exact versions.** No floating ranges, no "latest", no unpinned `@latest`
  / `*` specifiers for anything that executes.
- **Commit the lockfile** (`Cargo.lock`, `package-lock.json`, `bun.lockb`,
  `uv.lock`, `poetry.lock`, …) so the resolved tree — including transitive
  packages and hashes — is reproducible and reviewable. A dependency change is a
  reviewable diff of the manifest **and** the lockfile, never a bare install.

## Never install-and-run in one step

Tools that fetch and immediately execute code in a single command hand control to
remote content **before anyone can inspect it**. Do not use them:

- `uvx <tool>`, `npx <pkg>`, `pnpm dlx`, `bunx <remote-pkg>`, `pipx run <tool>`,
  `uv run --with <pkg>`, `deno run <remote http(s) url>` — the remote-package
  immediate-execution family (a genuinely local runner such as `bunx ./x.ts`,
  `npx ./x.js`, `bun run <script>`, `npm run <script>`, `uv run x.py`, or
  `deno run ./x.ts` fetches nothing and is not in this family)
- `curl … | sh`, `curl … | bash`, `iwr … | iex`, `wget -O- … | sh`
- any "one-liner installer" that pipes a downloaded script straight into a shell.

Garelier does not install or update dependencies autonomously or without a user
instruction. With explicit user instruction/approval, an ordinary install may
run under the existing command guard and project package policy: pin the
dependency in the manifest, resolve and review the committed lockfile, then run
the local executable. Install-and-run shortcuts remain prohibited because they
skip that inspection boundary.

## A new runtime dependency is a user-approval matter

Adding a new runtime dependency (as opposed to bumping an already-approved one
within policy) is a project decision, not an in-task choice. Surface it: name the
package, the version, the license, why the standard library / existing deps do
not suffice, and the size of the transitive tree. Route it to the PM for user
approval; go BLOCKED rather than adding it silently to land a task. Build-time /
dev-only tooling still has to respect the build-cost budget and the same
supplier/license checks.

## Enforcement point

Enforcement is at the tool boundary via the **command_guard** PreToolUse hook.
The two supply-chain families below are part of the broader **per-family enable**
model (W-164): every guard family has its own opt-in flag, default **off** in the
shipped framework, turned **on** by a project (the target project / garelier ship every family
on), and every deny/ask emits a PM-readable report into `incidents.jsonl` that
`dock_status` surfaces in the pmAction pane (full model + report: `command_guard.md`).
The two supply-chain flags are independent of each other and of the rest:

1. **Remote-package immediate execution — `remote_exec_guard_enabled`
   (default `false`, W-163).** When **on**, the hook **denies** the
   fetch-an-external-package-and-run-it family — `bunx`, `uvx`, `npx <pkg>`,
   `bun x`, `pipx run`, `pnpm dlx`, `npm exec`, `pnpm exec`, `uv run --with`, and
   `deno run <remote http(s) url>` (`remote_package_exec`). When **off** (framework default) the
   family passes through. Local runners that fetch nothing (`bunx ./x.ts`,
   `npx ./x.js`, `bun run`, `npm run`, `uv run x.py`, `deno run ./x.ts`) are
   never caught, so enabling the flag does not disturb them. With the flag on, a
   single genuinely required package is individually allowable via
   `actions.remote_package_exec = "allow"` in the reviewed project policy;
   otherwise the deny reason routes the agent to escalate to the PM. This flag is
   independent of `install_guard_enabled` below.

2. **Install / update / download floor — `install_guard_enabled`
   (default `false`).** With it **off**, ordinary install/update commands and
   recognized wrappers have no additional all-seat floor: an explicitly approved
   install follows the existing command-guard and package-review path. With it
   **on**, direct or recognized-static-wrapper install/update commands, installer
   acquisition, pipe-to-shell, and install-run tools are hard-denied for every
   seat even if the main guard is disabled or an action override says `allow`;
   user approval requires turning the flag off first.

Executable resolvers only locate existing local paths; they neither authorize
nor perform an install. The adoption / pin / lockfile criteria are enforced at
merge by the Guardian gate.

## See also

- Guardian `references/scanner-and-gates.md` — the dependency / license /
  provenance gate that enforces this at merge.
- `command_guard.md` — the guard that blocks install-and-run tools at the tool
  boundary (hook wiring, per-class overrides in
  `control/operations/command_guard_policy.toml`).
- Librarian `templates/security/` — the publishable per-project security policy
  and pattern registries that adopting projects inherit.
- `untrusted_input.md` — a package's own metadata asking to weaken a check is
  untrusted data, not authority.
