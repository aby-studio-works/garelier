// Shared CLI argument parsing for driver tools (W-064 #18+#19).
//
// Before this, ~7 driver tools each defined the same
//   const i = process.argv.indexOf(`--${name}`); return argv[i + 1];
// which silently dropped `--name=value`: indexOf never matches the `=` form, so
// a required flag errored as "missing" and an optional flag took its default
// with no warning — a silent-misconfiguration class. This helper accepts BOTH
// `--name value` and `--name=value`, and adds a `-h`/`--help` short-circuit
// (previously only status_web.ts had one).

// Value of a `--name value` or `--name=value` flag; undefined if absent. The
// space form returns the next token verbatim (exactly the pre-existing per-tool
// `arg()` behavior) — this helper only ADDS the `=` form, it does not change how
// `--name value` was parsed.
export function arg(name: string, argv: string[] = process.argv): string | undefined {
  const long = `--${name}`;
  const eq = `${long}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === long) return argv[i + 1];
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

// Numeric flag with a default; non-finite or absent values fall back to `def`.
export function numArg(name: string, def: number, argv: string[] = process.argv): number {
  const v = arg(name, argv);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// Presence of a boolean `--name` flag (also matches a stray `--name=...`).
export function boolFlag(name: string, argv: string[] = process.argv): boolean {
  const long = `--${name}`;
  return argv.includes(long) || argv.some((a) => a.startsWith(`${long}=`));
}

export function wantsHelp(argv: string[] = process.argv): boolean {
  return argv.includes("-h") || argv.includes("--help");
}

// Print `usage` and exit 0 when -h/--help is present. Call at the top of main()
// so `<tool> --help` documents its flags instead of running with defaults.
export function printHelpAndExitIfRequested(usage: string, argv: string[] = process.argv): void {
  if (wantsHelp(argv)) {
    process.stdout.write(usage.endsWith("\n") ? usage : `${usage}\n`);
    process.exit(0);
  }
}
