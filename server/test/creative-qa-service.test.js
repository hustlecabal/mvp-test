// PRODUCTION RELIABILITY LAYER — creative-qa-service.js (first real
// implementation of creative-qa-interface.js). Proves the deterministic
// dimensions correctly separate a genuinely complete production from one
// that is only TECHNICALLY valid, and that summarizeCreativeQAReport()
// never lets missing content read back as "passed".

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeContentCompleteness } = require('../services/production-completeness-service');
const { runDeterministicCreativeQA, summarizeCreativeQAReport } = require('../services/creative-qa-service');

function beat({ id, text = '' }) {
  return { id, narrationSegment: text ? { text } : null };
}

function shotProvenance({ beatId, duration = 3 }) {
  return { beatId, materialId: `mat-${beatId}`, executionId: `exec-${beatId}`, renderId: `render-${beatId}`, sourceAssetId: `asset-${beatId}`, startTime: 0, duration };
}

function job({ beats = [], assembledShots = [], narratedBeatIds = [], diagnostics = [] }) {
  return {
    productionJobId: 'job-1',
    beatGraph: { beats },
    diagnostics,
    beatProgress: narratedBeatIds.map((beatId) => ({ beatId, audioEvent: { status: 'COMPLETED' } })),
    assemblyResult: { status: 'COMPLETED', provenance: { shots: assembledShots }, expectedDuration: 9, artifact: { duration: 9 } },
  };
}

test('a valid, fully-complete production passes Creative QA', () => {
  const j = job({
    beats: [beat({ id: 'b1', text: 'hello' }), beat({ id: 'b2' })],
    assembledShots: [shotProvenance({ beatId: 'b1' }), shotProvenance({ beatId: 'b2' })],
    narratedBeatIds: ['b1'],
  });
  const completeness = computeContentCompleteness(j);
  assert.equal(completeness.overall, 'FULL_CONTENT');

  const report = runDeterministicCreativeQA(j, completeness);
  const summary = summarizeCreativeQAReport(report);
  assert.equal(summary.passed, true);
  assert.equal(summary.severity, 'PASS');
  assert.deepEqual(summary.issues, []);
  assert.deepEqual(summary.affectedBeatIds, []);
});

test('missing narration is detected and fails/blocks a clean pass', () => {
  const j = job({
    beats: [beat({ id: 'b1', text: 'needs narration' })],
    assembledShots: [shotProvenance({ beatId: 'b1' })],
    narratedBeatIds: [], // narration never completed
  });
  const completeness = computeContentCompleteness(j);
  const report = runDeterministicCreativeQA(j, completeness);
  const summary = summarizeCreativeQAReport(report);

  assert.equal(summary.passed, false);
  assert.equal(summary.severity, 'FAIL');
  assert.ok(summary.issues.some((i) => i.includes('b1')));
  assert.deepEqual(summary.affectedBeatIds, ['b1']);
  assert.match(summary.recommendedAction, /narration/i);
});

test('a missing beat is detected as a FAIL finding, never silently PASS', () => {
  const j = job({
    beats: [beat({ id: 'b1' }), beat({ id: 'b2' }), beat({ id: 'b3' })],
    assembledShots: [shotProvenance({ beatId: 'b1' }), shotProvenance({ beatId: 'b3' })], // b2 dropped
  });
  const completeness = computeContentCompleteness(j);
  const report = runDeterministicCreativeQA(j, completeness);
  const summary = summarizeCreativeQAReport(report);

  assert.equal(summary.passed, false);
  assert.equal(summary.severity, 'FAIL');
  assert.deepEqual(summary.affectedBeatIds, ['b2']);
  assert.match(summary.recommendedAction, /missing from the final video/i);
});

test('incomplete content can never silently present as a full pass — severity always reflects the worst finding', () => {
  const j = job({
    beats: [beat({ id: 'b1', text: 'narrate' }), beat({ id: 'b2' })],
    assembledShots: [shotProvenance({ beatId: 'b1' })], // b2 dropped AND b1 narration missing
    narratedBeatIds: [],
  });
  const completeness = computeContentCompleteness(j);
  assert.equal(completeness.overall, 'PARTIAL_CONTENT');

  const report = runDeterministicCreativeQA(j, completeness);
  const summary = summarizeCreativeQAReport(report);
  assert.equal(summary.passed, false);
  assert.equal(summary.severity, 'FAIL');
  assert.ok(summary.affectedBeatIds.includes('b1'));
  assert.ok(summary.affectedBeatIds.includes('b2'));
});

test('an implausibly short assembled beat is a WARNING, not a FAIL', () => {
  const j = job({
    beats: [beat({ id: 'b1' })],
    assembledShots: [shotProvenance({ beatId: 'b1', duration: 0.2 })],
  });
  const completeness = computeContentCompleteness(j);
  const report = runDeterministicCreativeQA(j, completeness);
  const summary = summarizeCreativeQAReport(report);

  assert.equal(summary.severity, 'WARN');
  assert.equal(summary.passed, true); // WARN still counts as passed, per this stage's PASS/WARN/FAIL contract
  assert.ok(summary.warnings.some((w) => w.includes('b1')));
});

test('a TIMELINE_GAP diagnostic is surfaced as a WARN, reusing the compiler\'s own already-computed diagnostic', () => {
  const j = job({
    beats: [beat({ id: 'b1' })],
    assembledShots: [shotProvenance({ beatId: 'b1' })],
    diagnostics: [{ stage: 'TIMELINE_COMPILATION', code: 'TIMELINE_GAP', beatId: 'b1', message: 'a 0.5s gap exists before this beat' }],
  });
  const completeness = computeContentCompleteness(j);
  const report = runDeterministicCreativeQA(j, completeness);
  const summary = summarizeCreativeQAReport(report);

  assert.equal(summary.severity, 'WARN');
  assert.ok(summary.warnings.some((w) => w.includes('gap')));
});
