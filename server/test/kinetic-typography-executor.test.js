// Tests for services/material-executors/kinetic-typography-executor.js —
// deterministic text-animation instructions, no LLM, no AI model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const executor = require('../services/material-executors/kinetic-typography-executor');

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, duration: 3, visualTreatment: 'KINETIC_TYPOGRAPHY', ...overrides });
}
function candidate(overrides = {}) {
  return createCandidateResult({ candidate: 'DETERMINISTIC_TEMPLATE+KINETIC_TYPOGRAPHY', ...overrides });
}

// --- D — KINETIC_TYPOGRAPHY -------------------------------------------------------------

test('D1. text is required — options.text is used when present', () => {
  const result = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'THE PROBLEM' } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.text, 'THE PROBLEM');
});

test('D1b. beat.narrationSegment.text is used as a fallback when options.text is omitted', () => {
  const b = beat({ narrationSegment: { text: 'BUT HERE\'S THE CATCH...', scriptRefId: null, startOffset: null, endOffset: null } });
  const result = executor.execute({ beat: b, selectedMaterial: candidate(), options: {} });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.text, "BUT HERE'S THE CATCH...");
});

test('D1c. missing text (no options.text, no narrationSegment) fails with MISSING_TEXT', () => {
  const result = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: {} });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'MISSING_TEXT');
});

test('D2. timing — the timeline is derived from duration and evenly spaced across it', () => {
  const result = executor.execute({ beat: beat({ duration: 4 }), selectedMaterial: candidate(), options: { text: 'ONE TWO', sequencing: 'WORD_BY_WORD' } });
  assert.equal(result.renderSpec.timeline.length, 2);
  assert.equal(result.renderSpec.timeline[0].startOffset, 0);
  assert.equal(result.renderSpec.timeline[0].endOffset, 2);
  assert.equal(result.renderSpec.timeline[1].startOffset, 2);
  assert.equal(result.renderSpec.timeline[1].endOffset, 4);
});

test('D3. sequencing — WORD_BY_WORD, LETTER_BY_LETTER, LINE_BY_LINE, and ALL_AT_ONCE each split correctly', () => {
  const wordResult = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: '$10,000 problem', sequencing: 'WORD_BY_WORD' } });
  assert.deepEqual(wordResult.renderSpec.units, ['$10,000', 'problem']);

  const letterResult = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'HI', sequencing: 'LETTER_BY_LETTER' } });
  assert.deepEqual(letterResult.renderSpec.units, ['H', 'I']);

  const lineResult = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'line one\nline two', sequencing: 'LINE_BY_LINE' } });
  assert.deepEqual(lineResult.renderSpec.units, ['line one', 'line two']);

  const allResult = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'THE PROBLEM', sequencing: 'ALL_AT_ONCE' } });
  assert.deepEqual(allResult.renderSpec.units, ['THE PROBLEM']);
});

test('D4. emphasis — a valid wordIndex is recorded, an out-of-range wordIndex fails structurally', () => {
  const ok = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: '$10,000 problem', emphasis: [{ wordIndex: 0, style: 'HIGHLIGHT' }] } });
  assert.equal(ok.status, 'COMPLETED');
  assert.deepEqual(ok.renderSpec.emphasis, [{ wordIndex: 0, style: 'HIGHLIGHT' }]);

  const outOfRange = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'one two', emphasis: [{ wordIndex: 5, style: 'HIGHLIGHT' }] } });
  assert.equal(outOfRange.status, 'FAILED');
  assert.equal(outOfRange.diagnostics[0].code, 'INVALID_EMPHASIS');
});

test('D5. deterministic output — identical input produces an identical render spec across repeated calls', () => {
  const options = { text: 'THE PROBLEM', sequencing: 'WORD_BY_WORD', entrance: 'SLIDE_UP', exit: 'FADE_OUT' };
  const first = executor.execute({ beat: beat(), selectedMaterial: candidate(), options });
  const second = executor.execute({ beat: beat(), selectedMaterial: candidate(), options });
  assert.deepEqual(first.renderSpec, second.renderSpec);
});

test('D6. invalid entrance/exit/sequencing/alignment values fail structurally', () => {
  const badEntrance = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'x', entrance: 'TELEPORT' } });
  assert.equal(badEntrance.diagnostics[0].code, 'INVALID_ENTRANCE');

  const badExit = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'x', exit: 'TELEPORT' } });
  assert.equal(badExit.diagnostics[0].code, 'INVALID_EXIT');

  const badSequencing = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'x', sequencing: 'RANDOM' } });
  assert.equal(badSequencing.diagnostics[0].code, 'INVALID_SEQUENCING');

  const badAlignment = executor.execute({ beat: beat(), selectedMaterial: candidate(), options: { text: 'x', alignment: 'DIAGONAL' } });
  assert.equal(badAlignment.diagnostics[0].code, 'INVALID_ALIGNMENT');
});

test('D7. no LLM/AI import anywhere in the executor — the only require is the execution schema', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executors', 'kinetic-typography-executor.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../../schemas/material-execution-schema']);
});
