// CI guard that keeps the Status Web's per-role assumptions (role_contracts.ts)
// from drifting out of sync with the canonical role skills + the driver. This is
// the systemic recurrence-prevention for the class of bug where the status
// snapshot quietly assumes a convention a role doesn't actually follow and the
// divergence only surfaces as a bogus warning a human has to catch:
//
//   • "guardian guardian-01: REPORTING without report.md" — Guardian writes
//     guardian_report.md, not report.md;
//   • a rate_limited_cleared recovery event shown as an ACTIVE rate limit.
//
// If a role renames its report file, or a new role is added to setup_config, or
// the driver renames a rate-limit event, one of these tests fails instead of the
// console lying.

import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WORKTREE_ROLE_KINDS, ROLE_REPORT_ARTIFACT, ROLE_SKILL_DIR,
  CONFIG_ARRAY_KIND, RATE_LIMIT_EVENTS, reportArtifact, type RoleKind,
} from "./role_contracts.ts";
import { buildSnapshot } from "./status_snapshot.ts";
import { loadConfig } from "./config.ts";

const SKILLS = join(import.meta.dir, "..", "..", "..");                 // repo/skills
const TEMPLATES = join(import.meta.dir, "..", "..", "templates");       // garelier-core/templates
const skillFile = (kind: RoleKind) => join(SKILLS, ROLE_SKILL_DIR[kind], "SKILL.md");

// The report filename(s) a skill names immediately after a write/emit/produce
// verb — i.e. the file the role is instructed to WRITE, distinct from a template
// reference like "(`templates/observer_report.md`)" which is the format, not the
// write target.
function writeTargets(skill: string): string[] {
  const re = /(?:write|writes|emit|emits|produce|produces|create|creates)\s+`?([a-z_]*report\.md)`?/gi;
  return [...skill.matchAll(re)].map((m) => m[1].toLowerCase());
}

describe("role_contracts: report artifact is grounded in each role's skill", () => {
  for (const kind of WORKTREE_ROLE_KINDS) {
    test(`${kind}: SoT artifact matches the skill's write instruction`, () => {
      const f = skillFile(kind);
      expect(existsSync(f)).toBe(true);
      const skill = readFileSync(f, "utf8");
      const artifact = ROLE_REPORT_ARTIFACT[kind];

      // (a) grounding: the SoT artifact is actually named in the skill (catches
      //     a typo'd SoT entry).
      expect(skill).toContain(artifact);

      // (b) anti-drift: every role-PREFIXED report write-target the skill names
      //     must equal the SoT artifact. This is exactly the Guardian/Concierge
      //     deviation — the old "report.md for everyone" assumption would fail
      //     here because Guardian's write target is `guardian_report.md`.
      const prefixed = writeTargets(skill).filter((t) => /_report\.md$/.test(t));
      for (const t of prefixed) expect(t).toBe(artifact);

      // (c) if the SoT artifact is itself role-prefixed, the skill must instruct
      //     writing it (so the SoT can't claim a prefixed name the role doesn't).
      if (/_report\.md$/.test(artifact)) {
        expect(writeTargets(skill)).toContain(artifact);
      }
    });
  }
});

describe("role_contracts: every provisionable role is handled by the status layer", () => {
  test("every setup_config [[role]] array maps to a known worktree role kind", () => {
    const cfg = readFileSync(join(TEMPLATES, "setup_config.toml"), "utf8");
    const arrayKeys = new Set(
      [...cfg.matchAll(/^\s*\[\[(\w+)\]\]/gm)].map((m) => m[1]),
    );
    expect(arrayKeys.size).toBeGreaterThan(0);
    // Every double-bracket array in the template is a role array today; if a
    // non-role one is ever added, register it here deliberately.
    for (const key of arrayKeys) {
      const kind = CONFIG_ARRAY_KIND[key];
      expect(kind).toBeDefined();                          // unknown [[key]] → fail
      expect(WORKTREE_ROLE_KINDS).toContain(kind);
      expect(ROLE_REPORT_ARTIFACT[kind]).toBeTruthy();
    }
    // …and every worktree role kind is reachable from a config array (no kind
    // the status layer guards that the wizard can't actually create).
    const mapped = new Set(Object.values(CONFIG_ARRAY_KIND));
    for (const kind of WORKTREE_ROLE_KINDS) expect(mapped.has(kind)).toBe(true);
  });

  test("every worktree role kind has an artifact and an existing skill", () => {
    for (const kind of WORKTREE_ROLE_KINDS) {
      expect(reportArtifact(kind)).toBeTruthy();
      expect(existsSync(skillFile(kind))).toBe(true);
    }
  });
});

describe("role_contracts: rate-limit event classification", () => {
  // The driver emitter was deleted under DEC-066 (dispatch-only); the
  // classification itself is still consumed by the Status Web snapshot.
  test("the recovery event is classified cleared (not active)", () => {
    expect(RATE_LIMIT_EVENTS.cleared).toContain("rate_limited_cleared");
    expect(RATE_LIMIT_EVENTS.active as readonly string[]).not.toContain("rate_limited_cleared");
  });
});

describe("role_contracts: no false REPORTING-without-report for any role", () => {
  const roots: string[] = [];
  afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function roleProject(kind: RoleKind, withArtifact: boolean) {
    const plural = `${kind}s`;
    const root = mkdtempSync(join(tmpdir(), "rc-")); roots.push(root);
    const pm = join(root, "__garelier", "pm");
    mkdirSync(join(pm, "_pm"), { recursive: true });
    writeFileSync(join(pm, "_pm", "setup_config.toml"),
      `[project]\nname = "X"\ngarelier_version = "2.7.1"\n\n` +
      `[branches]\ntarget = "main"\ntarget_slug = "main"\nintegration = "garelier/main/pm/studio"\n\n` +
      `[[${plural}]]\nid = "r1"\nprovider = "claude-code"\nenabled = true\n`, "utf8");
    const c = join(pm, `_${plural}`, "r1");
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "STATE.md"), `# ${kind} r1\n\n## Status\nREPORTING\n\n## Last activity\nnow\n`, "utf8");
    if (withArtifact) writeFileSync(join(c, ROLE_REPORT_ARTIFACT[kind]), "ok\n", "utf8");
    mkdirSync(join(pm, "runtime", "merge_gate", "results"), { recursive: true });
    return { root, config: loadConfig(root, "pm") };
  }

  for (const kind of WORKTREE_ROLE_KINDS) {
    test(`${kind} REPORTING with ${ROLE_REPORT_ARTIFACT[kind]} → no warning`, () => {
      const { root, config } = roleProject(kind, true);
      const r = buildSnapshot(root, "pm", config).roles.find((x) => x.kind === kind);
      expect(r?.state).toBe("REPORTING");
      expect(r?.warnings ?? []).toHaveLength(0);
    });
    test(`${kind} REPORTING without its artifact → warning names ${ROLE_REPORT_ARTIFACT[kind]}`, () => {
      const { root, config } = roleProject(kind, false);
      const r = buildSnapshot(root, "pm", config).roles.find((x) => x.kind === kind);
      expect(r?.warnings.some((m) => m.includes(ROLE_REPORT_ARTIFACT[kind]))).toBe(true);
    });
  }
});
