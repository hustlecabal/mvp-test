// Tests for services/creative-production-compiler-service.js — the
// Canonical Creative Production Contract -> real Storyboard+context
// compiler. Pure object factories + pure compiler function, no file I/O,
// no network, matching this codebase's established test conventions.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/creative-schema');
const { compileCreativeProjectToTimeline } = require('../services/creative-production-compiler-service');

function scene(overrides) {
  return schema.createStoryboardScene(overrides);
}
function shot(overrides) {
  return schema.createStoryboardShot(overrides);
}
function unit(overrides) {
  return schema.createGenerationUnit(overrides);
}

// 1. One shot / one GenerationUnit
test('1. a single shot with a single GenerationUnit compiles to exactly one compiled shot', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', duration: 6, generationUnitIds: ['g1'] });
  const u = unit({ id: 'g1', shotId: 'shot-1', order: 1, durationSeconds: 6 });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [u] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyboard.shots.length, 1);
  assert.equal(result.storyboard.shots[0].shotId, 'g1');
  assert.equal(result.storyboard.shots[0].duration, 6);
});

// 2. One 15-second shot / two GenerationUnits
test('2. a 15-second shot split into two GenerationUnits compiles to exactly two compiled shots', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', duration: 15, generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8 });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'a' });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyboard.shots.length, 2, 'must NOT collapse back into a single 15-second generation request');
  assert.deepEqual(result.storyboard.shots.map((sh2) => sh2.duration), [8, 7]);
});

// 3. Correct GenerationUnit ordering
test('3. compiled shots for a multi-unit creative shot preserve GenerationUnit order', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', duration: 15, generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8 });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7 });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitB, unitA] }; // deliberately unordered input

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true);
  const sorted = [...result.storyboard.shots].sort((x, y) => x.order - y.order);
  assert.equal(sorted[0].shotId, 'a');
  assert.equal(sorted[1].shotId, 'b');
});

// 4. Continuation relationship preserved
test('4. the continuesFromGenerationUnitId relationship is preserved as a DEPENDS_ON edge, never TRANSITIONS_TO', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', duration: 15, generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8, endFrameAssetId: 'frame-A' });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'a', startFrameAssetId: 'frame-A' });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true);
  const edge = result.context.edges.find((e) => e.fromShotId === 'a' && e.toShotId === 'b');
  assert.ok(edge, 'continuation edge must exist');
  assert.equal(edge.kind, 'DEPENDS_ON');
  assert.notEqual(edge.kind, 'TRANSITIONS_TO');
});

// 5. Start/end frame asset relationship preserved
test('5. the exact start/end frame asset relationship is preserved and reflected in the edge note', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8, endFrameAssetId: 'frame-final' });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'a', startFrameAssetId: 'frame-final' });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB], knownAssetIds: new Set(['frame-final']) };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const edge = result.context.edges.find((e) => e.fromShotId === 'a' && e.toShotId === 'b');
  assert.match(edge.note, /approved end frame \(frame-final\)/);
  // the units themselves, returned verbatim, still carry the exact ids:
  const unitBOut = result.generationUnitsById.get('b');
  assert.equal(unitBOut.startFrameAssetId, 'frame-final');
});

// 6. Character/location/prop references preserved
test('6. character/location/prop references are copied onto every compiled unit of a shot, never duplicating the canonical record', () => {
  const s = scene({ sceneId: 'scene-1', characterIds: ['mara'], locationId: 'kitchen', propIds: ['mug'] });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', characterReferences: ['mara'], locationReferences: ['kitchen'], propReferences: ['mug'], generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8 });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7 });
  const visualBible = schema.createVisualBible({ characters: [schema.createCharacter({ characterId: 'mara' })], locations: [schema.createLocation({ locationId: 'kitchen' })], props: [schema.createProp({ propId: 'mug' })] });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible, generationUnits: [unitA, unitB] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  for (const compiled of result.storyboard.shots) {
    assert.deepEqual(compiled.characterReferences, ['mara']);
    assert.deepEqual(compiled.locationReferences, ['kitchen']);
    assert.deepEqual(compiled.propReferences, ['mug']);
  }
  assert.equal(result.storyboard.projectId, null); // storyboard itself carries no duplicated Character/Location/Prop objects
  assert.equal(visualBible.characters.length, 1, 'the canonical Character record must not be duplicated by compilation');
});

// 7. Invalid >10-second GenerationUnit rejected before compilation
test('7. a >10-second GenerationUnit is rejected before any compilation happens', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', generationUnitIds: ['a'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 12 });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitA] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'GENERATION_UNIT_DURATION_EXCEEDS_MAXIMUM'));
  assert.equal(result.storyboard, undefined, 'no partial Timeline IR must be returned on a validation failure');
});

// 8. Invalid/dangling references rejected
test('8. a dangling character reference is rejected before any compilation happens', () => {
  const s = scene({ sceneId: 'scene-1', characterIds: ['ghost'] });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [] }), visualBible: schema.createVisualBible(), generationUnits: [] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'DANGLING_CHARACTER_REFERENCE'));
});

// 9. Multiple shots compile in correct timeline order
test('9. multiple shots across a scene compile with strictly increasing order, GenerationUnits nested within their parent shot\'s slot', () => {
  const s = scene({ sceneId: 'scene-1' });
  const shot1 = shot({ shotId: 'shot-1', sceneId: 'scene-1', order: 1, generationUnitIds: ['g1'] });
  const shot2 = shot({ shotId: 'shot-2', sceneId: 'scene-1', order: 2, generationUnitIds: ['g2a', 'g2b'] });
  const shot3 = shot({ shotId: 'shot-3', sceneId: 'scene-1', order: 3, generationUnitIds: ['g3'] });
  const units = [
    unit({ id: 'g1', shotId: 'shot-1', order: 1, durationSeconds: 6 }),
    unit({ id: 'g2a', shotId: 'shot-2', order: 1, durationSeconds: 8 }),
    unit({ id: 'g2b', shotId: 'shot-2', order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'g2a' }),
    unit({ id: 'g3', shotId: 'shot-3', order: 1, durationSeconds: 7 }),
  ];
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [shot1, shot2, shot3] }), visualBible: schema.createVisualBible(), generationUnits: units };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.storyboard.shots.length, 4);
  const sorted = [...result.storyboard.shots].sort((a, b) => a.order - b.order);
  assert.deepEqual(sorted.map((sh2) => sh2.shotId), ['g1', 'g2a', 'g2b', 'g3']);
  // every order value strictly increasing, no collisions:
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].order > sorted[i - 1].order);
});

// 10. Existing Timeline IR remains compatible with the current Production Orchestrator
test('10. the compiled Storyboard+context is exactly the shape beat-graph-derivation-service.js already accepts, unmodified', () => {
  const { deriveBeatGraph } = require('../services/beat-graph-derivation-service');
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', duration: 15, purpose: 'test', generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8 });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'a' });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB] };

  const result = compileCreativeProjectToTimeline(project);
  assert.equal(result.ok, true);

  // Passed straight into the REAL, UNMODIFIED deriveBeatGraph() — no adapter, no reshaping:
  const derivation = deriveBeatGraph(result.storyboard, result.context);
  assert.equal(derivation.status, 'DERIVED', JSON.stringify(derivation.diagnostics));
  assert.equal(derivation.beatGraph.beats.length, 2);
  assert.ok(derivation.beatGraph.edges.some((e) => e.fromBeatId === 'a' && e.toBeatId === 'b' && e.kind === 'DEPENDS_ON'));
});

// Idempotency (explicit, since it's a named milestone requirement)
test('IDEMPOTENCY — compiling the same canonical project twice produces identical compiled shot ids, order, and edges', () => {
  const s = scene({ sceneId: 'scene-1' });
  const sh = shot({ shotId: 'shot-1', sceneId: 'scene-1', duration: 15, generationUnitIds: ['a', 'b'] });
  const unitA = unit({ id: 'a', shotId: 'shot-1', order: 1, durationSeconds: 8, endFrameAssetId: 'f1' });
  const unitB = unit({ id: 'b', shotId: 'shot-1', order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'a', startFrameAssetId: 'f1' });
  const project = { storyboard: schema.createStoryboard({ scenes: [s], shots: [sh] }), visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB], knownAssetIds: new Set(['f1']) };

  const first = compileCreativeProjectToTimeline(project);
  const second = compileCreativeProjectToTimeline(project);
  assert.deepEqual(first.storyboard.shots.map((sh2) => ({ id: sh2.shotId, order: sh2.order, duration: sh2.duration })), second.storyboard.shots.map((sh2) => ({ id: sh2.shotId, order: sh2.order, duration: sh2.duration })));
  assert.deepEqual(first.context.edges, second.context.edges);
});
