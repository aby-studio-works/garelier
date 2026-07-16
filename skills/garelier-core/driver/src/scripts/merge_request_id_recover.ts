import { basename, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { die, valueAfter } from "./_lib.ts";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let stderrFile = "";
  let requestsDir = "";
  let since = 0;
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--stderr-file": stderrFile = valueAfter(argv, i); i += 2; break;
      case "--requests-dir": requestsDir = valueAfter(argv, i); i += 2; break;
      case "--since": since = Number(valueAfter(argv, i)); i += 2; break;
      default: die(`merge_request_id_recover: unknown arg: ${argv[i]}`);
    }
  }

  let requestFile = "";
  if (stderrFile && existsSync(stderrFile)) {
    const matches = [...readFileSync(stderrFile, "utf8").matchAll(/wrote ([^\s]+\.json)/g)];
    requestFile = matches.at(-1)?.[1] ?? "";
    if (requestFile && !existsSync(requestFile) && requestsDir) {
      const retry = join(requestsDir, basename(requestFile));
      requestFile = existsSync(retry) ? retry : "";
    }
    if (requestFile && !existsSync(requestFile)) requestFile = "";
  }

  let requestsIsDir = false;
  try { requestsIsDir = statSync(requestsDir).isDirectory(); } catch { /* absent */ }
  if (!requestFile && requestsDir && requestsIsDir) {
    let newestMtime = -1;
    for (const name of readdirSync(requestsDir).filter((x) => x.endsWith(".json")).sort()) {
      const path = join(requestsDir, name);
      let mtime = 0;
      try { mtime = Math.floor(statSync(path).mtimeMs / 1000); } catch { continue; }
      if (mtime >= since && mtime > newestMtime) {
        requestFile = path;
        newestMtime = mtime;
      }
    }
  }
  if (!requestFile || !existsSync(requestFile)) return 1;

  let requestId = "";
  try {
    requestId = String((JSON.parse(readFileSync(requestFile, "utf8")) as { request_id?: unknown }).request_id ?? "");
  } catch { /* basename fallback */ }
  if (!requestId) requestId = basename(requestFile, ".json");
  if (!requestId) return 1;
  process.stdout.write(`${requestId}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main());
