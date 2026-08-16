// Tests for services/voice/voice-provider-interface.js — Stage 26.9B,
// Part 3/16.1. Contract only — no real generation here (see
// espeak-voice-provider.test.js for that).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_METHODS,
  VOICE_GENERATION_STATUSES,
  createVoiceDiagnostic,
  createVoiceGenerationResult,
  assertImplementsVoiceProviderInterface,
} = require('../services/voice/voice-provider-interface');

test('1. REQUIRED_METHODS is exactly generateVoice', () => {
  assert.deepEqual(REQUIRED_METHODS, ['generateVoice']);
});

test('2. VOICE_GENERATION_STATUSES is exactly COMPLETED/FAILED', () => {
  assert.deepEqual(VOICE_GENERATION_STATUSES, ['COMPLETED', 'FAILED']);
});

test('3. createVoiceGenerationResult defaults', () => {
  const r = createVoiceGenerationResult();
  assert.equal(r.status, null);
  assert.equal(r.audioPath, null);
  assert.equal(r.duration, null);
  assert.deepEqual(r.diagnostics, []);
});

test('4. createVoiceGenerationResult has no provider/model/voiceId/apiKey/cost field — provider-neutral by construction', () => {
  const r = createVoiceGenerationResult();
  for (const forbidden of ['provider', 'model', 'voiceId', 'apiKey', 'cost', 'credits']) {
    assert.equal(forbidden in r, false, `VoiceGenerationResult must not have a "${forbidden}" field`);
  }
});

test('5. createVoiceDiagnostic defaults and overrides', () => {
  const d = createVoiceDiagnostic();
  assert.equal(d.code, null);
  assert.equal(d.message, '');
  const filled = createVoiceDiagnostic({ code: 'VOICE_PROVIDER_UNAVAILABLE', message: 'no engine found' });
  assert.equal(filled.code, 'VOICE_PROVIDER_UNAVAILABLE');
});

test('6. assertImplementsVoiceProviderInterface accepts a conforming object', () => {
  assert.doesNotThrow(() => assertImplementsVoiceProviderInterface({ generateVoice: () => {} }));
});

test('7. assertImplementsVoiceProviderInterface throws for a non-conforming object', () => {
  assert.throws(() => assertImplementsVoiceProviderInterface({}), /generateVoice/);
  assert.throws(() => assertImplementsVoiceProviderInterface(null), /generateVoice/);
});

test('8. the real espeak-voice-provider module satisfies the interface', () => {
  const espeak = require('../services/voice/espeak-voice-provider');
  assert.doesNotThrow(() => assertImplementsVoiceProviderInterface(espeak));
});
