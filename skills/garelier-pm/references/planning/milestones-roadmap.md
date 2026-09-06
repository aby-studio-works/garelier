# Garelier PM Milestones and Roadmap Reference

## §5. Milestone and roadmap management

### 5.1 Milestones

A milestone is a user-visible deliverable. Examples: "MVP completion",
"Steam early access launch", "Mod SDK release".

Resolve the exact `control.toml` schema/storage pair first. In schema v3, open a
control session, read the bounded resume, and create/update canonical Milestone
Markdown from the schema-3 template. Roadmap→Milestone edges belong to the
Roadmap; Milestone child edges belong to the parent Milestone; Backlog→Milestone
edges belong to the Backlog. Store only the owning edge, give it an immutable
owner-local `rel-NNN`, and derive inverses. Shared Milestones and shared child
Milestones are valid; containment cycles are not. Direct authoring is valid
after strict validation, while shared/automated multi-file changes use a
revision-checked transaction.

Schema v1/v2 and unknown Control formats are rejected explicitly.

Milestones may run in parallel. Dock handles the parallel phase
breakdown; PM just declares them.

**Risk-first sequencing (DEC-070).** Every milestone names its riskiest
unknown as the FIRST entry of "Risks and unknowns" (template comment), and
the milestone's first dispatched work targets it — a spike, a Scout
inspection, or the directly-affected blueprint — never the safest item. A
project with no completion path through its hardest problem has no
completion estimate at all; retire the unknown while the sunk cost is
smallest. Relate the risk-killing Backlog/Blueprint to the typed Risk and
prioritize it while high/critical Risks stay open. The control graph emits a
`risk-first-drift` advisory (warning) when high/critical risks are active
but no open high/critical-priority Work exists — treat it as a
planning prompt: queue or re-prioritize risk-killing work, or downgrade a
stale risk. It never fails strict doctor.

### 5.1b Milestone-close retrospective (DEC-067)

When marking a milestone shipped (and at most once per milestone — never
manufacture lessons), harvest what went wrong mechanically and decide what
deserves a rule:

1. Run `bun garelier-core/scripts/retro_digest.ts --project <root>
   --pm-id <id> [--since <milestone start>]` — a zero-LLM digest of
   rework/refuted/blocked events, non-success gate results, and the
   "Context pack gaps" sections from archived dispatch reports (DEC-071:
   what roles had to rediscover that the blueprint should have
   carried).
2. For any cause that appears MORE THAN ONCE, draft a
   `knowledge_update_request` naming the rule, trigger
   (`role_index.toml [[triggers]]`), or AGENTS.md §0 principle that would
   have prevented it. One-off incidents normally do not become rules.
   A RECURRING context-pack gap is different: it means the PM's blueprints
   under-specify that area — fix the blueprint authoring habit (Context
   pack contents) rather than writing a role-side rule.
3. PM approves; Librarian applies (DEC-029). Record the retro outcome through
   the canonical Milestone revision (even when the outcome is "no recurring
   causes — no knowledge change", so the next reader knows it ran).

### 5.2 Roadmap

Each schema-v3 Roadmap is a canonical Markdown record containing purpose,
direction, current position, tracks/order, exit conditions, and owned
Roadmap→Milestone relations. A project may have multiple active Roadmaps, and a
Milestone may belong to multiple Roadmaps. `project_dashboard/roadmap.md`
retains curated user-visible direction and contains generated indexes only
inside explicit markers; rendering never changes marker-external text.

Use `control resume/get/list` for bounded projections. Updating the order or
membership of one Roadmap does not silently rewrite another Roadmap.

The roadmap is a planning artifact. It does not bind execution; if
reality diverges, update it.
