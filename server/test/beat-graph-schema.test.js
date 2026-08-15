// Tests for schemas/beat-graph-schema.js — plain object factories only,
// no file I/O, no provider knowledge. Mirrors keyframe-schema.test.js's
// style.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BEAT_EDGE_KINDS, createBeatEdge, createBeatGraph } = require('../schemas/beat-graph-schema');
const { createVisualBeat } = require('../schemas/visual-beat-schema');

// --- 1. BeatGraph defaults --------------------------------------------------

test('1. createBeatGraph fills in versioning defaults and empty beats/edges arrays', () => {
  const graph = createBeatGraph({ projectId: 'p1' });
  assert.equal(graph.projectId, 'p1');
  assert.deepEqual(graph.beats, []);
  assert.deepEqual(graph.edges, []);
  assert.equal(graph.version, 1);
  assert.deepEqual(graph.history, []);
  assert.equal(graph.changeNote, null);
  assert.equal(graph.updatedBy, null);
});

test('createBeatGraph never lets an explicit undefined override a default', () => {
  const graph = createBeatGraph({ beats: undefined });
  assert.deepEqual(graph.beats, []);
});

// --- 2. Flat-array-plus-foreign-key convention ------------------------------------

test('2a. beats is a flat array — a beat carries its own sceneId/shotId/sequence rather than being nested inside a scene', () => {
  const beatA = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-1', sequence: 1 });
  const beatB = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-2', sequence: 2 });
  const beatC = createVisualBeat({ sceneId: 'sc-2', shotId: 'sh-3', sequence: 1 });
  const graph = createBeatGraph({ projectId: 'p1', beats: [beatA, beatB, beatC] });

  assert.equal(graph.beats.length, 3);
  // "beats grouped into scenes" is just a filter+sort over the flat array —
  // no nesting/hierarchy is required or provided by this schema
  const scene1Beats = graph.beats.filter((b) => b.sceneId === 'sc-1').sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(scene1Beats.map((b) => b.shotId), ['sh-1', 'sh-2']);
  const scene2Beats = graph.beats.filter((b) => b.sceneId === 'sc-2');
  assert.equal(scene2Beats.length, 1);
});

// --- 3. Beat edges -----------------------------------------------------------------

test('3a. BEAT_EDGE_KINDS is the exact fixed vocabulary', () => {
  assert.deepEqual(BEAT_EDGE_KINDS, ['CONTINUITY', 'DEPENDS_ON', 'ALTERNATE_OF', 'TRANSITIONS_TO']);
});

test('3b. createBeatEdge fills in every field with a safe default and a fresh unique id', () => {
  const edge = createBeatEdge();
  assert.ok(edge.edgeId);
  assert.equal(edge.fromBeatId, null);
  assert.equal(edge.toBeatId, null);
  assert.equal(edge.kind, null);
  assert.equal(edge.note, null);

  const other = createBeatEdge();
  assert.notEqual(edge.edgeId, other.edgeId);
});

test('3c. every BEAT_EDGE_KINDS value can be set on a real edge between two beats', () => {
  const a = createVisualBeat();
  const b = createVisualBeat();
  for (const kind of BEAT_EDGE_KINDS) {
    const edge = createBeatEdge({ fromBeatId: a.id, toBeatId: b.id, kind });
    assert.equal(edge.kind, kind);
  }
});

// --- 4. Concrete continuity/dependency/fallback graph example -----------------------

test('4. a graph can express continuity, dependency, and fallback relationships without a second timeline system', () => {
  const establishOffice = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-1', sequence: 1, narrativePurpose: 'Establish the office' });
  const novaEnters = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-2', sequence: 2, narrativePurpose: 'Nova enters' });
  const novaCloseUp = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-2', sequence: 3, narrativePurpose: 'Close-up of Nova' });
  const novaOpensDoor = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-3', sequence: 4, narrativePurpose: 'Nova opens the door' });
  const novaOpensDoorFallback = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-3', sequence: 4, narrativePurpose: 'Nova opens the door (still-image fallback)' });

  const edges = [
    createBeatEdge({ fromBeatId: establishOffice.id, toBeatId: novaEnters.id, kind: 'TRANSITIONS_TO' }),
    createBeatEdge({ fromBeatId: novaEnters.id, toBeatId: novaCloseUp.id, kind: 'CONTINUITY', note: 'same wardrobe/lighting as the entrance' }),
    createBeatEdge({ fromBeatId: novaCloseUp.id, toBeatId: novaOpensDoor.id, kind: 'DEPENDS_ON', note: 'the door beat needs the established identity lock' }),
    createBeatEdge({ fromBeatId: novaOpensDoor.id, toBeatId: novaOpensDoorFallback.id, kind: 'ALTERNATE_OF', note: 'only placed if the AI_VIDEO generation fails' }),
  ];

  const graph = createBeatGraph({
    projectId: 'p1',
    beats: [establishOffice, novaEnters, novaCloseUp, novaOpensDoor, novaOpensDoorFallback],
    edges,
  });

  assert.equal(graph.beats.length, 5);
  assert.equal(graph.edges.length, 4);

  const continuityEdges = graph.edges.filter((e) => e.kind === 'CONTINUITY');
  assert.equal(continuityEdges.length, 1);
  assert.equal(continuityEdges[0].fromBeatId, novaEnters.id);

  const alternateEdges = graph.edges.filter((e) => e.kind === 'ALTERNATE_OF');
  assert.equal(alternateEdges.length, 1);
  assert.equal(alternateEdges[0].toBeatId, novaOpensDoorFallback.id);
});

// --- 5. Provider neutrality / shape discipline -----------------------------------------

test('5a. schemas/beat-graph-schema.js has no require() of any provider, generation, or approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'beat-graph-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate|google/i.test(req), `unexpected import: ${req}`);
  }
});

test('5b. schemas/beat-graph-schema.js never mentions a specific provider or model name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'beat-graph-schema.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference provider/model "${forbidden}"`);
  }
});

test('5c. schemas/beat-graph-schema.js does no file I/O — the only require is crypto', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'beat-graph-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
});

test('5d. beat-graph-schema.js is not a general-purpose graph engine — no cycle-detection/traversal helpers are exported (that belongs to a future service, not this schema)', () => {
  const exported = require('../schemas/beat-graph-schema');
  const fnNames = Object.keys(exported);
  assert.deepEqual(fnNames.sort(), ['BEAT_EDGE_KINDS', 'createBeatEdge', 'createBeatGraph'].sort());
});
