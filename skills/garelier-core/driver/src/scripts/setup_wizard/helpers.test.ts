// W-083 ts-first: parity tests for the shared-helper modules ported in lane d2
// (ignores trim/write, showcase/gallery scaffolder). The heredoc byte content is
// additionally covered end-to-end by the fresh byte-diff oracle; here we pin the
// awk-derived trim logic and the scaffolder's file set.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trimLegacyRootBlock, writeNestedIgnores } from "./ignores.ts";
import { writeShowcaseGallery } from "./showcase.ts";

let temp = "";
let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("trimLegacyRootBlock (garelier_trim_legacy_root_block parity)", () => {
  test("removes the contiguous block, preserving a trailing user section", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-trim-"));
    const file = join(temp, ".gitignore");
    writeFileSync(
      file,
      [
        "# my own rules",
        "node_modules/",
        "",
        "# Garelier runtime (DEC-051 legacy block)",
        "__garelier/",
        "*/runtime/",
        "*/_workers/",
        "/STATE.md",
        "*.bak",
        "",
        "# Build cache",
        "dist/",
        "",
      ].join("\n"),
    );
    trimLegacyRootBlock(file, "Garelier runtime");
    // The block-internal blank + "# Build cache" header are flushed back as the
    // next section's lead-in (matches the bash awk), so two blanks survive.
    expect(readFileSync(file, "utf8")).toBe(
      ["# my own rules", "node_modules/", "", "", "# Build cache", "dist/", ""].join("\n"),
    );
  });

  test("deletes a file Garelier created (block only) to restore a pristine root", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-trim-"));
    const file = join(temp, ".ignore");
    writeFileSync(file, ["# Garelier search-ignore", "__garelier/", "*/runtime/", ""].join("\n"));
    trimLegacyRootBlock(file, "Garelier search-ignore");
    expect(existsSync(file)).toBe(false);
  });

  test("no-op when the marker is absent", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-trim-"));
    const file = join(temp, ".gitignore");
    const body = ["node_modules/", "dist/", ""].join("\n");
    writeFileSync(file, body);
    trimLegacyRootBlock(file, "Garelier runtime");
    expect(readFileSync(file, "utf8")).toBe(body);
  });
});

describe("writeShowcaseGallery (garelier_write_showcase_gallery parity)", () => {
  test("scaffolds showcase/ + gallery/ with the expected file set", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-showcase-"));
    const pmRoot = join(temp, "__garelier", "pm1");
    writeShowcaseGallery(pmRoot);
    for (const rel of [
      "showcase/README.md",
      "gallery/README.md",
      "gallery/.gitattributes",
      "gallery/.gitkeep",
    ]) {
      expect(existsSync(join(pmRoot, rel))).toBe(true);
    }
    // Heredocs always leave a final newline.
    expect(readFileSync(join(pmRoot, "showcase/README.md"), "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(join(pmRoot, "gallery/README.md"), "utf8").startsWith("# gallery/")).toBe(true);
    expect(readFileSync(join(pmRoot, "gallery/.gitkeep"), "utf8")).toBe("");
    // Idempotent second call preserves an edited README (create-if-absent).
    writeFileSync(join(pmRoot, "showcase/README.md"), "edited\n");
    writeShowcaseGallery(pmRoot);
    expect(readFileSync(join(pmRoot, "showcase/README.md"), "utf8")).toBe("edited\n");
  });
});

describe("writeNestedIgnores (garelier_write_nested_ignores parity)", () => {
  test("copies the templates into __garelier/ and trims the legacy root block", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-nested-"));
    const tdir = join(temp, "templates");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "runtime_gitignore"), "GITIGNORE-TEMPLATE\n");
    writeFileSync(join(tdir, "search_ignore"), "SEARCH-IGNORE-TEMPLATE\n");
    prevCwd = process.cwd();
    process.chdir(temp);
    // A pre-DEC-051 legacy block appended to the root .gitignore is migrated away.
    writeFileSync(join(temp, ".gitignore"), ["keep/", "# Garelier runtime", "__garelier/", ""].join("\n"));

    const prevEnv = process.env.GARELIER_CORE_TEMPLATES_DIR;
    process.env.GARELIER_CORE_TEMPLATES_DIR = tdir;
    try {
      writeNestedIgnores({ skillsDir: "/unused", driverDir: "/unused" });
    } finally {
      if (prevEnv === undefined) delete process.env.GARELIER_CORE_TEMPLATES_DIR;
      else process.env.GARELIER_CORE_TEMPLATES_DIR = prevEnv;
    }
    expect(readFileSync(join(temp, "__garelier/.gitignore"), "utf8")).toBe("GITIGNORE-TEMPLATE\n");
    expect(readFileSync(join(temp, "__garelier/.ignore"), "utf8")).toBe("SEARCH-IGNORE-TEMPLATE\n");
    expect(readFileSync(join(temp, ".gitignore"), "utf8")).toBe("keep/\n");
  });
});
