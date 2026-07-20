import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBash } from "./scripts/_lib.ts";

// W-054: dispatch_prepare.ts must accept a glob-shaped --touches value (e.g.
// "docs/**") when it is passed as a single argument, even from a cwd that
// contains matching paths — the script's own expansions are all quoted. And
// when a caller leaves the glob UNQUOTED so the shell pre-expands it into stray
// positionals, the failure must carry an actionable quoting hint (not just the
// cryptic "unknown arg: docs/engine").

const DP = join(import.meta.dir, "scripts", "dispatch_prepare.ts");
const T = 60_000; // spawns bash subprocesses; robust under load

let cwd: string;
afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } }, T);

function projectWithDocs(): string {
  cwd = mkdtempSync(join(tmpdir(), "garelier-dp-"));
  for (const d of ["docs/engine", "docs/main", "docs/mvp"]) mkdirSync(join(cwd, d), { recursive: true });
  return cwd;
}

describe("dispatch_prepare.ts --touches glob quoting (W-054)", () => {
  test("a SINGLE-quoted glob value survives the shell and is accepted (not mis-parsed)", () => {
    const dir = projectWithDocs();
    // The real invocation path is a shell command string (the Bash tool / a
    // dispatch command). A single-quoted 'docs/**' must reach the script intact
    // even from a cwd full of matching paths — the script never re-expands it.
    const cmd = `bun '${DP}' --project '${dir}' --pm-id p --role worker --slug s --touches 'docs/**'`;
    const r = runBash(["-c", cmd], { cwd: dir });
    // It fails later (no setup_config / --base) but MUST get past arg parsing:
    expect(r.stderr).not.toContain("unknown arg");
  }, T);

  test("an UNQUOTED glob (shell pre-expands it) fails with the W-054 quoting hint", () => {
    const dir = projectWithDocs();
    // Run through a real shell with the value left unquoted, from a cwd with
    // docs/* — the shell expands docs/** into multiple words before the script.
    const cmd = `bun '${DP}' --project '${dir}' --pm-id p --role worker --slug s --touches docs/**`;
    const r = runBash(["-c", cmd], { cwd: dir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown arg");
    expect(r.stderr).toContain("W-054");
    expect(r.stderr.toLowerCase()).toContain("single-quote");
  }, T);
});
