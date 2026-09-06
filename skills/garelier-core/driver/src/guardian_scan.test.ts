import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "./guard/path_guard.ts";
import {
  scan,
  parseAddedLines,
  resolveScannerBackend,
  scannerCommand,
  normalizeScannerReport,
  probeGitleaks,
  toNormalizedSecretMatch,
  SCANNER_BACKENDS,
  FORBIDDEN_NETWORK_FLAGS,
  ACCEPTED_FLAGS,
  USAGE,
  usageFlags,
  recoveryFor,
  type Registries,
  type ScanInput,
} from "./guardian_scan.ts";

const GUARDIAN_SCAN = join(import.meta.dir, "guardian_scan.ts");

function run(command: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { cwd, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

// W-379: path_guard's defaultFenceRoots() unconditionally trusts os.tmpdir()
// itself, regardless of any fix -- so a fixture built entirely under the REAL
// os.tmpdir() (as mkdtempSync always does) cannot distinguish "the W-379 fix
// registered this root" from "tmpdir() already covered it". This spawns the
// child process with TEMP/TMP overridden to `isolatedTmp`, so os.tmpdir() AS
// SEEN BY THE CHILD resolves there instead of the real OS temp dir -- a
// fixture built under the real tmpdir() (e.g. `repo`) is then NOT nested
// under the child's own idea of tmpdir(), closing the confound without
// placing any fixture outside the sanctioned scratch area.
function runIsolatedTmp(
  command: string[],
  cwd: string,
  isolatedTmp: string,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, TEMP: isolatedTmp, TMP: isolatedTmp },
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

function git(repo: string, ...args: string[]): string {
  const result = run(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("gitleaks native prerequisite probe", () => {
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("mandatory missing scanner fails closed; optional missing scanner explicitly skips (+1 folded case)", () => {
    // case: mandatory missing scanner fails closed; optional missing scanner explicitly skips
    {
      expect(probeGitleaks({ resolve: () => null })).toMatchObject({ status: "BLOCK", executable: null });
      expect(probeGitleaks({ required: false, resolve: () => null })).toMatchObject({ status: "SKIP", executable: null });
    }
    // case: version probe launches the resolved absolute executable
    {
      const calls: string[][] = [];
      const executable = "C:\\Security Tools\\gitleaks.exe";
      const result = probeGitleaks({
        resolve: () => executable,
        runner: (command) => {
          calls.push(command);
          return { exitCode: 0, stdout: "8.28.0\n", stderr: "" };
        },
      });
      expect(calls).toEqual([[executable, "version"]]);
      expect(result).toEqual({ status: "READY", executable, version: "8.28.0", reason: "" });
    }
  });
});

// Synthetic registries — no real secret/email shapes, so this file is inert to
// the public-export secret/email gate while still exercising the mechanism.
function registries(over: Partial<Registries> = {}): Registries {
  return {
    secret: [{ id: "fake-secret", regex: "SEKRIT-[0-9]{4}", severity: "critical" }],
    pii: [{ id: "fake-pii", regex: "PIINUM-[0-9]+", severity: "high" }],
    injection: [
      { id: "inj-block", regex: "INJECT-NOW", severity: "high", action: "block" },
      { id: "inj-note", regex: "ROLE-SWAP", severity: "medium", action: "note" },
    ],
    fpExceptions: [],
    ...over,
  };
}

function input(over: Partial<ScanInput> = {}): ScanInput {
  return {
    kind: "delta_gate",
    baseRef: "BASE",
    headRef: "HEAD",
    lines: [],
    changedFiles: [],
    packageFiles: ["package.json", "Cargo.toml"],
    ...over,
  };
}

describe("scan — secret dimension", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("un-excepted secret match → BLOCK, redacted pointer, no value leak (+2 folded cases)", () => {
    // case: un-excepted secret match → BLOCK, redacted pointer, no value leak
    {
      const d = scan(registries(), input({ lines: [{ file: "src/a.ts", line: 12, text: "const k = SEKRIT-1234" }] }));
      expect(d.provisional_verdict).toBe("BLOCK");
      expect(d.findings).toHaveLength(1);
      const f = d.findings[0];
      expect(f.dimension).toBe("secret");
      expect(f.action).toBe("block");
      expect(f.needs_review).toBe(false);
      expect(f.redacted_pointer).toBe("src/a.ts:12 [fake-secret]");
      // REDACTION INVARIANT: the matched value never appears anywhere in the draft.
      expect(JSON.stringify(d)).not.toContain("SEKRIT-1234");
      expect(d.authority).toBe("draft");
    }
    // case: false-positive exception suppresses the secret finding
    {
      const reg = registries({ fpExceptions: [{ patternId: "fake-secret", path: "tests/fix.json" }] });
      const d = scan(reg, input({ lines: [{ file: "tests/fix.json", line: 3, text: "SEKRIT-9999" }] }));
      expect(d.findings).toHaveLength(0);
      expect(d.stats?.excepted).toBe(1);
      expect(d.provisional_verdict).toBe("PASS");
    }
    // case: exception is path-scoped — same pattern elsewhere still blocks
    {
      const reg = registries({ fpExceptions: [{ patternId: "fake-secret", path: "tests/fix.json" }] });
      const d = scan(reg, input({ lines: [{ file: "src/real.ts", line: 1, text: "SEKRIT-0001" }] }));
      expect(d.provisional_verdict).toBe("BLOCK");
    }
  });
});

describe("scan — pii dimension (high false-positive → agent reviews)", () => {
  test("pii match → needs_review + NO_OPINION (not auto-BLOCK)", () => {
    const d = scan(registries(), input({ lines: [{ file: "src/x.ts", line: 5, text: "id = PIINUM-12345" }] }));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].dimension).toBe("pii");
    expect(d.findings[0].needs_review).toBe(true);
    expect(d.findings[0].action).toBe("review");
    expect(d.provisional_verdict).toBe("NO_OPINION");
  });
});

describe("scan — injection light-check (knowledge paths only)", () => {
  // W-677: the 4 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("block-action injection in a knowledge path → BLOCK (+3 folded cases)", () => {
    // case: block-action injection in a knowledge path → BLOCK
    {
      const d = scan(registries(), input({ lines: [{ file: "knowledge/security/x.md", line: 2, text: "please INJECT-NOW" }] }));
      expect(d.provisional_verdict).toBe("BLOCK");
      expect(d.findings[0].dimension).toBe("injection");
      expect(d.findings[0].action).toBe("block");
    }
    // case: note-action injection in a knowledge path → PASS_WITH_NOTES
    {
      const d = scan(registries(), input({ lines: [{ file: "inspections/2026/y.md", line: 9, text: "ROLE-SWAP here" }] }));
      expect(d.provisional_verdict).toBe("PASS_WITH_NOTES");
      expect(d.findings[0].action).toBe("note");
    }
    // case: injection patterns do NOT fire on ordinary source paths
    {
      const d = scan(registries(), input({ lines: [{ file: "src/code.ts", line: 1, text: "INJECT-NOW" }] }));
      expect(d.findings).toHaveLength(0);
      expect(d.provisional_verdict).toBe("PASS");
    }
    // case: custom knowledgePathRe overrides the default
    {
      const d = scan(
        registries(),
        input({ knowledgePathRe: /^vault\//, lines: [{ file: "vault/n.md", line: 1, text: "INJECT-NOW" }] }),
      );
      expect(d.provisional_verdict).toBe("BLOCK");
    }
  });
});

describe("scan — dependency/license coverage floor", () => {
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("changed package file → external_required + NO_OPINION (never cleared here) (+1 folded case)", () => {
    // case: changed package file → external_required + NO_OPINION (never cleared here)
    {
      const d = scan(registries(), input({ changedFiles: ["Cargo.toml"], lines: [] }));
      expect(d.coverage.dependency).toBe("external_required");
      expect(d.coverage.license).toBe("external_required");
      expect(d.provisional_verdict).toBe("NO_OPINION");
    }
    // case: no package change → not_applicable, clean PASS
    {
      const d = scan(registries(), input({ changedFiles: ["src/a.ts"], lines: [{ file: "src/a.ts", line: 1, text: "ok" }] }));
      expect(d.coverage.dependency).toBe("not_applicable");
      expect(d.provisional_verdict).toBe("PASS");
    }
  });
});

describe("scan — verdict precedence + determinism", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("BLOCK wins over review/notes/external (+2 folded cases)", () => {
    // case: BLOCK wins over review/notes/external
    {
      const d = scan(
        registries(),
        input({
          changedFiles: ["package.json"],
          lines: [
            { file: "src/a.ts", line: 1, text: "SEKRIT-1111" }, // block
            { file: "src/a.ts", line: 2, text: "PIINUM-2" }, // review
          ],
        }),
      );
      expect(d.provisional_verdict).toBe("BLOCK");
    }
    // case: same registries + same input → identical draft
    {
      const ln = [{ file: "src/a.ts", line: 1, text: "PIINUM-7" }];
      const a = scan(registries(), input({ lines: ln }));
      const b = scan(registries(), input({ lines: ln }));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    // case: an un-compilable secret pattern is surfaced + degrades coverage (no silent PASS)
    {
      const reg = registries({ secret: [{ id: "broken", regex: "((", severity: "critical" }] });
      const d = scan(reg, input({ lines: [{ file: "a.ts", line: 1, text: "anything" }] }));
      expect(d.skipped_patterns).toContain("broken");
      // W-461 AC-1: a degraded scan carries NO stats block. The recall hole it just
      // reported is exactly what a `skipped: 1` row next to `findings: 0` would
      // paper over. The count survives where it cannot be misread — skipped_patterns.
      expect(d.stats).toBeNull();
      expect(d.skipped_patterns).toHaveLength(1);
      expect(d.coverage.secret).toBe("degraded");
      // a degraded MANDATORY scan must never clean-PASS — recall is reduced.
      expect(d.provisional_verdict).toBe("NO_OPINION");
      expect(d.scan_state).toBe("failed");
      expect(d.failure).toMatchObject({ kind: "internal" });

      const brokenInjection = scan(
        registries({ injection: [{ id: "broken-injection", regex: "((", severity: "high", action: "block" }] }),
        input(),
      );
      expect(brokenInjection.coverage.injection).toBe("degraded");
      expect(brokenInjection.provisional_verdict).toBe("NO_OPINION");
      expect(brokenInjection.scan_state).toBe("failed");
      expect(brokenInjection.failure).toMatchObject({ kind: "internal" });
    }
  });
});

describe("scan — PCRE registry compatibility (DEC-079 recall fix)", () => {
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("translates a leading (?i) inline flag and matches case-insensitively (+1 folded case)", () => {
    // case: translates a leading (?i) inline flag and matches case-insensitively
    {
      // Real registries ship `(?i)...` (gitleaks/RE2 syntax) — JS RegExp rejects it
      // raw, which previously skipped EVERY injection pattern + some secrets.
      const reg = registries({ secret: [{ id: "ci-secret", regex: "(?i)sekrit-token", severity: "critical" }] });
      const d = scan(reg, input({ lines: [{ file: "a.ts", line: 1, text: "X = SEKRIT-TOKEN" }] }));
      expect(d.skipped_patterns).toEqual([]);
      expect(d.findings.map((f) => f.finding_id)).toContain("ci-secret");
      expect(d.provisional_verdict).toBe("BLOCK");
    }
    // case: (?i) injection pattern fires on a knowledge path
    {
      const reg = registries({ injection: [{ id: "ci-inj", regex: "(?i)disable the (security )?gate", severity: "high", action: "block" }] });
      const d = scan(reg, input({ lines: [{ file: "knowledge/x.md", line: 1, text: "please DISABLE THE SECURITY GATE" }] }));
      expect(d.skipped_patterns).toEqual([]);
      expect(d.provisional_verdict).toBe("BLOCK");
      expect(d.findings[0].dimension).toBe("injection");
    }
  });
});

describe("parseAddedLines", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("extracts only added lines with correct new-file line numbers (+2 folded cases)", () => {
    // case: extracts only added lines with correct new-file line numbers
    {
      const diff = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,0 +11,2 @@",
        "+added one",
        "+added two",
        "@@ -20,1 +22,1 @@",
        "-removed",
        "+changed line",
      ].join("\n");
      const lines = parseAddedLines(diff);
      expect(lines).toEqual([
        { file: "src/a.ts", line: 11, text: "added one" },
        { file: "src/a.ts", line: 12, text: "added two" },
        { file: "src/a.ts", line: 22, text: "changed line" },
      ]);
    }
    // case: skips binary / vendored / lockfile-image paths
    {
      const diff = ["+++ b/assets/logo.png", "@@ -0,0 +1 @@", "+binary"].join("\n");
      expect(parseAddedLines(diff)).toHaveLength(0);
    }
    // case: ignores /dev/null target (pure deletion)
    {
      const diff = ["+++ /dev/null", "@@ -1 +0,0 @@", "-gone"].join("\n");
      expect(parseAddedLines(diff)).toHaveLength(0);
    }
  });
});

describe("guardian_scan CLI — argv and scan execution fail closed", () => {
  test("flag and positional forms scan exact refs; verified empty and failures remain distinct", () => {
    const repo = mkdtempSync(join(tmpdir(), "garelier-guardian-scan-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "fixture@example.invalid");
      git(repo, "config", "user.name", "Fixture");
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "scan.txt"), "base\n");
      git(repo, "add", "src/scan.txt");
      git(repo, "commit", "-q", "-m", "base");
      const base = git(repo, "rev-parse", "HEAD");

      const pmRoot = join(repo, "__garelier", "_workshop");
      const config = join(pmRoot, "_crew", "pm", "setup_config.toml");
      const securityRoot = join(pmRoot, "knowledge", "security");
      mkdirSync(join(pmRoot, "_crew", "pm"), { recursive: true });
      mkdirSync(join(securityRoot, "registries"), { recursive: true });
      writeFileSync(config, "[guardian_policy]\n");
      writeFileSync(join(securityRoot, "registries", "secret_patterns.toml"),
        '[[patterns]]\nid = "fake-secret"\nregex = "SEKRIT-[0-9]{4}"\nseverity = "critical"\n');
      writeFileSync(join(securityRoot, "registries", "pii_patterns.toml"), "patterns = []\n");
      writeFileSync(join(securityRoot, "registries", "injection_patterns.toml"), "patterns = []\n");
      writeFileSync(join(securityRoot, "registries", "false_positive_exceptions.toml"), "exceptions = []\n");

      writeFileSync(join(repo, "src", "scan.txt"), "base\nSEKRIT-1234\n");
      git(repo, "add", "src/scan.txt");
      git(repo, "commit", "-q", "-m", "head");
      const head = git(repo, "rev-parse", "HEAD");

      const flags = [
        "--project", repo,
        "--base", base,
        "--head", head,
        "--security-root", securityRoot,
      ];
      const flagged = run([process.execPath, GUARDIAN_SCAN, ...flags], repo);
      expect(flagged.exitCode).toBe(0);
      const flaggedDraft = JSON.parse(flagged.stdout);
      expect(flaggedDraft.scan_state).toBe("complete");
      expect(flaggedDraft.scope).toMatchObject({ base_ref: base, head_ref: head });
      expect(flaggedDraft.provisional_verdict).toBe("BLOCK");
      expect(flaggedDraft.stats.lines_scanned).toBe(1);

      const positional = run([process.execPath, GUARDIAN_SCAN, config, repo, base, head, "--security-root", securityRoot], repo);
      expect(positional.exitCode).toBe(0);
      expect(JSON.parse(positional.stdout)).toMatchObject({
        scan_state: "complete",
        provisional_verdict: "BLOCK",
      });

      // W-461 AC-3 / AC-4(a) — THE COUNTERFACTUAL. This exact invocation used to
      // exit 0 with `provisional_verdict: PASS` and `lines_scanned: 0`, which is
      // byte-identical to what a PROXY lane (deliverable not yet committed) gets
      // from `--base studio --head HEAD`. Two Guardians and two PMs read that as
      // a clean scan. An unresolved denominator now refuses.
      const empty = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", repo,
        "--base", head,
        "--head", head,
        "--pm-id", "_workshop",
        "--security-root", securityRoot,
      ], repo);
      expect(empty.exitCode).not.toBe(0);
      expect(JSON.parse(empty.stdout)).toMatchObject({
        scan_state: "failed",
        provisional_verdict: "NO_OPINION",
        stats: null,
        failure: { kind: "denominator" },
        unresolved: { denominator: "UNRESOLVED" },
      });
      // G-4: the refusal names the opt-in that recovers it, and the opt-in works.
      expect(empty.stdout).toContain("--allow-empty-delta");
      expect(empty.stderr).toContain("recovery:");

      // W-461 AC-4(b) / R-4 — the input form that worked before still works. The
      // refusal above is a NOTICE, not a narrowing: a deliberately empty delta is
      // still expressible, it just has to be said out loud rather than inferred
      // from a zero. Without this half, "refuse everything" would satisfy AC-4(a).
      const emptyAllowed = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", repo,
        "--base", head,
        "--head", head,
        "--pm-id", "_workshop",
        "--security-root", securityRoot,
        "--allow-empty-delta",
      ], repo);
      expect(emptyAllowed.exitCode).toBe(0);
      expect(JSON.parse(emptyAllowed.stdout)).toMatchObject({
        scan_state: "complete",
        failure: null,
        provisional_verdict: "PASS",
        stats: { lines_scanned: 0 },
      });

      // W-353 (AC b) case 1: `git -C` walks UP to the enclosing repository, so a
      // --project naming a SUBDIRECTORY used to scan the parent repo's diff and
      // report `complete` — a wrong-repo result with no visible symptom.
      const subdirectory = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", join(repo, "src"),
        "--base", base,
        "--head", head,
        "--security-root", securityRoot,
        "--config", config,
      ], repo);
      expect(subdirectory.exitCode).toBe(3);
      const subdirectoryDraft = JSON.parse(subdirectory.stdout);
      expect(subdirectoryDraft.scan_state).toBe("failed");
      expect(subdirectoryDraft.failure.message).toContain("not a git repository toplevel");

      // W-353 (AC b) case 2 — THE COUNTEREXAMPLE. Comparing the resolved toplevel
      // against --project itself answers only "is this its own repo root?", so an
      // UNRELATED but perfectly valid repository ROOT passed and its tree was
      // scanned and reported complete. A baseline taken from the subject cannot
      // say the subject is the RIGHT one.
      //
      // The clone is deliberate: base/head RESOLVE in it, so the scan COULD have
      // produced a clean `complete` draft. The refusal must therefore be the
      // binding — not an incidental ref-resolution failure, which would make this
      // test pass for the wrong reason.
      const elsewhere = mkdtempSync(join(tmpdir(), "garelier-guardian-scan-other-"));
      try {
        const unrelated = join(elsewhere, "clone");
        expect(run(["git", "clone", "-q", repo, unrelated]).exitCode).toBe(0);
        expect(git(unrelated, "rev-parse", "--verify", `${head}^{commit}`)).toBe(head);
        expect(git(unrelated, "rev-parse", "--show-toplevel")).toBeTruthy();

        const wrongRepo = run([
          process.execPath, GUARDIAN_SCAN,
          "--project", unrelated,
          "--base", base,
          "--head", head,
          "--security-root", securityRoot,
          "--config", config,
        ], repo);
        expect(wrongRepo.exitCode).toBe(3);
        const wrongRepoDraft = JSON.parse(wrongRepo.stdout);
        expect(wrongRepoDraft.scan_state).toBe("failed");
        expect(wrongRepoDraft.failure.message).toContain("cannot be bound to the PM control tree");
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }

      const failedDiff = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", repo,
        "--base", "-h",
        "--head", head,
        "--pm-id", "_workshop",
        "--security-root", securityRoot,
      ], repo);
      expect(failedDiff.exitCode).not.toBe(0);
      expect(JSON.parse(failedDiff.stdout)).toMatchObject({
        scan_state: "failed",
        provisional_verdict: "NO_OPINION",
        coverage: { secret: "unavailable" },
        failure: { kind: "diff", message: expect.stringContaining("exit 129") },
      });
      expect(failedDiff.stderr).toContain("exit 129");

      const malformed = run([process.execPath, GUARDIAN_SCAN, ...flags, "--unknown"], repo);
      const missing = run([process.execPath, GUARDIAN_SCAN, "--project", repo, "--base", base, "--head"], repo);
      const duplicate = run([process.execPath, GUARDIAN_SCAN, ...flags, "--head", head], repo);
      const conflictingConfig = run([
        process.execPath, GUARDIAN_SCAN,
        "--config", config,
        "--pm-id", "_workshop",
        "--project", repo,
        "--base", base,
        "--head", head,
        "--security-root", securityRoot,
      ], repo);
      const duplicateOptional = run([
        process.execPath, GUARDIAN_SCAN,
        "--probe-gitleaks", "--optional", "--optional",
      ], repo);
      for (const result of [malformed, missing, duplicate, conflictingConfig, duplicateOptional]) {
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          scan_state: "failed",
          provisional_verdict: "NO_OPINION",
          coverage: { secret: "unavailable" },
          failure: { kind: "argv" },
        });
      }

      // W-461 AC-5 — the three inputs a PM actually typed on 2026-08-15 and again
      // on 2026-09-01, each of which returned `lines_scanned: 0` in the shape of a
      // clean scan. `--format json` (a flag that does not exist), `--security-root .`
      // (registries missing), and a --security-root outside the checkout (W-353).
      const nonexistentFlag = run([process.execPath, GUARDIAN_SCAN, ...flags, "--format", "json"], repo);
      const securityRootDot = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", repo, "--base", base, "--head", head,
        "--config", config, "--security-root", repo,
      ], repo);
      const outsideCheckout = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", repo, "--base", base, "--head", head,
        "--config", config, "--security-root", tmpdir(),
      ], repo);

      // W-461 AC-1 — the machine form of "read only the tail and you cannot call
      // it clean". Fifteen lines is what a PM sees scrolling a wrapped terminal;
      // before the fix those fifteen lines were `"lines_scanned": 0, "findings": 0,
      // "needs_review": 0, "excepted": 0, "skipped": 0` — identical to a real
      // clean run. Now the tail states the failure and its recovery.
      for (const [label, result] of [
        ["nonexistent flag", nonexistentFlag],
        ["--security-root without registries", securityRootDot],
        ["--security-root outside the checkout", outsideCheckout],
        ["empty delta", empty],
      ] as const) {
        expect(result.exitCode, label).not.toBe(0);
        const draft = JSON.parse(result.stdout);
        expect(draft.scan_state, label).toBe("failed");
        expect(draft.stats, label).toBeNull();
        expect(draft.unresolved.denominator, label).toBe("UNRESOLVED");
        expect(draft.unresolved.recovery.length, label).toBeGreaterThan(0);

        const tail = result.stdout.trimEnd().split("\n").slice(-15).join("\n");
        expect(tail, label).toContain("UNRESOLVED");
        expect(tail, label).toContain("FAILED SCAN");
        // The negative half: the tail must not carry the success-shaped counters
        // at all. Asserting only the presence of the new block would still pass if
        // the old zeros were left sitting next to it.
        expect(tail, label).not.toContain('"lines_scanned"');
        expect(tail, label).not.toContain('"findings": 0');
      }
      // …and the positive half of R-1: a run that DID scan still reports its stats
      // in the ordinary shape. Without this, emitting the failure block
      // unconditionally would satisfy every assertion above.
      const completeTail = flagged.stdout.trimEnd().split("\n").slice(-15).join("\n");
      expect(completeTail).toContain('"lines_scanned"');
      expect(completeTail).not.toContain("UNRESOLVED");

      const staleOut = join(repo, "guardian-draft.json");
      const seeded = run([
        process.execPath, GUARDIAN_SCAN,
        "--project", repo,
        "--base", head,
        "--head", head,
        "--pm-id", "_workshop",
        "--security-root", securityRoot,
        "--allow-empty-delta",
        "--out", staleOut,
      ], repo);
      expect(seeded.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(staleOut, "utf8"))).toMatchObject({
        scan_state: "complete",
        provisional_verdict: "PASS",
      });
      const staleInvalidated = run([
        process.execPath, GUARDIAN_SCAN,
        ...flags,
        "--out", staleOut,
        "--unknown",
      ], repo);
      expect(staleInvalidated.exitCode).not.toBe(0);
      expect(JSON.parse(readFileSync(staleOut, "utf8"))).toMatchObject({
        scan_state: "failed",
        provisional_verdict: "NO_OPINION",
        failure: { kind: "argv" },
      });

      const missingConfig = run([
        process.execPath, GUARDIAN_SCAN,
        "--config", join(repo, "missing.toml"),
        "--project", repo,
        "--base", base,
        "--head", head,
        "--security-root", securityRoot,
      ], repo);
      expect(missingConfig.exitCode).not.toBe(0);
      expect(JSON.parse(missingConfig.stdout)).toMatchObject({
        scan_state: "failed",
        provisional_verdict: "NO_OPINION",
        coverage: { secret: "unavailable" },
        failure: { kind: "config" },
      });

      const missingRegistries = run([
        process.execPath, GUARDIAN_SCAN,
        "--config", config,
        "--project", repo,
        "--base", base,
        "--head", head,
        "--security-root", join(repo, "missing-security"),
      ], repo);
      expect(missingRegistries.exitCode).not.toBe(0);
      expect(JSON.parse(missingRegistries.stdout)).toMatchObject({
        scan_state: "failed",
        provisional_verdict: "NO_OPINION",
        coverage: { secret: "unavailable" },
        failure: { kind: "internal" },
      });

      writeFileSync(
        join(securityRoot, "registries", "injection_patterns.toml"),
        '[[patterns]]\nid = "broken-injection"\nregex = "(("\nseverity = "high"\naction = "block"\n',
      );
      const internalOut = join(repo, "internal-failure.json");
      const malformedPattern = run([process.execPath, GUARDIAN_SCAN, ...flags, "--out", internalOut], repo);
      expect(malformedPattern.exitCode).toBe(3);
      expect(malformedPattern.stderr).toContain("pattern compilation failed: broken-injection");
      const internalFailure = {
        scan_state: "failed",
        provisional_verdict: "NO_OPINION",
        coverage: { injection: "degraded" },
        failure: { kind: "internal" },
      };
      expect(JSON.parse(malformedPattern.stdout)).toMatchObject(internalFailure);
      expect(JSON.parse(readFileSync(internalOut, "utf8"))).toMatchObject(internalFailure);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---- W-379: --out atomic write must not depend on ambient cwd/env ----------
//
// The bug: writeDraftAtomic's rename/unlink go through path_guard's guarded
// wrappers, which fence a path against defaultFenceRoots(process.cwd()) when
// no explicit fenceRoots are given. The real incident (Guardian #528 N3) saw
// this deny "outside fence roots" at every candidate --out location tried,
// because the gate seat's actual process cwd had no relationship to any of
// them. The pre-existing "guardian-draft.json" test above writes --out under
// the REPO ROOT with cwd ALSO set to the repo root, so it never exercised
// this: nearestRepoRoot(cwd) already covers repo-root paths regardless of the
// fix. These tests deliberately run with cwd pointed at an UNRELATED
// directory to prove the write no longer depends on it.
function w379Fixture(): { repo: string; pmRoot: string; config: string; securityRoot: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "garelier-w379-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "scan.txt"), "base\n");
  git(repo, "add", "src/scan.txt");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  const pmRoot = join(repo, "__garelier", "_workshop");
  const config = join(pmRoot, "_crew", "pm", "setup_config.toml");
  const securityRoot = join(pmRoot, "knowledge", "security");
  mkdirSync(join(pmRoot, "_crew", "pm"), { recursive: true });
  mkdirSync(join(securityRoot, "registries"), { recursive: true });
  writeFileSync(config, "[guardian_policy]\n");
  writeFileSync(join(securityRoot, "registries", "secret_patterns.toml"), "patterns = []\n");
  writeFileSync(join(securityRoot, "registries", "pii_patterns.toml"), "patterns = []\n");
  writeFileSync(join(securityRoot, "registries", "injection_patterns.toml"), "patterns = []\n");
  writeFileSync(join(securityRoot, "registries", "false_positive_exceptions.toml"), "exceptions = []\n");
  // This suite tests the WRITE, not findings, so the delta's CONTENT is irrelevant
  // — but it must not be EMPTY. W-461 refuses an unresolved denominator, and using
  // base===head here would make these tests silently depend on --allow-empty-delta
  // rather than on the ordinary path they exist to cover.
  writeFileSync(join(repo, "src", "scan.txt"), "base\nordinary\n");
  git(repo, "add", "src/scan.txt");
  git(repo, "commit", "-q", "-m", "head");
  const head = git(repo, "rev-parse", "HEAD");
  return { repo, pmRoot, config, securityRoot, base, head };
}

describe("guardian_scan usage banner (W-461 AC-2 / G-2 — usage IS the parser)", () => {
  // W-677: the 4 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("the flags USAGE names and the flags the parsers accept are the same set, both directions (+3 folded cases)", () => {
    // case: the flags USAGE names and the flags the parsers accept are the same set, both directions
    {
      // R-2's shape: the two sides are DERIVED, never restated. Adding a `case` to a
      // parser without touching USAGE, or advertising a flag no parser accepts (the
      // merge_land → merge_request defect), turns this RED.
      expect(usageFlags()).toEqual([...ACCEPTED_FLAGS]);

      // Add one to either side and it must break — otherwise the equality above
      // could be vacuous (e.g. both sides derived from the same list).
      expect(usageFlags(`${USAGE}\n  [--rebind-authority]`)).not.toEqual([...ACCEPTED_FLAGS]);
    }
    // case: USAGE states that --security-root is required and never derived from --pm-id
    {
      // The pre-fix banner put the REQUIRED --security-root behind `[--pm-id | --config]`,
      // which reads as "resolved from --pm-id". It is not: resolveConfigPath infers a
      // pm-id FROM the security root. A PM followed the banner three times.
      expect(USAGE).toContain("--security-root is REQUIRED");
      expect(USAGE).toContain("NEVER derived from --pm-id");
      // Positional order carries the same claim to anyone who reads only line 1.
      const scanLine = USAGE.split("\n").find((line) => line.includes("--project <root>"))!;
      expect(scanLine.indexOf("--security-root")).toBeGreaterThan(-1);
      expect(scanLine).not.toContain("[--pm-id");
    }
    // case: a usage error names EVERY missing requirement at once and carries a recovery step
    {
      // control-transition L-4: disclosing one required argument per round trip costs
      // the caller a round trip per argument. Two missing → both named.
      const two = run([process.execPath, GUARDIAN_SCAN, "--project", "."], process.cwd());
      expect(two.exitCode).toBe(2);
      const draft = JSON.parse(two.stdout);
      expect(draft.stats).toBeNull();
      expect(draft.unresolved.failure_kind).toBe("argv");
      for (const required of ["--base <ref>", "--head <ref>", "--security-root <dir>"]) {
        expect(draft.unresolved.message).toContain(required);
      }
      expect(draft.unresolved.recovery.join("\n")).toContain("bun guardian_scan.ts");
    }
    // case: recoveryFor never returns an empty next step for any failure kind
    {
      for (const kind of ["argv", "config", "diff", "internal", "denominator"] as const) {
        expect(recoveryFor(kind, "registries", { projectRoot: ".", pmId: "_workshop" }).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("guardian_scan --out W-379 (atomic write reaches the canonical results dir from any cwd)", () => {
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("--out under <pmRoot>/runtime/guardian/results succeeds with cwd pointed elsewhere entirely (+1 folded case)", () => {
    // case: --out under <pmRoot>/runtime/guardian/results succeeds with cwd pointed elsewhere entirely
    {
      const { repo, securityRoot, base, head } = w379Fixture();
      const elsewhere = mkdtempSync(join(tmpdir(), "garelier-w379-elsewhere-"));
      try {
        const resultsDir = join(repo, "__garelier", "_workshop", "runtime", "guardian", "results");
        const outPath = join(resultsDir, "w379-scan-draft.json");
        const result = runIsolatedTmp([
          process.execPath, GUARDIAN_SCAN,
          "--project", repo,
          "--base", base,
          "--head", head,
          "--pm-id", "_workshop",
          "--security-root", securityRoot,
          "--out", outPath,
        ], elsewhere, elsewhere); // cwd AND the child's own os.tmpdir() have NO relationship to repo/pmRoot
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(outPath, "utf8"))).toMatchObject({
          scan_state: "complete",
          provisional_verdict: "PASS",
        });
        // The observer's own results dir is registered the same way (both roles
        // share the fix), even though this run only wrote the guardian one.
        const observerResultsDir = join(repo, "__garelier", "_workshop", "runtime", "observer", "results");
        const observerOut = join(observerResultsDir, "w379-observer-draft.json");
        const observerResult = runIsolatedTmp([
          process.execPath, GUARDIAN_SCAN,
          "--project", repo,
          "--base", base,
          "--head", head,
          "--pm-id", "_workshop",
          "--security-root", securityRoot,
          "--out", observerOut,
        ], elsewhere, elsewhere);
        expect(observerResult.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(observerOut, "utf8"))).toMatchObject({ scan_state: "complete" });
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    }
    // case: registering the trusted results root never widens what --out may target outside it
    {
      // W-379's fix only ADDS <pmRoot>/runtime/{guardian,observer}/results as a
      // trusted root for THIS process -- it must not become a general escape
      // for an --out pointed somewhere else the ambient fence also does not
      // cover. A location with no relationship to cwd, repo, or the trusted
      // results roots stays denied.
      const { repo, securityRoot, base, head } = w379Fixture();
      const elsewhere = mkdtempSync(join(tmpdir(), "garelier-w379-elsewhere-"));
      const unrelated = mkdtempSync(join(tmpdir(), "garelier-w379-unrelated-"));
      try {
        const outPath = join(unrelated, "draft.json");
        const result = runIsolatedTmp([
          process.execPath, GUARDIAN_SCAN,
          "--project", repo,
          "--base", base,
          "--head", head,
          "--pm-id", "_workshop",
          "--security-root", securityRoot,
          "--out", outPath,
        ], elsewhere, elsewhere);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("path_guard");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
        rmSync(unrelated, { recursive: true, force: true });
      }
    }
  }, 30000);
});

describe("guardian_scan --sweep-stale-drafts (W-379 residue cleanup)", () => {
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("removes only the exact atomic-write tmp shape, under the trusted roots only, from any cwd (+1 folded case)", () => {
    // case: removes only the exact atomic-write tmp shape, under the trusted roots only, from any cwd
    {
      const { repo } = w379Fixture();
      const elsewhere = mkdtempSync(join(tmpdir(), "garelier-w379-sweep-elsewhere-"));
      try {
        const guardianResults = join(repo, "__garelier", "_workshop", "runtime", "guardian", "results");
        const observerResults = join(repo, "__garelier", "_workshop", "runtime", "observer", "results");
        mkdirSync(guardianResults, { recursive: true });
        mkdirSync(observerResults, { recursive: true });
        const staleTmp1 = join(guardianResults, "w365-scan-draft.json.tmp-12345-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
        const staleTmp2 = join(observerResults, "w365-scan-draft.json.tmp-67890-2c8e7cde-ccfe-4c3e-9c6e-bc9efcce5cfe");
        const realDraft = join(guardianResults, "w365-scan-draft.json");
        const lookalike = join(guardianResults, "not-a-tmp.json");
        writeFileSync(staleTmp1, "{}");
        writeFileSync(staleTmp2, "{}");
        writeFileSync(realDraft, "{}");
        writeFileSync(lookalike, "{}");

        // cwd AND the child's own os.tmpdir() are UNRELATED to repo -- same
        // cwd-independence property as the --out fix above, proven here for
        // the sweep entry too.
        const result = runIsolatedTmp([
          process.execPath, GUARDIAN_SCAN,
          "--sweep-stale-drafts",
          "--project", repo,
          "--pm-id", "_workshop",
        ], elsewhere, elsewhere);
        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout);
        const removedBasenames = report.removed.map((p: string) => p.replace(/\\/g, "/").split("/").pop());
        expect(report.removed).toHaveLength(2);
        expect(removedBasenames).toContain(staleTmp1.replace(/\\/g, "/").split("/").pop());
        expect(removedBasenames).toContain(staleTmp2.replace(/\\/g, "/").split("/").pop());

        expect(existsSync(staleTmp1)).toBe(false);
        expect(existsSync(staleTmp2)).toBe(false);
        expect(existsSync(realDraft)).toBe(true); // not a tmp shape: untouched
        expect(existsSync(lookalike)).toBe(true); // not a tmp shape: untouched
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    }
    // case: requires --project and --pm-id explicitly; never infers them
    {
      const missingBoth = run([process.execPath, GUARDIAN_SCAN, "--sweep-stale-drafts"], tmpdir());
      expect(missingBoth.exitCode).toBe(2);
      const missingPmId = run([process.execPath, GUARDIAN_SCAN, "--sweep-stale-drafts", "--project", tmpdir()], tmpdir());
      expect(missingPmId.exitCode).toBe(2);
    }
  }, 30000);
});

// ---- scanner backend abstraction (W-065) ------------------------------------

describe("resolveScannerBackend — selection + fail-safe default", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("missing config / no key → gitleaks (shipped default) (+2 folded cases)", () => {
    // case: missing config / no key → gitleaks (shipped default)
    {
      expect(resolveScannerBackend(undefined)).toBe("gitleaks");
      expect(resolveScannerBackend({})).toBe("gitleaks");
      expect(resolveScannerBackend({ guardian_tools: {} })).toBe("gitleaks");
    }
    // case: explicit betterleaks is honored; unknown / wrong-type values fall back to gitleaks
    {
      expect(resolveScannerBackend({ guardian_tools: { scanner_backend: "betterleaks" } })).toBe("betterleaks");
      expect(resolveScannerBackend({ guardian_tools: { scanner_backend: "trufflehog" } })).toBe("gitleaks");
      expect(resolveScannerBackend({ guardian_tools: { scanner_backend: 1 } })).toBe("gitleaks");
      expect(resolveScannerBackend({ guardian_tools: { scanner_backend: true } })).toBe("gitleaks");
    }
    // case: the two supported backends are exactly gitleaks + betterleaks
    {
      expect([...SCANNER_BACKENDS]).toEqual(["gitleaks", "betterleaks"]);
    }
  });
});

describe("scannerCommand — argv per backend + JSON/redacted output", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("gitleaks dir: modern form, JSON to stdout, redacted (+2 folded cases)", () => {
    // case: gitleaks dir: modern form, JSON to stdout, redacted
    {
      const argv = scannerCommand("gitleaks", { subcommand: "dir", target: "." });
      expect(argv[0]).toBe("gitleaks");
      expect(argv).toContain("dir");
      expect(argv).toContain("--no-banner");
      expect(argv).toContain("--redact");
      expect(argv.join(" ")).toContain("--report-format json");
      expect(argv.join(" ")).toContain("--report-path -");
    }
    // case: gitleaks git: range is passed via --log-opts
    {
      const argv = scannerCommand("gitleaks", { subcommand: "git", target: ".", range: "base...head" });
      expect(argv).toContain("--log-opts");
      expect(argv[argv.indexOf("--log-opts") + 1]).toBe("base...head");
    }
    // case: betterleaks dir: verified verbs/flags, JSON to stdout, redacted
    {
      const argv = scannerCommand("betterleaks", { subcommand: "dir", target: "src" });
      expect(argv[0]).toBe("betterleaks");
      expect(argv).toContain("dir");
      expect(argv).toContain("src");
      expect(argv).toContain("--redact");
      expect(argv.join(" ")).toContain("--report-format json");
      expect(argv.join(" ")).toContain("--report-path -");
    }
  });
});

describe("scannerCommand — betterleaks HTTP-validation forced OFF (W-065 / W-058)", () => {
  // betterleaks validation is OFF by default and only enabled by `--validation`
  // (docs/config.md). Guardian is read-only + non-network, so the backend argv
  // must NEVER carry the enable flag(s). These pin the offline invariant.
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("betterleaks argv never contains --validation nor --validation-env-vars (+1 folded case)", () => {
    // case: betterleaks argv never contains --validation nor --validation-env-vars
    {
      for (const opts of [
        { subcommand: "dir" as const, target: "." },
        { subcommand: "git" as const, target: ".", range: "a...b" },
        { subcommand: "dir" as const, target: "some/very/deep/path" },
      ]) {
        const argv = scannerCommand("betterleaks", opts);
        for (const bad of FORBIDDEN_NETWORK_FLAGS) expect(argv).not.toContain(bad);
        expect(argv.join(" ")).not.toContain("--validation");
      }
    }
    // case: the forbidden-network-flag list is the enable flags, not a disable flag
    {
      // Documents the enforcement shape: there is no --no-validation; we withhold
      // the enable flags. If this list ever shrinks, the guard below still fires.
      expect([...FORBIDDEN_NETWORK_FLAGS]).toEqual(["--validation", "--validation-env-vars"]);
    }
  });
});

describe("normalizeScannerReport — one schema, redacted", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("maps PascalCase (gitleaks/betterleaks JSON) findings, dropping the value (+2 folded cases)", () => {
    // case: maps PascalCase (gitleaks/betterleaks JSON) findings, dropping the value
    {
      const raw = JSON.stringify([
        { RuleID: "aws-access-key", File: "src/a.ts", StartLine: 12, Secret: "AKIAIOSFODNN7EXAMPLE", Match: "key=AKIA..." },
      ]);
      const out = normalizeScannerReport(raw);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        file: "src/a.ts",
        line: 12,
        rule: "aws-access-key",
        severity: "unknown",
        redacted_pointer: "src/a.ts:12 [aws-access-key]",
      });
      // REDACTION INVARIANT: the matched value never survives normalization.
      expect(JSON.stringify(out)).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(JSON.stringify(out)).not.toContain("key=AKIA");
    }
    // case: reads camelCase field variants too
    {
      const raw = JSON.stringify([{ ruleID: "generic", file: "x.env", startLine: 3, severity: "high" }]);
      expect(normalizeScannerReport(raw)[0]).toEqual({
        file: "x.env",
        line: 3,
        rule: "generic",
        severity: "high",
        redacted_pointer: "x.env:3 [generic]",
      });
    }
    // case: tolerates junk: non-array, bad JSON, and value-less rows
    {
      expect(normalizeScannerReport("not json")).toEqual([]);
      expect(normalizeScannerReport(JSON.stringify({ not: "an array" }))).toEqual([]);
      expect(normalizeScannerReport(JSON.stringify([null, 5, { RuleID: "no-file" }]))).toEqual([]);
    }
  });
});

describe("common schema — both backends are comparable", () => {
  test("an in-process gitleaks Finding projects onto the same NormalizedSecretMatch", () => {
    const d = scan(registries(), input({ lines: [{ file: "src/a.ts", line: 4, text: "const k = SEKRIT-1234" }] }));
    const norm = toNormalizedSecretMatch(d.findings[0]);
    expect(norm).toEqual({
      file: "src/a.ts",
      line: 4,
      rule: "fake-secret",
      severity: "critical",
      redacted_pointer: "src/a.ts:4 [fake-secret]",
    });
    expect(JSON.stringify(norm)).not.toContain("SEKRIT-1234");
  });
});

describe("scan — records the secret backend provenance", () => {
  // W-677: the 2 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("defaults to gitleaks when no backend is supplied (+1 folded case)", () => {
    // case: defaults to gitleaks when no backend is supplied
    {
      const d = scan(registries(), input({ lines: [] }));
      expect(d.scope.secret_backend).toBe("gitleaks");
    }
    // case: carries the selected backend through to the draft scope
    {
      const d = scan(registries(), input({ lines: [], scannerBackend: "betterleaks" }));
      expect(d.scope.secret_backend).toBe("betterleaks");
    }
  });
});
