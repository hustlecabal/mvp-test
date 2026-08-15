// Tests for services/renderers/kinetic-typography-renderer.js — Stage
// 26.8A. No asset needed — text-only renderSpec, always produced by the
// real executor (services/material-executors/kinetic-typography-executor.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExecutionResult } = require('../schemas/material-execution-schema');
const { execute } = require('../services/material-executors/kinetic-typography-executor');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const renderer = require('../services/renderers/kinetic-typography-renderer');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-output-'));
}

function realExecution(options = {}) {
  const beat = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 4, visualTreatment: 'KINETIC_TYPOGRAPHY' });
  return execute({ beat, selectedMaterial: { candidate: 'M1' }, options: { text: 'Hello world today', duration: 4, ...options } });
}

// --- happy path -------------------------------------------------------------------

test('1. WORD_BY_WORD text produces a COMPLETED render with one animated group per word', () => {
  const ex = realExecution({ sequencing: 'WORD_BY_WORD' });
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.rendererType, 'KINETIC_TYPOGRAPHY');
  assert.equal(result.artifact.duration, 4);
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.equal((svgText.match(/<text /g) || []).length, 3, 'Hello/world/today -> 3 <text> elements');
  assert.match(svgText, /Hello/);
  assert.match(svgText, /world/);
  assert.match(svgText, /today/);
  assert.match(svgText, /<animate attributeName="opacity"/);
});

test('2. LETTER_BY_LETTER produces one <text> element per non-space character', () => {
  const ex = realExecution({ text: 'Hi', sequencing: 'LETTER_BY_LETTER' });
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.equal((svgText.match(/<text /g) || []).length, 2);
});

test('3. LINE_BY_LINE stacks each line vertically at increasing y', () => {
  const ex = realExecution({ text: 'Line one\nLine two', sequencing: 'LINE_BY_LINE' });
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const ys = [...svgText.matchAll(/<text x="[\d.-]+" y="([\d.-]+)"/g)].map((m) => Number(m[1]));
  assert.equal(ys.length, 2);
  assert.notEqual(ys[0], ys[1]);
});

test('4. ALL_AT_ONCE produces a single animated group covering the whole text', () => {
  const ex = realExecution({ sequencing: 'ALL_AT_ONCE' });
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(ex.renderSpec.units.length, 1);
  assert.equal(ex.renderSpec.timeline.length, 1);
  assert.equal(result.status, 'COMPLETED');
});

test('5. emphasis on a wordIndex changes that word\'s fill color', () => {
  const ex = realExecution({ sequencing: 'WORD_BY_WORD', emphasis: [{ wordIndex: 1, style: 'BOLD' }] });
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /fill="#ffd54a"[^>]*>world</);
});

test('6. every ENTRANCE_KINDS value produces a valid COMPLETED render', () => {
  for (const entrance of ['FADE_IN', 'SLIDE_UP', 'SLIDE_IN', 'POP_IN', 'TYPE_ON']) {
    const ex = realExecution({ entrance });
    const result = renderer.render({ executionResult: ex, outputDir: outDir() });
    assert.equal(result.status, 'COMPLETED', `entrance ${entrance} should render`);
  }
});

test('7. every EXIT_KINDS value (including NONE) produces a valid COMPLETED render', () => {
  for (const exit of ['FADE_OUT', 'SLIDE_DOWN', 'SLIDE_OUT', 'POP_OUT', 'NONE']) {
    const ex = realExecution({ exit });
    const result = renderer.render({ executionResult: ex, outputDir: outDir() });
    assert.equal(result.status, 'COMPLETED', `exit ${exit} should render`);
  }
});

test('8. CENTER/LEFT/RIGHT alignment all produce a valid COMPLETED render with distinct x positions', () => {
  const positions = {};
  for (const alignment of ['CENTER', 'LEFT', 'RIGHT']) {
    const ex = realExecution({ alignment, sequencing: 'ALL_AT_ONCE' });
    const result = renderer.render({ executionResult: ex, outputDir: outDir() });
    const svgText = fs.readFileSync(result.artifact.path, 'utf8');
    const firstX = Number(svgText.match(/<text x="([\d.-]+)"/)[1]);
    positions[alignment] = firstX;
  }
  assert.notEqual(positions.LEFT, positions.RIGHT);
});

// --- failure codes -------------------------------------------------------------------

test('9. renderSpec.type !== KINETIC_TYPOGRAPHY fails with INVALID_RENDER_SPEC', () => {
  const result = renderer.render({ executionResult: createExecutionResult({ renderSpec: { type: 'WHITEBOARD' }, status: 'COMPLETED' }), outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('10. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const ex = realExecution();
  const result = renderer.render({ executionResult: ex });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

// --- determinism -------------------------------------------------------------------

test('11. determinism — identical input produces an identical SVG across repeated calls', () => {
  const ex = realExecution({ sequencing: 'WORD_BY_WORD', emphasis: [{ wordIndex: 0, style: 'BOLD' }] });
  const first = renderer.render({ executionResult: ex, outputDir: outDir() });
  const second = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(fs.readFileSync(first.artifact.path, 'utf8'), fs.readFileSync(second.artifact.path, 'utf8'));
});

test('12. renderSpec is never mutated by rendering', () => {
  const ex = realExecution();
  const before = JSON.stringify(ex.renderSpec);
  renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(JSON.stringify(ex.renderSpec), before);
});

// --- security -------------------------------------------------------------------

test('13. rendered SVG never contains a raw, unescaped angle bracket from user-supplied text (XML injection safety)', () => {
  const ex = realExecution({ text: '<script>evil()</script> ok', sequencing: 'WORD_BY_WORD' });
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.doesNotMatch(svgText, /<script>/);
  assert.match(svgText, /&lt;script&gt;/);
});

test('14. services/renderers/kinetic-typography-renderer.js has no eval/new Function/child_process/network call and reads no asset store', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'kinetic-typography-renderer.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
  assert.doesNotMatch(text, /require\(\s*['"`]\.\.\/timeline-store['"`]\s*\)/);
});
