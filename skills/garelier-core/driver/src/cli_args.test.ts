import { describe, expect, test } from "bun:test";
import { arg, boolFlag, numArg, wantsHelp } from "./cli_args.ts";

// argv shape matches process.argv (node/bun prepend runtime + script path).
const av = (...rest: string[]) => ["bun", "tool.ts", ...rest];

describe("arg", () => {
  test("parses the --name value (space) form", () => {
    expect(arg("pm-id", av("--pm-id", "acme"))).toBe("acme");
  });

  test("parses the --name=value form (the silent-drop bug)", () => {
    expect(arg("pm-id", av("--pm-id=acme"))).toBe("acme");
  });

  test("--name= yields empty string, not undefined", () => {
    expect(arg("pm-id", av("--pm-id="))).toBe("");
  });

  test("value containing '=' keeps everything after the first '='", () => {
    expect(arg("filter", av("--filter=a=b"))).toBe("a=b");
  });

  test("absent flag is undefined", () => {
    expect(arg("pm-id", av("--project", "."))).toBeUndefined();
  });

  test("first occurrence wins, mixing both forms", () => {
    expect(arg("format", av("--format", "text", "--format=json"))).toBe("text");
    expect(arg("format", av("--format=json", "--format", "text"))).toBe("json");
  });
});

describe("numArg", () => {
  test("reads --name=value numbers", () => {
    expect(numArg("poll-ms", 100, av("--poll-ms=250"))).toBe(250);
  });
  test("falls back to default when absent or non-finite", () => {
    expect(numArg("poll-ms", 100, av())).toBe(100);
    expect(numArg("poll-ms", 100, av("--poll-ms", "abc"))).toBe(100);
  });
});

describe("boolFlag", () => {
  test("detects the bare flag and the stray =form", () => {
    expect(boolFlag("all-pms", av("--all-pms"))).toBe(true);
    expect(boolFlag("all-pms", av("--all-pms=1"))).toBe(true);
    expect(boolFlag("all-pms", av("--project", "."))).toBe(false);
  });
});

describe("wantsHelp", () => {
  test("matches -h and --help", () => {
    expect(wantsHelp(av("-h"))).toBe(true);
    expect(wantsHelp(av("--help"))).toBe(true);
    expect(wantsHelp(av("--pm-id", "x"))).toBe(false);
  });
});
