import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from 'vite';
import solid from '@solidjs/vite-plugin';

const fixture = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sandbox = fs.mkdtempSync(path.join(fixture, 'node_modules/cleanup-target-'));
const root = path.join(sandbox, 'project');
const clientDir = path.join(root, 'dist/client');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(clientDir, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(root, 'src/App.tsx'), 'export default function App() { return null; }');
const sentinel = path.join(clientDir, 'asset.js');
fs.writeFileSync(sentinel, 'client asset');

// Exercise the real prerender hook with completed environment builds. Its
// removal is observed without executing it, even for project-root targets.
const builder = await createBuilder({ root, configFile: false, plugins: [solid({ start: true })] });
const serving = builder.config.plugins.find((plugin) => plugin.name === 'solid:ssr/setup');
const prerender = builder.config.plugins.find((plugin) => plugin.name === 'solid:start/prerender');
assert.ok(serving && prerender);
const originalRemove = fs.rmSync;
const removals = [];
fs.rmSync = (directory) => removals.push(directory);
syncBuiltinESMExports();
try {
  for (const [name, target, removable] of [
    ['project root', root, false],
    ['project ancestor', sandbox, false],
    ['outside root', path.join(sandbox, 'outside'), false],
    ['root prefix sibling', root + '-sibling', false],
    ['client directory', clientDir, false],
    ['client ancestor', path.dirname(clientDir), false],
    ['standalone server', path.join(root, 'dist/server'), true],
  ]) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, 'server.js'),
      'export function handleRequest() { return new Response("<!DOCTYPE html><html></html>"); }',
    );
    serving.generateBundle.handler.call(
      { environment: builder.environments.client },
      { dir: clientDir },
      {},
    );
    serving.generateBundle.handler.call(
      { environment: builder.environments.ssr },
      { dir: target },
      {},
    );
    removals.length = 0;
    await prerender.buildApp.handler({
      config: builder.config,
      environments: { client: { isBuilt: true }, ssr: { isBuilt: true } },
    });
    assert.deepEqual(removals, removable ? [target] : [], `cleanup eligibility: ${name}`);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'client asset');
    console.log(`PASS cleanup target: ${name}`);
  }
} finally {
  fs.rmSync = originalRemove;
  syncBuiltinESMExports();
}
