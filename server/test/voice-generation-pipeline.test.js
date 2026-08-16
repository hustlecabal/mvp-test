// Stage 26.9B, Part 17/18 — the required real, complete pipeline proof:
//
//   existing script -> real VisualBeat -> real BeatGraph ->
//   real Narration Director -> human-approved NarrationDirection fixture ->
//   real voice generation -> real audio file -> real alignment ->
//   Transcript + WordTimestamp[] -> AudioEvent
//
// Every step uses the REAL Stage 26.1/26.9/26.9B modules — nothing here is
// mocked, and no timestamp is ever fabricated. Part 18 additionally proves
// explicitly that target duration != actual duration when they differ,
// and that the AudioEvent uses the real, measured value.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-voicegen-pipeline-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-voicegen-pipeline-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat, createNarrationSegment } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { directNarration } = require('../services/narration-director-service');
const { createVoiceProfile } = require('../schemas/audio-schema');
const { generateNarratedAudioEvent } = require('../services/voice-generation-service');

test('1. real pipeline — script -> VisualBeat -> BeatGraph -> Narration Director -> human-approved direction -> real voice generation -> real alignment -> AudioEvent', () => {
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.9B PIPELINE PROOF', topic: 'voice generation proof' });
  const scriptRefId = 'script-26.9b-fixture';

  // --- real VisualBeat, via the real Stage 26.1 factory ---
  const beat = createVisualBeat({
    projectId: project.id, sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 6,
    visualTreatment: 'MOTION_GRAPHIC',
    narrationSegment: createNarrationSegment({ scriptRefId, text: "That £100,000 isn't actually worth £100,000." }),
  });
  const beatGraph = createBeatGraph({ projectId: project.id, beats: [beat] });
  assert.equal(beatGraph.beats.length, 1);

  // --- real Narration Director, producing a SYSTEM-suggested direction first ---
  const systemDirection = directNarration({
    scriptRefId: beat.narrationSegment.scriptRefId,
    text: beat.narrationSegment.text,
    beats: [{ beatId: beat.id, narrativeRole: 'REVEAL' }],
    targetWordsPerMinute: 150,
  });
  assert.equal(systemDirection.status, 'COMPLETED');
  assert.ok(systemDirection.delivery.energy >= 7, 'REVEAL should default to a high system-suggested energy');

  // --- a human approves the direction but lowers the energy (Part 13) ---
  const voiceProfile = createVoiceProfile({ accent: 'British', speakingStyle: 'documentary', deliveryNotes: 'Sounds intelligent and conversational, never like a newsreader.' });
  const humanApprovedDirection = directNarration({
    scriptRefId: beat.narrationSegment.scriptRefId,
    text: beat.narrationSegment.text,
    beats: [{ beatId: beat.id, narrativeRole: 'REVEAL' }],
    targetWordsPerMinute: 150,
    channelVoiceBible: { voiceProfile },
    beatOverride: { delivery: { energy: 5 } },
  });
  assert.equal(humanApprovedDirection.status, 'COMPLETED');
  assert.equal(humanApprovedDirection.delivery.energy, 5, 'the human override must be reflected in the approved direction');
  assert.notEqual(humanApprovedDirection.delivery.energy, systemDirection.delivery.energy);

  // --- real voice generation + real alignment + AudioEvent ---
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: humanApprovedDirection });
  assert.equal(result.status, 'COMPLETED', result.diagnostics[0] && result.diagnostics[0].message);

  // --- real Asset ---
  assert.equal(result.asset.type, 'audio');
  assert.equal(result.asset.storage.status, 'STORED');
  assert.ok(fs.existsSync(path.join(assetStorageDir, result.asset.storage.path)));

  // --- real Transcript + WordTimestamp[] ---
  const { transcript } = result.audioEvent;
  assert.equal(transcript.text, beat.narrationSegment.text);
  assert.ok(transcript.words.length > 0);
  for (const w of transcript.words) {
    assert.ok(w.word.length > 0);
    assert.ok(typeof w.startTime === 'number' && w.startTime >= 0);
    assert.ok(typeof w.endTime === 'number' && w.endTime > w.startTime);
  }

  // --- real AudioEvent, correctly linked back through the whole chain ---
  assert.equal(result.audioEvent.scriptRefId, scriptRefId);
  assert.equal(result.audioEvent.beatId, beat.id);
  assert.deepEqual(result.audioEvent.voiceProfile, voiceProfile);
  assert.equal(result.audioEvent.sourceAssetId, result.asset.assetId);
  assert.equal(result.audioEvent.status, 'READY');

  // --- Part 18: target duration != actual duration, and AudioEvent uses actual ---
  const targetDuration = humanApprovedDirection.timing.target.duration;
  const actualDuration = result.audioEvent.duration;
  assert.ok(targetDuration > 0);
  assert.ok(actualDuration > 0);
  assert.notEqual(targetDuration, actualDuration, `target (${targetDuration}s) and actual (${actualDuration}s) should differ — a real synthesizer at a real speaking rate is never exactly the WPM estimate`);
  assert.equal(humanApprovedDirection.timing.actual, null, 'NarrationDirection.timing.actual must never be populated by the Narration Director itself');

  // --- no mutation of the real BeatGraph/VisualBeat ---
  assert.equal(beatGraph.beats[0].id, beat.id);
  assert.equal(beatGraph.beats[0].narrationSegment.text, beat.narrationSegment.text);
});

// --- 2. explicit target-vs-actual proof with a wildly unrealistic target (Part 18) -------------------------------------------------------------------

test('2. target-vs-actual timing proof — an intentionally unrealistic target duration never leaks into the AudioEvent, which always uses the real measured value', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const nd = directNarration({ scriptRefId: 's1', text: 'This line has an intentionally unrealistic target duration for the timing proof.', targetDuration: 0.5 });
  assert.equal(nd.timing.target.duration, 0.5);

  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(result.audioEvent.duration > 0.5, `real speech for this sentence cannot possibly take only 0.5s — got ${result.audioEvent.duration}s, proving the AudioEvent used the REAL measured duration, not the unrealistic 0.5s target`);
});

// --- 3. no real project data corrupted across the whole real chain -------------------------------------------------------------------

test('3. no project/asset data outside the newly-created audio asset is mutated across the full real chain', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const beforeAssetCount = projectStore.getProject(project.id).assets.length;
  assert.equal(beforeAssetCount, 0);

  const nd = directNarration({ scriptRefId: 's1', text: 'No corruption check.' });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(result.status, 'COMPLETED');

  const afterAssets = projectStore.getProject(project.id).assets;
  assert.equal(afterAssets.length, 1, 'exactly one new asset — the generated audio — should exist');
  assert.equal(afterAssets[0].assetId, result.asset.assetId);
});
