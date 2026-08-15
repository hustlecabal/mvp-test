// Tests for services/renderers/motion-graphic-renderer.js — Stage 26.8A.
// No asset needed — a primitives-array renderSpec, always produced by the
// real executor (services/material-executors/motion-graphic-executor.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExecutionResult } = require('../schemas/material-execution-schema');
const { execute } = require('../services/material-executors/motion-graphic-executor');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const renderer = require('../services/renderers/motion-graphic-renderer');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-output-'));
}

function realExecution(elements, options = {}) {
  const beat = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'MOTION_GRAPHIC' });
  return execute({ beat, selectedMaterial: { candidate: 'M1' }, options: { elements, duration: 5, ...options } });
}

// --- one test per primitive kind -------------------------------------------------------------------

test('1. RECTANGLE renders a real <rect> element', () => {
  const ex = realExecution([{ kind: 'RECTANGLE', position: { x: 0.5, y: 0.5 }, props: { width: 200, height: 100, color: '#ff0000' } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'COMPLETED');
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<rect x="-100" y="-50" width="200" height="100" rx="0" fill="#ff0000"\/>/);
});

test('2. CIRCLE renders a real <circle> element', () => {
  const ex = realExecution([{ kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: { radius: 60, color: '#00ff00' } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<circle cx="0" cy="0" r="60" fill="#00ff00"\/>/);
});

test('3. LINE renders a real <line> element', () => {
  const ex = realExecution([{ kind: 'LINE', position: { x: 0.5, y: 0.5 }, props: { dx: 100, dy: 0 } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<line x1="0" y1="0" x2="100" y2="0"/);
});

test('4. ARROW renders a line plus an arrowhead polygon', () => {
  const ex = realExecution([{ kind: 'ARROW', position: { x: 0.5, y: 0.5 }, props: { dx: 100, dy: 0 } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<line /);
  assert.match(svgText, /<polygon /);
});

test('5. TEXT renders a real, escaped <text> element', () => {
  const ex = realExecution([{ kind: 'TEXT', position: { x: 0.5, y: 0.5 }, props: { text: 'Growth <fast>', fontSize: 30 } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /Growth &lt;fast&gt;/);
});

test('6. BAR renders as a rectangle (same primitive family as RECTANGLE)', () => {
  const ex = realExecution([{ kind: 'BAR', position: { x: 0.5, y: 0.5 }, props: { width: 50, height: 200 } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<rect /);
});

test('7. PROGRESS_BAR renders a track rect + a filled rect proportional to progress', () => {
  const ex = realExecution([{ kind: 'PROGRESS_BAR', position: { x: 0.5, y: 0.5 }, props: { width: 400, height: 20, progress: 0.5, color: '#0000ff' } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /width="200" height="20" rx="10" fill="#0000ff"/);
});

test('8. CHART renders one bar per data point, tallest bar reaching full chart height', () => {
  const ex = realExecution([{ kind: 'CHART', position: { x: 0.5, y: 0.5 }, props: { data: [10, 20, 5], width: 300, height: 150, color: '#123456' } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const bars = [...svgText.matchAll(/<rect x="[\d.-]+" y="[\d.-]+" width="[\d.]+" height="([\d.]+)" fill="#123456"\/>/g)];
  assert.equal(bars.length, 3);
  assert.ok(bars.some((b) => Number(b[1]) === 150), 'the max-value bar must reach full chart height');
});

test('9. GROUP renders no shape of its own but does not fail', () => {
  const ex = realExecution([{ kind: 'GROUP', position: { x: 0.5, y: 0.5 }, props: {} }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'COMPLETED');
});

test('10. CONNECTOR renders like LINE/ARROW (a line + arrowhead)', () => {
  const ex = realExecution([{ kind: 'CONNECTOR', position: { x: 0.5, y: 0.5 }, props: { dx: 80, dy: 40 } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<polygon /);
});

// --- sequencing/opacity/rotation/scale -------------------------------------------------------------------

test('11. each element gets a position/rotation/scale transform and a sequence-timed opacity animation', () => {
  const ex = realExecution([{ kind: 'CIRCLE', position: { x: 0.25, y: 0.75 }, rotation: 45, scale: 2, opacity: 0.8, props: { radius: 10 }, sequence: { startOffset: 1, endOffset: 3 } }]);
  const result = renderer.render({ executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /translate\(480 810\) rotate\(45\) scale\(2\)/);
  assert.match(svgText, /values="0;0\.8"/);
  assert.match(svgText, /begin="1s"/);
});

// --- failure codes -------------------------------------------------------------------

test('12. renderSpec.type !== MOTION_GRAPHIC fails with INVALID_RENDER_SPEC', () => {
  const result = renderer.render({ executionResult: createExecutionResult({ renderSpec: { type: 'WHITEBOARD' }, status: 'COMPLETED' }), outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('13. an element with an unsupported/missing required prop (TEXT with no text, CHART with no data) fails with INVALID_ELEMENT', () => {
  const noText = realExecution([{ kind: 'TEXT', position: { x: 0.5, y: 0.5 }, props: {} }]);
  const r1 = renderer.render({ executionResult: noText, outputDir: outDir() });
  assert.equal(r1.diagnostics[0].code, 'INVALID_ELEMENT');

  const noData = realExecution([{ kind: 'CHART', position: { x: 0.5, y: 0.5 }, props: {} }]);
  const r2 = renderer.render({ executionResult: noData, outputDir: outDir() });
  assert.equal(r2.diagnostics[0].code, 'INVALID_ELEMENT');
});

test('14. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const ex = realExecution([{ kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: {} }]);
  const result = renderer.render({ executionResult: ex });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

// --- determinism -------------------------------------------------------------------

test('15. determinism — identical input produces an identical SVG across repeated calls', () => {
  const ex = realExecution([
    { kind: 'RECTANGLE', position: { x: 0.3, y: 0.3 }, props: { width: 100, height: 50 } },
    { kind: 'TEXT', position: { x: 0.6, y: 0.6 }, props: { text: 'x' } },
  ]);
  const first = renderer.render({ executionResult: ex, outputDir: outDir() });
  const second = renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(fs.readFileSync(first.artifact.path, 'utf8'), fs.readFileSync(second.artifact.path, 'utf8'));
});

test('16. renderSpec is never mutated by rendering', () => {
  const ex = realExecution([{ kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: { radius: 40 } }]);
  const before = JSON.stringify(ex.renderSpec);
  renderer.render({ executionResult: ex, outputDir: outDir() });
  assert.equal(JSON.stringify(ex.renderSpec), before);
});

// --- security -------------------------------------------------------------------

test('17. no MOTION_GRAPHIC_PRIMITIVES value is ever expanded beyond the executor\'s own list', () => {
  const { MOTION_GRAPHIC_PRIMITIVES } = require('../services/material-executors/motion-graphic-executor');
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'motion-graphic-renderer.js'), 'utf8');
  const caseMatches = [...text.matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1]);
  for (const kind of caseMatches) {
    assert.ok(MOTION_GRAPHIC_PRIMITIVES.includes(kind), `${kind} is not one of MOTION_GRAPHIC_PRIMITIVES`);
  }
});

test('18. services/renderers/motion-graphic-renderer.js has no eval/new Function/child_process/network call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'motion-graphic-renderer.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});
