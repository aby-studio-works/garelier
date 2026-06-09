# Artisan reference: escalation + recovery

> Moved from `SKILL.md` (DEC-032): when to return to PM (§10) and
> resume-after-stop recovery (§11).

## §10. Escalation — when to return to PM

Return to PM only for **judgment, authority, or safety** reasons — never
because the task is large or slow. Transition to `BLOCKED`, write
`questions.md`, and notify PM. In driver mode `BLOCKED` costs no provider
tokens until `answers.md` or `abort.md` appears.

Return to PM when:

- The assignment and the actual code contradict each other.
- A spec/design judgment is needed.
- User approval is required (e.g., a destructive or data-changing step).
- External auth/permission is missing and you cannot proceed.
- A security / license / release decision is undecided.
- A merge conflict or studio drift cannot be safely reconciled on `satchel`.
- A dock-lane `lane.lock` is already active (lanes are exclusive).

## §11. Recovery (resume after a stop)

If you start and find work already in progress:

1. Read `runtime/lane.lock`, your `STATE.md`, and the latest
   `checkpoints/` entry.
2. Inspect the satchel branch: `git status`, `git diff --stat`,
   `git log --oneline`. If a prior iteration left coherent uncommitted
   work, commit it as a checkpoint before continuing — do not redo it.
3. Resume from the recorded phase. Do not restart from scratch.
4. Never abandon a task only because time has passed.
5. If the lane.lock is yours but its pid is dead, reclaim it (update
   pid/started fields); if it is genuinely inconsistent, surface it to PM
   rather than deleting another lane's lock.
