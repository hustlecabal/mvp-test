// Tests for schemas/render-result-schema.js — Stage 26.8A. Plain object
// factories only, no file I/O, no provider knowledge, no generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  RENDER_STATUSES,
  RENDERER_TYPES,
  RENDER_ARTIFACT_FORMATS,
  createRenderDiagnostic,
  createRenderArtifact,
  createRenderResult,
} = require('../schemas/render-result-schema');

test('1. RENDER_STATUSES is exactly COMPLETED/FAILED', () => {
  assert.deepEqual(RENDER_STATUSES, ['COMPLETED', 'FAILED']);
});

test('2. RENDERER_TYPES is exactly the 6 target renderer types', () => {
  assert.deepEqual(RENDERER_TYPES, ['ASSET_PLACEMENT', 'STILL_IMAGE_MOTION', 'KINETIC_TYPOGRAPHY', 'MOTION_GRAPHIC', 'WHITEBOARD', 'BROLL_CLIP']);
});

test('3. RENDER_ARTIFACT_FORMATS is exactly SVG this stage — never MP4/PNG/JPEG speculatively', () => {
  assert.deepEqual(RENDER_ARTIFACT_FORMATS, ['SVG']);
});

test('4. createRenderDiagnostic defaults', () => {
  const d = createRenderDiagnostic();
  assert.equal(d.code, null);
  assert.equal(d.message, '');
});

test('5. createRenderDiagnostic overrides apply', () => {
  const d = createRenderDiagnostic({ code: 'MISSING_ASSET', message: 'no such asset' });
  assert.equal(d.code, 'MISSING_ASSET');
  assert.equal(d.message, 'no such asset');
});

test('6. createRenderArtifact defaults — every field null except frameCount/duration semantics documented', () => {
  const a = createRenderArtifact();
  assert.equal(a.format, null);
  assert.equal(a.path, null);
  assert.equal(a.width, null);
  assert.equal(a.height, null);
  assert.equal(a.duration, null);
  assert.equal(a.frameCount, null);
});

test('7. createRenderArtifact overrides apply per field', () => {
  const a = createRenderArtifact({ format: 'SVG', path: '/tmp/x.svg', width: 1920, height: 1080, duration: 5 });
  assert.equal(a.format, 'SVG');
  assert.equal(a.path, '/tmp/x.svg');
  assert.equal(a.width, 1920);
  assert.equal(a.height, 1080);
  assert.equal(a.duration, 5);
  assert.equal(a.frameCount, null, 'untouched field keeps its default');
});

test('8. createRenderResult defaults — every field present with a safe, non-invented default', () => {
  const r = createRenderResult();
  assert.ok(r.renderId);
  assert.equal(r.rendererType, null);
  assert.equal(r.beatId, null);
  assert.equal(r.materialId, null);
  assert.equal(r.executionId, null);
  assert.equal(r.status, null);
  assert.equal(r.artifact, null);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.createdAt);
});

test('9. createRenderResult assigns a fresh, unique renderId every call', () => {
  const a = createRenderResult();
  const b = createRenderResult();
  assert.notEqual(a.renderId, b.renderId);
});

test('10. createRenderResult produces exactly the documented field set, nothing more', () => {
  const r = createRenderResult();
  assert.deepEqual(
    Object.keys(r).sort(),
    ['renderId', 'rendererType', 'beatId', 'materialId', 'executionId', 'status', 'artifact', 'diagnostics', 'createdAt'].sort()
  );
});

test('11. createRenderResult has no provider/model/cost field — rendering is deterministic local infrastructure', () => {
  const r = createRenderResult();
  for (const forbidden of ['provider', 'model', 'cost', 'price', 'credits']) {
    assert.equal(forbidden in r, false, `RenderResult must not have a "${forbidden}" field`);
  }
});

test('12. schemas/render-result-schema.js requires nothing but crypto — no file I/O, no network', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'render-result-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

test('13. determinism — identical overrides produce structurally identical output (ids/timestamps aside)', () => {
  const a = createRenderResult({ rendererType: 'ASSET_PLACEMENT', status: 'COMPLETED', artifact: createRenderArtifact({ format: 'SVG', width: 1920, height: 1080 }) });
  const b = createRenderResult({ rendererType: 'ASSET_PLACEMENT', status: 'COMPLETED', artifact: createRenderArtifact({ format: 'SVG', width: 1920, height: 1080 }) });
  const { renderId: idA, createdAt: createdAtA, ...restA } = a;
  const { renderId: idB, createdAt: createdAtB, ...restB } = b;
  assert.deepEqual(restA, restB);
});
