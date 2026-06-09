---
knowledge_id: quality.cross_artifact_consistency
title: Cross-Artifact Consistency
category: quality
status: active
owners:
  - pm
consumers:
  - smith
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Cross-Artifact Consistency

A test perspective for finding **drift between artifacts that must agree** — the
defects that surface after a merge integrates several changes, when each change
was locally correct but left a paired or mirrored artifact stale. Original
wording; project-specific. Primarily a Smith post-merge perspective; Worker and
Artisan apply it to their own change before merge.

## Why this is a distinct perspective

Unit, integration, and system tests check that **code behaves**. They do not
catch a reference that points at a renamed file, a config field the loader
stopped reading, a table that no longer lists every case, or a rule
re-implemented two ways. These are consistency defects: two artifacts that are
each internally fine but disagree with each other. After a merge — when renames,
new options, new cases, and dual-platform edits land together — this is where
integration risk concentrates, and a single grep is exactly how it gets missed.

## Consistency dimensions

Check the dimensions the change surface touches; do not force all on every change.

1. **Reference integrity** — every pointer resolves to a real target. Links,
   "see X" cross-references, file / section / symbol references, import paths,
   doc anchors. After a rename or a move, the old target is the first casualty.

2. **Mirror agreement** — when the same fact is intentionally stored in more than
   one place, every copy agrees. Two-layer docs, a constant duplicated in code
   and documentation, a default repeated in a schema and its prose.

3. **Dual-implementation parity** — the same logic re-implemented in two places
   reaches the same result for the same input. Two-OS scripts, a port to a second
   language, validation enforced on both client and server. Parity matters most
   on security and validation paths, where the lenient side is the hole.

4. **Enumeration completeness** — a table, registry, switch, or routing map that
   enumerates a set lists **every** member, and any "this is the complete set /
   no others exist" claim is true. A new member added in one place is the one
   left un-listed in the parallel one.

5. **Declaration ↔ consumer agreement** — a declared field / flag / option is
   actually read by its consumer, and a consumer never requires a field its
   schema omits. A config key nothing reads, a documented flag nothing parses, an
   API field one side sends and the other drops.

6. **Lifecycle hygiene** — superseded, deprecated, or renamed things are marked
   as such **everywhere** they appear, not left presented as current. A replaced
   decision still labelled active, a deprecated option still shown as the way to
   do it, an old name lingering beside the new.

7. **Label / version / status drift** — labels, version strings, status fields,
   and counts reflect current reality. A version that disagrees across files, an
   "experimental" tag on a now-stable feature, a status not advanced, a total
   that no longer matches its list.

## How to check — and how to be sure

- **A search is a hypothesis, not a verdict.** Grepping finds candidates; open
  each target and confirm it actually resolves / agrees before calling it
  consistent. A clean grep is not proof.
- **Drive from the source of truth.** For an enumeration, list the members from
  the authoritative definition and compare the dependent copies against it — not
  the reverse.
- **Diff the two implementations directly** for parity, on the same inputs,
  including the edge inputs (empty, quoted, commented, trailing whitespace) where
  two parsers most often diverge.
- **Before claiming "no drift," walk each dimension the change touched** rather
  than spot-checking one file. Consistency defects cluster: a rename that broke
  one reference usually broke several.
- **Report confirmed drift with a pointer** (`path:line`), the two artifacts that
  disagree, and which side is authoritative — evidence, not a claim
  (`coverage_evidence_policy.md`). Do not imply you checked a dimension you did
  not.

## Boundary

This perspective covers the **target project's own** artifacts (its specs,
schemas, docs, config, scripts, registries). Garelier's own control / state
documents are PM-owned: report drift there to Dock / PM, do not self-repair
(`garelier-smith` §3). Fix **mechanical** drift (a stale pointer, a missing row,
a lenient parser); when reconciling two artifacts requires deciding **which
meaning is intended**, that is a design decision — transition to `BLOCKED` and
escalate rather than guessing.

Generalized project knowledge, Librarian-maintained under PM approval. See also
`../review/system_impact_review.md` for the same sync question from the
Observer's review angle.
