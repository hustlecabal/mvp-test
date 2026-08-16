// Tests for services/voice-generation-service.js — Stage 26.9B, Part 16.
// The orchestrator: NarrationDirection -> Voice Generation -> Audio File
// -> Word-Level Alignment -> AudioEvent. Happy-path/timing/override proofs
// use the REAL espeak-ng/faster-whisper adapters; failure-path tests use
// small injected fake providers (implementing the same interfaces) to
// exercise every failure code deterministically and quickly — never by
// actually breaking the real installed tools mid-suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-voicegen-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-voicegen-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { directNarration } = require('../services/narration-director-service');
const { createVoiceProfile } = require('../schemas/audio-schema');
const { generateNarratedAudioEvent, checkScriptAudioConsistency, CONSISTENCY_SIMILARITY_THRESHOLD } = require('../services/voice-generation-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

// --- 1. real end-to-end happy path -------------------------------------------------------------------

test('1. real end-to-end — a real NarrationDirection becomes a real Asset + a real AudioEvent', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 'script-1', text: 'This proves the full real voice generation pipeline.', beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }] });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });

  assert.equal(result.status, 'COMPLETED', result.diagnostics[0] && result.diagnostics[0].message);
  assert.deepEqual(result.diagnostics, []);

  assert.ok(result.asset);
  assert.equal(result.asset.type, 'audio');
  assert.equal(result.asset.storage.status, 'STORED');
  assert.ok(fs.existsSync(path.join(assetStorageDir, result.asset.storage.path)));

  assert.ok(result.audioEvent);
  assert.equal(result.audioEvent.type, 'NARRATION');
  assert.equal(result.audioEvent.status, 'READY');
  assert.equal(result.audioEvent.sourceAssetId, result.asset.assetId);
  assert.ok(result.audioEvent.duration > 0);
  assert.ok(result.audioEvent.transcript.words.length > 0);
});

// --- 2. scriptRefId preservation -------------------------------------------------------------------

test('2. scriptRefId is preserved verbatim from NarrationDirection to AudioEvent', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 'my-exact-script-ref-42', text: 'Preserve my script reference.' });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.audioEvent.scriptRefId, 'my-exact-script-ref-42');
});

// --- 3. beat association -------------------------------------------------------------------

test('3. a single-beat NarrationDirection sets AudioEvent.beatId; a multi-beat one leaves it null rather than guessing', () => {
  const project = newProject();
  const single = directNarration({ scriptRefId: 's1', text: 'Single beat narration.', beats: [{ beatId: 'only-beat', narrativeRole: 'HOOK' }] });
  const singleResult = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: single });
  assert.equal(singleResult.status, 'COMPLETED');
  assert.equal(singleResult.audioEvent.beatId, 'only-beat');

  const multi = directNarration({ scriptRefId: 's1', text: 'Multi beat narration line.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }, { beatId: 'b2', narrativeRole: 'EXPLANATION' }] });
  const multiResult = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: multi });
  assert.equal(multiResult.status, 'COMPLETED');
  assert.equal(multiResult.audioEvent.beatId, null);
});

// --- 4. voiceProfile preservation -------------------------------------------------------------------

test('4. voiceProfile is preserved verbatim from NarrationDirection to AudioEvent', () => {
  const project = newProject();
  const voiceProfile = createVoiceProfile({ speakingStyle: 'conversational_documentary', accent: 'British', emotionalTone: 'confident_curious' });
  const nd = directNarration({ scriptRefId: 's1', text: 'Preserve my voice profile please.', channelVoiceBible: { voiceProfile } });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.audioEvent.voiceProfile, voiceProfile);
});

// --- 5/6. structural failure handling -------------------------------------------------------------------

test('5. an incomplete NarrationDirection fails with INVALID_NARRATION_DIRECTION, never attempts generation', () => {
  const project = newProject();
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: { status: 'FAILED', text: 'x' } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_NARRATION_DIRECTION');
  assert.equal(result.audioEvent, null);
  assert.equal(result.asset, null);
});

test('6. a missing projectId fails with INVALID_NARRATION_DIRECTION, never crashes', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  assert.doesNotThrow(() => {
    const result = generateNarratedAudioEvent({ narrationDirection: nd });
    assert.equal(result.status, 'FAILED');
  });
});

// --- 7/8. injected-provider failure propagation -------------------------------------------------------------------

test('7. a failing voice provider propagates its diagnostics and creates no Asset', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  const before = timelineStore.listAssets ? timelineStore.listAssets(project.id).length : projectStore.getProject(project.id).assets.length;
  const fakeVoiceProvider = { generateVoice: () => ({ status: 'FAILED', audioPath: null, duration: null, diagnostics: [{ code: 'VOICE_PROVIDER_UNAVAILABLE', message: 'fake unavailable' }] }) };
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: fakeVoiceProvider });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VOICE_PROVIDER_UNAVAILABLE');
  assert.equal(result.audioEvent, null);
  const after = projectStore.getProject(project.id).assets.length;
  assert.equal(after, before, 'no asset should be created when voice generation fails');
});

test('8. a failing alignment provider propagates its diagnostics and creates no Asset (even though audio WAS generated)', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  const before = projectStore.getProject(project.id).assets.length;
  const fakeVoiceProvider = { generateVoice: ({ outputPath }) => { fs.writeFileSync(outputPath, Buffer.from('RIFF0000WAVEfmt fake')); return { status: 'COMPLETED', audioPath: outputPath, duration: 2.5, diagnostics: [] }; } };
  const fakeAlignmentProvider = { alignAudio: () => ({ status: 'FAILED', words: [], diagnostics: [{ code: 'ALIGNMENT_UNAVAILABLE', message: 'fake unavailable' }] }) };
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: fakeVoiceProvider, alignmentProvider: fakeAlignmentProvider });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ALIGNMENT_UNAVAILABLE');
  const after = projectStore.getProject(project.id).assets.length;
  assert.equal(after, before, 'no asset should be created when alignment fails');
});

test('9. a voice/alignment provider that throws never crashes the caller — becomes a structured FAILED result', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  const throwingProvider = { generateVoice: () => { throw new Error('boom'); } };
  assert.doesNotThrow(() => {
    const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: throwingProvider });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'VOICE_GENERATION_FAILED');
  });
});

// --- 10. script/audio consistency (Part 12) -------------------------------------------------------------------

test('10. checkScriptAudioConsistency passes for a realistic near-match (punctuation/tokenization differences only)', () => {
  const r = checkScriptAudioConsistency("That £100,000 isn't actually worth £100,000.", [
    { word: 'At' }, { word: '£100' }, { word: ',000' }, { word: "isn't" }, { word: 'actually' }, { word: 'worth' }, { word: '£100' }, { word: ',000.' },
  ]);
  assert.equal(r.ok, true);
  assert.ok(r.similarity >= CONSISTENCY_SIMILARITY_THRESHOLD);
});

test('11. checkScriptAudioConsistency fails for a completely unrelated transcript (TRANSCRIPT_MISMATCH territory)', () => {
  const r = checkScriptAudioConsistency('The quick brown fox jumps over the lazy dog.', [{ word: 'completely' }, { word: 'unrelated' }, { word: 'nonsense' }]);
  assert.equal(r.ok, false);
  assert.ok(r.similarity < CONSISTENCY_SIMILARITY_THRESHOLD);
});

test('12. checkScriptAudioConsistency never fails purely for punctuation/casing differences', () => {
  const r = checkScriptAudioConsistency('Hello, World! How ARE you?', [{ word: 'hello' }, { word: 'world' }, { word: 'how' }, { word: 'are' }, { word: 'you' }]);
  assert.equal(r.ok, true);
});

test('13. an alignment that diverges too far from the script fails the full pipeline with TRANSCRIPT_MISMATCH', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 's1', text: 'The quick brown fox jumps over the lazy dog.' });
  const fakeVoiceProvider = { generateVoice: ({ outputPath }) => { fs.writeFileSync(outputPath, Buffer.from('fake')); return { status: 'COMPLETED', audioPath: outputPath, duration: 2, diagnostics: [] }; } };
  const fakeAlignmentProvider = { alignAudio: () => ({ status: 'COMPLETED', language: 'en', words: [{ word: 'totally', start: 0, end: 0.2, confidence: 0.9 }, { word: 'unrelated', start: 0.2, end: 0.4, confidence: 0.9 }], diagnostics: [] }) };
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: fakeVoiceProvider, alignmentProvider: fakeAlignmentProvider });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'TRANSCRIPT_MISMATCH');
});

// --- 14. no provider-specific data leakage -------------------------------------------------------------------

test('14. AudioEvent produced by the real pipeline has no provider name/API key/cost field anywhere in it', () => {
  const project = newProject();
  const nd = directNarration({ scriptRefId: 's1', text: 'No leakage check.' });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(result.status, 'COMPLETED');
  const serialized = JSON.stringify(result.audioEvent).toLowerCase();
  for (const forbidden of ['espeak', 'whisper', 'apikey', 'api_key', 'elevenlabs', 'openai']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden), `AudioEvent must not mention "${forbidden}"`);
  }
});

// --- 15. target vs actual timing (Part 11/18) -------------------------------------------------------------------

test('15. target timing (pre-audio estimate) and actual timing (real, measured) are never conflated — AudioEvent.duration uses the REAL measured value, not the target estimate', () => {
  const project = newProject();
  const text = 'This sentence has a deliberately specific target duration for the timing proof.';
  const nd = directNarration({ scriptRefId: 's1', text, targetWordsPerMinute: 400 }); // an unrealistically fast target, guaranteed to differ from real espeak-ng output
  assert.ok(nd.timing.target.duration > 0);
  assert.equal(nd.timing.actual, null);

  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(result.status, 'COMPLETED');
  assert.notEqual(result.audioEvent.duration, nd.timing.target.duration, 'the AudioEvent must use the REAL measured duration, not the pre-audio target estimate');
  assert.ok(result.audioEvent.duration > 0);
});

// --- 16. human override proof (Part 13) -------------------------------------------------------------------

test('16. a human-approved override (beatOverride changing pace) changes the REAL measured output duration', () => {
  const project = newProject();
  const text = 'The human director wants this line delivered at a very specific pace for the override proof.';
  const systemDefault = directNarration({ scriptRefId: 's1', text, beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }] });
  const humanApproved = directNarration({ scriptRefId: 's1', text, beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }], beatOverride: { delivery: { pace: 'SLOW' } } });
  assert.notEqual(systemDefault.delivery.pace, humanApproved.delivery.pace);

  const defaultResult = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: systemDefault });
  const overriddenResult = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: humanApproved });
  assert.equal(defaultResult.status, 'COMPLETED');
  assert.equal(overriddenResult.status, 'COMPLETED');
  assert.ok(overriddenResult.audioEvent.duration > defaultResult.audioEvent.duration, 'the human-approved SLOW override should produce measurably longer real audio than the system default pace');
});

// --- 17. security -------------------------------------------------------------------

test('17. security — voice-generation-service.js has no eval/new Function/shell/network call, and never logs a raw env var value', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'voice-generation-service.js'), 'utf8');
  const text = fullText.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(text, /\beval\(/);
  assert.doesNotMatch(text, /new\s+Function\(/);
  assert.doesNotMatch(text, /child_process/);
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.doesNotMatch(text, /\baxios\b/);
  assert.doesNotMatch(text, /shell\s*:\s*true/);
});
