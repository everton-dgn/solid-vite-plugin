---
'@solidjs/vite-plugin': patch
---

Client chunk and asset file names no longer contain `..`. A catch-all route module such as `[...404].tsx` built to `_...404_-<hash>.js`, and hosts, CDNs or middleware that reject any URL containing `..` refused that chunk, so the lazy route failed to hydrate. The client build now runs the configured `output.sanitizeFileName` (or the bundler default) and then collapses every run of dots to one: the chunk becomes `_.404_-<hash>.js`. A custom `sanitizeFileName` still runs, with the collapse applied after it; `sanitizeFileName: false` is left alone. Server output is unchanged. Fixes #391.
