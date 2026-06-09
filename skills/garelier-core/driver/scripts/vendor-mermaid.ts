// One-time vendoring of Mermaid for OFFLINE diagram rendering in the status
// web console. Run once, with network:  bun run vendor:mermaid
//
// Why this is a separate, opt-in step (not committed to the repo):
//   Mermaid itself is MIT, but its all-in-one UMD bundle inlines elkjs
//   (EPL-2.0 — weak copyleft) plus other deps, and a minified blob carries
//   attribution duties if redistributed. So the downloaded file is gitignored
//   and stays local to whoever runs this. At runtime the status server serves
//   it from static/vendor/ (no CDN); without it, ```mermaid blocks remain
//   readable as diagram source. See docs/web_console.md.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

async function main(): Promise<void> {
  const version = process.env.MERMAID_VERSION ?? "11";
  const url = `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`;
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "vendor");
  const out = join(outDir, "mermaid.min.js");

  console.log(`Fetching mermaid@${version} UMD bundle (one-time, needs network)…`);
  const r = await fetch(url);
  if (!r.ok) {
    console.error(`Failed: HTTP ${r.status} for ${url}`);
    process.exit(1);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  mkdirSync(outDir, { recursive: true });
  await Bun.write(out, buf);
  console.log(`Wrote ${out} (${(buf.length / 1024 / 1024).toFixed(2)} MB).`);
  console.log("It is gitignored (bundles elkjs EPL-2.0). The status console now");
  console.log("renders Mermaid diagrams offline; no CDN is used at runtime.");
}

void main();
