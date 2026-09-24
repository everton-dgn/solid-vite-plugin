---
"@solidjs/vite-plugin": patch
---

Source names for the dev and `observe` postures: the compiler option `componentNames` is now `sourceNames` and covers components, compiled binding effects (`span.textContent`, `div.children`), and primitives. Primitives are named by the compiler's new `transformSourceNames` pass — `createSignal(0)` declared as `count` becomes `createSignal(0, { name: "count" })`, `createCounter.value` inside a composed primitive — which the plugin now runs ahead of the JSX transform, and alone on plain `.ts`/`.js` modules (outside `node_modules`), so attribution chains, diagnostics owner paths, and the Chrome performance tracks read source identifiers instead of `signal` / `computed` / `effect`. `solid.sourceNames` (`boolean | { components?, bindings?, primitives? }`) overrides the posture default. Requires the `@solidjs/compiler` release carrying `sourceNames` and `transformSourceNames`; on an older compiler the primitives pass is skipped with a warning.
