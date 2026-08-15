// Tests for services/render-service.js — Stage 26.8A. The top-level
// renderMaterial() entry point: routes an ExecutionResult's renderSpec to
// the right renderer via renderSpec.type, and never crashes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderMaterial } = require('../services/render-service');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { execute: executeKineticTypography } = require('../services/material-executors/kinetic-typography-executor');
const { createVisualBeat } = require('../schemas/visual-beat-schema');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-service-output-'));
}

function realKineticExecution() {
  const beat = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 3, visualTreatment: 'KINETIC_TYPOGRAPHY' });
  return executeKineticTypography({ beat, selectedMaterial: { candidate: 'M1' }, options: { text: 'go now', duration: 3 } });
}

// --- happy path -------------------------------------------------------------------

test('1. renderMaterial routes a real COMPLETED ExecutionResult to the correct renderer by renderSpec.type', () => {
  const ex = realKineticExecution();
  const result = renderMaterial('p1', ex, outDir());
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.rendererType, 'KINETIC_TYPOGRAPHY');
  assert.equal(result.beatId, ex.beatId);
  assert.equal(result.executionId, ex.executionId);
});

// --- failure codes -------------------------------------------------------------------

test('2. a non-COMPLETED executionResult fails with INVALID_RENDER_SPEC — nothing to render', () => {
  const ex = createExecutionResult({ status: 'FAILED', renderSpec: null });
  const result = renderMaterial('p1', ex, outDir());
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('3. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const ex = realKineticExecution();
  const result = renderMaterial('p1', ex, undefined);
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('4. an unregistered renderSpec.type fails with UNSUPPORTED_RENDER_TYPE, never throws', () => {
  const ex = createExecutionResult({ status: 'COMPLETED', renderSpec: { type: 'NOT_A_REAL_TYPE' } });
  assert.doesNotThrow(() => {
    const result = renderMaterial('p1', ex, outDir());
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_RENDER_TYPE');
  });
});

test('5. a renderer that throws produces a structured RENDERER_THREW result, never crashes the caller', () => {
  // A MOTION_GRAPHIC element missing `position` entirely passes this
  // renderer's own INVALID_ELEMENT checks (which only validate TEXT/CHART-
  // specific props) but throws when the renderer reads element.position.x —
  // proving render-service.js catches it rather than propagating.
  const ex = createExecutionResult({
    beatId: 'b1',
    materialId: 'm1',
    status: 'COMPLETED',
    duration: 3,
    renderSpec: { type: 'MOTION_GRAPHIC', duration: 3, elements: [{ elementId: 'e0', kind: 'CIRCLE', rotation: 0, scale: 1, opacity: 1, props: {}, sequence: { startOffset: 0, endOffset: 3 } }] },
  });

  assert.doesNotThrow(() => {
    const result = renderMaterial('p1', ex, outDir());
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'RENDERER_THREW');
    assert.equal(result.beatId, 'b1');
    assert.equal(result.materialId, 'm1');
  });
});

// --- provenance carried through -------------------------------------------------------------------

test('6. beatId/materialId/executionId from the ExecutionResult are carried into the RenderResult even on failure', () => {
  const ex = createExecutionResult({ beatId: 'beat-x', materialId: 'mat-x', status: 'COMPLETED', renderSpec: { type: 'NOT_A_REAL_TYPE' } });
  const result = renderMaterial('p1', ex, outDir());
  assert.equal(result.beatId, 'beat-x');
  assert.equal(result.materialId, 'mat-x');
  assert.equal(result.executionId, ex.executionId);
});

// --- no timeline assembly / no persistence -------------------------------------------------------------------

test('7. render-service.js never picks a default outputDir — omitting it always fails rather than writing anywhere', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'render-service.js'), 'utf8');
  assert.doesNotMatch(text, /data[\\/]renders/);
  assert.doesNotMatch(text, /outputDir\s*=\s*outputDir\s*\|\|/);
});

// --- security -------------------------------------------------------------------

test('8. services/render-service.js has no eval/new Function/child_process/network call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'render-service.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});
