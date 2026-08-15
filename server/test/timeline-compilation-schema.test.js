// Tests for schemas/timeline-compilation-schema.js — plain object factories
// only, no file I/O, no persistence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  TIMELINE_COMPILATION_STATUSES,
  createCompilationDiagnostic,
  createCompiledTransition,
  createTimelineCompilationResult,
} = require('../schemas/timeline-compilation-schema');

test('1. TIMELINE_COMPILATION_STATUSES is exactly COMPILED/PARTIAL/FAILED', () => {
  assert.deepEqual(TIMELINE_COMPILATION_STATUSES, ['COMPILED', 'PARTIAL', 'FAILED']);
});

test('2. createCompilationDiagnostic defaults', () => {
  const d = createCompilationDiagnostic();
  assert.equal(d.code, null);
  assert.equal(d.message, '');
  assert.equal(d.beatId, null);
  assert.equal(d.materialId, null);
});

test('3. createCompilationDiagnostic overrides', () => {
  const d = createCompilationDiagnostic({ code: 'UNRESOLVED_BEAT', message: 'x', beatId: 'b1', materialId: 'm1' });
  assert.equal(d.code, 'UNRESOLVED_BEAT');
  assert.equal(d.message, 'x');
  assert.equal(d.beatId, 'b1');
  assert.equal(d.materialId, 'm1');
});

test('4. createCompiledTransition defaults', () => {
  const t = createCompiledTransition();
  assert.equal(t.fromBeatId, null);
  assert.equal(t.toBeatId, null);
  assert.equal(t.kind, null);
  assert.equal(t.note, null);
});

test('5. createCompiledTransition overrides', () => {
  const t = createCompiledTransition({ fromBeatId: 'b1', toBeatId: 'b2', kind: 'TRANSITIONS_TO', note: 'cross-fade' });
  assert.equal(t.fromBeatId, 'b1');
  assert.equal(t.toBeatId, 'b2');
  assert.equal(t.kind, 'TRANSITIONS_TO');
  assert.equal(t.note, 'cross-fade');
});

test('6. createTimelineCompilationResult defaults', () => {
  const r = createTimelineCompilationResult();
  assert.ok(r.id);
  assert.equal(r.projectId, null);
  assert.equal(r.status, null);
  assert.deepEqual(r.shots, []);
  assert.deepEqual(r.transitions, []);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.createdAt);
});

test('7. createTimelineCompilationResult assigns a fresh, unique id every call', () => {
  const a = createTimelineCompilationResult();
  const b = createTimelineCompilationResult();
  assert.notEqual(a.id, b.id);
});

test('8. createTimelineCompilationResult has no version/history/cost/provider fields — a computed snapshot', () => {
  const r = createTimelineCompilationResult();
  for (const key of ['version', 'history', 'updatedBy', 'changeNote', 'provider', 'model', 'cost', 'estimatedCost']) {
    assert.equal(key in r, false, `unexpected field "${key}"`);
  }
});

test('9. no totalScore field anywhere — this file never invents a ranking score', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'timeline-compilation-schema.js'), 'utf8');
  assert.doesNotMatch(text, /totalScore\s*[:=]/);
});

test('10. requires nothing but crypto — no file I/O, no provider knowledge', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'timeline-compilation-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
});

test('11. never mentions a specific provider or model name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'timeline-compilation-schema.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai', 'ffmpeg', 'hyperframes']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference "${forbidden}"`);
  }
});
