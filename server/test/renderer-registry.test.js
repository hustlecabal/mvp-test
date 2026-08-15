// Tests for services/renderer-registry.js — Stage 26.8A. A pure lookup, no
// renderer selection by content, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('../services/renderer-registry');
const { RENDERER_TYPES } = require('../schemas/render-result-schema');

test('1. every RENDERER_TYPES value is registered with a render function', () => {
  for (const rendererType of RENDERER_TYPES) {
    const renderer = registry.getRenderer(rendererType);
    assert.ok(renderer, `${rendererType} must be registered`);
    assert.equal(typeof renderer.render, 'function');
  }
});

test('2. listRendererTypes returns the exact RENDERER_TYPES list', () => {
  assert.deepEqual(registry.listRendererTypes(), RENDERER_TYPES);
});

test('3. an unknown renderSpec.type fails safely — returns null, never throws', () => {
  assert.doesNotThrow(() => {
    assert.equal(registry.getRenderer('NOT_A_REAL_RENDERER_TYPE'), null);
  });
  assert.equal(registry.getRenderer(undefined), null);
  assert.equal(registry.getRenderer(null), null);
});

test('4. services/renderer-registry.js has no require() of any provider, generation, or approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderer-registry.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['./renderers', '../schemas/render-result-schema'].sort());
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate|google/i.test(req), `unexpected import: ${req}`);
  }
});

test('5. services/renderers/index.js registers exactly the RENDERER_TYPES modules, nothing else', () => {
  const map = require('../services/renderers');
  assert.deepEqual(Object.keys(map).sort(), [...RENDERER_TYPES].sort());
});
