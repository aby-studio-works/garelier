import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendMessage, channelDir, readLog } from "./channel.ts";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "wanderer_hook.ts");
const PM = "aby_works";
const CH = "wanderer";
const PEER = "wanderer-01";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "garelier-wanderer-hook-"));
}

function runHook(project: string, input: object): void {
  const proc = spawnSync("bun", [
    hook,
    "--project", project,
    "--pm-id", PM,
    "--channel", CH,
    "--peer", PEER,
    "--tool", "codex",
  ], { input: JSON.stringify(input), encoding: "utf8" });
  expect(proc.status).toBe(0);
}

function pendingExists(project: string): boolean {
  return existsSync(join(channelDir(project, PM, CH), "pending", `${PEER}.json`));
}

describe("wanderer hook harvest", () => {
  test("keeps pending armed for intermediate replies and harvests only verdicts", () => {
    const project = tmpProject();
    appendMessage(project, PM, CH, {
      from: "pm",
      to: PEER,
      kind: "review_request",
      body: "review this design",
      ref: "control/blueprints/x.md",
    });

    runHook(project, { hook_event_name: "Stop" });
    expect(pendingExists(project)).toBe(true);

    runHook(project, {
      hook_event_name: "Stop",
      last_assistant_message: "I will read the referenced design and come back with a verdict.",
    });
    expect(readLog(channelDir(project, PM, CH)).filter((m) => m.kind === "review_reply")).toHaveLength(0);
    expect(pendingExists(project)).toBe(true);

    runHook(project, {
      hook_event_name: "Stop",
      last_assistant_message: "PASS_WITH_NOTES: the plan is sound; record the Observer fallback.",
    });
    const replies = readLog(channelDir(project, PM, CH)).filter((m) => m.kind === "review_reply");
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toContain("PASS_WITH_NOTES");
    expect(pendingExists(project)).toBe(false);
  });

  test("rate-limit messages become unavailable notices for Observer fallback", () => {
    const project = tmpProject();
    appendMessage(project, PM, CH, {
      from: "pm",
      to: PEER,
      kind: "review_request",
      body: "review this design",
      ref: "control/blueprints/x.md",
    });

    runHook(project, { hook_event_name: "Stop" });
    runHook(project, {
      hook_event_name: "Stop",
      last_assistant_message: "Rate limited: quota exhausted, try again later.",
    });

    const unavailable = readLog(channelDir(project, PM, CH)).filter((m) => m.kind === "unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].body).toContain("quota exhausted");
    expect(pendingExists(project)).toBe(false);
  });
});
