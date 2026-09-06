// gate_seat_commands.ts — W-353: carry the project's policy-mandatory SECRET
// scanner into the gate seat's permission record.
//
// THE GAP THIS CLOSES. `[guardian_tools]` names the scanners a Guardian/Observer
// gate MUST run, and `[guardian_policy].block_when_required_scanner_unavailable`
// makes a missing mandatory scanner a BLOCK. But until this module, only
// `scanner_backend` was ever machine-read (guardian_scan.ts resolveScannerBackend)
// — the command strings themselves were parsed by NOTHING, and dispatch_prepare
// wrote every gate record with an EMPTY `quality_gate_commands`. The gate profile
// is fail-closed (`unknown: "deny"`, no in-fence relaxation), so a mandatory
// command that matched no preset was denied `profile_unknown` at the seat: policy
// said "you must run it", the seat could not. A consuming project hit this on
// four consecutive gates (2026-08-03) and its PM ran every scanner by hand.
//
// SCOPE: THE SECRET SCANNER ONLY (PM ruling, W-353 F3). An earlier revision also
// transcribed `pii_scan` / `dependency_scan` / `license_scan` / `sast_scan`
// VERBATIM. That was withdrawn, and the reasoning is worth keeping because it
// governs any future attempt to widen this module:
//
//   * Those four have no canonical form, so they could only be copied as written
//     — an arbitrary head (`node -e …`, `bun /abs/x.ts`) landing in the seat's
//     authorized list with only `trim()` + a disabled-value check between the
//     config and execution. The deny floor still outranks it, but the floor is
//     not an allowlist of safe heads.
//   * `setup_config.toml` is GIT-TRACKED, so such a value reaches the seat
//     through the ordinary role -> merge path.
//   * The "this removes hand-typing, not checks" defence was too weak: the
//     hand-typing WAS a per-spawn human check. Replacing it with a repo-tracked,
//     permanent, automatically-applied source is a DIFFERENT trust model, not
//     the same one mechanized.
//
// The secret scanner is exempt from that reasoning because it is not copied at
// all: it is REBUILT from `scannerCommand()` below, and command_guard
// additionally forces the canonical grammar and binds execution to the reviewed
// worktree. Narrowing the four rather than deleting them was rejected too — a
// partially-narrowed transcription is a second allowlist whose denominator drifts
// from the deny floor. Deleting the surface leaves nothing to drift. Their trust
// design is a separate row.
//
// WHY A CANONICAL RE-RENDER, NOT A VERBATIM COPY.
// `declaredCommandStaysHermetic` (command_guard.ts) rejects ANY gitleaks
// invocation that is not `isCanonicalGitleaksInvocation` — the W-297 exact
// ordered grammar. A project whose config predates that grammar (the observed
// one carried `gitleaks dir --no-banner --redact .`) therefore stays denied even
// when its own string is transcribed verbatim. So the entry is REBUILT from
// `scannerCommand()` — the same builder guardian_scan and the preset grammar
// derive from — and the configured spelling is reported as `drift` rather than
// silently rewritten or silently dropped.

import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { resolveScannerBackend, scannerCommand } from "../guardian_scan.ts";
import { crewSubdirFromPmRoot } from "../workspace.ts";

/** The ONE `[guardian_tools]` key this module reads. Deliberately a single
 * constant, not a list: see the SCOPE note above — widening it needs the
 * trust-model argument re-made, not just another array entry. */
export const GUARDIAN_TOOL_SECRET_KEY = "secret_scan" as const;

/** Spellings that mean "this scanner is deliberately off" (degraded mode, see
 * scanner-and-gates.md § Degraded secret-scan mode). They declare nothing. */
const DISABLED_VALUES = new Set(["off", "none", "disabled", "false", "-"]);

export interface GateSeatCommands {
  /** Verbatim commands to write into the record's `quality_gate_commands`. */
  commands: string[];
  /** Operator-facing notes: a configured spelling that is NOT what the seat was
   * authorized to run, or a config that could not be read. Never fatal — a gate
   * seat with no resolvable config simply declares nothing and keeps today's
   * preset-only reach. */
  drift: string[];
  /** The setup_config.toml consulted, or null when none was found. */
  configPath: string | null;
}

const EMPTY: GateSeatCommands = { commands: [], drift: [], configPath: null };

/** Canonical `<pmRoot>/_crew/pm/setup_config.toml`. */
export function setupConfigPathFor(pmRoot: string): string {
  return `${crewSubdirFromPmRoot(pmRoot, "pm")}/setup_config.toml`;
}

/** Resolve the declared verify commands for a gate seat from a PM control root
 * (`<project>/__garelier/<pmId>`). Never throws: an unreadable or absent config
 * yields an empty declaration plus a drift note. */
export function resolveGateSeatCommands(pmRoot: string): GateSeatCommands {
  const configPath = setupConfigPathFor(pmRoot);
  if (!existsSync(configPath)) return { ...EMPTY, drift: [`no setup_config.toml at ${configPath}; the gate seat declares no scanner command`] };

  let config: Record<string, unknown>;
  try {
    config = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { commands: [], configPath, drift: [`cannot parse ${configPath} (${String(error)}); the gate seat declares no scanner command`] };
  }

  const raw = config.guardian_tools;
  if (!raw || typeof raw !== "object") return { commands: [], configPath, drift: [] };
  const tools = raw as Record<string, unknown>;

  const rawSecret = tools[GUARDIAN_TOOL_SECRET_KEY];
  const configured = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (!configured || DISABLED_VALUES.has(configured.toLowerCase())) {
    return { commands: [], configPath, drift: [] };
  }

  const backend = resolveScannerBackend(config);
  const canonical = scannerCommand(backend, { subcommand: "dir", target: "." }).join(" ");
  const drift: string[] = [];
  if (configured !== canonical) {
    drift.push(
      `[guardian_tools].secret_scan is '${configured}' but the ${backend} canonical argv is '${canonical}'. ` +
      "The seat is authorized for the canonical form (the guard rejects any other gitleaks spelling); " +
      "update setup_config.toml so the policy text and the runnable command agree.",
    );
  }

  // A delta secret scan (`… git . … --log-opts <base>...<head>`) carries a range
  // that only exists at gate time, so it cannot be pre-rendered into a verbatim
  // declaration. gitleaks reaches it through the `gitleaks-readonly` preset,
  // which accepts any range; betterleaks has no preset, so a betterleaks delta
  // scan still needs an explicit PM `--quality-gate` entry. Stated rather than
  // silently left as a surprise at the seat.
  if (backend === "betterleaks") {
    drift.push(
      "backend is betterleaks: only the whole-tree `dir` form is pre-declarable. " +
      "A delta (`git … --log-opts <base>...<head>`) scan needs an explicit attended_record --quality-gate entry.",
    );
  }

  return { commands: [canonical], drift, configPath };
}
