// PRODUCTION RELIABILITY LAYER — production-diagnosis-service.js. Proves
// diagnoseProductionJob() answers "what happened to this job" correctly for
// every terminal/non-terminal shape, without the caller manually correlating
// diagnostics/escalations/beatProgress/contentCompleteness/creativeQa by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseProductionJob, classifyRetryable } = require('../services/production-diagnosis-service');
const { createCreativeQAReport, createCreativeQAFinding } = require('../services/creative-qa-interface');

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
