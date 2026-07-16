import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keysOf, fpMap, fpOf, suppressed, decide } from "./fleet_watch.ts";
import {
  tomlValue as riTomlValue,
  tomlSectionExists as riSectionExists,
  listContains,
  listEmpty,
  sourceIdExists,
  priorityRank,
  tomlEscape as riEscape,
} from "./request_intake_handler.ts";
import { tomlValue as schTomlValue, safeName } from "./scheduler_adapter.ts";
import { flipSection, templateTrailer, dropRegisterBlock } from "./worker_finalize.ts";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("fleet_watch stall-scan keys/fingerprint/decide", () => {
  const scan = {
    idle_no_register: [{ dispatch: "7", kind: "reporting-no-register" }],
    unwatched: ["9"],
    unprocessed_results: [{ request_id: "r9" }],
    items: [{ dispatch: "7", tip_sha: "T1", dirty_hash: "DH", dirty: false }],
    unwatched_detail: [{ dispatch: "9", watch_cmd: "w" }],
  };

  test("keysOf enumerates the three actionable arrays", () => {
    expect(keysOf(scan)).toEqual(["idle:7", "unwatched:9", "unproc:r9"]);
  });

  test("fingerprint keys idle/unwatched, request-keyed items get empty fp", () => {
    const m = fpMap(scan);
    expect(fpOf("idle:7", m)).toBe("T1|DH|false");
    expect(fpOf("unproc:r9", m)).toBe("");
  });

  test("suppression window blocks a freshly stamped key", () => {
    const now = 1000;
    expect(suppressed({ "idle:7": 990 }, "idle:7", now, 900)).toBe(true);
    expect(suppressed({ "idle:7": 1 }, "idle:7", now, 900)).toBe(false);
    expect(suppressed({}, "idle:7", now, 0)).toBe(false);
  });

  test("decide fires only when both scans agree and the fingerprint is stable", () => {
    temp = mkdtempSync(join(tmpdir(), "fw-decide-"));
    const stateFile = join(temp, "state.json");
    const fired = decide(scan, scan, ["idle:7"], stateFile, 2000, 900);
    expect(fired).not.toBeNull();
    expect(fired!.startsWith("RESULT: FLEET-ATTENTION")).toBe(true);
    expect(fired!).toContain('"attention": 1');
    // the fire stamps the key so a re-decide inside the window is suppressed.
    expect(readFileSync(stateFile, "utf8")).toContain('"idle:7"');
    const moved = { ...scan, items: [{ dispatch: "7", tip_sha: "T2", dirty_hash: "DH", dirty: false }] };
    expect(decide(scan, moved, ["idle:7"], stateFile, 3000, 900)).toBeNull();
  });
});

describe("request_intake_handler TOML + list helpers", () => {
  const toml =
    'request_id = "R-1"  # trailing comment\n' +
    "kind = deploy\n" +
    "[safety]\n" +
    'allow_commits = "true"\n' +
    "[capability.deploy]\n" +
    'allowed_sources = ["pm_a", "pm_b"]\n';

  test("tomlValue reads top-level and sectioned keys, strips quotes+comments", () => {
    expect(riTomlValue("", "request_id", toml)).toBe("R-1");
    expect(riTomlValue("", "kind", toml)).toBe("deploy");
    expect(riTomlValue("safety", "allow_commits", toml)).toBe("true");
    expect(riTomlValue("capability.deploy", "allowed_sources", toml)).toBe('["pm_a", "pm_b"]');
  });

  test("section existence honours the escaped-dot regex form", () => {
    expect(riSectionExists("capability\\.deploy", toml)).toBe(true);
    expect(riSectionExists("capability\\.other", toml)).toBe(false);
  });

  test("list membership / emptiness after normalization", () => {
    expect(listContains('["pm_a", "pm_b"]', "pm_a")).toBe(true);
    expect(listContains('["pm_a"]', "pm_b")).toBe(false);
    expect(listEmpty("[]")).toBe(true);
    expect(listEmpty('["x"]')).toBe(false);
  });

  test("source id lookup + priority rank + escape", () => {
    expect(sourceIdExists('id = "pm_a"\nid = "pm_b"\n', "pm_b")).toBe(true);
    expect(sourceIdExists('id = "pm_a"\n', "pm_z")).toBe(false);
    expect(priorityRank("urgent")).toBeGreaterThan(priorityRank("high"));
    expect(priorityRank("nope")).toBe(0);
    expect(riEscape('a\\b"c')).toBe('a\\\\b\\"c');
  });
});

describe("scheduler_adapter TOML + name helpers", () => {
  test("tomlValue + safeName", () => {
    const toml = 'job_id = "J-x"\n[safety]\nallow_promote = "false"\n';
    expect(schTomlValue("", "job_id", toml)).toBe("J-x");
    expect(schTomlValue("safety", "allow_promote", toml)).toBe("false");
    expect(safeName("a/b c:d")).toBe("a_b_c_d");
  });
});

describe("worker_finalize section rewriters", () => {
  test("flipSection replaces first non-blank line after the heading", () => {
    const src = "## Status\n\nWORKING\n\n## Current task\n\n#7\n";
    expect(flipSection(src, /^##[\t ]+Status[\t ]*$/, "REPORTING")).toBe(
      "## Status\n\nREPORTING\n\n## Current task\n\n#7\n",
    );
  });

  test("templateTrailer pulls the first Garelier: line after the subject", () => {
    expect(templateTrailer("<subject>\n\nGarelier: tpm worker#7 #7")).toBe("Garelier: tpm worker#7 #7");
    expect(templateTrailer("<subject>\n\nno trailer here")).toBe("");
  });

  test("dropRegisterBlock removes a prior block up to the next heading", () => {
    const h = "## Finalize register (worker_finalize.sh)";
    const src = `# Report\n\n${h}\n\n- old\n\n## Summary\n\nx\n`;
    expect(dropRegisterBlock(src, h)).toBe("# Report\n\n## Summary\n\nx\n");
  });
});
