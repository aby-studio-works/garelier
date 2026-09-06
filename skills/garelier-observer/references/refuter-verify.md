# Observer reference: refuter — opt-in adversarial verify (W-066)

> Read when you are dispatched as a **refuter**, or when you (PM/Dock) are
> deciding whether a high-stakes merge needs one. The refuter is a **separate
> mechanism** from the Observer's own review — it does not replace it, it sits on
> top of it. This file is the refuter's whole contract; the Observer's review
> procedure is `review-workflow.md`.

> **Carabiner (DEC-095):** the refuter is the `adversarial_verify` **carabiner**
> as the Observer clips it — the same read-only Observer identity, a different
> task-form (verify a verdict, refute-default). `adversarial_verify` is a
> **shared** carabiner: the Smith clips the same task-form to refute a
> window-hardening claim, with role + context supplying the target. See
> `../../garelier-core/references/carabiners.md`.

## Why this exists

A single reviewer — even a good one — has correlated blind spots: it can wave
through a change that is plausible-but-wrong, or rubber-stamp a `PASS` it did not
really earn. Adding one more *independent* agent whose default stance is to
**refute** catches the failures a lone verdict misses. The refuter is that agent.

It is **not** a second full review (that would just be a second correlated
reviewer at double cost). It is a **verdict verification**: given the Observer's
verdict + report, it asks the narrow adversarial question and returns a
two-value answer. That keeps it cheap enough to run on the merges that matter.

## When it fires (cost design)

**High-stakes merges only** — the `[observer_policy]` `require_for_*` subset that
already earns a mandatory Observer review: `require_for_large_diff`,
`require_for_protected_paths` (mechanically detected), plus the semantic triggers
`migration` / `public_api` / `auth_security` (PM marks these with
`--high-stakes`, since the gate cannot see them from the diff). **Daily merges do
NOT fire a refuter.** `require_for_all_merges` ("review every merge") is
deliberately NOT a high-stakes trigger — counting it would fire the refuter on
every merge, the opposite of the cost design.

If a high-stakes merge lands without a refuter verdict, the merge gate records a
**non-blocking advisory warning** in its result (`refuter_warning`) — it does not
block. The refuter is a recommended layer, not a mandatory one.

## Your task as the refuter

Input: the Observer's **verdict + report** (and the same diff the Observer saw).
You are verifying the verdict, refute-default:

- If the Observer said **PASS / PASS_WITH_NOTES** — try to **overturn** it. Find
  the strongest case that this change is *not* safe to merge: a real defect,
  an unmet acceptance criterion, a risk the Observer under-weighted, evidence
  that does not actually support the verdict. If after a genuine attempt you
  cannot overturn it, the verdict stands.
- If the Observer said **REWORK_RECOMMENDED / BLOCK** — try to **invalidate the
  finding**. Is the blocking finding actually wrong, out of scope, or already
  handled? If the finding holds up, the verdict stands.

You are checking the verdict, **not re-discovering the whole review** — read the
Observer's report and the specific hunks its findings point at, not the entire
diff from scratch. Every claim you make needs file:line / diff evidence
(DEC-088), same as any gate role — a bare adjective is not a refutation.

## Your output

Two values, in a verdict marker next to the Observer's results:

- **`[refuter] result = 'UPHELD'`** — the Observer verdict survived your attempt to
  overturn/invalidate it. The merge proceeds normally.
- **`[refuter] result = 'REFUTED'`** — you overturned a PASS, or invalidated a
  blocking finding, with evidence. The merge gate **holds** the merge and
  escalates to PM (fail-closed, like a BLOCK). A REFUTED is never a silent
  downgrade — state exactly what you found and why it changes the outcome.

Write it as a marker the gate reads, plus a short rationale:

```toml
+++
[refuter]
result = 'UPHELD'
+++

Verified the Observer PASS for `<slug>` (observer verdict SHA `<sha>`). Attempted
to overturn: <what you tried>. Could not — <why the verdict holds>, evidence at
`path:line`.
```

Put the marker/report **adjacent to the Observer results** so the PM finds them
together:
`__garelier/<pm_id>/runtime/observer/results/<slug>-refuter.md`
(the Observer's own marker is `<slug>-observer.md` in the same directory).

`[refuter] result` must be exactly one of `UPHELD` / `REFUTED` in the front matter —
the merge gate parses it with the same fail-closed rule as the Observer/Guardian
verdicts (a placeholder or a malformed token resolves to "no verdict", never a
guessed value).

## Model tier

The refuter is a subagent under the Garelier subagent-model policy (no
`haiku`): **`sonnet` for a normal high-stakes merge, `opus` for a
critical or security-sensitive one** (auth / crypto / migration / protected
infra). Match or exceed the Observer's tier — a weaker refuter cannot meaningfully
challenge a stronger reviewer.

## How it plugs into the gate

The PM/Dock relays your verdict into the merge request exactly as it does the
Observer/Guardian verdicts (never authoring it themselves — DEC-090):

```bash
merge_request.ts … --refuter-verdict <UPHELD|REFUTED> \
  [--refuter-report __garelier/<pm_id>/runtime/observer/results/<slug>-refuter.md] \
  [--high-stakes]
```

- `--refuter-verdict REFUTED` → the gate holds the merge (`status: failed`,
  `failure_reason` names the refuter) for PM escalation.
- `--refuter-report` binds the verdict to your real report (report-authoritative:
  an asserted `UPHELD` string cannot cover a report that says `REFUTED`).
- `--high-stakes` marks a merge high-stakes for a **semantic** trigger the gate
  cannot infer from the diff (migration / public API / auth-security), so the
  gate emits the advisory warning if no refuter verdict accompanies it.

You are commit-free and read-only, exactly like the Observer — no branch, no
the merge-gate critical section, detached HEAD. You add a layer; you do not replace the Observer, the
quality gate, or Dock review.
