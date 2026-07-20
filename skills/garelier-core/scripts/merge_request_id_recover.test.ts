import { expect, test } from "bun:test";
import { runShellOracle } from "../driver/src/scripts/shell_oracle_test_runner.ts";

// W-111: Bun registers this parity oracle. Its existing shell assertions remain
// verbatim while every Garelier CLI under test is invoked directly with Bun.
const shellScript = [
  "#!/usr/bin/env bash",
  "# Tests for merge_request_id_recover.ts (W-064).",
  "set -euo pipefail",
  "SELF_DIR=\"$(cd \"$(dirname \"$0\")\" && pwd -P)\"",
  "SUT=\"$SELF_DIR/../driver/src/scripts/merge_request_id_recover.ts\"",
  "TMP=\"$(mktemp -d)\"",
  "trap 'rm -rf \"$TMP\"' EXIT",
  "fail=0",
  "ok()   { echo \"  ok: $1\"; }",
  "bad()  { echo \"  FAIL: $1\" >&2; fail=1; }",
  "",
  "REQ_DIR=\"$TMP/requests\"; mkdir -p \"$REQ_DIR\"",
  "RID=\"20260714-085500-W-064test\"",
  "printf '{\"request_id\":\"%s\",\"branch\":\"b\"}\\n' \"$RID\" > \"$REQ_DIR/$RID.json\"",
  "",
  "# 1. stderr \"wrote <path>\" evidence → id from file content",
  "ERR1=\"$TMP/err1\"; printf 'merge_request: wrote %s\\n' \"$REQ_DIR/$RID.json\" > \"$ERR1\"",
  "got=\"$(bun \"$SUT\" --stderr-file \"$ERR1\" --requests-dir \"$REQ_DIR\" --since 0)\"",
  "[ \"$got\" = \"$RID\" ] && ok \"stderr-path recovery\" || bad \"stderr-path recovery: got '$got'\"",
  "",
  "# 2. no stderr line → newest-file recovery (since <= mtime)",
  "ERR2=\"$TMP/err2\"; printf 'merge_request: unrelated log\\n' > \"$ERR2\"",
  "got=\"$(bun \"$SUT\" --stderr-file \"$ERR2\" --requests-dir \"$REQ_DIR\" --since 0)\"",
  "[ \"$got\" = \"$RID\" ] && ok \"newest-file recovery\" || bad \"newest-file recovery: got '$got'\"",
  "",
  "# 3. stale guard: since far in the future → no recovery, exit 1",
  "if bun \"$SUT\" --stderr-file \"$ERR2\" --requests-dir \"$REQ_DIR\" --since 99999999999 >/dev/null 2>&1; then",
  "  bad \"stale guard should have refused a too-old request file\"",
  "else",
  "  ok \"stale guard refuses older-than-since files\"",
  "fi",
  "",
  "# 4. request file without request_id field → basename fallback",
  "RID2=\"20260714-085501-W-064basename\"",
  "printf '{\"branch\":\"b\"}\\n' > \"$REQ_DIR/$RID2.json\"",
  "touch \"$REQ_DIR/$RID2.json\"",
  "ERR4=\"$TMP/err4\"; printf 'merge_request: wrote %s\\n' \"$REQ_DIR/$RID2.json\" > \"$ERR4\"",
  "got=\"$(bun \"$SUT\" --stderr-file \"$ERR4\" --requests-dir \"$REQ_DIR\" --since 0)\"",
  "[ \"$got\" = \"$RID2\" ] && ok \"basename fallback\" || bad \"basename fallback: got '$got'\"",
  "",
  "# 5. relative logged path that doesn't resolve → basename retry against requests dir",
  "ERR5=\"$TMP/err5\"; printf 'merge_request: wrote ./nonexistent/relative/%s.json\\n' \"$RID\" > \"$ERR5\"",
  "got=\"$(bun \"$SUT\" --stderr-file \"$ERR5\" --requests-dir \"$REQ_DIR\" --since 0)\"",
  "[ \"$got\" = \"$RID\" ] && ok \"relative-path basename retry\" || bad \"relative-path basename retry: got '$got'\"",
  "",
  "[ \"$fail\" -eq 0 ] && echo \"merge_request_id_recover.test.ts: ALL PASS\" || { echo \"merge_request_id_recover.test.ts: FAILURES\" >&2; exit 1; }",
].join("\n") + "\n";

test("merge_request_id_recover shell parity oracle", () => {
  const result = runShellOracle(shellScript, import.meta.path);
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  expect(result.exitCode, stdout + stderr).toBe(0);
}, 240_000);
