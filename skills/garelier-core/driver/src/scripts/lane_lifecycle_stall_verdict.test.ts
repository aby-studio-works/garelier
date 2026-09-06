import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { laneDeclaredCompletion, terminalWindowVerdict } from "./dispatch_watch.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function container(state: string, laneResult?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "garelier-lane-lifecycle-"));
  scratch.push(dir);
  mkdirSync(join(dir, "lane"), { recursive: true });
  writeFileSync(join(dir, "STATE.md"), `# Dispatch #1 - worker probe\n\n## Status\n\n${state}\n\n## Current task\n\n#1 probe (branch)\n`);
  if (laneResult !== undefined) writeFileSync(join(dir, "lane", "result.md"), laneResult);
  return dir;
}

const flat = { sigMoved: false, wtMoved: false, paMoved: false, isProxy: false };

// A provider register declares its state in the lane result's machine face.
const declared = (state: string, tail: string): string => [
  "+++", "[lane]", `state = '${state}'`, "+++", "", tail, "",
].join("\n");

describe("lane lifecycle vs stall verdict", () => {
  // W-677: the 9 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("a lane that declared REPORTING is read as declared, even while STATE.md still says WORKING (+8 folded cases)", () => {
    // case: a lane that declared REPORTING is read as declared, even while STATE.md still says WORKING
    {
      // STATE.md is dispatch-setup intent; the provider's own register is canonical.
      expect(laneDeclaredCompletion(container("WORKING", declared("REPORTING", "branch=x commit=y")))).toBe("REPORTING");
      expect(laneDeclaredCompletion(container("WORKING", declared("BLOCKED", "question=needs a ruling")))).toBe("BLOCKED");
    }
    // case: a lane that declared nothing is not treated as complete
    {
      expect(laneDeclaredCompletion(container("WORKING"))).toBeNull();
      expect(laneDeclaredCompletion(container("WORKING", ""))).toBeNull();
      // The canonical first-line grammar is closed: near-miss forms must not be
      // mistaken for a completion declaration and silence the stall detector.
      expect(laneDeclaredCompletion(container("WORKING", "STATE: REPORTING\n"))).toBeNull();
      expect(laneDeclaredCompletion(container("WORKING", "preface\nSTATE=REPORTING\n"))).toBeNull();
    }
    // case: both launch transports reach the same verdict for the same completion
    {
      // A CLI-transport seat (either provider) has lane/result.md written for it by
      // provider_session; an Agent-tool-spawned seat never passes through that path
      // and carries only the STATE.md heading. Both must suppress the stall, or the
      // suppression is real for one transport and absent for the other.
      const cliTransport = container("WORKING", declared("REPORTING", "branch=x commit=y"));
      const agentTransport = container("REPORTING");

      expect(laneDeclaredCompletion(cliTransport)).toBe("REPORTING");
      expect(laneDeclaredCompletion(agentTransport)).toBe("REPORTING");
      for (const c of [cliTransport, agentTransport]) {
        expect(terminalWindowVerdict({ ...flat, declaredCompletion: laneDeclaredCompletion(c), inSpawnGrace: false })).toBe("DECLARED-DONE");
      }
    }
    // case: a present provider result outranks STATE.md, so a corrupt result cannot read as done
    {
      // The precedence has to be the canonical one, not "consult both". A seat whose
      // provider result is present but unparsable is exactly the seat most likely to
      // need the stall detector; letting a stale STATE.md speak for it would silence
      // that detector for the CLI transport only.
      expect(laneDeclaredCompletion(container("REPORTING", "STATE: REPORTING\n"))).toBeNull();
      expect(laneDeclaredCompletion(container("REPORTING", "half-written provider output\n"))).toBeNull();
      // With NO result source at all, STATE.md is the only signal and is honoured.
      expect(laneDeclaredCompletion(container("REPORTING"))).toBe("REPORTING");
    }
    // case: a completed lane is DECLARED-DONE, not STALLED
    {
      expect(terminalWindowVerdict({ ...flat, declaredCompletion: "REPORTING", inSpawnGrace: false })).toBe("DECLARED-DONE");
      expect(terminalWindowVerdict({ ...flat, declaredCompletion: "BLOCKED", inSpawnGrace: false })).toBe("DECLARED-DONE");
    }
    // case: a lane inside its spawn/resume grace is SPAWN-GRACE, not STALLED
    {
      expect(terminalWindowVerdict({ ...flat, declaredCompletion: null, inSpawnGrace: true })).toBe("SPAWN-GRACE");
    }
    // case: checkout worktree movement alone is progress for every seat
    {
      // The write destination is the checkout, not the container and not the commit
      // log; moving ONLY the checkout must change the verdict.
      expect(terminalWindowVerdict({ ...flat, wtMoved: true, declaredCompletion: null, inSpawnGrace: false })).toBe("ADVANCING");
      expect(terminalWindowVerdict({ ...flat, wtMoved: true, isProxy: true, declaredCompletion: null, inSpawnGrace: false })).toBe("ADVANCING");
    }
    // case: a genuinely stalled lane is still STALLED
    {
      // Past the grace, nothing declared, and nothing moved anywhere the seat
      // writes — the detector must still fire, or the false-positive fixes above
      // would have been achieved by switching it off.
      expect(terminalWindowVerdict({ ...flat, declaredCompletion: null, inSpawnGrace: false })).toBe("STALLED");
      // A proxy seat's report activity does not rescue a non-proxy seat, and an
      // undeclared lane past grace with a flat worktree stays STALLED.
      expect(terminalWindowVerdict({ ...flat, paMoved: true, declaredCompletion: null, inSpawnGrace: false })).toBe("STALLED");
    }
    // case: observed progress outranks both suppressions
    {
      // A lane that is still moving is ADVANCING even inside the grace, so the
      // suppressions never mask real signal.
      expect(terminalWindowVerdict({ ...flat, sigMoved: true, declaredCompletion: "REPORTING", inSpawnGrace: true })).toBe("ADVANCING");
    }
  });
});
