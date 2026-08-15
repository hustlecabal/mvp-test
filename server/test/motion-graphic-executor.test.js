// Tests for services/material-executors/motion-graphic-executor.js —
// deterministic primitive-based graphics, intentionally small primitive set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const executor = require('../services/material-executors/motion-graphic-executor');

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, duration: 5, visualTreatment: 'MOTION_GRAPHIC', ...overrides });
}
function candidate(overrides = {}) {
  return createCandidateResult({ candidate: 'DETERMINISTIC_TEMPLATE+MOTION_GRAPHIC', ...overrides });
}

// --- E — MOTION_GRAPHIC -------------------------------------------------------------

test('E1. every documented primitive kind is accepted and generates a corresponding element', () => {
  for (const kind of executor.MOTION_GRAPHIC_PRIMITIVES) {
    const result = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind, label: kind }] } });
    assert.equal(result.status, 'COMPLETED', `${kind} should complete`);
    assert.equal(result.renderSpec.elements[0].kind, kind);
  }
});

test('E1b. an unsupported primitive kind fails structurally', () => {
  const result = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'PIE_CHART' }] } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_PRIMITIVE');
});

test('E2. positioning — explicit position/scale/rotation/opacity are recorded exactly, defaults apply when omitted', () => {
  const result = executor.execute({
    beat: beat(),
    selectedMaterial: candidate(),
    options: { elements: [{ kind: 'RECTANGLE', position: { x: 0.2, y: 0.3 }, scale: 1.5, rotation: 45, opacity: 0.8 }, { kind: 'CIRCLE' }] },
  });
  assert.deepEqual(result.renderSpec.elements[0].position, { x: 0.2, y: 0.3 });
  assert.equal(result.renderSpec.elements[0].scale, 1.5);
  assert.equal(result.renderSpec.elements[0].rotation, 45);
  assert.equal(result.renderSpec.elements[0].opacity, 0.8);
  assert.deepEqual(result.renderSpec.elements[1].position, { x: 0, y: 0 });
  assert.equal(result.renderSpec.elements[1].scale, 1);
});

test('E3. sequencing — an explicit valid sequence window is accepted; an out-of-range window fails structurally', () => {
  const valid = executor.execute({
    beat: beat({ duration: 5 }),
    selectedMaterial: candidate(),
    options: { elements: [{ kind: 'BAR', sequence: { startOffset: 1, endOffset: 3 } }] },
  });
  assert.equal(valid.status, 'COMPLETED');
  assert.deepEqual(valid.renderSpec.elements[0].sequence, { startOffset: 1, endOffset: 3 });

  const invalid = executor.execute({
    beat: beat({ duration: 5 }),
    selectedMaterial: candidate(),
    options: { elements: [{ kind: 'BAR', sequence: { startOffset: 4, endOffset: 10 } }] },
  });
  assert.equal(invalid.status, 'FAILED');
  assert.equal(invalid.diagnostics[0].code, 'INVALID_SEQUENCE');
});

test('E4. deterministic output — identical input produces an identical render spec across repeated calls, including auto-generated element ids', () => {
  const options = { elements: [{ kind: 'BAR', label: 'Q1' }, { kind: 'BAR', label: 'Q2' }] };
  const first = executor.execute({ beat: beat(), selectedMaterial: candidate(), options });
  const second = executor.execute({ beat: beat(), selectedMaterial: candidate(), options });
  assert.deepEqual(first.renderSpec, second.renderSpec);
  assert.equal(first.renderSpec.elements[0].elementId, 'element-0');
  assert.equal(first.renderSpec.elements[1].elementId, 'element-1');
});

test('E5. missing/empty elements fails with MISSING_ELEMENTS — motion graphics are never inferred from beat text', () => {
  const missing = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: {} });
  assert.equal(missing.status, 'FAILED');
  assert.equal(missing.diagnostics[0].code, 'MISSING_ELEMENTS');

  const empty = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [] } });
  assert.equal(empty.status, 'FAILED');
  assert.equal(empty.diagnostics[0].code, 'MISSING_ELEMENTS');
});

test('E6. an invalid duration fails structurally', () => {
  const result = executor.execute({ beat: beat({ duration: -1 }), selectedMaterial: candidate(), options: { elements: [{ kind: 'CIRCLE' }] } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_DURATION');
});

test('E7. grouped elements — groupId is preserved on each element', () => {
  const result = executor.execute({
    beat: beat(),
    selectedMaterial: candidate(),
    options: { elements: [{ kind: 'TEXT', label: 'Total', groupId: 'summary' }, { kind: 'BAR', groupId: 'summary' }] },
  });
  assert.equal(result.renderSpec.elements[0].groupId, 'summary');
  assert.equal(result.renderSpec.elements[1].groupId, 'summary');
});
