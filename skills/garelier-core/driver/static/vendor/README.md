# static/vendor/ — optional, offline, fetched on demand

This directory holds large third-party browser assets that are **not committed**
to the repository. They are downloaded locally by the setup wizard when Bun is
available and the asset is missing (or manually when you want the feature), then
served by the read-only status web console over loopback/LAN — **no CDN is used
at runtime**, so the console works fully offline once an asset is present.

## Mermaid (diagram rendering)

```bash
cd skills/garelier-core/driver
bun run vendor:mermaid      # downloads static/vendor/mermaid.min.js (~3.3 MB, one-time, needs network)
```

After this, the **Files**, **Flow**, and other Markdown views render ```mermaid fenced code blocks as
diagrams. If `mermaid.min.js` is absent, those blocks stay readable as
diagram source (the feature degrades gracefully).

### Why it isn't bundled in the repo

Mermaid is MIT, but its all-in-one minified bundle inlines many third-party
dependencies under their own licenses, and redistributing a minified blob
would carry per-dependency attribution duties. Keeping it out of the repo
means this repository never redistributes it; the asset you download is for
your local use only.
