// Tests for schemas/narration-schema.js — Stage 26.9. Plain object
// factories only, no file I/O, no provider knowledge, no generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  NARRATION_DIRECTION_STATUSES,
  PACE_LEVELS,
  EMOTIONAL_TONES,
  DELIVERY_AXES,
  EMPHASIS_LEVELS,
  PAUSE_REASONS,
  createDeliveryDirection,
  createEmphasis,
  createPause,
  createPronunciationNote,
  createEmotionalArcStage,
  createNarrationTargetTiming,
  createNarrationTiming,
  createNarrationDiagnostic,
  createNarrationDirection,
} = require('../schemas/narration-schema');
const { createVoiceProfile } = require('../schemas/audio-schema');

// --- 1. vocabulary -------------------------------------------------------------------

test('1. NARRATION_DIRECTION_STATUSES is exactly COMPLETED/FAILED', () => {
  assert.deepEqual(NARRATION_DIRECTION_STATUSES, ['COMPLETED', 'FAILED']);
});

test('2. PACE_LEVELS/EMOTIONAL_TONES/EMPHASIS_LEVELS/PAUSE_REASONS are small, controlled vocabularies', () => {
  assert.ok(PACE_LEVELS.length <= 6);
  assert.ok(EMOTIONAL_TONES.length <= 12);
  assert.deepEqual(EMPHASIS_LEVELS, ['LIGHT', 'MODERATE', 'STRONG', 'CONTRAST']);
  assert.deepEqual(PAUSE_REASONS, ['SENTENCE_BREAK', 'PARAGRAPH_BREAK', 'BEFORE_REVEAL', 'AFTER_REVEAL', 'DRAMATIC', 'BREATH']);
});

test('3. DELIVERY_AXES names exactly the 6 numeric 0-10 delivery fields', () => {
  assert.deepEqual(DELIVERY_AXES, ['energy', 'intensity', 'confidence', 'warmth', 'urgency', 'conversationality']);
  const d = createDeliveryDirection();
  for (const axis of DELIVERY_AXES) assert.ok(axis in d, `createDeliveryDirection() should have a "${axis}" field`);
});

// --- 4. DeliveryDirection -------------------------------------------------------------------

test('4. createDeliveryDirection defaults — every field null', () => {
  const d = createDeliveryDirection();
  assert.equal(d.pace, null);
  assert.equal(d.emotionalTone, null);
  for (const axis of DELIVERY_AXES) assert.equal(d[axis], null);
});

test('5. createDeliveryDirection overrides apply per field, untouched fields keep default', () => {
  const d = createDeliveryDirection({ energy: 8, pace: 'FAST' });
  assert.equal(d.energy, 8);
  assert.equal(d.pace, 'FAST');
  assert.equal(d.confidence, null);
});

// --- 6. Emphasis -------------------------------------------------------------------

test('6. createEmphasis defaults', () => {
  const e = createEmphasis();
  assert.equal(e.text, null);
  assert.equal(e.charStart, null);
  assert.equal(e.charEnd, null);
  assert.equal(e.level, null);
  assert.equal(e.reason, null);
});

test('7. createEmphasis stores deterministic character offsets, not just text', () => {
  const e = createEmphasis({ text: '£100,000', charStart: 5, charEnd: 13, level: 'STRONG' });
  assert.equal(e.charStart, 5);
  assert.equal(e.charEnd, 13);
});

// --- 8. Pause -------------------------------------------------------------------

test('8. createPause defaults', () => {
  const p = createPause();
  assert.equal(p.afterCharOffset, null);
  assert.equal(p.durationMs, null);
  assert.equal(p.reason, null);
});

test('9. createPause overrides apply, including a zero durationMs (never rejected by the schema — policy is a service concern)', () => {
  const p = createPause({ afterCharOffset: 10, durationMs: 0, reason: 'BREATH' });
  assert.equal(p.durationMs, 0);
  assert.equal(p.reason, 'BREATH');
});

// --- 10. Pronunciation -------------------------------------------------------------------

test('10. createPronunciationNote defaults and overrides', () => {
  const note = createPronunciationNote();
  assert.equal(note.text, null);
  assert.equal(note.pronunciation, null);
  const filled = createPronunciationNote({ text: 'NVIDIA', pronunciation: 'en-VID-ee-uh' });
  assert.equal(filled.text, 'NVIDIA');
  assert.equal(filled.pronunciation, 'en-VID-ee-uh');
});

test('11. pronunciation is free-text, never SSML/IPA markup required — no phoneme/ssml fields exist', () => {
  const note = createPronunciationNote({ text: 'SQL', pronunciation: 'sequel' });
  assert.equal('ssml' in note, false);
  assert.equal('ipa' in note, false);
  assert.equal('phoneme' in note, false);
});

// --- 12. EmotionalArcStage -------------------------------------------------------------------

test('12. createEmotionalArcStage defaults — nested delivery always a full createDeliveryDirection() shape', () => {
  const stage = createEmotionalArcStage();
  assert.equal(stage.beatId, null);
  assert.equal(stage.label, null);
  assert.deepEqual(Object.keys(stage.delivery).sort(), Object.keys(createDeliveryDirection()).sort());
});

test('13. createEmotionalArcStage ties a stage to a beatId and label', () => {
  const stage = createEmotionalArcStage({ beatId: 'b1', label: 'HOOK', delivery: { energy: 8 } });
  assert.equal(stage.beatId, 'b1');
  assert.equal(stage.label, 'HOOK');
  assert.equal(stage.delivery.energy, 8);
});

// --- 14. Timing — target vs actual -------------------------------------------------------------------

test('14. createNarrationTiming defaults — target is a full object, actual is null', () => {
  const t = createNarrationTiming();
  assert.equal(t.actual, null);
  assert.equal(t.target.startTime, null);
  assert.equal(t.target.duration, null);
  assert.equal(t.target.wordsPerMinute, null);
  assert.equal(t.target.pauseBudgetMs, null);
});

test('15. createNarrationTargetTiming overrides apply', () => {
  const t = createNarrationTargetTiming({ duration: 4.2, wordsPerMinute: 150 });
  assert.equal(t.duration, 4.2);
  assert.equal(t.wordsPerMinute, 150);
});

test('16. NarrationTiming.actual can never be silently populated by the schema itself — createNarrationTiming({}) always yields actual: null even with other fields set', () => {
  const t = createNarrationTiming({ target: { duration: 5 } });
  assert.equal(t.actual, null);
});

// --- 17. NarrationDirection -------------------------------------------------------------------

test('17. createNarrationDirection defaults — every field present with a safe, non-invented default', () => {
  const n = createNarrationDirection();
  assert.ok(n.narrationId);
  assert.equal(n.scriptRefId, null);
  assert.deepEqual(n.beatIds, []);
  assert.equal(n.text, '');
  assert.equal(n.voiceProfile, null);
  assert.equal(n.delivery, null);
  assert.ok(n.timing);
  assert.deepEqual(n.emphasis, []);
  assert.deepEqual(n.pauses, []);
  assert.deepEqual(n.pronunciation, []);
  assert.deepEqual(n.emotionalArc, []);
  assert.equal(n.notes, null);
  assert.equal(n.status, null);
  assert.deepEqual(n.diagnostics, []);
  assert.ok(n.createdAt);
});

test('18. createNarrationDirection assigns a fresh, unique narrationId every call', () => {
  const a = createNarrationDirection();
  const b = createNarrationDirection();
  assert.notEqual(a.narrationId, b.narrationId);
});

test('19. createNarrationDirection produces exactly the documented field set, nothing more', () => {
  const n = createNarrationDirection();
  assert.deepEqual(
    Object.keys(n).sort(),
    ['narrationId', 'scriptRefId', 'beatIds', 'text', 'voiceProfile', 'delivery', 'timing', 'emphasis', 'pauses', 'pronunciation', 'emotionalArc', 'notes', 'status', 'diagnostics', 'createdAt'].sort()
  );
});

test('20. array fields (emphasis/pauses/pronunciation/emotionalArc) are re-shaped through their own factory, not stored raw', () => {
  const n = createNarrationDirection({
    text: 'hello',
    emphasis: [{ text: 'hello', charStart: 0, charEnd: 5, level: 'STRONG' }],
    pauses: [{ afterCharOffset: 5, durationMs: 300, reason: 'BREATH' }],
    pronunciation: [{ text: 'hello', pronunciation: 'huh-LOH' }],
    emotionalArc: [{ beatId: 'b1', delivery: { energy: 7 } }],
  });
  assert.deepEqual(Object.keys(n.emphasis[0]).sort(), Object.keys(createEmphasis()).sort());
  assert.deepEqual(Object.keys(n.pauses[0]).sort(), Object.keys(createPause()).sort());
  assert.deepEqual(Object.keys(n.pronunciation[0]).sort(), Object.keys(createPronunciationNote()).sort());
  assert.deepEqual(Object.keys(n.emotionalArc[0]).sort(), Object.keys(createEmotionalArcStage()).sort());
});

// --- 21. VoiceProfile compatibility (Part 3 — reuse, never redefine) -------------------------------------------------------------------

test('21. NarrationDirection.voiceProfile accepts the EXISTING schemas/audio-schema.js createVoiceProfile() shape verbatim', () => {
  const vp = createVoiceProfile({ speakingStyle: 'conversational_documentary', energy: 'medium', emotionalTone: 'confident_curious', deliveryNotes: 'Sounds intelligent and conversational, never like a newsreader.' });
  const n = createNarrationDirection({ voiceProfile: vp });
  assert.deepEqual(n.voiceProfile, vp);
});

function stripLineComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

test('22. schemas/narration-schema.js does not redefine/duplicate VoiceProfile — no createVoiceProfile export here, and no cross-schema-file require of audio-schema.js (self-contained-schema-file convention)', () => {
  const narrationSchema = require('../schemas/narration-schema');
  assert.equal('createVoiceProfile' in narrationSchema, false);
  const text = stripLineComments(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'narration-schema.js'), 'utf8'));
  assert.doesNotMatch(text, /require\(\s*['"`]\.\/audio-schema['"`]\s*\)/);
});

// --- 23. Provider neutrality -------------------------------------------------------------------

test('23. schemas/narration-schema.js requires nothing but crypto — no file I/O, no network, no provider name', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'narration-schema.js'), 'utf8');
  const text = stripLineComments(fullText);
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/, /elevenlabs/i, /whisper/i, /openai/i, /azure/i, /\bssml\b/i]) {
    assert.doesNotMatch(text, pattern);
  }
});

test('24. NarrationDirection has no provider/model/cost/apiKey field — creative direction only, structurally', () => {
  const n = createNarrationDirection();
  for (const forbidden of ['provider', 'model', 'cost', 'price', 'credits', 'apiKey', 'voiceId', 'providerId']) {
    assert.equal(forbidden in n, false, `NarrationDirection must not have a "${forbidden}" field`);
  }
});

// --- 25. Diagnostic -------------------------------------------------------------------

test('25. createNarrationDiagnostic defaults and overrides — same {code, message} shape as every other *Result schema', () => {
  const d = createNarrationDiagnostic();
  assert.equal(d.code, null);
  assert.equal(d.message, '');
  const filled = createNarrationDiagnostic({ code: 'MISSING_TEXT', message: 'text is required' });
  assert.equal(filled.code, 'MISSING_TEXT');
  assert.equal(filled.message, 'text is required');
});

// --- 26. determinism -------------------------------------------------------------------

test('26. determinism — identical overrides produce structurally identical output (ids/timestamps aside)', () => {
  const a = createNarrationDirection({ scriptRefId: 's1', text: 'hi', status: 'COMPLETED', delivery: { energy: 5 } });
  const b = createNarrationDirection({ scriptRefId: 's1', text: 'hi', status: 'COMPLETED', delivery: { energy: 5 } });
  const { narrationId: idA, createdAt: createdAtA, ...restA } = a;
  const { narrationId: idB, createdAt: createdAtB, ...restB } = b;
  assert.deepEqual(restA, restB);
});
