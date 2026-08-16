// Tests for schemas/audio-schema.js — Stage 26.7. Plain object factories
// only, no file I/O, no provider knowledge, no generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AUDIO_EVENT_TYPES,
  AUDIO_EVENT_STATUSES,
  createVoiceProfile,
  createWordTimestamp,
  createTranscript,
  createAudioEvent,
} = require('../schemas/audio-schema');
const { ASSET_TYPES } = require('../schemas/production-schema');

// --- 1. vocabulary -------------------------------------------------------------------

test('1. AUDIO_EVENT_TYPES is exactly NARRATION/MUSIC/SFX/AMBIENCE — no SILENCE', () => {
  assert.deepEqual(AUDIO_EVENT_TYPES, ['NARRATION', 'MUSIC', 'SFX', 'AMBIENCE']);
  assert.equal(AUDIO_EVENT_TYPES.includes('SILENCE'), false);
});

test('2. AUDIO_EVENT_STATUSES is exactly PLANNED/READY — no FAILED/GENERATING yet', () => {
  assert.deepEqual(AUDIO_EVENT_STATUSES, ['PLANNED', 'READY']);
});

test('3. ASSET_TYPES gains "audio" additively, existing values untouched (INT-1B additively appended "reference_frame" after it — same pattern, not a regression)', () => {
  assert.equal(ASSET_TYPES.includes('audio'), true);
  assert.deepEqual(ASSET_TYPES, ['character_reference', 'location_reference', 'keyframe', 'video', 'audio', 'reference_frame']);
});

// --- 4. VoiceProfile — creative intent only -------------------------------------------------------------------

test('4. createVoiceProfile defaults — every field an empty string, nothing pre-filled', () => {
  const v = createVoiceProfile();
  for (const key of ['genderPresentation', 'ageImpression', 'accent', 'language', 'speakingStyle', 'emotionalTone', 'energy', 'pace', 'pitch', 'deliveryNotes']) {
    assert.equal(v[key], '', `${key} should default to ''`);
  }
});

test('5. createVoiceProfile overrides apply per field', () => {
  const v = createVoiceProfile({ genderPresentation: 'male', accent: 'British', emotionalTone: 'warm', energy: 'medium' });
  assert.equal(v.genderPresentation, 'male');
  assert.equal(v.accent, 'British');
  assert.equal(v.emotionalTone, 'warm');
  assert.equal(v.energy, 'medium');
  assert.equal(v.pace, ''); // untouched fields keep their default
});

test('6. VoiceProfile never contains a provider/model/voiceId field — creative intent only, structurally', () => {
  const v = createVoiceProfile({ genderPresentation: 'male' });
  for (const forbidden of ['provider', 'model', 'voiceId', 'providerId', 'apiKey']) {
    assert.equal(forbidden in v, false, `VoiceProfile must not have a "${forbidden}" field`);
  }
});

test('7. schemas/audio-schema.js never mentions a specific voice/TTS provider name as actual usage (a require(), string literal value, or field default) — an explanatory comment about deliberate absence is fine', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'audio-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/elevenlabs|azure|openai|polly/i.test(req), `unexpected provider-shaped require: ${req}`);
  }
  // No field default (e.g. `provider: 'elevenlabs'`) anywhere in the file.
  assert.doesNotMatch(text, /:\s*['"`][^'"`]*(elevenlabs|azure|openai|edge-tts|amazon polly)[^'"`]*['"`]/i);
});

// --- 8. WordTimestamp / Transcript -------------------------------------------------------------------

test('8. createWordTimestamp defaults', () => {
  const w = createWordTimestamp();
  assert.equal(w.word, '');
  assert.equal(w.startTime, null);
  assert.equal(w.endTime, null);
});

test('9. createTranscript defaults to empty text and an empty words array — never invented word timing', () => {
  const t = createTranscript();
  assert.equal(t.text, '');
  assert.deepEqual(t.words, []);
});

test('10. createTranscript accepts text without requiring word timestamps to exist', () => {
  const t = createTranscript({ text: 'The problem is bigger than you think.' });
  assert.equal(t.text, 'The problem is bigger than you think.');
  assert.deepEqual(t.words, [], 'word-level timing may be introduced later without changing this shape');
});

test('11. createTranscript normalizes a supplied words array through createWordTimestamp', () => {
  const t = createTranscript({
    text: 'The problem',
    words: [
      { word: 'The', startTime: 0, endTime: 0.21 },
      { word: 'problem', startTime: 0.21, endTime: 0.62 },
    ],
  });
  assert.equal(t.words.length, 2);
  assert.equal(t.words[0].word, 'The');
  assert.equal(t.words[0].startTime, 0);
  assert.equal(t.words[1].endTime, 0.62);
});

// --- 12. AudioEvent — defaults/overrides -------------------------------------------------------------------

test('12. createAudioEvent defaults — every field present with a safe, non-invented default', () => {
  const e = createAudioEvent();
  assert.ok(e.audioEventId);
  assert.equal(e.type, null);
  assert.equal(e.status, 'PLANNED');
  assert.equal(e.startTime, null);
  assert.equal(e.duration, null);
  assert.equal(e.sourceAssetId, null);
  assert.equal(e.scriptRefId, null);
  assert.equal(e.transcript, null);
  assert.equal(e.voiceProfile, null);
  assert.equal(e.volume, 1);
  assert.equal(e.fadeIn, 0);
  assert.equal(e.fadeOut, 0);
  assert.equal(e.duckingTarget, null);
  assert.equal(e.beatId, null);
  assert.equal(e.sceneId, null);
  assert.ok(e.createdAt);
});

test('13. createAudioEvent assigns a fresh, unique audioEventId every call', () => {
  const a = createAudioEvent();
  const b = createAudioEvent();
  assert.notEqual(a.audioEventId, b.audioEventId);
});

test('14. createAudioEvent embeds a transcript/voiceProfile when supplied, via the same factories', () => {
  const e = createAudioEvent({
    type: 'NARRATION',
    transcript: { text: 'Hello' },
    voiceProfile: { genderPresentation: 'female', accent: 'American general' },
  });
  assert.equal(e.transcript.text, 'Hello');
  assert.deepEqual(e.transcript.words, []);
  assert.equal(e.voiceProfile.genderPresentation, 'female');
  assert.equal(e.voiceProfile.accent, 'American general');
});

test('15. transcript/voiceProfile stay null for a non-narration event unless explicitly supplied', () => {
  const music = createAudioEvent({ type: 'MUSIC', sourceAssetId: 'a1' });
  assert.equal(music.transcript, null);
  assert.equal(music.voiceProfile, null);
});

test('16. duration represents the ACTUAL/measured value, never silently copied from a beat\'s planned duration', () => {
  const e = createAudioEvent({ type: 'NARRATION', duration: 5.72 });
  assert.equal(e.duration, 5.72);
  // this schema has no "plannedDuration" field at all — the planned value
  // lives exclusively on VisualBeat, never duplicated here (see file header)
  assert.equal('plannedDuration' in e, false);
});

test('17. status defaults to PLANNED and is never auto-derived from sourceAssetId presence by the schema itself', () => {
  const noAsset = createAudioEvent({ type: 'MUSIC' });
  assert.equal(noAsset.status, 'PLANNED');
  const withAsset = createAudioEvent({ type: 'MUSIC', sourceAssetId: 'a1' });
  assert.equal(withAsset.status, 'PLANNED', 'the schema never infers READY on its own — that is a future service decision, not shape policy');
});

// --- 18. no cost field -------------------------------------------------------------------

test('18. AudioEvent has no cost/price/credit field — cost tracking is deferred entirely', () => {
  const e = createAudioEvent();
  for (const forbidden of ['cost', 'price', 'estimatedCost', 'reservedCost', 'actualCost', 'credits']) {
    assert.equal(forbidden in e, false, `AudioEvent must not have a "${forbidden}" field yet`);
  }
});

// --- 19. no unexpected fields -------------------------------------------------------------------

test('19. createAudioEvent produces exactly the documented field set, nothing more', () => {
  const e = createAudioEvent();
  assert.deepEqual(
    Object.keys(e).sort(),
    ['audioEventId', 'type', 'status', 'startTime', 'duration', 'sourceAssetId', 'scriptRefId', 'transcript', 'voiceProfile', 'volume', 'fadeIn', 'fadeOut', 'duckingTarget', 'beatId', 'sceneId', 'createdAt'].sort()
  );
});

// --- 20. safety / provider neutrality -------------------------------------------------------------------

test('20. schemas/audio-schema.js requires nothing but crypto — no file I/O, no network, no provider adapter', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'audio-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

test('21. schemas/audio-schema.js never REQUIRES/imports ffmpeg/ffprobe/whisper — comments explaining their deliberate absence are fine', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'audio-schema.js'), 'utf8');
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*(ffmpeg|ffprobe|whisper)[^'"`]*['"`]\s*\)/i);
});

// --- 22. determinism / idempotency -------------------------------------------------------------------

test('22. identical overrides produce structurally identical output (ids/timestamps aside)', () => {
  const a = createAudioEvent({ type: 'NARRATION', startTime: 0, duration: 5, transcript: { text: 'x' }, voiceProfile: { accent: 'British' } });
  const b = createAudioEvent({ type: 'NARRATION', startTime: 0, duration: 5, transcript: { text: 'x' }, voiceProfile: { accent: 'British' } });
  const { audioEventId: idA, createdAt: createdAtA, ...restA } = a;
  const { audioEventId: idB, createdAt: createdAtB, ...restB } = b;
  assert.deepEqual(restA, restB);
});
