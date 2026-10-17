// Composition of the dev-manifest startup fix (#416) with the isolated CSS
// cache invalidation (#417): an HMR-enabled isolated runner (nitro's shape)
// imports virtual:solid-manifest before listen(), recovers the bridge once
// the port opens, and keeps honoring invalidations afterwards, including
// while a bridge fetch is pending. Requires the plugin built.
// Usage: node test/startup-cache.mjs

import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import solid from '@solidjs/vite-plugin';
import {
  createServer,
  createServerHotChannel,
  createServerModuleRunner,
  DevEnvironment,
} from 'vite';

const EVENT = 'solid:dev-manifest-invalidate';
const MANIFEST_ID = '\0virtual:solid-manifest';
const BRIDGE_ID = '\0virtual:solid-manifest-bridge';
const KEY = 'page.ts';
const REGISTRY_KEY = Symbol.for('@solidjs/vite-plugin:dev-manifest');

const isThenable = (value) => !!value && typeof value.then === 'function';
const cssText = (assets) => JSON.stringify(assets?.css ?? []);

async function within(promise, label, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Resolves on the next full assets answer for `key`; early answers after
// listen() may still be js-only (recovery is eventual by design).
async function untilCss(manifest, key, pattern, label) {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await within(Promise.resolve(manifest.resolve(key)), label);
    if (pattern.test(cssText(last))) return last;
    await delay(20);
  }
  throw new Error(`${label}: never resolved ${pattern}, last ${JSON.stringify(last)}`);
}

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'solid-startup-cache-')));
  await writeFile(path.join(root, KEY), "import './page.css'");
  const css = path.join(root, 'page.css');
  await writeFile(css, '.probe { width: 18px; }');
  const fetchCalls = [];
  let fetchHook = (request) => request;
  const runners = [];
  let server;
  context.after(async () => {
    for (const runner of runners) await runner.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0 },
    environments: {
      ssr: {
        dev: {
          createEnvironment(name, config) {
            const transport = createServerHotChannel();
            const send = transport.send.bind(transport);
            transport.send = (payload) => {
              // Nitro consumes full-reload itself.
              if (payload.type !== 'full-reload') send(payload);
            };
            return new DevEnvironment(name, config, { hot: true, transport });
          },
        },
      },
    },
    plugins: [
      solid({ ssr: true }),
      {
        name: 'startup-cache:probe',
        resolveId(id) {
          if (id === 'virtual:startup-cache-probe') return '\0' + id;
        },
        load(id) {
          if (id !== '\0virtual:startup-cache-probe') return;
          return `let complete;
            import.meta.hot.on(${JSON.stringify(EVENT)}, () => {
              complete?.();
              complete = undefined;
            });
            export const next = () => new Promise(resolve => { complete = resolve; });`;
        },
      },
    ],
  });
  const environment = server.environments.ssr;

  function createRunner() {
    const runner = createServerModuleRunner(environment, {
      sourcemapInterceptor: false,
      hmr: { logger: false },
      evaluator: {
        async runInlinedModule(moduleContext, code) {
          await runInNewContext(`(async () => { ${code}\n })()`, {
            ...moduleContext,
            fetch: async (...args) => {
              fetchCalls.push(String(args[0]));
              return fetchHook(fetch(...args));
            },
            URL,
            console,
          });
        },
        runExternalModule: (file) => import(file),
      },
    });
    runners.push(runner);
    return runner;
  }

  const runner = createRunner();
  const probe = await runner.import('virtual:startup-cache-probe');
  return {
    server,
    environment,
    runner,
    css,
    fetchCalls,
    createRunner,
    importManifest: (from = runner) =>
      within(from.import('virtual:solid-manifest'), 'manifest import'),
    nextInvalidation: () => within(probe.next(), 'manifest invalidation'),
    setFetchHook: (hook) => {
      fetchHook = hook;
    },
    async editCss(value) {
      const received = within(probe.next(), 'manifest invalidation');
      await writeFile(css, `.probe { width: ${value}; }`);
      await received;
    },
  };
}

test(
  'HMR runner importing before listen() recovers the bridge and keeps invalidating',
  { timeout: 30_000 },
  async (context) => {
    const state = await fixture(context);
    const { server, environment, fetchCalls } = state;

    // Import before listen(): must settle without the port and must not bind
    // the in-process registry resolver (isolated context).
    const manifest = (await state.importManifest()).default;
    assert.equal(server.httpServer.listening, false);
    assert.notEqual(manifest, globalThis[REGISTRY_KEY]?.[server.config.root]);

    // First lookup: js-only, no HTTP, and nothing cached (!bridgeMissing guard).
    const first = await within(Promise.resolve(manifest.resolve(KEY)), 'resolve before listen');
    assert.equal(first.css.length, 0);
    assert.equal(JSON.stringify(first.js), JSON.stringify(['/' + KEY]));
    assert.equal(fetchCalls.length, 0);
    const again = manifest.resolve(KEY);
    assert.ok(!isThenable(again), 'no-origin lookups stay synchronous');
    assert.equal(again.css.length, 0);
    assert.notEqual(again, first, 'js-only answers are not cached');
    assert.equal(manifest.resolveSync(KEY).css.length, 0);

    const bridgeNode = environment.moduleGraph.getModuleById(BRIDGE_ID);
    assert.ok(bridgeNode, 'bridge module was evaluated before listen');
    const manifestNode = environment.moduleGraph.getModuleById(MANIFEST_ID);
    assert.ok(manifestNode?.transformResult, 'manifest transform cached before listen');

    await within(server.listen(), 'listen()');
    assert.equal(server.httpServer.listening, true);
    assert.equal(bridgeNode.transformResult, null, 'bridge module dropped on listen');
    assert.equal(
      manifestNode.transformResult,
      null,
      'invalidation propagates to the manifest importer',
    );

    // Recovery once listening, on the same resolver instance.
    const recovered = await untilCss(manifest, KEY, /18px/, 'resolve after listen');
    assert.equal(fetchCalls.length, 1, 'exactly one bridge request after recovery');
    const warm = manifest.resolve(KEY);
    assert.ok(!isThenable(warm), 'warm key answers synchronously');
    assert.equal(warm, recovered);
    assert.equal(manifest.resolveSync(KEY), recovered);

    // Invalidation after recovery still reaches this instance.
    await state.editCss('36px');
    assert.equal(manifest.resolveSync(KEY).css.length, 0, 'cache cleared by invalidation');
    const after = await within(Promise.resolve(manifest.resolve(KEY)), 'resolve after edit');
    assert.match(cssText(after), /36px/);
    assert.doesNotMatch(cssText(after), /18px/);
    assert.equal(manifest.resolve(KEY), after);
    assert.equal(fetchCalls.length, 2);

    // Invalidation while a real bridge fetch is pending: the stale answer is
    // returned to its caller but never cached (generation guard).
    await state.editCss('48px');
    const release = Promise.withResolvers();
    const answered = Promise.withResolvers();
    state.setFetchHook(async (request) => {
      const response = await request;
      // Make sure the body is fully received before the next edit.
      const body = await response.text();
      answered.resolve(body);
      await release.promise;
      return new Response(body, { status: response.status, headers: response.headers });
    });
    const pending = manifest.resolve(KEY);
    assert.ok(isThenable(pending));
    assert.equal(manifest.resolve(KEY), pending, 'in-flight request is shared');
    assert.match(await within(answered.promise, 'bridge answer'), /48px/);
    await state.editCss('60px');
    assert.notEqual(manifest.resolve(KEY), pending, 'invalidation drops the pending entry');
    release.resolve();
    const stale = await pending;
    assert.match(cssText(stale), /48px/);
    assert.notEqual(manifest.resolveSync(KEY), stale, 'stale answer is not cached');
    state.setFetchHook((request) => request);
    const fresh = await untilCss(manifest, KEY, /60px/, 'resolve after in-flight invalidation');
    assert.doesNotMatch(cssText(fresh), /48px/);
    assert.equal(manifest.resolve(KEY), fresh);

    // Observed: dropping the bridge module's cached null on listen also
    // invalidates its importer in the server graph, so a later re-import in
    // the same runner evaluates a new manifest (origin baked in) and, as with
    // any re-evaluation, only that instance stays subscribed afterwards.
    const reimported = (await state.importManifest()).default;
    assert.notEqual(reimported, manifest);
    const reimportedAssets = await within(Promise.resolve(reimported.resolve(KEY)), 're-import');
    assert.match(cssText(reimportedAssets), /60px/);
    assert.equal(reimported.resolve(KEY), reimportedAssets);

    // A further edit invalidates the new instance only: the old one keeps
    // its last cached answer (identity preserved), the new one refetches.
    const oldWarm = manifest.resolve(KEY);
    assert.ok(!isThenable(oldWarm));
    assert.equal(oldWarm, fresh);
    await state.editCss('72px');
    assert.equal(manifest.resolve(KEY), fresh, 'old instance is no longer subscribed');
    assert.equal(manifest.resolveSync(KEY), fresh);
    assert.equal(reimported.resolveSync(KEY).css.length, 0, 'new instance cache cleared');
    const refreshed = await within(
      Promise.resolve(reimported.resolve(KEY)),
      'resolve after re-import edit',
    );
    assert.match(cssText(refreshed), /72px/);
    assert.doesNotMatch(cssText(refreshed), /60px/);
    assert.notEqual(refreshed, fresh);
    assert.equal(reimported.resolve(KEY), refreshed);
    assert.match(
      cssText(manifest.resolve(KEY)),
      /60px/,
      'old instance still answers its stale entry',
    );
  },
);

test(
  'two runners on one server keep independent caches and both receive invalidations',
  { timeout: 30_000 },
  async (context) => {
    const state = await fixture(context);
    const { server } = state;
    const first = (await state.importManifest()).default;
    await within(server.listen(), 'listen()');
    await untilCss(first, KEY, /18px/, 'first runner');

    const second = (await state.importManifest(state.createRunner())).default;
    assert.notEqual(second, first, 'each runner evaluates its own manifest');
    assert.notEqual(second, globalThis[REGISTRY_KEY]?.[server.config.root]);
    assert.ok(isThenable(second.resolve(KEY)), 'second runner starts cold');
    assert.ok(!isThenable(first.resolve(KEY)), 'first runner stays warm');
    const secondAssets = await untilCss(second, KEY, /18px/, 'second runner');
    assert.equal(second.resolve(KEY), secondAssets);

    await state.editCss('36px');
    assert.equal(first.resolveSync(KEY).css.length, 0, 'first cache cleared');
    assert.equal(second.resolveSync(KEY).css.length, 0, 'second cache cleared');
    assert.match(cssText(await within(Promise.resolve(first.resolve(KEY)), 'first')), /36px/);
    assert.match(cssText(await within(Promise.resolve(second.resolve(KEY)), 'second')), /36px/);
  },
);
