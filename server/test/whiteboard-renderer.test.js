// Tests for services/renderers/whiteboard-renderer.js — Stage 26.8A.
// No asset needed — a drawingOrder renderSpec, always produced by the real
// executor (services/material-executors/whiteboard-executor.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExecutionResult } = require('../schemas/material-execution-schema');
const { execute } = require('../services/material-executors/whiteboard-executor');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const renderer = require('../services/renderers/whiteboard-renderer');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-output-'));
}

function realExecution(elements, options = {}) {
  const beat = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 6, visualTreatment: 'WHITEBOARD' });
  return execute({ beat, selectedMaterial: { candidate: 'M1' }, options: { elements, duration: 6, ...options } });
}

// --- per-kind rendering -------------------------------------------------------------------

test('1. TEXT produces a real, escaped <text> element with a clip-path wipe reveal', () => {
  const ex = realExecution([{ kind: 'TEXT', content: 'Idea <one>', drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'COMPLETED');
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /Idea &lt;one&gt;/);
  assert.match(svgText, /<clipPath /);
  assert.match(svgText, /<animate attributeName="width"/);
});

test('2. SHAPE produces a stroke-dasharray outline with a stroke-dashoffset draw animation', () => {
  const ex = realExecution([{ kind: 'SHAPE', content: 'box', style: { shapeType: 'RECTANGLE', width: 100, height: 60 }, drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<rect[^>]*stroke-dasharray="320"/);
  assert.match(svgText, /<animate attributeName="stroke-dashoffset" values="320;0"/);
});

test('3. SHAPE with shapeType CIRCLE produces a circle outline', () => {
  const ex = realExecution([{ kind: 'SHAPE', content: 'c', style: { shapeType: 'CIRCLE', radius: 50 }, drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<circle cx="0" cy="0" r="50"/);
});

test('4. ARROW produces a line + arrowhead with a draw animation', () => {
  const ex = realExecution([{ kind: 'ARROW', content: 'a', style: { dx: 150, dy: 0 }, drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<line /);
  assert.match(svgText, /<polygon /);
});

test('5. OBJECT renders an honestly-labeled placeholder (dashed outline + label text), never a fabricated icon', () => {
  const ex = realExecution([{ kind: 'OBJECT', content: 'lightbulb', drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /stroke-dasharray="4 4"/);
  assert.match(svgText, /lightbulb/);
});

test('6. EMPHASIS anchors at the referenced earlier element\'s own position', () => {
  const ex = realExecution([
    { elementId: 'target', kind: 'SHAPE', content: 's', style: { shapeType: 'RECTANGLE', width: 100, height: 60, position: { x: 0.7, y: 0.2 } }, drawDuration: 1 },
    { kind: 'EMPHASIS', content: 'target', drawDuration: 0.5 },
  ]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const groups = [...svgText.matchAll(/<g id="[^"]*" transform="translate\(([\d.-]+) ([\d.-]+)\)/g)];
  assert.equal(groups.length, 2);
  assert.equal(groups[0][1], groups[1][1], 'EMPHASIS must share the target element\'s x position');
  assert.equal(groups[0][2], groups[1][2], 'EMPHASIS must share the target element\'s y position');
});

test('7. ERASE animates the referenced earlier element\'s own group to opacity 0, never removing/redrawing it', () => {
  const ex = realExecution([
    { elementId: 'target', kind: 'TEXT', content: 'gone soon', drawDuration: 1 },
    { kind: 'ERASE', content: 'target', drawDuration: 0.5 },
  ]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  // exactly one visible group (ERASE contributes no new group of its own)
  assert.equal((svgText.match(/<g id="/g) || []).length, 1);
  assert.match(svgText, /<animate attributeName="opacity" values="1;0"/);
});

// --- layout fallback -------------------------------------------------------------------

test('8. an explicit style.position places the element at that normalized point', () => {
  const ex = realExecution([{ kind: 'SHAPE', content: 's', style: { shapeType: 'CIRCLE', radius: 20, position: { x: 0.25, y: 0.5 } }, drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /translate\(480 540\)/);
});

test('9. two elements with no explicit position get distinct deterministic grid positions', () => {
  const ex = realExecution([
    { kind: 'SHAPE', content: 'a', style: { shapeType: 'CIRCLE', radius: 10 }, drawDuration: 0.5 },
    { kind: 'SHAPE', content: 'b', style: { shapeType: 'CIRCLE', radius: 10 }, drawDuration: 0.5 },
  ]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const positions = [...svgText.matchAll(/translate\(([\d.-]+) ([\d.-]+)\)/g)].map((m) => `${m[1]},${m[2]}`);
  assert.notEqual(positions[0], positions[1]);
});

// --- failure codes -------------------------------------------------------------------

test('10. renderSpec.type !== WHITEBOARD fails with INVALID_RENDER_SPEC', () => {
  const result = renderer.render({ executionResult: createExecutionResult({ renderSpec: { type: 'MOTION_GRAPHIC' }, status: 'COMPLETED' }), outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('11. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const ex = realExecution([{ kind: 'TEXT', content: 'x', drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

// --- determinism -------------------------------------------------------------------

test('12. determinism — identical input produces an identical SVG across repeated calls', () => {
  const ex = realExecution([{ kind: 'TEXT', content: 'x', drawDuration: 1 }, { kind: 'SHAPE', content: 's', style: { shapeType: 'RECTANGLE' }, drawDuration: 1 }]);
  const first = renderer.render({ executionResult: ex, outputDir: outDir() });
  const second = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(fs.readFileSync(first.artifact.path, 'utf8'), fs.readFileSync(second.artifact.path, 'utf8'));
});

test('13. renderSpec is never mutated by rendering', () => {
  const ex = realExecution([{ kind: 'TEXT', content: 'x', drawDuration: 1 }]);
  const before = JSON.stringify(ex.renderSpec);
  renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(JSON.stringify(ex.renderSpec), before);
});

// --- security -------------------------------------------------------------------

test('14. rendered SVG never contains a raw, unescaped angle bracket from user-supplied content (XML injection safety)', () => {
  const ex = realExecution([{ kind: 'OBJECT', content: '<img onerror=alert(1)>', drawDuration: 1 }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.doesNotMatch(svgText, /<img /);
  assert.match(svgText, /&lt;img/);
});

test('15. services/renderers/whiteboard-renderer.js has no eval/new Function/child_process/network call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'whiteboard-renderer.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});
