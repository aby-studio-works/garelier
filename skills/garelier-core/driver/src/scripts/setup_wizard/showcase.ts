// W-083 ts-first: setup_wizard showcase/ + gallery/ scaffolder.
//
// Faithful port of garelier_write_showcase_gallery from setup_wizard.ts (lines
// 717-766). Idempotent; called from fresh setup. Arg is the PM root
// (__garelier/<pm_id>). READMEs / .gitattributes are byte-for-byte the heredocs;
// built from line arrays to keep the many backticks literal without escaping.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// Heredoc body + trailing newline (heredocs always leave a final newline).
function heredoc(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

const SHOWCASE_README = heredoc([
  "# showcase/ — user-facing deliverable drop-zone (NOT committed)",
  "",
  "Gitignored (`*/showcase/`). The DEFAULT home for role output meant for the",
  "user but with no fixed destination yet: screenshots, audio previews, render",
  "comparisons, sample exports.",
  "",
  "Rules (see control/operations/showcase_gallery.md / retention.md):",
  "1. **When in doubt, showcase** — no explicit destination means it lands here.",
  "2. **Never put files directly under showcase/ — always a subfolder**",
  "   (`showcase/<topic>/…`, e.g. `showcase/screenshots/`, `showcase/audio_preview/`).",
  "3. Promotion showcase → gallery is by the user's explicit request only.",
  "4. `runtime/` = machine-facing intermediates; `showcase/` = human-facing output.",
  "5. Retention follows `runtime/` (transient; swept by the retention policy).",
]);

const GALLERY_README = heredoc([
  "# gallery/ — curated user-facing keepers (TRACKED, Git LFS)",
  "",
  "Tracked (re-included by the nested __garelier/.gitignore). Holds deliverables the",
  "user explicitly asked to KEEP. Binaries (.png/.wav/.mp4/.glb/…) go through Git",
  "LFS per `gallery/.gitattributes`. Promote here from showcase/ only on the user's",
  "explicit request; never auto-persist.",
]);

const GALLERY_GITATTRIBUTES = heredoc([
  "# W-085: gallery binaries via Git LFS (nested .gitattributes applies to this",
  "# subtree). Requires `git lfs install` in the repo (project-standard).",
  "*.png  filter=lfs diff=lfs merge=lfs -text",
  "*.jpg  filter=lfs diff=lfs merge=lfs -text",
  "*.jpeg filter=lfs diff=lfs merge=lfs -text",
  "*.gif  filter=lfs diff=lfs merge=lfs -text",
  "*.webp filter=lfs diff=lfs merge=lfs -text",
  "*.wav  filter=lfs diff=lfs merge=lfs -text",
  "*.ogg  filter=lfs diff=lfs merge=lfs -text",
  "*.mp3  filter=lfs diff=lfs merge=lfs -text",
  "*.mp4  filter=lfs diff=lfs merge=lfs -text",
  "*.webm filter=lfs diff=lfs merge=lfs -text",
  "*.glb  filter=lfs diff=lfs merge=lfs -text",
  "*.zip  filter=lfs diff=lfs merge=lfs -text",
]);

// garelier_write_showcase_gallery <pm-root>
export function writeShowcaseGallery(pmRoot: string): void {
  mkdirSync(`${pmRoot}/showcase`, { recursive: true });
  mkdirSync(`${pmRoot}/gallery`, { recursive: true });
  if (!existsSync(`${pmRoot}/showcase/README.md`)) {
    writeFileSync(`${pmRoot}/showcase/README.md`, SHOWCASE_README);
  }
  if (!existsSync(`${pmRoot}/gallery/README.md`)) {
    writeFileSync(`${pmRoot}/gallery/README.md`, GALLERY_README);
  }
  if (!existsSync(`${pmRoot}/gallery/.gitattributes`)) {
    writeFileSync(`${pmRoot}/gallery/.gitattributes`, GALLERY_GITATTRIBUTES);
  }
  if (!existsSync(`${pmRoot}/gallery/.gitkeep`)) {
    writeFileSync(`${pmRoot}/gallery/.gitkeep`, ""); // touch (create-if-absent)
  }
}
