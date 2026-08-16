// Stage 26.9, Part 15/16 — the required real pipeline proof:
//
//   Script (scriptRefId + text) -> real VisualBeat -> real BeatGraph ->
//   Narration Director -> NarrationDirection
//
// Every VisualBeat/BeatGraph here is built via the REAL Stage 26.1 schema
// factories (schemas/visual-beat-schema.js's createVisualBeat/
// createNarrationSegment, schemas/beat-graph-schema.js's createBeatGraph)
// — never a fabricated ad-hoc object — matching every other *-pipeline.test.js
// file's own discipline in this codebase (e.g. test/render-pipeline-
// integration.test.js, test/beat-graph-material-resolution.test.js).
//
// No Script schema exists in this repository (confirmed by this stage's
// Part 1 audit) — "Script" here is exactly what schemas/visual-beat-
// schema.js's own narrationSegment.scriptRefId/text fields already treat
// it as: a scriptRefId string plus narration text, authored directly on
// each beat's narrationSegment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisualBeat, createNarrationSegment } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { directNarration } = require('../services/narration-director-service');
const { createVoiceProfile } = require('../schemas/audio-schema');

// A small, real 3-beat script: HOOK -> EXPLANATION -> REVEAL, mirroring the
// task's own worked examples (Part 5's "£100,000" line, Part 8's
// HOOK/EXPLANATION/REVEAL arc).
function buildScript() {
  const scriptRefId = 'script-26.9-fixture';
  const beat1 = createVisualBeat({
    projectId: 'p1', sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 4,
    visualTreatment: 'STILL_IMAGE',
    narrationSegment: createNarrationSegment({ scriptRefId, text: 'What if everything you knew about saving money was wrong?' }),
  });
  const beat2 = createVisualBeat({
    projectId: 'p1', sceneId: 's1', shotId: 'sh2', sequence: 2, startTime: 4, duration: 6,
    visualTreatment: 'KINETIC_TYPOGRAPHY',
    narrationSegment: createNarrationSegment({ scriptRefId, text: 'Inflation quietly eats away at your savings every single year.' }),
  });
  const beat3 = createVisualBeat({
    projectId: 'p1', sceneId: 's1', shotId: 'sh3', sequence: 3, startTime: 10, duration: 5,
    visualTreatment: 'MOTION_GRAPHIC',
    narrationSegment: createNarrationSegment({ scriptRefId, text: "That £100,000 isn't actually worth £100,000." }),
  });
  const beatGraph = createBeatGraph({ projectId: 'p1', beats: [beat1, beat2, beat3] });
  return { scriptRefId, beatGraph, beats: [beat1, beat2, beat3] };
}

// --- 1. real pipeline: each beat's own narrationSegment feeds the Narration Director directly -------------------------------------------------------------------

test('1. real pipeline — Script -> VisualBeat -> BeatGraph -> Narration Director produces a distinct, structured NarrationDirection per beat', () => {
  const { scriptRefId, beatGraph } = buildScript();
  assert.equal(beatGraph.beats.length, 3);

  const roles = ['HOOK', 'EXPLANATION', 'REVEAL'];
  const directions = beatGraph.beats.map((beat, i) => {
    assert.equal(beat.narrationSegment.scriptRefId, scriptRefId, 'every beat in this real BeatGraph shares the same real scriptRefId');
    return directNarration({
      scriptRefId: beat.narrationSegment.scriptRefId,
      text: beat.narrationSegment.text,
      beats: [{ beatId: beat.id, narrativeRole: roles[i] }],
      targetWordsPerMinute: 150,
    });
  });

  for (const d of directions) {
    assert.equal(d.status, 'COMPLETED', d.diagnostics[0] && d.diagnostics[0].message);
    assert.equal(d.scriptRefId, scriptRefId);
  }

  // --- different emotional states across the arc (Part 8) ---
  assert.equal(directions[0].delivery.emotionalTone, 'CURIOUS'); // HOOK (also a real "?" question, reinforcing it)
  assert.equal(directions[1].delivery.emotionalTone, 'CONFIDENT'); // EXPLANATION
  assert.equal(directions[2].delivery.emotionalTone, 'SURPRISED'); // REVEAL
  assert.notEqual(directions[0].delivery.energy, directions[1].delivery.energy);

  // --- emphasis: the REVEAL beat's real narration text auto-detects both currency figures (Part 5) ---
  const revealEmphasis = directions[2].emphasis.filter((e) => e.reason === 'IMPORTANT_NUMBER');
  assert.equal(revealEmphasis.length, 2);
  assert.ok(revealEmphasis.every((e) => e.text === '£100,000'));

  // --- pauses: the REVEAL beat gets its automatic AFTER_REVEAL pause (Part 6) ---
  assert.ok(directions[2].pauses.some((p) => p.reason === 'AFTER_REVEAL'));

  // --- timing targets: every direction has a real target duration derived from its own word count (Part 9) ---
  for (const d of directions) {
    assert.ok(d.timing.target.duration > 0);
    assert.equal(d.timing.actual, null, 'no real audio exists yet — actual timing must stay null');
  }

  // --- voice profile: a real audio-schema.js VoiceProfile carried through a channel tier ---
  const voiceProfile = createVoiceProfile({ speakingStyle: 'conversational_documentary', emotionalTone: 'confident_curious', deliveryNotes: 'Sounds intelligent and conversational, never like a newsreader.' });
  const withVoice = directNarration({
    scriptRefId, text: beatGraph.beats[0].narrationSegment.text, beats: [{ beatId: beatGraph.beats[0].id, narrativeRole: 'HOOK' }],
    channelVoiceBible: { voiceProfile },
  });
  assert.deepEqual(withVoice.voiceProfile, voiceProfile);

  // Output is plain, inspectable JSON — no functions/class instances anywhere in the tree.
  const serialized = JSON.parse(JSON.stringify(directions));
  assert.equal(serialized.length, 3);
});

// --- 2. multi-beat single narration segment (a narration spanning >1 beat) -------------------------------------------------------------------

test('2. a single narration direction can legitimately span multiple real beats, tying an emotionalArc stage to each', () => {
  const { scriptRefId, beatGraph } = buildScript();
  const d = directNarration({
    scriptRefId,
    text: 'A combined line spanning the hook and the explanation beats.',
    beats: [
      { beatId: beatGraph.beats[0].id, narrativeRole: 'HOOK' },
      { beatId: beatGraph.beats[1].id, narrativeRole: 'EXPLANATION' },
    ],
  });
  assert.equal(d.status, 'COMPLETED');
  assert.deepEqual(d.beatIds, [beatGraph.beats[0].id, beatGraph.beats[1].id]);
  assert.equal(d.emotionalArc.length, 2);
  assert.equal(d.emotionalArc[0].beatId, beatGraph.beats[0].id);
  assert.equal(d.emotionalArc[1].beatId, beatGraph.beats[1].id);
  assert.notEqual(d.emotionalArc[0].delivery.emotionalTone, d.emotionalArc[1].delivery.emotionalTone);
});

// --- 3. Part 16 — consistency: same channel voice bible + same script characteristics + same rules -> same direction -------------------------------------------------------------------

test('3. consistency — the same channel voice bible + the same real script/beat fixture always produces the same NarrationDirection', () => {
  const { scriptRefId, beatGraph } = buildScript();
  const beat = beatGraph.beats[2]; // the REVEAL beat — exercises emphasis + auto-pause + role rules together
  const channelVoiceBible = { voiceProfile: createVoiceProfile({ accent: 'British', speakingStyle: 'documentary' }), delivery: { warmth: 7 } };

  const run = () => directNarration({
    scriptRefId, text: beat.narrationSegment.text, beats: [{ beatId: beat.id, narrativeRole: 'REVEAL' }],
    targetWordsPerMinute: 140, channelVoiceBible,
  });

  const a = run();
  const b = run();
  const c = run();
  const strip = ({ narrationId, createdAt, ...rest }) => JSON.stringify(rest);
  assert.equal(strip(a), strip(b));
  assert.equal(strip(b), strip(c));
});

// --- 4. Part 16 — a beat-level override changes only the intended field(s), proven against the real fixture -------------------------------------------------------------------

test('4. consistency — a beat-level override applied to the real fixture changes only the overridden field(s), leaving emphasis/pauses/voiceProfile/other delivery axes identical', () => {
  const { scriptRefId, beatGraph } = buildScript();
  const beat = beatGraph.beats[2];
  const channelVoiceBible = { voiceProfile: createVoiceProfile({ accent: 'British' }), delivery: { warmth: 7 } };
  const common = { scriptRefId, text: beat.narrationSegment.text, beats: [{ beatId: beat.id, narrativeRole: 'REVEAL' }], channelVoiceBible };

  const base = directNarration(common);
  const overridden = directNarration({ ...common, beatOverride: { delivery: { confidence: 2 } } });

  assert.equal(overridden.delivery.confidence, 2);
  assert.notEqual(overridden.delivery.confidence, base.delivery.confidence);
  for (const field of ['pace', 'emotionalTone', 'energy', 'intensity', 'warmth', 'urgency', 'conversationality']) {
    assert.equal(overridden.delivery[field], base.delivery[field], `field "${field}" must be unaffected by a confidence-only override`);
  }
  assert.deepEqual(overridden.voiceProfile, base.voiceProfile);
  assert.deepEqual(overridden.emphasis, base.emphasis);
  assert.deepEqual(overridden.pauses, base.pauses);
  assert.deepEqual(overridden.timing, base.timing);
});

// --- 5. no mutation of the real BeatGraph/VisualBeat objects -------------------------------------------------------------------

test('5. directNarration never mutates the VisualBeat/BeatGraph it reads from', () => {
  const { scriptRefId, beatGraph } = buildScript();
  const before = JSON.stringify(beatGraph);
  for (const beat of beatGraph.beats) {
    directNarration({ scriptRefId, text: beat.narrationSegment.text, beats: [{ beatId: beat.id, narrativeRole: 'EXPLANATION' }] });
  }
  assert.equal(JSON.stringify(beatGraph), before);
});
