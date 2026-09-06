<!--
  Guardian → Observer evidence pack (W-192 b) — FACTS ONLY.

  The Guardian writes this at the END of a code/security-tier review so the
  Observer skips re-discovering the diff (which files, which lines, which hunks).
  It carries SHARED FACTS ONLY — never the Guardian's verdict, reasoning, or
  conclusion. Independence is the point of the second seat (DEC-090): if the
  Guardian's judgment rode along, the two reads would collapse into one correlated
  sample. The Observer forms its OWN verdict from these facts plus its own reading.

  Enforced by the non-inclusion lint:
    bun skills/garelier-core/driver/src/dispatch/evidence_pack.ts <this-file>
  It fails closed on any leaked verdict token (PASS / BLOCK / REWORK_RECOMMENDED /
  NO_OPINION / PASS_WITH_NOTES) or judgment/recommendation prose in the AUTHOR's
  lines. Quoted diff (fenced ```code```) and file/symbol refs in `inline code` are
  exempt — so put every hunk in a fence and every path/symbol in backticks, and
  keep your own prose to neutral facts ("touched", "adds", "at line N"), never
  "this looks safe" / "should block" / "no problem".

  Path (companion to the verdict marker, same branch slug):
    __garelier/<pm_id>/runtime/guardian/results/<branch-slug>-evidence.md
-->

# Evidence pack — `{{branch-slug}}` (facts only)

- Reviewed SHA: {{head_sha}}
- Base: {{base_sha}}
- Author: guardian — shared facts for the Observer; the Guardian's conclusion stays OUT of this file

## Touched files

<!-- one line per file: `path` — N hunks, +A/-D. Neutral counts only. -->
- `{{path/to/file}}` — {{n}} hunks, +{{added}}/-{{deleted}}

## Line references

<!-- the specific locations worth a look, as file:line. No adjectives. -->
- `{{path/to/file}}:{{line}}` — {{neutral one-phrase what-is-here, e.g. "new public fn `foo`"}}

## Key hunks

<!-- verbatim diff excerpts, each in a fenced block (exempt from the lint). Quote,
     do not characterize. -->
```diff
{{@@ hunk @@}}
```
