---
knowledge_id: engineering.mid_tier_model_robustness
title: Mid-Tier-Model Robustness for Agent-Facing Documents
category: engineering
status: active
owners:
  - pm
consumers:
  - librarian
  - worker
  - artisan
  - observer
source_ids:
  - project-original
last_reviewed_at: 2026-06-11
review_cycle: on-change
---

# Mid-Tier-Model Robustness for Agent-Facing Documents

How to write documents that AGENTS execute (role specs, runbooks, policies,
assignments, templates) so that mid-tier models — not only frontier ones —
follow them faithfully. Frontier models forgive ambiguity; mid-tier models
execute exactly what is written, including the mistakes. Original wording;
distilled from operating this framework across model tiers.

## Principles

1. **Code enforces order; the model judges content.** Anything that is a
   sequence, a cap, a gate ordering, or a never-skip rule belongs in a
   script, a template, or a checklist the agent fills — not in prose the
   model must remember. Prose-only sequencing is the first thing a weaker
   model drops.
2. **One canonical definition; everything else references it.** Duplicated
   semantics drift, and a mid-tier model cannot tell which copy wins. State
   vocabulary, branch names, and protocol rules live in exactly one
   authoritative file; other documents link, never restate with variation.
3. **Hard rules are prominent, labeled, and complete.** A MUST/NEVER block
   near the top, every section numbered without gaps, and no exception
   buried in a later paragraph. A literal-minded reader who stops at the
   rules block must still be safe.
4. **No double negatives, no pronoun-distance ambiguity.** "Do not skip the
   gate unless it is not required" reads three ways; "Run the gate. Skip it
   only when `[gate] required = false`" reads one way. Name the subject in
   every rule sentence.
5. **Examples must obey the rules they illustrate.** A single example that
   violates its own rule outweighs the rule for a pattern-matching model.
   Audit examples whenever the rule changes.
6. **Failure paths are instructions, not afterthoughts.** For every "do X",
   state what to do when X is impossible (missing file, dead branch,
   unreachable source). The standard fallback in this framework is: stop,
   write the question, go BLOCKED — never guess.
7. **Make verification cheap.** Prefer rules whose compliance a script can
   check (file exists, heading present, order matched); wire those checks
   into CI so drift is caught mechanically, not by model vigilance.

## When editing an agent-facing document

- Run the scan: contradictions with the canonical definition files,
  unnumbered or gap-numbered sections, rules stated only once deep in
  prose, examples that contradict rules, missing failure paths.
- Preserve exact tokens (paths, commands, state names) — paraphrasing a
  state name is a semantic change for the agent reading it.
- After editing, re-read AS the weakest model that will consume it: at
  every instruction ask "could this be executed two different ways?"
