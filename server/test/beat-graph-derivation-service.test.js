// Tests for services/beat-graph-derivation-service.js — P0-1, the
// Storyboard -> BeatGraph bridge. Pure/deterministic — no persistence, no
// network, no provider, no Material Resolution/Execution call anywhere in
// this file's exercised code path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-beatgraph-derivation-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-beatgraph-derivation-creative-'));
process.env.CREATIVE_DATA_DIR = creativeTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const { createStoryboard, createStoryboardScene, createStoryboardShot, createVisualBible, createCharacter, createLocation, createProp } = require('../schemas/creative-schema');
const { VISUAL_TREATMENTS } = require('../schemas/visual-beat-schema');
const { deriveBeatGraph } = require('../services/beat-graph-derivation-service');

function board(overrides = {}) {
  return createStoryboard({ projectId: 'p1', ...overrides });
}

// --- 1. valid storyboard -> BeatGraph -------------------------------------------------------------------

test('1. a valid storyboard produces a DERIVED BeatGraph', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.derivedBeatCount, 1);
  assert.equal(result.rejectedBeatCount, 0);
  assert.ok(result.beatGraph);
});

// --- 2. one shot -> one beat -------------------------------------------------------------------

test('2. exactly one shot produces exactly one beat, never split', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, visualDescription: 'a very long shot with multiple distinct actions happening in sequence over its duration' });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats.length, 1);
});

// --- 3. multiple scenes/shots -------------------------------------------------------------------

test('3. multiple scenes and shots all derive correctly', () => {
  const scene1 = createStoryboardScene({ title: 'S1' });
  const scene2 = createStoryboardScene({ title: 'S2' });
  const shots = [
    createStoryboardShot({ sceneId: scene1.sceneId, order: 1, duration: 3 }),
    createStoryboardShot({ sceneId: scene1.sceneId, order: 2, duration: 3 }),
    createStoryboardShot({ sceneId: scene2.sceneId, order: 1, duration: 5 }),
  ];
  const result = deriveBeatGraph(board({ scenes: [scene1, scene2], shots }));
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.derivedBeatCount, 3);
  assert.equal(result.beatGraph.beats.filter((b) => b.sceneId === scene1.sceneId).length, 2);
  assert.equal(result.beatGraph.beats.filter((b) => b.sceneId === scene2.sceneId).length, 1);
});

// --- 4. stable shot/beat identity -------------------------------------------------------------------

test('4. beat.id and beat.shotId both equal the source shot.shotId', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  const beat = result.beatGraph.beats[0];
  assert.equal(beat.id, shot.shotId);
  assert.equal(beat.shotId, shot.shotId);
});

// --- 5. scene mapping -------------------------------------------------------------------

test('5. beat.sceneId is copied directly from shot.sceneId', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].sceneId, scene.sceneId);
});

// --- 6. sequence mapping -------------------------------------------------------------------

test('6. beat.sequence is copied from shot.order (ordinal, not temporal)', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, order: 7 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].sequence, 7);
});

// --- 7. narrative-purpose mapping -------------------------------------------------------------------

test('7. beat.narrativePurpose derives from shot.purpose, falling back to narrativeBeat', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shotWithPurpose = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, purpose: 'establish the setting' });
  const r1 = deriveBeatGraph(board({ scenes: [scene], shots: [shotWithPurpose] }));
  assert.equal(r1.beatGraph.beats[0].narrativePurpose, 'establish the setting');

  const shotWithBeatOnly = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, narrativeBeat: 'the turn' });
  const r2 = deriveBeatGraph(board({ scenes: [scene], shots: [shotWithBeatOnly] }));
  assert.equal(r2.beatGraph.beats[0].narrativePurpose, 'the turn');
});

// --- 8. identity-reference mapping -------------------------------------------------------------------

test('8. character/location/prop references map directly into identityRequirements', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({
    sceneId: scene.sceneId, duration: 4,
    characterReferences: ['char-1', 'char-2'], locationReferences: ['loc-1'], propReferences: ['prop-1'],
  });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  const beat = result.beatGraph.beats[0];
  assert.deepEqual(beat.identityRequirements.characterReferences, ['char-1', 'char-2']);
  assert.deepEqual(beat.identityRequirements.locationReferences, ['loc-1']);
  assert.deepEqual(beat.identityRequirements.propReferences, ['prop-1']);
});

// --- 9. continuity mapping -------------------------------------------------------------------

test('9. beat.continuityRequirements is copied directly from shot.continuityRequirements', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, continuityRequirements: ['red jacket', 'scar on left cheek'] });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.deepEqual(result.beatGraph.beats[0].continuityRequirements, ['red jacket', 'scar on left cheek']);
});

// --- 10. transition mapping -------------------------------------------------------------------

test('10. beat.transition is copied directly from shot.transition', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, transition: 'crossfade' });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].transition, 'crossfade');
});

// --- 11. duration mapping -------------------------------------------------------------------

test('11. beat.duration is copied directly from shot.duration', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 6.5 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].duration, 6.5);
});

// --- 12. missing duration -------------------------------------------------------------------

test('12. a missing duration is non-fatal — beat is still created with duration null and a SHOT_DURATION_MISSING diagnostic', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.beatGraph.beats[0].duration, null);
  assert.ok(result.diagnostics.some((d) => d.code === 'SHOT_DURATION_MISSING' && d.shotId === shot.shotId));
});

// --- 13. invalid duration -------------------------------------------------------------------

test('13. an invalid duration (negative) rejects that beat with SHOT_DURATION_INVALID', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: -3 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.derivedBeatCount, 0);
  assert.equal(result.rejectedBeatCount, 1);
  assert.ok(result.diagnostics.some((d) => d.code === 'SHOT_DURATION_INVALID' && d.shotId === shot.shotId));
});

test('13b. a zero duration is also invalid (must be strictly positive)', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 0 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.ok(result.diagnostics.some((d) => d.code === 'SHOT_DURATION_INVALID'));
});

// --- 14. order is not converted into startTime -------------------------------------------------------------------

test('14. beat.startTime is ALWAYS null, even when shot.order is set — order is ordinal, never temporal', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, order: 3 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].startTime, null);
});

// --- 15. explicit treatment override -------------------------------------------------------------------

test('15. an explicit context.treatments entry sets beat.visualTreatment', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { treatments: { [shot.shotId]: 'BROLL_CLIP' } });
  assert.equal(result.beatGraph.beats[0].visualTreatment, 'BROLL_CLIP');
});

// --- 16. explicit narration override -------------------------------------------------------------------

test('16. an explicit context.narrationSegments entry sets beat.narrationSegment', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { narrationSegments: { [shot.shotId]: { text: 'Hello world', scriptRefId: 'script-1' } } });
  const seg = result.beatGraph.beats[0].narrationSegment;
  assert.equal(seg.text, 'Hello world');
  assert.equal(seg.scriptRefId, 'script-1');
});

// --- 17. treatment is never inferred -------------------------------------------------------------------

test('17. visualTreatment stays null even for strongly suggestive wording, with no context.treatments supplied', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({
    sceneId: scene.sceneId, duration: 4,
    visualDescription: 'AI generated video of the hero running through whiteboard motion graphics with kinetic typography captions',
  });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].visualTreatment, null);
});

test('17b. an unsupplied shot in the treatments map still leaves that beat\'s visualTreatment null', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot1 = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const shot2 = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot1, shot2] }), { treatments: { [shot1.shotId]: 'STILL_IMAGE' } });
  const beat2 = result.beatGraph.beats.find((b) => b.id === shot2.shotId);
  assert.equal(beat2.visualTreatment, null);
});

// --- 18. narration is never inferred -------------------------------------------------------------------

test('18. narrationSegment stays null even when soundNotes contains text, with no context.narrationSegments supplied', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, soundNotes: 'narrator says: this changes everything' });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.beatGraph.beats[0].narrationSegment, null);
});

// --- 19. missing visual intent -------------------------------------------------------------------

test('19. all of purpose/narrativeBeat/visualDescription empty emits non-fatal MISSING_VISUAL_INTENT', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.status, 'DERIVED');
  assert.ok(result.diagnostics.some((d) => d.code === 'MISSING_VISUAL_INTENT' && d.shotId === shot.shotId));
});

test('19b. a shot with a real purpose does NOT get MISSING_VISUAL_INTENT', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, purpose: 'establish tone' });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.diagnostics.some((d) => d.code === 'MISSING_VISUAL_INTENT'), false);
});

// --- 20. duplicate shot order -------------------------------------------------------------------

test('20. two shots in the same scene sharing an order value emit non-fatal DUPLICATE_SHOT_ORDER, ordering unchanged', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot1 = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, order: 1 });
  const shot2 = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, order: 1 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot1, shot2] }));
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.derivedBeatCount, 2);
  assert.ok(result.diagnostics.some((d) => d.code === 'DUPLICATE_SHOT_ORDER' && d.shotId === shot1.shotId));
  assert.ok(result.diagnostics.some((d) => d.code === 'DUPLICATE_SHOT_ORDER' && d.shotId === shot2.shotId));
  assert.equal(result.beatGraph.beats.find((b) => b.id === shot1.shotId).sequence, 1);
  assert.equal(result.beatGraph.beats.find((b) => b.id === shot2.shotId).sequence, 1);
});

test('20b. shots in DIFFERENT scenes sharing an order value is not a duplicate', () => {
  const scene1 = createStoryboardScene({ title: 'S1' });
  const scene2 = createStoryboardScene({ title: 'S2' });
  const shot1 = createStoryboardShot({ sceneId: scene1.sceneId, duration: 4, order: 1 });
  const shot2 = createStoryboardShot({ sceneId: scene2.sceneId, duration: 4, order: 1 });
  const result = deriveBeatGraph(board({ scenes: [scene1, scene2], shots: [shot1, shot2] }));
  assert.equal(result.diagnostics.some((d) => d.code === 'DUPLICATE_SHOT_ORDER'), false);
});

// --- 21. malformed storyboard -------------------------------------------------------------------

test('21. a malformed storyboard (no shots array) fails the whole derivation', () => {
  const result = deriveBeatGraph({ projectId: 'p1', scenes: [] });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.beatGraph, null);
  assert.equal(result.diagnostics[0].code, 'INVALID_STORYBOARD');
});

test('21b. null/undefined storyboard never throws', () => {
  assert.doesNotThrow(() => {
    const r1 = deriveBeatGraph(null);
    assert.equal(r1.status, 'FAILED');
    const r2 = deriveBeatGraph(undefined);
    assert.equal(r2.status, 'FAILED');
  });
});

// --- 22. empty storyboard -------------------------------------------------------------------

test('22. an empty storyboard (zero shots) is DERIVED with zero beats, not an error', () => {
  const result = deriveBeatGraph(board({ scenes: [], shots: [] }));
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.derivedBeatCount, 0);
  assert.equal(result.beatGraph.beats.length, 0);
});

// --- 23/24/25. unknown identity references -------------------------------------------------------------------

test('23. an unknown character reference rejects that beat with UNKNOWN_CHARACTER_REFERENCE', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, characterReferences: ['ghost-char'] });
  const visualBible = createVisualBible({ characters: [createCharacter({ characterId: 'real-char' })] });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { visualBible });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.diagnostics.some((d) => d.code === 'UNKNOWN_CHARACTER_REFERENCE' && d.shotId === shot.shotId));
});

test('24. an unknown location reference rejects that beat with UNKNOWN_LOCATION_REFERENCE', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, locationReferences: ['ghost-loc'] });
  const visualBible = createVisualBible({ locations: [createLocation({ locationId: 'real-loc' })] });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { visualBible });
  assert.ok(result.diagnostics.some((d) => d.code === 'UNKNOWN_LOCATION_REFERENCE'));
});

test('25. an unknown prop reference rejects that beat with UNKNOWN_PROP_REFERENCE', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, propReferences: ['ghost-prop'] });
  const visualBible = createVisualBible({ props: [createProp({ propId: 'real-prop' })] });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { visualBible });
  assert.ok(result.diagnostics.some((d) => d.code === 'UNKNOWN_PROP_REFERENCE'));
});

test('25b. identity references are left unchecked (no rejection) when no visualBible is supplied', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, characterReferences: ['whoever'] });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.diagnostics.some((d) => d.code === 'UNKNOWN_CHARACTER_REFERENCE'), false);
});

test('25c. a real, known reference is accepted', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, characterReferences: ['real-char'] });
  const visualBible = createVisualBible({ characters: [createCharacter({ characterId: 'real-char' })] });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { visualBible });
  assert.equal(result.status, 'DERIVED');
});

// --- 26. partial failure -------------------------------------------------------------------

test('26. a storyboard with some valid and some invalid shots is PARTIAL — one bad beat never destroys the good ones', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const goodShot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const badShot = createStoryboardShot({ sceneId: scene.sceneId, duration: -1 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [goodShot, badShot] }));
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.derivedBeatCount, 1);
  assert.equal(result.rejectedBeatCount, 1);
  assert.ok(result.beatGraph.beats.some((b) => b.id === goodShot.shotId));
});

// --- 27. deterministic repeated derivation -------------------------------------------------------------------

test('27. identical (storyboard, context) produces an identical BeatGraph across repeated calls (timestamps aside)', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({
    sceneId: scene.sceneId, duration: 4, order: 1, purpose: 'x', camera: 'wide',
    characterReferences: ['c1'], continuityRequirements: ['r1'], transition: 'cut',
  });
  const storyboard = board({ scenes: [scene], shots: [shot] });
  const context = { treatments: { [shot.shotId]: 'STILL_IMAGE' }, narrationSegments: { [shot.shotId]: { text: 'hi' } } };

  const strip = (r) => {
    const beats = r.beatGraph.beats.map(({ updatedAt, ...rest }) => rest);
    return JSON.stringify({ status: r.status, diagnostics: r.diagnostics, beats });
  };

  const a = deriveBeatGraph(storyboard, context);
  const b = deriveBeatGraph(storyboard, context);
  assert.equal(strip(a), strip(b));
});

// --- 28. source Storyboard remains byte-identical -------------------------------------------------------------------

test('28. the source Storyboard object is never mutated by derivation', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4, characterReferences: ['c1'] });
  const storyboard = board({ scenes: [scene], shots: [shot] });
  const before = JSON.stringify(storyboard);
  deriveBeatGraph(storyboard, { treatments: { [shot.shotId]: 'STILL_IMAGE' } });
  assert.equal(JSON.stringify(storyboard), before);
});

// --- 29. no persistence -------------------------------------------------------------------

test('29. no persistence — services/beat-graph-derivation-service.js requires no fs/store module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'beat-graph-derivation-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../schemas/beat-graph-schema', '../schemas/visual-beat-schema'].sort());
});

// --- 30. no external/network calls -------------------------------------------------------------------

test('30. security — no network/child_process/eval/provider call anywhere in the file', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'beat-graph-derivation-service.js'), 'utf8');
  const text = fullText.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

// --- 31. no provider/model names -------------------------------------------------------------------

test('31. no provider/model name anywhere in the file\'s actual code (comments may explain what is deliberately NOT called)', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'beat-graph-derivation-service.js'), 'utf8');
  const text = fullText.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const pattern of [/elevenlabs/i, /openai/i, /evolink/i, /whisper/i, /espeak/i, /seedance/i, /hyperframes/i]) {
    assert.doesNotMatch(text, pattern);
  }
});

// --- 32. no second timeline -------------------------------------------------------------------

test('32. output uses the real production BeatGraph/VisualBeat shape, never an invented parallel one', () => {
  const { createBeatGraph } = require('../schemas/beat-graph-schema');
  const { createVisualBeat } = require('../schemas/visual-beat-schema');
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }));

  assert.deepEqual(Object.keys(result.beatGraph).sort(), Object.keys(createBeatGraph()).sort());
  assert.deepEqual(Object.keys(result.beatGraph.beats[0]).sort(), Object.keys(createVisualBeat()).sort());
});

// --- 33. real repository fixture integration -------------------------------------------------------------------

test('33. real pipeline — a storyboard built through the real creativeStore/projectStore derives correctly', () => {
  const project = projectStore.createProject({ title: 'P0-1 fixture', topic: 'bridge proof' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Opening' });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    purpose: 'establish the setting',
    characterReferences: ['char-1'],
    locationReferences: ['loc-1'],
    duration: 5,
    camera: 'wide establishing',
    lighting: 'golden hour',
    continuityRequirements: ['red jacket'],
    transition: 'cut',
  });

  const storyboard = creativeStore.getStoryboard(project.id);
  assert.equal(storyboard.shots.length, 1);

  const result = deriveBeatGraph(storyboard);
  assert.equal(result.status, 'DERIVED');
  const beat = result.beatGraph.beats[0];
  assert.equal(beat.id, shot.shotId);
  assert.equal(beat.shotId, shot.shotId);
  assert.equal(beat.sceneId, scene.sceneId);
  assert.equal(beat.narrativePurpose, 'establish the setting');
  assert.equal(beat.duration, 5);
  assert.equal(beat.camera, 'wide establishing');
  assert.equal(beat.lighting, 'golden hour');
  assert.deepEqual(beat.identityRequirements.characterReferences, ['char-1']);
  assert.deepEqual(beat.identityRequirements.locationReferences, ['loc-1']);
  assert.deepEqual(beat.continuityRequirements, ['red jacket']);
  assert.equal(beat.transition, 'cut');
  assert.equal(beat.visualTreatment, null);
  assert.equal(beat.narrationSegment, null);
  assert.equal(beat.startTime, null);

  // the real Storyboard on disk is untouched by derivation
  const after = creativeStore.getStoryboard(project.id);
  assert.deepEqual(after, storyboard);
});

test('34. every VISUAL_TREATMENTS value is accepted as an explicit override, and an invalid one is rejected', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  for (const treatment of VISUAL_TREATMENTS) {
    const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
    const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { treatments: { [shot.shotId]: treatment } });
    assert.equal(result.beatGraph.beats[0].visualTreatment, treatment);
  }
  const badShot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const badResult = deriveBeatGraph(board({ scenes: [scene], shots: [badShot] }), { treatments: { [badShot.shotId]: 'NOT_A_REAL_TREATMENT' } });
  assert.equal(badResult.status, 'FAILED');
  assert.ok(badResult.diagnostics.some((d) => d.code === 'INVALID_VISUAL_TREATMENT'));
});

test('35. a malformed context.treatments/narrationSegments/visualBible is reported and ignored, never fatal', () => {
  const scene = createStoryboardScene({ title: 'S1' });
  const shot = createStoryboardShot({ sceneId: scene.sceneId, duration: 4 });
  const result = deriveBeatGraph(board({ scenes: [scene], shots: [shot] }), { treatments: 'not-an-object', visualBible: [] });
  assert.equal(result.status, 'DERIVED');
  assert.ok(result.diagnostics.some((d) => d.code === 'INVALID_CONTEXT'));
  assert.equal(result.beatGraph.beats[0].visualTreatment, null);
});
