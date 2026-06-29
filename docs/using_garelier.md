# Using Garelier

Garelier is a file-based framework that coordinates a team of AI roles to turn a
request into reviewed, merged work — while you stay in control of what ships. You
give direction; the roles design, build, review, and integrate; you approve what
reaches your real branch. This is the operator's guide. The **Console** tab
documents this read-only viewer, and **Flow** explains the work model in detail.

## The shape of it

- **You / the user** set direction (a request, or a roadmap + backlog) and own
  the two go/no-go decisions: approving a non-trivial design, and approving a
  promote to your real branch.
- **PM** turns direction into a *blueprint* (a small spec), picks a lane, and
  approves promotes. PM never edits source.
- **Producers** do the work: *Worker* (implementation), *Smith* (post-merge
  hardening), *Librarian* (knowledge / registry), *Scout* (investigation, no
  commits), or a single *Artisan* doing the whole scope on one branch.
- **Gates** keep quality: the *merge gate* runs your configured checks; *Guardian*
  is a security / license gate; *Observer* is an independent review; the
  *Wanderer* is an optional external peer that reviews a design before anyone
  builds against it.
- **Dock** owns the integration branch (`studio`), dispatches producers, and
  sends accepted work through the merge gate. **Concierge** executes the one
  external step — merging `studio` into your real branch once you approve.

## The daily loop

1. **Give it work.** Point the PM at the next backlog item, or hand it a fresh
   request. In autonomous mode the driver keeps the loop running; otherwise you
   prompt the PM.
2. **Design.** PM writes a blueprint. A non-trivial design is reviewed (Wanderer,
   else Observer) with a sign-off *before* any code is written.
3. **Build.** Dock dispatches a producer (or an Artisan). It commits on its own
   branch — never on your real branch.
4. **Gate + integrate.** The merge gate runs your checks; Guardian / Observer run
   where required. Passing work lands on `studio`.
5. **Promote — your call.** Nothing reaches your real branch until you approve.
   On approval, Concierge merges `studio` into it.

You watch all of this in this **read-only** console: the **Dashboard** for
health, **Work** for the live queue and reports, **Control** for the plan, and
**Knowledge** for what the roles read.

## How you steer it

- **Start / stop the driver** with the documented helper scripts. A stop file
  pauses autonomous self-driving without killing in-flight work.
- **Hold the queue** (a *dispatch hold*) to pause new dispatch intentionally —
  the console shows it as a banner, not a fault.
- **Approve or decline** a blueprint and a promote. These decisions are yours;
  the PM does not promote to your real branch on its own.
- **Add knowledge or policy** by having the Librarian curate it; roles then read
  it automatically (see **Knowledge → By role**).

This console never *performs* any of these — it only shows state. Operations
happen through the PM and the driver, by your instruction.

## Where things live

- **`control/`** — the durable plan: roadmap, backlog, blueprints, decisions,
  operations. The source of truth for *what* and *why*. Browse it under
  **Control**.
- **`runtime/`** — transient execution state (queues, inboxes, locks, logs). Not
  tracked in git; treat it as machine-local.
- **knowledge trees** — curated, reusable knowledge the roles read; see
  **Knowledge**. Two layers can exist: a shared project-wide layer and this PM's
  own layer (the **Layer** column marks which one a document came from).
- **branches** — every role works on its own local branch under
  `garelier/<target-slug>/<pm_id>/…`; your real branch is touched only by an
  approved promote. See **Flow → Branches**.

## When something looks off

- The queue is full but nothing starts → *held future* items are waiting on a
  milestone / dependency gate; that is by design (**Work → Queue**).
- A role shows REPORTING with no report, or a lock looks stale → **Guide →
  Diagnostics** lists the check order (lane → merge gate → role STATE).
- A merge failed → the **Dashboard** shows `failed_quality_gate`; the detail is
  in **Work → Reports**.

Two rules of thumb make the whole system legible:

- **commit vs report decides the role** — only Worker / Smith / Librarian /
  Artisan commit; PM / Scout / Observer / Guardian / Wanderer never do.
- **you own the boundary** — Garelier proposes; nothing reaches your real branch
  without your promote.
