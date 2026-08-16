// Tests for schemas/reference-video-measurement-schema.js — plain object
// factories, defaults, and the closed vocabularies this file's own
// integrity depends on (never a place where "strong hook"/"good pacing"
// could be stored).

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/reference-video-measurement-schema');

test('1. createReferenceVideoMeasurements defaults to an empty-but-valid record with generated id/timestamps', () => {
  const m = schema.createReferenceVideoMeasurements();
  assert.match(m.id, /^[0-9a-f-]{36}$/);
  assert.equal(m.projectId, null);
  assert.equal(m.referenceVideoId, null);
  assert.deepEqual(m.shots, []);
  assert.deepEqual(m.frameSamples, []);
  assert.deepEqual(m.wordTiming, []);
  assert.deepEqual(m.diagnostics, []);
  assert.equal(m.status, null);
  assert.ok(m.createdAt);
});

test('2. createReferenceVideoMeasurements applies overrides without losing untouched defaults', () => {
  const m = schema.createReferenceVideoMeasurements({ projectId: 'p1', referenceVideoId: 'rv1', status: 'COMPLETE' });
  assert.equal(m.projectId, 'p1');
  assert.equal(m.referenceVideoId, 'rv1');
  assert.equal(m.status, 'COMPLETE');
  assert.deepEqual(m.shots, []);
});

test('3. createMeasurement wraps a value with metric/unit/source/evidence/confidence, all defaulting to null', () => {
  const measurement = schema.createMeasurement();
  assert.deepEqual(measurement, { metric: null, value: null, unit: null, source: null, evidence: null, detectionMethod: null, confidence: null });
});

test('4. createMeasurement.confidence, when set, must be a real CONFIDENCE_LEVELS value', () => {
  const measurement = schema.createMeasurement({ confidence: 'HIGH' });
  assert.ok(schema.CONFIDENCE_LEVELS.includes(measurement.confidence));
});

test('5. createDistribution defaults to count 0 and every statistic null', () => {
  assert.deepEqual(schema.createDistribution(), { count: 0, mean: null, median: null, min: null, max: null, p25: null, p75: null, p90: null });
});

test('6. createEvidenceRef defaults to a fully-null pointer, and sourceType is restricted to EVIDENCE_SOURCE_TYPES by convention', () => {
  const ev = schema.createEvidenceRef({ sourceType: 'REFERENCE_VIDEO_ASSET', sourceId: 'a1' });
  assert.ok(schema.EVIDENCE_SOURCE_TYPES.includes(ev.sourceType));
  assert.equal(ev.sourceId, 'a1');
});

test('7. createShot defaults never assign a confidence, and detectionMethod/evidence stay null until explicitly set', () => {
  const shot = schema.createShot({ index: 0, startTime: 0, endTime: 5, duration: 5 });
  assert.equal(shot.confidence, null);
  assert.equal(shot.detectionMethod, null);
  assert.equal(shot.evidence, null);
});

test('8. createShotRhythm defaults to zero shots and empty quarterShotCounts, never a fabricated distribution', () => {
  const rhythm = schema.createShotRhythm();
  assert.equal(rhythm.shotCount, 0);
  assert.deepEqual(rhythm.quarterShotCounts, []);
  assert.deepEqual(rhythm.durationDistribution, schema.createDistribution());
});

test('9. createFrameSample defaults frameAssetId to null (extraction not assumed to have succeeded)', () => {
  const sample = schema.createFrameSample({ time: 1.5, role: 'OPENING' });
  assert.equal(sample.frameAssetId, null);
  assert.equal(sample.role, 'OPENING');
});

test('10. createAudioMeasurements/createTranscriptMeasurements default every derived number to a null-valued createMeasurement, never zero', () => {
  const audio = schema.createAudioMeasurements();
  assert.equal(audio.totalSilenceDuration.value, null);
  assert.deepEqual(audio.silenceIntervals, []);
  const transcript = schema.createTranscriptMeasurements();
  assert.equal(transcript.totalWords.value, null);
  assert.equal(transcript.wordsPerMinute.value, null);
  assert.deepEqual(transcript.sentences, []);
});

test('11. createHookMeasurements has no field capable of holding a qualitative judgment — every key is a count, a timestamp, or a literal quotation', () => {
  const hook = schema.createHookMeasurements();
  const keys = Object.keys(hook);
  assert.deepEqual(keys.sort(), ['firstQuestionMarkText', 'firstQuestionMarkTime', 'firstSentenceDuration', 'firstWords', 'openingCutCounts', 'openingWordCounts'].sort());
  for (const forbidden of ['strong', 'weak', 'good', 'bad', 'engaging', 'quality', 'score', 'rating']) {
    assert.ok(!keys.some((k) => k.toLowerCase().includes(forbidden)), `hook measurements must never have a "${forbidden}" field`);
  }
});

test('12. createVisualMeasurements carries an explicit note disclaiming semantic interpretation', () => {
  const visual = schema.createVisualMeasurements();
  assert.match(visual.note, /never be read as/i);
});

test('13. createOcrCapabilityReport defaults to unavailable — never assumes OCR exists', () => {
  const ocr = schema.createOcrCapabilityReport();
  assert.equal(ocr.available, false);
  assert.deepEqual(ocr.checkedFor, []);
});

test('14. createSceneDetectionCapabilityReport defaults to unavailable with an honest, non-renamed-shots reason', () => {
  const report = schema.createSceneDetectionCapabilityReport();
  assert.equal(report.available, false);
  assert.match(report.reason, /shot/i);
  assert.match(report.reason, /semantic/i);
});

test('15. createDeterminismNote defaults to deterministic:true with an explanation', () => {
  const note = schema.createDeterminismNote();
  assert.equal(note.deterministic, true);
  assert.ok(note.explanation.length > 20);
});

test('16. createMeasurementDiagnostic code must come from the closed MEASUREMENT_DIAGNOSTIC_CODES vocabulary used by the task\'s own spec', () => {
  for (const code of ['INVALID_REFERENCE_VIDEO', 'VIDEO_METADATA_UNAVAILABLE', 'SHOT_DETECTION_FAILED', 'AUDIO_MEASUREMENT_FAILED', 'TRANSCRIPT_MEASUREMENT_FAILED', 'INVALID_WORD_TIMESTAMP', 'INSUFFICIENT_EVIDENCE', 'OCR_UNAVAILABLE', 'SCENE_DETECTION_UNAVAILABLE']) {
    assert.ok(schema.MEASUREMENT_DIAGNOSTIC_CODES.includes(code), `expected diagnostic code "${code}" to be in the closed vocabulary`);
  }
});

test('17. createReferenceVideo Measurements never mutates a nested override object passed in (deep-copies through withDefaults + nested factories)', () => {
  const shotsInput = [{ index: 0, startTime: 0, endTime: 1, duration: 1 }];
  const m = schema.createReferenceVideoMeasurements({ shots: shotsInput });
  m.shots[0].startTime = 999;
  assert.equal(shotsInput[0].startTime, 0);
});
