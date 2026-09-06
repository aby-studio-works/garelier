import { test, expect } from "bun:test";
import { filterIdentityScrubHits } from "./identity_scrub_lint.ts";

// W-310: the detective must flag a reintroduced developer-private identifier
// in a published file (the RED fixture) while leaving the export gate's own
// self-excluded spelling of the same deny term alone.
//
// W-310 rework (Guardian BLOCK B1): every fixture below that would otherwise
// spell the deny term is built by concatenation instead — a literal spelling
// here made this file's own commit fail the very lint it tests (SELF_EXCLUDE
// only covers identity_scrub_lint.ts and make-public-export.ts, and this
// .test.ts file does not start with either of those paths). Same technique
// _lib.ts's PRIVATE_IDENTIFIER_DENY_PATTERN uses for its own source text.
const DEV_HANDLE = ["ri", "fu"].join("");

test("RED: an actual leaked term survives the filter", () => {
  const grepOutput = `skills/garelier-core/driver/src/scripts/spawn_env.test.ts:62:${DEV_HANDLE} shows up here\n`;
  expect(filterIdentityScrubHits(grepOutput)).toEqual([
    `skills/garelier-core/driver/src/scripts/spawn_env.test.ts:62:${DEV_HANDLE} shows up here`,
  ]);
});

test("GREEN: the export gate's own self-excluded spelling is exempt", () => {
  const grepOutput = [
    `skills/garelier-core/driver/src/scripts/make-public-export.ts:165:    const builtinPattern = PRIVATE_IDENTIFIER_DENY_PATTERN; // spells ${DEV_HANDLE}`,
    `skills/garelier-core/driver/src/scripts/identity_scrub_lint.ts:20:const DENY_PATTERN = PRIVATE_IDENTIFIER_DENY_PATTERN; // spells ${DEV_HANDLE}`,
  ].join("\n");
  expect(filterIdentityScrubHits(grepOutput)).toEqual([]);
});

test("backslash-separated self-excluded paths are also normalized", () => {
  const grepOutput = `skills\\garelier-core\\driver\\src\\scripts\\make-public-export.ts:1:${DEV_HANDLE}\n`;
  expect(filterIdentityScrubHits(grepOutput)).toEqual([]);
});

test("empty / blank input yields no findings", () => {
  expect(filterIdentityScrubHits("")).toEqual([]);
  expect(filterIdentityScrubHits("\n  \n")).toEqual([]);
});
