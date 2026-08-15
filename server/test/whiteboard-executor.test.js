// Tests for services/material-executors/whiteboard-executor.js —
// deterministic ordered drawing instructions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const executor = require('../services/material-executors/whiteboard-executor');

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, duration: 6, visualTreatment: 'WHITEBOARD', ...overrides });
}
function candidate(overrides = {}) {
  return createCandidateResult({ candidate: 'DETERMINISTIC_TEMPLATE+WHITEBOARD', ...overrides });
}

// --- F — WHITEBOARD -------------------------------------------------------------------

test('F1. ordered drawing — elements auto-stack in array order when drawStartOffset is omitted', () => {
  const result = executor.execute({
    beat: beat(),
    selectedMaterial: candidate(),
    options: { elements: [{ kind: 'OBJECT', content: 'wallet', drawDuration: 1 }, { kind: 'TEXT', content: '£100', drawDuration: 0.5 }, { kind: 'ARROW', drawDuration: 0.5 }] },
  });

  assert.equal(result.status, 'COMPLETED');
  const order = result.renderSpec.drawingOrder;
  assert.equal(order[0].drawStartOffset, 0);
  assert.equal(order[1].drawStartOffset, 1);
  assert.equal(order[2].drawStartOffset, 1.5);
});

test('F2. text elements are supported and carry their content through', () => {
  const result = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'TEXT', content: 'Inflation destroys purchasing power', drawDuration: 1 }] } });
  assert.equal(result.renderSpec.drawingOrder[0].kind, 'TEXT');
  assert.equal(result.renderSpec.drawingOrder[0].content, 'Inflation destroys purchasing power');
});

test('F3. simple shapes are supported', () => {
  const result = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'SHAPE', content: 'circle', drawDuration: 1 }, { kind: 'ARROW', drawDuration: 1 }] } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.drawingOrder[0].kind, 'SHAPE');
  assert.equal(result.renderSpec.drawingOrder[1].kind, 'ARROW');
});

test('F4. reveal timing — an explicit drawStartOffset overrides auto-stacking for that element only', () => {
  const result = executor.execute({
    beat: beat(),
    selectedMaterial: candidate(),
    options: {
      elements: [
        { kind: 'OBJECT', content: 'wallet', drawDuration: 1 },
        { kind: 'TEXT', content: '£100', drawDuration: 0.5, drawStartOffset: 5 },
        { kind: 'ARROW', drawDuration: 0.5 },
      ],
    },
  });
  const order = result.renderSpec.drawingOrder;
  assert.equal(order[0].drawStartOffset, 0);
  assert.equal(order[1].drawStartOffset, 5, 'explicit offset must be honored exactly');
  assert.equal(order[2].drawStartOffset, 1, 'auto-stacking resumes from the last AUTO-stacked element, not the explicit one');
});

test('F5. deterministic output — identical input produces an identical render spec across repeated calls', () => {
  const options = { elements: [{ kind: 'OBJECT', content: 'wallet', drawDuration: 1 }, { kind: 'TEXT', content: '£100', drawDuration: 0.5 }] };
  const first = executor.execute({ beat: beat(), selectedMaterial: candidate(), options });
  const second = executor.execute({ beat: beat(), selectedMaterial: candidate(), options });
  assert.deepEqual(first.renderSpec, second.renderSpec);
});

test('F6. the worked wallet/£100/arrow/£80/emphasis example from the master spec resolves cleanly', () => {
  const result = executor.execute({
    beat: beat({ duration: 3.2 }),
    selectedMaterial: candidate(),
    options: {
      elements: [
        { kind: 'OBJECT', content: 'wallet', drawDuration: 0.6 },
        { kind: 'TEXT', content: '£100', drawDuration: 0.4 },
        { kind: 'ARROW', drawDuration: 0.5 },
        { kind: 'TEXT', content: '£80', drawDuration: 0.4 },
        { kind: 'EMPHASIS', content: '£80', drawDuration: 0.3, holdDuration: 0.6 },
      ],
    },
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.drawingOrder.length, 5);
  assert.equal(result.renderSpec.drawingOrder[4].kind, 'EMPHASIS');
  assert.equal(result.renderSpec.drawingOrder[4].holdDuration, 0.6);
});

test('F7. ERASE requires a valid, already-drawn target element id', () => {
  const missingTarget = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'ERASE', content: 'nonexistent', drawDuration: 0.2 }] } });
  assert.equal(missingTarget.status, 'FAILED');
  assert.equal(missingTarget.diagnostics[0].code, 'INVALID_ERASE_TARGET');

  const validErase = executor.execute({
    beat: beat(),
    selectedMaterial: candidate(),
    options: { elements: [{ elementId: 'wallet-1', kind: 'OBJECT', content: 'wallet', drawDuration: 1 }, { kind: 'ERASE', content: 'wallet-1', drawDuration: 0.2 }] },
  });
  assert.equal(validErase.status, 'COMPLETED');
});

test('F8. an element that would draw past the beat duration fails with EXCEEDS_DURATION', () => {
  const result = executor.execute({ beat: beat({ duration: 1 }), selectedMaterial: candidate(), options: { elements: [{ kind: 'TEXT', content: 'x', drawDuration: 5 }] } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'EXCEEDS_DURATION');
});

test('F9. an unsupported element kind, missing elements, and an invalid drawDuration all fail structurally', () => {
  const badKind = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'PHOTO', drawDuration: 1 }] } });
  assert.equal(badKind.diagnostics[0].code, 'INVALID_ELEMENT_KIND');

  const missing = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: {} });
  assert.equal(missing.diagnostics[0].code, 'MISSING_ELEMENTS');

  const badDuration = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'TEXT', drawDuration: -1 }] } });
  assert.equal(badDuration.diagnostics[0].code, 'INVALID_DRAW_DURATION');
});

test('F10. canvas defaults to a sensible size when not supplied, and honors an explicit override', () => {
  const defaultResult = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'TEXT', content: 'x', drawDuration: 1 }] } });
  assert.deepEqual(defaultResult.renderSpec.canvas, { width: 1920, height: 1080 });

  const customResult = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { elements: [{ kind: 'TEXT', content: 'x', drawDuration: 1 }], canvas: { width: 800, height: 600 } } });
  assert.deepEqual(customResult.renderSpec.canvas, { width: 800, height: 600 });
});
