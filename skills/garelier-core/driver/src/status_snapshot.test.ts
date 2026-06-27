import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, redact, readDispatchHold } from "./status_snapshot.ts";
import { loadConfig } from "./config.ts";

const PM = "pm";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Build a temp project with a setup_config containing one observer, plus
 *  optional runtime artifacts. Returns { root, config }. */
function project(body = "", state = "OBSERVING") {
  const root = mkdtempSync(join(tmpdir(), "symphsnap-")); dirs.push(root);
  const pm = join(root, "__garelier", PM);
  mkdirSync(join(pm, "_pm"), { recursive: true });
  writeFileSync(join(pm, "_pm", "setup_config.toml"),
    `[project]\nname = "X"\ngarelier_version = "2.8.4"\n\n` +
    `[branches]\ntarget = "main"\ntarget_slug = "main"\nintegration = "garelier/main/pm/studio"\n\n` +
    `[[observers]]\nid = "ob1"\nprovider = "claude-code"\nenabled = true\n`, "utf8");
  // Observer worktree + STATE.md so readRoles can report its state.
  mkdirSync(join(pm, "_observers", "ob1"), { recursive: true });
  writeFileSync(join(pm, "_observers", "ob1", "STATE.md"),
    `# observer ob1\n\n## Status\n${state}\n\n## Last activity\nnow\n`, "utf8");
  mkdirSync(join(pm, "runtime", "merge_gate", "results"), { recursive: true });
  // caller-supplied extra runtime files
  if (body) {
    for (const [rel, content] of JSON.parse(body) as [string, string][]) {
      const p = join(pm, "runtime", rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
  }
  const config = loadConfig(root, PM);
  return { root, config };
}

describe("readDispatchHold (surface WHY the pipeline is parked)", () => {
  function holdRuntime(files: [string, string][]) {
    const root = mkdtempSync(join(tmpdir(), "symph-hold-")); dirs.push(root);
    const runtime = join(root, "__garelier", PM, "runtime");
    for (const [rel, content] of files) {
      const p = join(runtime, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
    return runtime;
  }

  test("detects an active hold from a dock-inbox directive (scope + reason)", () => {
    const runtime = holdRuntime([[
      "dock/inbox/20260601-204659-pm-resume-m3-hold-m4.md",
      "# PM directive — RESUME m3; m4 stays HELD\n\nIssued: 2026-06-01T11:47:00Z\n\n" +
      "## DO NOT — m4 stays held\n- Do NOT dispatch #16-#22 (m4-engine-extension-residual).\n",
    ]]);
    const h = readDispatchHold(runtime, PM);
    expect(h.active).toBe(true);
    expect(h.scope).toBe("m4");
    expect(h.source).toBe("inbox");
    expect(h.issuedAt).toBe("2026-06-01T11:47:00Z");
    expect(h.rel).toBe(`__garelier/${PM}/runtime/dock/inbox/20260601-204659-pm-resume-m3-hold-m4.md`);
    expect(h.reason).toContain("Do NOT dispatch");
  });

  test("prefers the canonical marker over inbox heuristics", () => {
    const runtime = holdRuntime([
      ["dock/inbox/x-hold.md", "# something HELD\n"],
      ["dock/dispatch_hold.md", "# DISPATCH HOLD m5 until release sign-off\nIssued: 2026-06-04T00:00:00Z\n"],
    ]);
    const h = readDispatchHold(runtime, PM);
    expect(h.active).toBe(true);
    expect(h.source).toBe("marker");
    expect(h.scope).toBe("m5");
  });

  test("a newer resume directive supersedes the hold (banner clears)", () => {
    const runtime = holdRuntime([[
      "dock/inbox/20260601-204659-pm-resume-m3-hold-m4.md",
      "# PM directive — m4 stays HELD\n## DO NOT\n- Do NOT dispatch #16-#22 (m4).\n",
    ]]);
    // A newer operator directive that resumes m4.
    const resume = join(runtime, "dock/inbox/20260603-999999-operator-resume-m4.md");
    writeFileSync(resume, "# Operator directive — RESUME m4 dispatch (#16-#22)\nThe m4 parking is lifted; dispatch m4 backlog and keep going.\n", "utf8");
    // ensure the resume file is newer
    const now = Date.now();
    utimesSync(resume, new Date(now + 5000), new Date(now + 5000));
    expect(readDispatchHold(runtime, PM).active).toBe(false);
  });

  test("no hold when inbox has only ordinary directives", () => {
    const runtime = holdRuntime([["dock/inbox/note.md", "# Dock note — dispatched #13 to worker-01\n"]]);
    expect(readDispatchHold(runtime, PM).active).toBe(false);
  });
});

describe("redact (secrets never reach the browser)", () => {
  test("masks key=value secrets, AWS keys, private-key headers", () => {
    expect(redact("api_key=sk-supersecret-LEAK")).toContain("[REDACTED]");
    expect(redact("token: ghp_abc123def456")).toContain("[REDACTED]");
    expect(redact("id = AKIA1234567890ABCDEF here")).toContain("[REDACTED]");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----")).toContain("[REDACTED]");
  });
  test("leaves ordinary text untouched", () => {
    expect(redact("the quick brown fox")).toBe("the quick brown fox");
  });
  test("masks shape-based tokens with no keyword prefix", () => {
    expect(redact("ghp_0123456789abcdef0123456789abcdefABCD")).toContain("[REDACTED]");
    expect(redact("xoxb-123456789012-abcdefABCDEF")).toContain("[REDACTED]");
    expect(redact("sk-abcdefghijklmnopqrstuvwxyz0123")).toContain("[REDACTED]");
    expect(redact("sk_live_abcdefghijklmnop0123")).toContain("[REDACTED]");
    expect(redact("AIzaSyA1234567890abcdef_ghIJKLmnoPQ")).toContain("[REDACTED]");
    expect(redact("eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT")).toContain("[REDACTED]");
  });
  test("masks the WHOLE PEM block, not just the header", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----";
    const out = redact(pem);
    expect(out).not.toContain("MIIEvQIBADAN");        // body gone
    expect(out).not.toContain("b3BlbnNzaC1rZXk");
    expect(out).toContain("[REDACTED]");
  });
  test("masks connection-string credentials, keeps scheme + host", () => {
    const out = redact("DB=postgres://user:p4ssw0rd@db.example.com/app");
    expect(out).not.toContain("p4ssw0rd");
    expect(out).toContain("postgres://[REDACTED]@db.example.com/app");
  });
});

describe("buildSnapshot role coverage", () => {
  test("Observer role appears in the snapshot with its STATE", () => {
    const { root, config } = project();
    const snap = buildSnapshot(root, PM, config);
    expect(snap.projectRoot).toBe(root);
    const obs = snap.roles.find((r) => r.kind === "observer" && r.id === "ob1");
    expect(obs).toBeDefined();
    expect(obs!.state).toBe("OBSERVING");
    expect(obs!.provider).toBe("claude-code");
    expect(obs!.model).toBeNull();
    // PM + Dock are always present as supervised roles.
    expect(snap.roles.some((r) => r.kind === "pm")).toBe(true);
    expect(snap.roles.some((r) => r.kind === "dock")).toBe(true);
  });
  test("RoleInfo.task surfaces the role's STATE.md 'Current task' (which work it drives)", () => {
    const { root, config } = project();
    const sf = join(root, "__garelier", PM, "_observers", "ob1", "STATE.md");
    writeFileSync(sf, "# observer ob1\n\n## Status\nOBSERVING\n\n## Current task\n#42 — premerge review of workbench #41\n\n## Last activity\nnow\n", "utf8");
    const obs = buildSnapshot(root, PM, config).roles.find((r) => r.kind === "observer" && r.id === "ob1");
    expect(obs!.task).toContain("#42");
    expect(obs!.task).toContain("premerge review");
    // supervised coordinators carry no single task
    expect(buildSnapshot(root, PM, config).roles.find((r) => r.kind === "pm")!.task).toBeNull();
  });
});

describe("buildSnapshot role state staleness", () => {
  test("a container holding ANOTHER role's STATE.md reports `stale`, not its literal status", () => {
    const { root, config } = project();
    // container-reuse residue: the observer container holds a Worker's STATE.md
    // (header role mismatch). It must NOT surface as a live REPORTING.
    const sf = join(root, "__garelier", PM, "_observers", "ob1", "STATE.md");
    writeFileSync(sf, "# Worker ob1\n\n## Status\nREPORTING\n", "utf8");
    const obs = buildSnapshot(root, PM, config).roles.find((r) => r.kind === "observer" && r.id === "ob1");
    expect(obs!.state).toBe("stale");
    expect(obs!.warnings.join(" ")).toContain("stale STATE.md");
  });
});

describe("buildSnapshot merge gate state", () => {
  test("a failed result → mergeGate.state failed", () => {
    const { root, config } = project(JSON.stringify([["merge_gate/results/r1.json", '{"status":"failed"}']]));
    expect(buildSnapshot(root, PM, config).mergeGate.state).toBe("failed");
  });
  test("a success result → mergeGate.state passed", () => {
    const { root, config } = project(JSON.stringify([["merge_gate/results/r1.json", '{"status":"success"}']]));
    expect(buildSnapshot(root, PM, config).mergeGate.state).toBe("passed");
  });
  test("a conflict result → mergeGate.state conflict", () => {
    const { root, config } = project(JSON.stringify([["merge_gate/results/r1.json", '{"status":"conflict"}']]));
    expect(buildSnapshot(root, PM, config).mergeGate.state).toBe("conflict");
  });
  test("a newer in-flight request SUPERSEDES an older failed result → state running, not failed", () => {
    // The bug this guards: an old failed result (e.g. an sccache false-fail) was
    // reported as the current state while a newer re-gate was already running.
    const { root, config } = project(JSON.stringify([
      ["merge_gate/results/11-x.request.json", '{"status":"failed"}'],
      ["merge_gate/requests/12-x.request.json", '{"request_id":"12-x"}'],
    ]));
    const mg = buildSnapshot(root, PM, config).mergeGate;
    expect(mg.state).toBe("running");
    expect(mg.active).toBe(true);
    expect(mg.lastResult).toBe("failed"); // prior outcome still surfaced, not as current state
  });
  test("active.lock present SUPERSEDES an older failed result → state running", () => {
    const { root, config } = project(JSON.stringify([
      ["merge_gate/results/11-x.request.json", '{"status":"failed"}'],
      ["merge_gate/locks/active.lock", '{"pid":1,"request_id":"12-x"}'],
    ]));
    expect(buildSnapshot(root, PM, config).mergeGate.state).toBe("running");
  });
  test("a running gate does NOT raise the failed_quality_gate warning", () => {
    const { root, config } = project(JSON.stringify([
      ["merge_gate/results/11-x.request.json", '{"status":"failed"}'],
      ["merge_gate/requests/12-x.request.json", '{"request_id":"12-x"}'],
    ]));
    const warns = buildSnapshot(root, PM, config).warnings;
    expect(warns.some((w) => w.kind === "failed_quality_gate")).toBe(false);
  });
  test("a failed result with NO newer run still warns", () => {
    const { root, config } = project(JSON.stringify([["merge_gate/results/r1.json", '{"status":"failed"}']]));
    const warns = buildSnapshot(root, PM, config).warnings;
    expect(warns.some((w) => w.kind === "failed_quality_gate")).toBe(true);
  });
  test("summary sidecars are not counted as merge-gate result files", () => {
    const { root, config } = project(JSON.stringify([
      ["merge_gate/results/001-old.summary.json", '{"status":"failed"}'],
    ]));
    const mg = buildSnapshot(root, PM, config).mergeGate;
    expect(mg.state).toBe("idle");
    expect(mg.pendingResults).toBe(0);
    expect(mg.lastResult).toBeNull();
  });
});

describe("buildSnapshot idle-with-pending (DEC-048 §status)", () => {
  const alivePid = process.pid; // the test runner is alive
  const pendingRow = '| 07 | #13 | hp-p2-3 | m3 | worker | — |\n';



});

describe("buildSnapshot knowledge registry warnings", () => {
  test("external sources with missing/old sync metadata become stale_source_registry warnings", () => {
    const { root, config } = project();
    const kdir = join(root, "__garelier", "__atmos", "knowledge");
    mkdirSync(kdir, { recursive: true });
    writeFileSync(join(kdir, "source_registry.toml"), `
[[sources]]
id = "company-policy"
source_type = "sharepoint"
url = "https://example.sharepoint.com/policy"
target = "docs/rules/company_policy.md"
update_mode = "scheduled"
authority = "internal"
license = "confirmed"
use = "internal-policy-source"
last_reviewed_at = "2026-01-01T00:00:00Z"
last_synced_at = ""

[[sources]]
id = "stale-policy"
source_type = "url"
url = "https://example.com/stale"
target = "docs/rules/stale.md"
update_mode = "manual"
authority = "recognized"
license = "confirmed"
use = "allowed-summary"
last_reviewed_at = "2000-01-01T00:00:00Z"
last_synced_at = "2000-01-01T00:00:00Z"
`, "utf8");

    const warns = buildSnapshot(root, PM, config).warnings;
    expect(warns.some((w) => w.kind === "stale_source_registry" && w.message.includes("last_synced_at is empty"))).toBe(true);
    expect(warns.some((w) => w.kind === "stale_source_registry" && w.message.includes("last synced"))).toBe(true);
  });

  test("source target metadata mismatch and missing routine manuals are surfaced", () => {
    const { root, config } = project();
    const kdir = join(root, "__garelier", "__atmos", "knowledge");
    const rules = join(root, "docs", "rules");
    mkdirSync(kdir, { recursive: true });
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(kdir, "source_registry.toml"), `
[[sources]]
id = "test-policy"
source_type = "sharepoint"
url = "https://example.sharepoint.com/test"
target = "docs/rules/testing_rules.md"
update_mode = "scheduled"
authority = "internal"
license = "confirmed"
use = "internal-policy-source"
last_reviewed_at = "2026-01-01T00:00:00Z"
last_synced_at = "2026-01-01T00:00:00Z"
`, "utf8");
    writeFileSync(join(rules, "testing_rules.md"), "---\nlast_synced_at: 2026-01-02T00:00:00Z\n---\n", "utf8");
    writeFileSync(join(kdir, "routine_registry.toml"), `
[[routines]]
id = "daily-progress-update"
manual = "runbooks/daily_progress_update.md"
default_role = "librarian"
`, "utf8");

    const warns = buildSnapshot(root, PM, config).warnings;
    expect(warns.some((w) => w.kind === "stale_source_registry" && w.message.includes("mismatch"))).toBe(true);
    expect(warns.some((w) => w.kind === "missing_routine_manual" && w.path === "runbooks/daily_progress_update.md")).toBe(true);
  });
});


describe("buildSnapshot REPORTING artifact is role-specific", () => {
  // Guardian/Concierge name their report after the role; a flat report.md check
  // false-flagged "guardian guardian-01: REPORTING without report.md" forever.
  function guardianProject(reportFile: string | null) {
    const root = mkdtempSync(join(tmpdir(), "symphsnap-g-")); dirs.push(root);
    const pm = join(root, "__garelier", PM);
    mkdirSync(join(pm, "_pm"), { recursive: true });
    writeFileSync(join(pm, "_pm", "setup_config.toml"),
      `[project]\nname = "X"\ngarelier_version = "2.8.4"\n\n` +
      `[branches]\ntarget = "main"\ntarget_slug = "main"\nintegration = "garelier/main/pm/studio"\n\n` +
      `[[guardians]]\nid = "g1"\nprovider = "claude-code"\nenabled = true\n`, "utf8");
    const g = join(pm, "_guardians", "g1");
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, "STATE.md"), `# guardian g1\n\n## Status\nREPORTING\n\n## Last activity\nnow\n`, "utf8");
    if (reportFile) writeFileSync(join(g, reportFile), "verdict: PASS\n", "utf8");
    mkdirSync(join(pm, "runtime", "merge_gate", "results"), { recursive: true });
    return { root, config: loadConfig(root, PM) };
  }

  test("guardian REPORTING with guardian_report.md is NOT flagged", () => {
    const { root, config } = guardianProject("guardian_report.md");
    const g = buildSnapshot(root, PM, config).roles.find((r) => r.kind === "guardian");
    expect(g?.state).toBe("REPORTING");
    expect(g?.warnings ?? []).toHaveLength(0);
  });

  test("guardian REPORTING with NO report artifact is flagged by its own filename", () => {
    const { root, config } = guardianProject(null);
    const g = buildSnapshot(root, PM, config).roles.find((r) => r.kind === "guardian");
    expect(g?.warnings.some((m) => m.includes("guardian_report.md"))).toBe(true);
    expect(g?.warnings.some((m) => m === "REPORTING without report.md")).toBe(false);
  });
});

describe("buildSnapshot report sidecars", () => {
  test("recent report summaries prefer compact sibling json over markdown body", () => {
    const { root, config } = project("", "REPORTING");
    const dir = join(root, "__garelier", PM, "_observers", "ob1");
    writeFileSync(join(dir, "report.md"), "# Long markdown report\n\nThis body should not be the summary.\n", "utf8");
    writeFileSync(join(dir, "report.json"), JSON.stringify({
      schema_version: 1,
      verdict: "PASS",
      summary: "compact sidecar summary",
      tests: { full: "passed" },
    }), "utf8");
    const reports = buildSnapshot(root, PM, config).recentReports;
    expect(reports[0].summary).toContain("verdict=PASS");
    expect(reports[0].summary).toContain("compact sidecar summary");
    expect(reports[0].summary).not.toContain("Long markdown report");
  });
});

describe("buildSnapshot lane", () => {
  test("an artisan lane.lock → lane.state artisan", () => {
    const { root, config } = project(JSON.stringify([["lane.lock", '{"lane":"artisan","owner":"sol1","pid":999999}']]));
    const snap = buildSnapshot(root, PM, config);
    expect(snap.lane.state).toBe("artisan");
    expect(snap.lane.owner).toBe("sol1");
  });
  test("no lane.lock + driver DOWN → idle (truly nothing running)", () => {
    // ob1 IDLE so there is genuinely no dispatch activity; a default OBSERVING
    // observer now correctly counts as dock-lane activity (DISPATCH_ACTIVE_STATES).
    const { root, config } = project("", "IDLE");
    expect(buildSnapshot(root, PM, config).lane.state).toBe("idle");
  });
  test("no lane.lock + a role mid-dispatch → dock (the default lane is active, not idle)", () => {
    // The dock lane never writes lane.lock; an active dispatch with no
    // artisan lock IS the dock pipeline working — report it truthfully.
    // (project()'s fixture observer is dispatch-active.)
    const { root, config } = project();
    expect(buildSnapshot(root, PM, config).lane.state).toBe("dock");
  });
  test("an artisan lane.lock wins even while dispatch is active", () => {
    const { root, config } = project(JSON.stringify([
      ["lane.lock", '{"lane":"artisan","owner":"sol1","pid":999999}'],
    ]));
    expect(buildSnapshot(root, PM, config).lane.state).toBe("artisan");
  });
});


