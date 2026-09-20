---
'@solidjs/vite-plugin': patch
---

Vitest 5 inline projects get the plugin's test configuration again (#369). Vitest 5 defaults `test.sharedViteServer` to `true`, so an inline project that only changes `test` options reuses the root Vite server and resolves its options from the raw root `test` block, without running the plugin's `config` hook. Such projects lost everything the hook injects: a `test.environment: 'node'` project kept the root's `browser` condition (`isServer` was `false`), and jsdom projects lost the `@testing-library/jest-dom` setup file and the `solid-js` `server.deps` handling. When the root config declares `test.projects` and leaves `test.sharedViteServer` unset, the plugin now sets it to `false` so every project resolves its own Vite config, as it did under Vitest 4. An explicit `sharedViteServer` value is respected.
