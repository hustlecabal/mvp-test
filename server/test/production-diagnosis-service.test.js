// PRODUCTION RELIABILITY LAYER — production-diagnosis-service.js. Proves
// diagnoseProductionJob() answers "what happened to this job" correctly for
// every terminal/non-terminal shape, without the caller manually correlating
// diagnostics/escalations/beatProgress/contentCompleteness/creativeQa by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseProductionJob, classifyRetryable } = require('../services/production-diagnosis-service');
const { createCreativeQAReport, createCreativeQAFinding } = require('../services/creative-qa-interface');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

function baseJob(overrides = {}) {
  return {
    productionJobId: 'job-1',
    projectId: 'proj-1',
    status: 'REQUESTED',
    failureStage: null,
    diagnostics: [],
    escalations: [],
    beatProgress: [],
    qc: null,
    contentCompleteness: null,
    creativeQa: null,
    ...overrides,
  };
}

test('a genuinely successful job classifies as SUCCESS with no affected beats', () => {
  const job = baseJob({
    status: 'COMPLETE',
    qc: { passed: true, checks: [] },
    contentCompleteness: { overall: 'FULL_CONTENT', missingBeatIds: [], missingNarrationBeatIds: [] },
    creativeQa: createCreativeQAReport({ subjectType: 'ProductionJob', subjectId: 'job-1', findings: [createCreativeQAFinding({ dimension: 'BEAT_COVERAGE', result: 'PASS', objectType: 'ProductionJob', objectId: null })] }),
  });
  const diagnosis = diagnoseProductionJob(job);

  assert.equal(diagnosis.classification, 'SUCCESS');
  assert.equal(diagnosis.isComplete, true);
  assert.equal(diagnosis.isTechnicallyComplete, true);
  assert.equal(diagnosis.isContentComplete, true);
  assert.deepEqual(diagnosis.affectedBeatIds, []);
  assert.equal(diagnosis.retryable, null);
  assert.equal(diagnosis.canResumeFromCheckpoint, false);
});

test('a COMPLETE job with PARTIAL_CONTENT classifies as PARTIAL_SUCCESS, never SUCCESS', () => {
  const job = baseJob({
    status: 'COMPLETE',
    qc: { passed: true, checks: [] },
    contentCompleteness: { overall: 'PARTIAL_CONTENT', missingBeatIds: ['b2'], missingNarrationBeatIds: [] },
    creativeQa: createCreativeQAReport({
      subjectType: 'ProductionJob',
      subjectId: 'job-1',
      findings: [createCreativeQAFinding({ dimension: 'BEAT_COVERAGE', result: 'FAIL', objectType: 'VisualBeat', objectId: 'b2', note: 'beat "b2" missing' })],
    }),
  });
  const diagnosis = diagnoseProductionJob(job);

  assert.equal(diagnosis.classification, 'PARTIAL_SUCCESS');
  assert.equal(diagnosis.isComplete, true);
  assert.equal(diagnosis.isContentComplete, false);
  assert.deepEqual(diagnosis.affectedBeatIds, ['b2']);
  assert.match(diagnosis.summary, /incomplete/i);
});

test('a hard-failed job classifies as HARD_FAILURE and reports its failing stage', () => {
  const job = baseJob({
    status: 'FAILED',
    failureStage: 'MATERIAL_EXECUTION',
    diagnostics: [{ stage: 'MATERIAL_EXECUTION', code: 'INVALID_DURATION', beatId: 'b1', message: 'duration must be positive' }],
  });
  const diagnosis = diagnoseProductionJob(job);

  assert.equal(diagnosis.classification, 'HARD_FAILURE');
  assert.equal(diagnosis.failingStage, 'MATERIAL_EXECUTION');
  assert.equal(diagnosis.retryable, false); // INVALID_* is non-retryable
  assert.deepEqual(diagnosis.affectedBeatIds, ['b1']);
  assert.equal(diagnosis.canResumeFromCheckpoint, false);
});

test('a failure whose last diagnostic code names a transient condition is reported as retryable', () => {
  const job = baseJob({
    status: 'FAILED',
    failureStage: 'RENDERING',
    diagnostics: [{ stage: 'RENDERING', code: 'PROVIDER_TIMEOUT', beatId: 'b1', message: 'render provider timed out' }],
  });
  const diagnosis = diagnoseProductionJob(job);

  assert.equal(diagnosis.retryable, true);
  assert.match(diagnosis.recommendedAction, /transient|retry/i);
});

test('an escalated job classifies as ESCALATED and is never marked retryable', () => {
  const job = baseJob({
    status: 'ESCALATED',
    escalations: [{ beatId: 'b3', reason: 'no approved generation exists for this beat' }],
  });
  const diagnosis = diagnoseProductionJob(job);

  assert.equal(diagnosis.classification, 'ESCALATED');
  assert.equal(diagnosis.retryable, false);
  assert.deepEqual(diagnosis.affectedBeatIds, ['b3']);
  assert.equal(diagnosis.canResumeFromCheckpoint, false);
});

test('an in-progress (non-terminal) job is classified as IN_PROGRESS and reports it CAN resume from checkpoint', () => {
  const job = baseJob({ status: 'RENDERING' });
  const diagnosis = diagnoseProductionJob(job);

  assert.equal(diagnosis.classification, 'IN_PROGRESS');
  assert.equal(diagnosis.canResumeFromCheckpoint, true);
  assert.equal(diagnosis.isComplete, false);
});

test('multiple affected beats across diagnostics, escalations, and content completeness are unioned without duplicates', () => {
  const job = baseJob({
    status: 'FAILED',
    failureStage: 'TIMELINE_COMPILATION',
    diagnostics: [
      { stage: 'TIMELINE_COMPILATION', code: 'PRIMARY_OVERLAP_FORBIDDEN', beatId: 'b1', message: 'overlap' },
      { stage: 'TIMELINE_COMPILATION', code: 'PRIMARY_OVERLAP_FORBIDDEN', beatId: 'b2', message: 'overlap' },
    ],
    escalations: [{ beatId: 'b1', reason: 'duplicate flagged beat' }],
    contentCompleteness: { overall: 'PARTIAL_CONTENT', missingBeatIds: ['b3'], missingNarrationBeatIds: [] },
  });
  const diagnosis = diagnoseProductionJob(job);

  assert.deepEqual(diagnosis.affectedBeatIds.sort(), ['b1', 'b2', 'b3']);
});

test('classifyRetryable returns null for a code matching neither pattern, never guessing', () => {
  assert.equal(classifyRetryable('SOME_UNRECOGNIZED_CODE'), null);
  assert.equal(classifyRetryable(null), null);
  assert.equal(classifyRetryable('NETWORK_ERROR'), true);
  assert.equal(classifyRetryable('MISSING_SOURCE_ASSET'), false);
});

// ===========================================================================
// PHASE 3F-B — PRODUCTION QUALITY/READINESS. isProductionReady/
// unresolvedBeatCount/unresolvedMaterialCount, and on-the-fly
// contentCompleteness computation for a terminal job that never got one
// pre-computed (FAILED/ESCALATED) — the exact gap a real Golden Video #1
// run exposed: ESCALATED with 3/11 beats assembled reported
// isContentComplete:null instead of false+8-missing.
// ===========================================================================

// Builds a real BeatGraph of `count` beats, each with a narration segment
// (so completeness's own narration-coverage check has something to
// compare against), and an assemblyResult.provenance.shots[] reflecting
// exactly which beatIds reached the final assembly — the same shape
// production-completeness-service.js's own header documents it reads.
function mockTerminalJob({ status, beatCount, assembledBeatIds, narratedBeatIds, escalations = [] }) {
  const beats = Array.from({ length: beatCount }, (_, i) =>
    createVisualBeat({ id: `b${i + 1}`, sceneId: 's1', shotId: `sh${i + 1}`, sequence: i + 1, visualTreatment: 'STILL_IMAGE', narrationSegment: { text: `line ${i + 1}` } })
  );
  return baseJob({
    status,
    escalations,
    beatGraph: createBeatGraph({ projectId: 'proj-1', beats }),
    beatProgress: beats.map((b) => ({ beatId: b.id, audioEvent: narratedBeatIds.includes(b.id) ? { type: 'NARRATION' } : null })),
    assemblyResult: { status: 'COMPLETED', provenance: { shots: assembledBeatIds.map((id) => ({ beatId: id })) } },
    qc: { passed: true, checks: [] },
  });
}

test('READINESS 1. all required beats resolved (COMPLETE, FULL_CONTENT) -> isProductionReady true, zero unresolved', () => {
  const job = baseJob({
    status: 'COMPLETE',
    qc: { passed: true, checks: [] },
    contentCompleteness: { overall: 'FULL_CONTENT', missingBeatIds: [], missingNarrationBeatIds: [] },
  });
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.classification, 'SUCCESS');
  assert.equal(diagnosis.isProductionReady, true);
  assert.equal(diagnosis.unresolvedBeatCount, 0);
  assert.equal(diagnosis.unresolvedMaterialCount, 0);
});

test('READINESS 2. one required beat unresolved (ESCALATED, real BeatGraph/assembly shape, no pre-computed contentCompleteness) -> isProductionReady false', () => {
  const job = mockTerminalJob({
    status: 'ESCALATED',
    beatCount: 3,
    assembledBeatIds: ['b1', 'b2'], // b3 never resolved
    narratedBeatIds: ['b1', 'b2', 'b3'],
    escalations: [{ beatId: 'b3', reason: 'no stock media acquired' }],
  });
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.classification, 'ESCALATED');
  assert.equal(diagnosis.isProductionReady, false);
  assert.equal(diagnosis.isContentComplete, false, 'on-the-fly completeness must compute, never stay null, for a terminal job with a real beatGraph');
  assert.equal(diagnosis.unresolvedBeatCount, 1);
  assert.deepEqual(diagnosis.contentCompleteness.missingBeatIds, ['b3']);
});

test('READINESS 3. multiple unresolved beats (real Golden Video #1 shape: 11 planned, 3 compiled, 8 escalated) -> isProductionReady false with exact counts', () => {
  const assembledBeatIds = ['b4', 'b8', 'b11'];
  const escalatedBeatIds = ['b1', 'b2', 'b3', 'b5', 'b6', 'b7', 'b9', 'b10'];
  const job = mockTerminalJob({
    status: 'ESCALATED',
    beatCount: 11,
    assembledBeatIds,
    narratedBeatIds: Array.from({ length: 11 }, (_, i) => `b${i + 1}`),
    escalations: escalatedBeatIds.map((id) => ({ beatId: id, reason: 'no stock media acquired for this beat' })),
  });
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.isProductionReady, false);
  assert.equal(diagnosis.unresolvedBeatCount, 8);
  assert.equal(diagnosis.unresolvedMaterialCount, 8);
  assert.equal(diagnosis.contentCompleteness.expectedBeatCount, 11);
  assert.equal(diagnosis.contentCompleteness.assembledBeatCount, 3);
  assert.match(diagnosis.summary, /3\/11 beat\(s\) reached the final assembly/);
});

test('READINESS 4. assembly COMPLETED + timeline only PARTIAL -> still not production-ready (assembly succeeding is never read as production succeeding)', () => {
  const job = mockTerminalJob({
    status: 'ESCALATED',
    beatCount: 4,
    assembledBeatIds: ['b1'],
    narratedBeatIds: ['b1', 'b2', 'b3', 'b4'],
    escalations: [
      { beatId: 'b2', reason: 'no stock media acquired' },
      { beatId: 'b3', reason: 'no stock media acquired' },
      { beatId: 'b4', reason: 'no stock media acquired' },
    ],
  });
  assert.equal(job.assemblyResult.status, 'COMPLETED', 'sanity: assembly itself reports success');
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.isProductionReady, false, 'a COMPLETED assemblyResult must never be read as a production success on its own');
});

test('READINESS 5. technical QC passes + unresolved content -> overall production still not ready', () => {
  const job = mockTerminalJob({
    status: 'ESCALATED',
    beatCount: 2,
    assembledBeatIds: ['b1'],
    narratedBeatIds: ['b1', 'b2'],
    escalations: [{ beatId: 'b2', reason: 'no stock media acquired' }],
  });
  assert.equal(job.qc.passed, true, 'sanity: technical QC passed');
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.isTechnicallyComplete, true, 'file-level technical validity is correctly reported as true');
  assert.equal(diagnosis.isProductionReady, false, 'production readiness must not be inferred from qc.passed alone');
});

test('READINESS 6. unresolved narration on an otherwise-assembled beat (real HTTP 500 shape) is represented in diagnosis, distinct from a missing beat', () => {
  const job = mockTerminalJob({
    status: 'ESCALATED',
    beatCount: 3,
    assembledBeatIds: ['b1', 'b2'], // b2's VISUAL did assemble...
    narratedBeatIds: ['b1', 'b3'], // ...but its narration never completed (mirrors the real AI33 HTTP 500 case)
    escalations: [{ beatId: 'b3', reason: 'no stock media acquired' }],
  });
  const diagnosis = diagnoseProductionJob(job);
  assert.deepEqual(diagnosis.contentCompleteness.missingBeatIds, ['b3'], 'b2 assembled visually — it is NOT a missing beat');
  assert.deepEqual(diagnosis.contentCompleteness.missingNarrationBeatIds, ['b2'], 'b2\'s missing narration must still be visible');
  assert.equal(diagnosis.isProductionReady, false);
  assert.equal(diagnosis.isContentComplete, false);
});

test('READINESS 7. an existing COMPLETE+FULL_CONTENT job (pre-computed contentCompleteness, no beatGraph needed) remains valid and unaffected', () => {
  const job = baseJob({
    status: 'COMPLETE',
    qc: { passed: true, checks: [] },
    contentCompleteness: { overall: 'FULL_CONTENT', missingBeatIds: [], missingNarrationBeatIds: [] },
    creativeQa: createCreativeQAReport({ subjectType: 'ProductionJob', subjectId: 'job-1', findings: [createCreativeQAFinding({ dimension: 'BEAT_COVERAGE', result: 'PASS', objectType: 'ProductionJob', objectId: null })] }),
  });
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.classification, 'SUCCESS');
  assert.equal(diagnosis.isProductionReady, true);
  assert.equal(diagnosis.unresolvedBeatCount, 0);
  assert.equal(diagnosis.unresolvedMaterialCount, 0);
  // Every pre-existing field this test file already asserted stays identical.
  assert.equal(diagnosis.isComplete, true);
  assert.equal(diagnosis.isTechnicallyComplete, true);
  assert.equal(diagnosis.isContentComplete, true);
});

test('READINESS 8. a job with no beatGraph at all (e.g. failed before BEATGRAPH stage) never gets a fabricated completeness read', () => {
  const job = baseJob({ status: 'FAILED', failureStage: 'APPROVAL_BOUNDARY', diagnostics: [{ stage: 'APPROVAL_BOUNDARY', code: 'NO_BLUEPRINT_LINKED', beatId: null, message: 'no blueprint' }] });
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.contentCompleteness, null);
  assert.equal(diagnosis.isContentComplete, null);
  assert.equal(diagnosis.unresolvedBeatCount, null);
  assert.equal(diagnosis.isProductionReady, false);
});

test('READINESS 9. an IN_PROGRESS job never gets a premature/misleading completeness computed, even if a beatGraph already exists', () => {
  const beats = [createVisualBeat({ id: 'b1', sceneId: 's1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', narrationSegment: { text: 'x' } })];
  const job = baseJob({ status: 'RENDERING', beatGraph: createBeatGraph({ projectId: 'proj-1', beats }) });
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.classification, 'IN_PROGRESS');
  assert.equal(diagnosis.contentCompleteness, null, 'a still-resolving job must never get an on-the-fly completeness read — nothing has failed or escalated yet');
  assert.equal(diagnosis.isProductionReady, false);
});
