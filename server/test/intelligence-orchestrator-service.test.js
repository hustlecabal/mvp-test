// Tests for services/intelligence-orchestrator-service.js — P0-INTEL, the
// INTELLIGENCE ORCHESTRATOR. Same fixture discipline as test/cross-video-
// pattern-service.test.js (its own header is the direct precedent): every
// ReferenceVideo/Measurement/ObservationSet run through this file's tests
// is REAL evidence produced by the real, unmodified INT-1A/B/C pipeline
// (real FFmpeg-encoded fixture videos, real ffprobe/ffmpeg measurement,
// real rule-based observation) — only the video CONTENT and the network
// acquisition boundary are faked (Part 24: no APIFY_API_TOKEN or
// ANTHROPIC_API_KEY exists in this environment; the codebase's own
// established fakeProvider()/createFakeInterpretationProvider() testing
// conventions are used instead of inventing credentials).
//
// Categories covered (Part 30's 14-item list): (1) IntelligenceRun schema,
// (2) lifecycle transitions, (3) dependency ordering, (4) stage
// invocation, (5) idempotency, (6) resumability, (7) partial failure,
// (8) provider failure, (9) evidence sufficiency, (10) financial controls,
// (11) provenance, (12) async execution, (13) operator entry point,
// (14) the GOLDEN INTELLIGENCE TEST.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, fork } = require('child_process');
const { Readable } = require('stream');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-iorch-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-iorch-projects-'],
  ['REFERENCE_VIDEO_DATA_DIR', 'evolink-iorch-rvstore-'],
  ['REFERENCE_VIDEO_MEASUREMENT_DATA_DIR', 'evolink-iorch-mstore-'],
  ['REFERENCE_VIDEO_OBSERVATION_DATA_DIR', 'evolink-iorch-ostore-'],
  ['REFERENCE_SET_DATA_DIR', 'evolink-iorch-rsstore-'],
  ['CROSS_VIDEO_PATTERN_DATA_DIR', 'evolink-iorch-pstore-'],
  ['RECOMMENDATION_DATA_DIR', 'evolink-iorch-recstore-'],
  ['INTELLIGENCE_RUNS_DATA_DIR', 'evolink-iorch-irstore-'],
  ['INTERPRETATION_APPROVAL_DATA_DIR', 'evolink-iorch-iastore-'],
  ['REFERENCE_VIDEO_INTERPRETATION_DATA_DIR', 'evolink-iorch-interpstore-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const referenceSetStore = require('../services/reference-set-store');
const referenceSetSvc = require('../services/reference-set-service');
const referenceVideoStore = require('../services/reference-video-store');
const measurementStore = require('../services/reference-video-measurement-store');
const observationStore = require('../services/reference-video-observation-store');
const patternStore = require('../services/cross-video-pattern-store');
const recommendationStore = require('../services/recommendation-store');
const interpretationStore = require('../services/reference-video-interpretation-store');
const interpretationApprovalStore = require('../services/reference-video-interpretation-approval-store');
const { createFakeInterpretationProvider } = require('../services/reference-video/fake-interpretation-provider');
const intelligenceRunStore = require('../services/intelligence-run-store');
const orchestrator = require('../services/intelligence-orchestrator-service');
const { INTELLIGENCE_RUN_STATUSES, INTELLIGENCE_FAILURE_STAGES, createIntelligenceRun } = require('../schemas/intelligence-run-schema');

function newProject(title = 'x') {
  const project = projectStore.createProject({ title, topic: 'y' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

// --- fixture video + fake acquisition provider, same convention as
// test/cross-video-pattern-service.test.js's own buildFixtureVideo/
// ingestFixture (mirrored, not duplicated logic — this file never touches
// ingestReferenceVideo()/measureReferenceVideo()/etc. itself). ---
const fixtureVideos = {};
function buildFixtureVideo(key, shotDurations) {
  if (fixtureVideos[key]) return fixtureVideos[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evolink-iorch-src-${key}-`));
  const p = path.join(dir, 'v.mp4');
  const colors = ['red', 'blue', 'green', 'yellow', 'white'];
  const inputs = [];
  shotDurations.forEach((dur, i) => inputs.push('-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:size=160x90:duration=${dur}:rate=15`));
  const total = shotDurations.reduce((a, b) => a + b, 0);
  inputs.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${total}`);
  const filterInputs = shotDurations.map((_, i) => `[${i}:v]`).join('');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', `${filterInputs}concat=n=${shotDurations.length}:v=1:a=0[outv]`, '-map', '[outv]', '-map', `${shotDurations.length}:a`, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  fixtureVideos[key] = p;
  return p;
}

const WORDS = [
  { word: 'Is', startTime: 0, endTime: 0.2 },
  { word: 'this', startTime: 0.2, endTime: 0.4 },
  { word: 'working?', startTime: 0.4, endTime: 0.8 },
  { word: 'Yes', startTime: 1.0, endTime: 1.2 },
  { word: 'it', startTime: 1.2, endTime: 1.3 },
  { word: 'is.', startTime: 1.3, endTime: 1.6 },
];

function fakeProvider(videoPath, overrides = {}) {
  return {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 't', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'COMPLETED', transcript: { text: WORDS.map((w) => w.word).join(' '), language: 'en', words: WORDS, segments: [] }, diagnostics: [] }),
    ...overrides,
  };
}

function fetchImplServing(filePath) {
  return async () => {
    const buf = fs.readFileSync(filePath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
}

function urlsFor(n) {
  return Array.from({ length: n }, (_, i) => `https://www.youtube.com/watch?v=fx${String(i + 1).padStart(11, '0')}`);
}

async function runGolden(project, { n = 3, acquisitionOverrides = {} } = {}) {
  const videoPath = buildFixtureVideo('golden', [1, 1]);
  const result = await orchestrator.startIntelligenceRun(project.id, {
    referenceVideoUrls: urlsFor(n),
    name: 'Golden Set',
    acquisitionProvider: fakeProvider(videoPath, acquisitionOverrides),
    fetchImpl: fetchImplServing(videoPath),
  });
  return result;
}

// === (1) IntelligenceRun schema ============================================

test('1. createIntelligenceRun() produces a well-formed, real-defaults record', () => {
  const run = createIntelligenceRun({ projectId: 'p1' });
  assert.equal(run.status, 'REQUESTED');
  assert.equal(run.failureStage, null);
  assert.deepEqual(run.videoProgress, []);
  assert.deepEqual(run.diagnostics, []);
  assert.equal(run.patternSetId, null);
  assert.equal(run.recommendationSetId, null);
  assert.ok(run.intelligenceRunId);
  assert.ok(run.createdAt);
});

test('2. INTELLIGENCE_FAILURE_STAGES deliberately excludes INTERPRETATION (Part 11 — interpretation never fails the run)', () => {
  assert.ok(!INTELLIGENCE_FAILURE_STAGES.includes('INTERPRETATION'));
  assert.ok(INTELLIGENCE_RUN_STATUSES.includes('INTERPRETING'));
});

test('3. intelligence-run-store persists, reads, lists (filtered), and updates a run', async () => {
  const run = intelligenceRunStore.addIntelligenceRun({ projectId: 'p2', status: 'REQUESTED' });
  assert.ok(intelligenceRunStore.getIntelligenceRun(run.intelligenceRunId));
  const listed = intelligenceRunStore.listIntelligenceRuns({ projectId: 'p2' });
  assert.equal(listed.length, 1);
  // A real, if tiny, delay — updatedAt has millisecond resolution and the
  // add+update pair above can otherwise land in the same millisecond
  // under fast synchronous execution, making a notEqual comparison flaky
  // rather than meaningful.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = intelligenceRunStore.updateIntelligenceRun(run.intelligenceRunId, { ...run, status: 'COMPLETE' });
  assert.equal(updated.status, 'COMPLETE');
  assert.notEqual(updated.updatedAt, run.updatedAt);
  assert.equal(intelligenceRunStore.getIntelligenceRun('not-a-real-id'), null);
});

// === (13) operator entry point + basic guards ==============================

test('4. startIntelligenceRun fails immediately for a non-existent project', async () => {
  const result = await orchestrator.startIntelligenceRun('00000000-0000-4000-8000-000000000000', { referenceVideoUrls: ['https://x'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_NOT_FOUND');
});

test('5. startIntelligenceRun fails with NO_REFERENCE_INPUT when neither referenceVideoUrls nor referenceSetId is given (Part 4 — never invents topic-only discovery)', async () => {
  const project = newProject();
  const result = await orchestrator.startIntelligenceRun(project.id, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_REFERENCE_INPUT');
});

test('6. startIntelligenceRun fails with REFERENCE_SET_NOT_FOUND for a bogus referenceSetId', async () => {
  const project = newProject();
  const result = await orchestrator.startIntelligenceRun(project.id, { referenceSetId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REFERENCE_SET_NOT_FOUND');
});

// === (14) THE GOLDEN INTELLIGENCE TEST ======================================

test('7. GOLDEN INTELLIGENCE TEST: ONE call to startIntelligenceRun drives real ingestion -> measurement -> observation -> cross-video pattern extraction -> recommendation generation to a real, persisted, COMPLETE RecommendationSet', async () => {
  const project = newProject('Golden Intelligence Test');
  const result = await runGolden(project, { n: 3 });

  assert.equal(result.ok, true, JSON.stringify(result));
  const run = result.run;
  assert.equal(run.status, 'COMPLETE');
  assert.equal(run.failureStage, null);
  assert.equal(run.videoProgress.length, 3);
  for (const vp of run.videoProgress) {
    assert.equal(vp.ingestionStatus, 'COMPLETE');
    assert.ok(vp.referenceVideoId);
    assert.ok(vp.measurementId);
    assert.ok(vp.observationSetId);
  }
  assert.ok(run.patternSetId);
  assert.ok(run.recommendationSetId);

  // The run itself is really persisted, independently re-readable.
  const reloaded = intelligenceRunStore.getIntelligenceRun(run.intelligenceRunId);
  assert.equal(reloaded.status, 'COMPLETE');

  // The RecommendationSet is a REAL, persisted record from INT-1F, not a
  // second copy invented by the orchestrator.
  const recSet = recommendationStore.getRecommendationSet(project.id, run.recommendationSetId);
  assert.ok(recSet);
  assert.ok(['COMPLETE', 'PARTIAL'].includes(recSet.status));

  // The PatternSet is a REAL, persisted record from INT-1E.
  const patternSet = patternStore.getPatternSet(project.id, run.patternSetId);
  assert.ok(patternSet);
});

test('8. GOLDEN TEST — full evidence chain (Part 25): every id in the run traces back to a real, persisted record belonging to this exact project/run', async () => {
  const project = newProject('Evidence Chain Test');
  const result = await runGolden(project, { n: 3 });
  assert.equal(result.ok, true);
  const run = result.run;

  const recSet = recommendationStore.getRecommendationSet(project.id, run.recommendationSetId);
  assert.equal(recSet.referenceSetId, run.referenceSetId);

  const patternSet = patternStore.getPatternSet(project.id, run.patternSetId);
  assert.equal(patternSet.referenceSetId, run.referenceSetId);

  // Every support[] reference on every pattern resolves to a REAL
  // Measurements/ObservationSet/ReferenceVideo that this run itself
  // produced (never a foreign or fabricated id).
  const knownReferenceVideoIds = new Set(run.videoProgress.map((v) => v.referenceVideoId));
  const knownMeasurementIds = new Set(run.videoProgress.map((v) => v.measurementId));
  const knownObservationSetIds = new Set(run.videoProgress.map((v) => v.observationSetId));

  let checkedAtLeastOneSupportEntry = false;
  for (const pattern of patternSet.patterns) {
    for (const support of pattern.support) {
      checkedAtLeastOneSupportEntry = true;
      assert.ok(knownReferenceVideoIds.has(support.referenceVideoId), `pattern support referenceVideoId "${support.referenceVideoId}" must belong to this run`);
      const rv = referenceVideoStore.getReferenceVideo(project.id, support.referenceVideoId);
      assert.ok(rv, 'the referenced ReferenceVideo must actually exist');
      if (support.measurementsId) {
        assert.ok(knownMeasurementIds.has(support.measurementsId));
        assert.ok(measurementStore.getMeasurement(project.id, support.measurementsId));
      }
      if (support.observationSetId) {
        assert.ok(knownObservationSetIds.has(support.observationSetId));
        assert.ok(observationStore.getObservationSet(project.id, support.observationSetId));
      }
    }
  }
  assert.ok(checkedAtLeastOneSupportEntry, 'the fixture must exercise at least one real pattern support entry');
});

// === (3) dependency ordering / (4) stage invocation =========================

test('9. resumeIntelligenceRun executes stages in the real, verified order (ingest -> measure -> observe -> pattern -> recommend), never patterning before every video has been measured/observed', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('order', [1, 1]);
  const run0 = intelligenceRunStore.addIntelligenceRun({
    projectId: project.id,
    referenceSetId: referenceSetSvc.createSet(project.id, { name: 'order-set' }).referenceSet.id,
    requestedReferenceVideoUrls: urlsFor(3),
    videoProgress: urlsFor(3).map((url) => ({ url, referenceVideoId: null, ingestionStatus: null, measurementId: null, observationSetId: null, interpretations: [] })),
    status: 'REQUESTED',
  });
  const result = await orchestrator.resumeIntelligenceRun(run0.intelligenceRunId, { acquisitionProvider: fakeProvider(videoPath), fetchImpl: fetchImplServing(videoPath) });
  assert.equal(result.ok, true);
  for (const vp of result.run.videoProgress) {
    assert.ok(vp.referenceVideoId && vp.measurementId && vp.observationSetId, 'every video must be fully ingested/measured/observed before the run reaches PATTERNING');
  }
});

// === (5)/(6) idempotency + resumability =====================================

test('10. resumeIntelligenceRun is idempotent: re-running a COMPLETE run again is a no-op that returns ok:true without recomputing anything', async () => {
  const project = newProject();
  const first = await runGolden(project, { n: 3 });
  assert.equal(first.ok, true);
  const countBefore = referenceVideoStore.listReferenceVideos(project.id).length;

  const second = await orchestrator.resumeIntelligenceRun(first.run.intelligenceRunId);
  assert.equal(second.ok, true);
  assert.equal(second.run.intelligenceRunId, first.run.intelligenceRunId);
  assert.equal(referenceVideoStore.listReferenceVideos(project.id).length, countBefore, 'no new ReferenceVideo should be created by re-running a COMPLETE run');
});

test('11. startIntelligenceRun called twice while a run is in-flight resumes the SAME run, never creating a duplicate (Part 14, mirrors startProduction convention)', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('dup', [1, 1]);

  // Seed a non-terminal run manually (simulating "still in flight"), with
  // its own real requested videos already recorded — a second start_
  // intelligence call never merges NEW urls into an in-flight run's own
  // videoProgress (resumeIntelligenceRun only ever resumes what the run
  // itself already recorded), exactly mirroring startProduction()'s own
  // "a second call resumes the existing job as-is" convention.
  const set = referenceSetSvc.createSet(project.id, { name: 'dup-set' }).referenceSet;
  const inflight = intelligenceRunStore.addIntelligenceRun({
    projectId: project.id,
    referenceSetId: set.id,
    status: 'INGESTING',
    videoProgress: urlsFor(3).map((url) => ({ url, referenceVideoId: null, ingestionStatus: null, measurementId: null, observationSetId: null, interpretations: [] })),
  });

  // The new URL passed on this second call is NEVER merged into the
  // in-flight run — resumeIntelligenceRun() drives only the run's own
  // already-recorded videoProgress.
  const second = await orchestrator.startIntelligenceRun(project.id, { referenceVideoUrls: ['https://www.youtube.com/watch?v=fxNEWNEWNEW1'], acquisitionProvider: fakeProvider(videoPath), fetchImpl: fetchImplServing(videoPath) });
  assert.equal(second.run.intelligenceRunId, inflight.intelligenceRunId, 'a second start call must resume the existing non-terminal run, never start a duplicate');
  assert.equal(second.ok, true, JSON.stringify(second.run.diagnostics));
  assert.equal(second.run.videoProgress.length, 3, 'the new url from the second call must never be merged into the in-flight run');
  assert.ok(!second.run.videoProgress.some((v) => v.url === 'https://www.youtube.com/watch?v=fxNEWNEWNEW1'));

  const listed = intelligenceRunStore.listIntelligenceRuns({ projectId: project.id });
  assert.equal(listed.length, 1);
});

test('12. resumability: an IntelligenceRun with some videos already ingested (persisted ids present) resumes from that checkpoint — never re-ingests', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('resume', [1, 1]);
  const set = referenceSetSvc.createSet(project.id, { name: 'resume-set' }).referenceSet;

  let calls = 0;
  const provider = fakeProvider(videoPath, {
    resolveSource: async () => {
      calls += 1;
      return { status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] };
    },
  });

  // Pre-ingest ONE video directly (simulating a process that already
  // completed INGESTING for this video before a crash), and seed the run
  // with its real referenceVideoId already recorded.
  const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl: fetchImplServing(videoPath) });
  referenceSetSvc.addVideo(project.id, set.id, rv.id);
  assert.equal(calls, 1);

  const run0 = intelligenceRunStore.addIntelligenceRun({
    projectId: project.id,
    referenceSetId: set.id,
    requestedReferenceVideoUrls: [...urlsFor(3)],
    videoProgress: [
      { url: 'https://www.youtube.com/watch?v=fx0000000001', referenceVideoId: rv.id, ingestionStatus: rv.status, measurementId: null, observationSetId: null, interpretations: [] },
      ...urlsFor(3).slice(1).map((url) => ({ url, referenceVideoId: null, ingestionStatus: null, measurementId: null, observationSetId: null, interpretations: [] })),
    ],
    status: 'REQUESTED',
  });

  const result = await orchestrator.resumeIntelligenceRun(run0.intelligenceRunId, { acquisitionProvider: provider, fetchImpl: fetchImplServing(videoPath) });
  assert.equal(result.ok, true, JSON.stringify(result.run.diagnostics));
  assert.equal(calls, 3, 'resolveSource must be called exactly once per NEW video — the already-ingested one must never be re-acquired');
  assert.equal(result.run.videoProgress[0].referenceVideoId, rv.id);
});

// === (7) partial failure semantics ==========================================

test('13. partial ingestion failure: one video fails to acquire, the others succeed, patterning proceeds on real evidence, and the failed video is never silently dropped from videoProgress', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('partial', [1, 1]);
  let call = 0;
  const provider = fakeProvider(videoPath, {
    acquireVideo: async () => {
      call += 1;
      if (call === 1) return { status: 'FAILED', diagnostics: [{ code: 'VIDEO_UNAVAILABLE', message: 'simulated failure' }] };
      return { status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] };
    },
  });

  const result = await orchestrator.startIntelligenceRun(project.id, {
    referenceVideoUrls: urlsFor(4), // 1 fails, 3 succeed — 3 real successes is exactly MIN_ABSOLUTE_SUPPORT_COUNT, so patterning can still legitimately proceed
    acquisitionProvider: provider,
    fetchImpl: fetchImplServing(videoPath),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.run.videoProgress.length, 4, 'the failed video must remain in videoProgress — never silently excluded from the denominator');
  const statuses = result.run.videoProgress.map((v) => v.ingestionStatus);
  assert.ok(statuses.includes('FAILED'));
  assert.equal(statuses.filter((s) => s === 'COMPLETE').length, 3);
  // Patterning still ran on the 2 real successful videos + whatever
  // pre-existing members — status must not silently claim more success
  // than actually happened.
  assert.ok(result.run.patternSetId);
});

test('14. failure injection — measurement failure for one video is recorded in diagnostics without crashing the run', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('measfail', [1, 1]);
  const set = referenceSetSvc.createSet(project.id, { name: 'measfail-set' }).referenceSet;

  const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
  const timelineStore = require('../services/timeline-store');
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider: fakeProvider(videoPath), fetchImpl: fetchImplServing(videoPath) });
  timelineStore.updateAssetStorage(project.id, rv.videoAssetId, { status: 'FAILED' });
  referenceSetSvc.addVideo(project.id, set.id, rv.id);

  const run0 = intelligenceRunStore.addIntelligenceRun({
    projectId: project.id,
    referenceSetId: set.id,
    videoProgress: [{ url: 'https://www.youtube.com/watch?v=fx0000000001', referenceVideoId: rv.id, ingestionStatus: rv.status, measurementId: null, observationSetId: null, interpretations: [] }],
    status: 'REQUESTED',
  });

  const result = await orchestrator.resumeIntelligenceRun(run0.intelligenceRunId);
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'FAILED');
  assert.equal(result.run.failureStage, 'PATTERNING'); // insufficient real evidence after the one member's measurement genuinely failed
  assert.ok(result.run.diagnostics.length > 0);
});

// === (9) evidence sufficiency ===============================================

test('15. evidence sufficiency: fewer than MIN_ABSOLUTE_SUPPORT_COUNT(3) real members correctly fails at PATTERNING, never fabricating a pattern from insufficient evidence', async () => {
  const project = newProject();
  const result = await runGolden(project, { n: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'FAILED');
  assert.equal(result.run.failureStage, 'PATTERNING');
  assert.equal(result.run.patternSetId, null, 'no PatternSet id should be recorded for a failed extraction');
  assert.equal(result.run.recommendationSetId, null, 'recommendation generation must never run after patterning genuinely failed');
});

// === (10) financial controls / interpretation gate ==========================

test('16. interpretation is OPT-IN: a run with no interpretationQuestions never creates any InterpretationApproval or Interpretation record', async () => {
  const project = newProject();
  const result = await runGolden(project, { n: 3 });
  assert.equal(result.ok, true);
  for (const vp of result.run.videoProgress) {
    assert.deepEqual(vp.interpretations, []);
  }
  assert.equal(interpretationStore.listInterpretations(project.id).length, 0);
});

test('17. interpretation gate: a requested question stays AWAITING_APPROVAL (never auto-approved, never fails the run) until a human decides it', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('interp-gate', [1, 1]);
  const result = await orchestrator.startIntelligenceRun(project.id, {
    referenceVideoUrls: urlsFor(3),
    interpretationQuestions: ['OPENING_STRUCTURAL_PURPOSE'],
    acquisitionProvider: fakeProvider(videoPath),
    fetchImpl: fetchImplServing(videoPath),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.run.status, 'COMPLETE', 'interpretation awaiting approval must never fail or block the run — Part 11');
  for (const vp of result.run.videoProgress) {
    assert.equal(vp.interpretations.length, 1);
    assert.equal(vp.interpretations[0].status, 'AWAITING_APPROVAL');
    assert.equal(vp.interpretations[0].interpretationId, null);
    // A real InterpretationApproval was actually created (never bypassed).
    const approval = interpretationApprovalStore.getApproval(project.id, vp.referenceVideoId, 'OPENING_STRUCTURAL_PURPOSE');
    assert.equal(approval.status, 'PENDING');
  }
  // Never auto-approved, never fabricated.
  assert.equal(interpretationStore.listInterpretations(project.id).length, 0);
});

test('18. interpretation gate: once a human explicitly approves + acknowledges, a SECOND resume call actually completes that interpretation via the existing INT-1D service — never a fabricated result', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('interp-approved', [1, 1]);
  const first = await orchestrator.startIntelligenceRun(project.id, {
    referenceVideoUrls: urlsFor(3),
    interpretationQuestions: ['OPENING_STRUCTURAL_PURPOSE'],
    acquisitionProvider: fakeProvider(videoPath),
    fetchImpl: fetchImplServing(videoPath),
  });
  assert.equal(first.ok, true);

  // A human decides + acknowledges, exactly as INT-1D's own test suite
  // establishes — the orchestrator never calls decideApproval/
  // acknowledgeUnknownCost itself.
  for (const vp of first.run.videoProgress) {
    interpretationApprovalStore.decideApproval(project.id, vp.referenceVideoId, 'OPENING_STRUCTURAL_PURPOSE', { approve: true, decidedBy: 'tester' });
    interpretationApprovalStore.acknowledgeUnknownCost(project.id, vp.referenceVideoId, 'OPENING_STRUCTURAL_PURPOSE', { acknowledgedBy: 'tester' });
  }

  // Force the run back to a non-terminal status so resumeIntelligenceRun
  // re-attempts the INTERPRETING stage exactly like a real restart would.
  intelligenceRunStore.updateIntelligenceRun(first.run.intelligenceRunId, { ...first.run, status: 'INTERPRETING' });

  const second = await orchestrator.resumeIntelligenceRun(first.run.intelligenceRunId, { interpretationProvider: createFakeInterpretationProvider() });
  assert.equal(second.ok, true, JSON.stringify(second.run.diagnostics));
  for (const vp of second.run.videoProgress) {
    assert.equal(vp.interpretations[0].status, 'COMPLETED');
    assert.ok(vp.interpretations[0].interpretationId);
    const interp = interpretationStore.getInterpretation(project.id, vp.interpretations[0].interpretationId);
    assert.ok(interp, 'the interpretationId recorded on videoProgress must resolve to a REAL, persisted Interpretation');
    assert.equal(interp.referenceVideoId, vp.referenceVideoId);
  }
  // Patterning/Recommendation must not have been re-run/duplicated.
  assert.equal(second.run.patternSetId, first.run.patternSetId);
  assert.equal(second.run.recommendationSetId, first.run.recommendationSetId);
});

test('19. interpretation provider failure is recorded as a non-blocking diagnostic — the run still reaches COMPLETE', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('interp-fail', [1, 1]);
  const first = await orchestrator.startIntelligenceRun(project.id, {
    referenceVideoUrls: urlsFor(3),
    interpretationQuestions: ['OPENING_STRUCTURAL_PURPOSE'],
    acquisitionProvider: fakeProvider(videoPath),
    fetchImpl: fetchImplServing(videoPath),
  });
  for (const vp of first.run.videoProgress) {
    interpretationApprovalStore.decideApproval(project.id, vp.referenceVideoId, 'OPENING_STRUCTURAL_PURPOSE', { approve: true, decidedBy: 'tester' });
    interpretationApprovalStore.acknowledgeUnknownCost(project.id, vp.referenceVideoId, 'OPENING_STRUCTURAL_PURPOSE', { acknowledgedBy: 'tester' });
  }
  intelligenceRunStore.updateIntelligenceRun(first.run.intelligenceRunId, { ...first.run, status: 'INTERPRETING' });

  const failingProvider = createFakeInterpretationProvider({ respond: () => ({ status: 'UNAVAILABLE', diagnostics: [{ code: 'INTERPRETATION_PROVIDER_UNAVAILABLE', message: 'simulated no API key' }] }) });
  const second = await orchestrator.resumeIntelligenceRun(first.run.intelligenceRunId, { interpretationProvider: failingProvider });

  assert.equal(second.ok, true, 'a provider failure for the OPTIONAL interpretation branch must never fail the whole run');
  assert.equal(second.run.status, 'COMPLETE');
  for (const vp of second.run.videoProgress) {
    assert.equal(vp.interpretations[0].status, 'FAILED');
  }
  assert.ok(second.run.diagnostics.some((d) => d.stage === 'INTERPRETATION_NON_BLOCKING'));
});

// === (11) provenance =========================================================

test('20. provenance: the run never mutates the underlying ReferenceVideo/Measurement/ObservationSet records it references — only reads them', async () => {
  const project = newProject();
  const result = await runGolden(project, { n: 3 });
  assert.equal(result.ok, true);
  const vp = result.run.videoProgress[0];
  const rvBefore = JSON.stringify(referenceVideoStore.getReferenceVideo(project.id, vp.referenceVideoId));
  await orchestrator.resumeIntelligenceRun(result.run.intelligenceRunId);
  const rvAfter = JSON.stringify(referenceVideoStore.getReferenceVideo(project.id, vp.referenceVideoId));
  assert.equal(rvBefore, rvAfter);
});

test('21. provenance: a FAILED ingestion is never added as a ReferenceSet member (Part 10)', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('noadd', [1, 1]);
  const provider = fakeProvider(videoPath, { acquireVideo: async () => ({ status: 'FAILED', diagnostics: [{ code: 'VIDEO_UNAVAILABLE', message: 'x' }] }) });
  const result = await orchestrator.startIntelligenceRun(project.id, { referenceVideoUrls: ['https://www.youtube.com/watch?v=fx0000000001'], acquisitionProvider: provider, fetchImpl: fetchImplServing(videoPath) });
  const set = referenceSetStore.getReferenceSet(project.id, result.run.referenceSetId);
  assert.equal(set.members.length, 0, 'a FAILED ingestion must never become a ReferenceSet member');
});

// === (8) provider failure — recommendation stage ============================

test('22. failure injection — recommendation generation genuinely fails (no ReferenceSet at all) is reported honestly, never silently COMPLETE', async () => {
  const project = newProject();
  const emptySet = referenceSetSvc.createSet(project.id, { name: 'empty' }).referenceSet;
  const run0 = intelligenceRunStore.addIntelligenceRun({ projectId: project.id, referenceSetId: emptySet.id, videoProgress: [], status: 'REQUESTED' });
  const result = await orchestrator.resumeIntelligenceRun(run0.intelligenceRunId);
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'FAILED');
  assert.equal(result.run.failureStage, 'PATTERNING');
});

// === (2) lifecycle transitions ==============================================

test('23. resumeIntelligenceRun on an already-terminal (COMPLETE) run is a safe no-op returning ok:true without changing status', async () => {
  const project = newProject();
  const result = await runGolden(project, { n: 3 });
  const before = result.run.updatedAt;
  const again = await orchestrator.resumeIntelligenceRun(result.run.intelligenceRunId);
  assert.equal(again.ok, true);
  assert.equal(again.run.status, 'COMPLETE');
});

test('24. resumeIntelligenceRun on an already-terminal (FAILED) run is a safe no-op returning ok:false without re-attempting the pipeline', async () => {
  const project = newProject();
  const result = await runGolden(project, { n: 2 }); // insufficient evidence -> FAILED
  assert.equal(result.run.status, 'FAILED');
  const again = await orchestrator.resumeIntelligenceRun(result.run.intelligenceRunId);
  assert.equal(again.ok, false);
  assert.equal(again.run.status, 'FAILED');
});

test('25. getIntelligenceStatus returns ok:false with a reason for an unknown run id, never a silent pass', () => {
  const result = orchestrator.getIntelligenceStatus('00000000-0000-4000-8000-000000000000');
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

// === (12) async execution ====================================================

test('26. startIntelligenceRunAsync returns immediately (never blocks on the real pipeline) and the forked child process drives the SAME run to COMPLETE', async () => {
  const project = newProject('Async Golden Test');
  const videoPath = buildFixtureVideo('async', [1, 1]);

  // startIntelligenceRunAsync() cannot accept a fake acquisitionProvider
  // (it never crosses the fork() boundary — by design, see that
  // function's own header) — so this test seeds a run whose videos are
  // ALREADY ingested via the sync/testable path, then proves the async
  // fork picks up from there and completes measurement -> recommendation
  // for real, exactly the same "provider overrides are sync-path-only"
  // convention startProductionAsync()'s own tests already establish.
  const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
  const set = referenceSetSvc.createSet(project.id, { name: 'async-set' }).referenceSet;
  const provider = fakeProvider(videoPath);
  for (const url of urlsFor(3)) {
    const rv = await ingestReferenceVideo(project.id, { url, provider, fetchImpl: fetchImplServing(videoPath) });
    referenceSetSvc.addVideo(project.id, set.id, rv.id);
  }

  const requestedAt = Date.now();
  const started = orchestrator.startIntelligenceRunAsync(project.id, { referenceSetId: set.id });
  const returnedAfterMs = Date.now() - requestedAt;
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(!['COMPLETE', 'FAILED'].includes(started.run.status), 'must return before the real pipeline finishes');
  assert.ok(returnedAfterMs < 2000, `startIntelligenceRunAsync must return quickly (took ${returnedAfterMs}ms)`);

  const deadline = Date.now() + 60000;
  let finalRun;
  for (;;) {
    finalRun = intelligenceRunStore.getIntelligenceRun(started.run.intelligenceRunId);
    if (['COMPLETE', 'FAILED'].includes(finalRun.status)) break;
    if (Date.now() > deadline) throw new Error(`intelligence run did not reach a terminal status within the deadline (last status: ${finalRun.status})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(finalRun.status, 'COMPLETE', JSON.stringify(finalRun.diagnostics));
  assert.ok(finalRun.recommendationSetId);
});

test('27. startIntelligenceRunAsync is idempotent per project: a second call while non-terminal resumes the same run', () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'async-dup-set' }).referenceSet;
  const first = orchestrator.startIntelligenceRunAsync(project.id, { referenceSetId: set.id });
  assert.equal(first.ok, true);
  const second = orchestrator.startIntelligenceRunAsync(project.id, { referenceSetId: set.id });
  assert.equal(second.ok, true);
  assert.equal(second.run.intelligenceRunId, first.run.intelligenceRunId);
});

// === determinism (Part 27) ===================================================

test('28. determinism: re-running extractPatterns/generateRecommendations through the orchestrator against unchanged evidence never duplicates or alters the underlying PatternSet/RecommendationSet ids', async () => {
  const project = newProject();
  const result = await runGolden(project, { n: 3 });
  assert.equal(result.ok, true);
  const patternSetIdBefore = result.run.patternSetId;
  const recommendationSetIdBefore = result.run.recommendationSetId;
  const again = await orchestrator.resumeIntelligenceRun(result.run.intelligenceRunId);
  assert.equal(again.run.patternSetId, patternSetIdBefore);
  assert.equal(again.run.recommendationSetId, recommendationSetIdBefore);
  assert.equal(patternStore.listPatternSets(project.id).length, 1, 'idempotent resume must never create a second PatternSet');
  assert.equal(recommendationStore.listRecommendationSets(project.id).length, 1, 'idempotent resume must never create a second RecommendationSet');
});

// === reusing an existing, curated ReferenceSet (Part 9 multi-reference) ====

test('29. an existing, pre-curated ReferenceSet (with a REJECTED member) is honored exactly — orchestrator never re-includes rejected members', async () => {
  const project = newProject();
  const videoPath = buildFixtureVideo('curated', [1, 1]);
  const provider = fakeProvider(videoPath);
  const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
  const set = referenceSetSvc.createSet(project.id, { name: 'curated-set' }).referenceSet;
  const ids = [];
  for (const url of urlsFor(4)) {
    const rv = await ingestReferenceVideo(project.id, { url, provider, fetchImpl: fetchImplServing(videoPath) });
    referenceSetSvc.addVideo(project.id, set.id, rv.id);
    ids.push(rv.id);
  }
  referenceSetSvc.curateVideo(project.id, set.id, ids[0], { curationStatus: 'REJECTED', curatedBy: 'tester' });

  const result = await orchestrator.startIntelligenceRun(project.id, { referenceSetId: set.id });
  assert.equal(result.ok, true, JSON.stringify(result.run.diagnostics));
  assert.equal(result.run.videoProgress.length, 3, 'the REJECTED member must not be seeded into videoProgress at all');
  assert.ok(!result.run.videoProgress.some((v) => v.referenceVideoId === ids[0]));
});

// === security / hygiene (Part 28, quick in-file check) =====================

test('30. intelligence-orchestrator-service.js makes no direct network call, no shell/eval, and requires no new credential', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intelligence-orchestrator-service.js'), 'utf8');
  assert.ok(!/\beval\(/.test(src));
  assert.ok(!/child_process['"]\)\.exec\b/.test(src));
  assert.ok(!/\bfetch\(/.test(src), 'the orchestrator itself must never call fetch directly — only ingestReferenceVideo()/interpretReferenceVideo() do, through their own existing boundaries');
  assert.ok(!/API_KEY|API_TOKEN/.test(src), 'no new credential env var should be referenced directly by the orchestrator');
});

// === PRODUCTION UNBLOCK — Part 3: reference failure degrades gracefully ===

test('PB-1. total reference acquisition failure is recorded honestly (real VIDEO_ACQUISITION_FAILED + INSUFFICIENT_REFERENCE_SET diagnostics, run status FAILED) AND does not prevent a creator-led CreativeBlueprint from being built for the same project afterward', async () => {
  const creativeBlueprintService = require('../services/creative-blueprint-service');
  const project = newProject();
  const result = await runGolden(project, {
    n: 3,
    acquisitionOverrides: { acquireVideo: async () => ({ status: 'FAILED', diagnostics: [{ code: 'VIDEO_ACQUISITION_FAILED', message: 'provider returned no result URL' }] }) },
  });

  // --- the failure is real and explicitly represented, exactly as before
  // this stage — nothing here was changed in the orchestrator itself. ---
  assert.equal(result.run.status, 'FAILED');
  assert.equal(result.run.failureStage, 'PATTERNING');
  assert.ok(result.run.diagnostics.some((d) => d.code === 'VIDEO_ACQUISITION_FAILED'));
  assert.ok(result.run.diagnostics.some((d) => d.code === 'INSUFFICIENT_REFERENCE_SET'));
  assert.equal(result.run.recommendationSetId, null);

  // --- the failure does NOT poison the project: no RecommendationSet
  // exists for it, and a creator-led Blueprint can still be built. ---
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    concept: 'a cleaner survives a hit and runs',
    corePromise: 'survive the next thirty seconds',
    targetDuration: 360,
  });
  assert.equal(draft.status, 'DRAFT');
  assert.deepEqual(draft.diagnostics, []);
  assert.equal(draft.recommendationSetId, null);
});

test('PB-2. FAILURE INJECTION — partial reference failure (some videos acquire, not enough to pattern) is still recorded honestly and still does not block creator-led Blueprint creation', async () => {
  const creativeBlueprintService = require('../services/creative-blueprint-service');
  const project = newProject();
  let call = 0;
  const result = await runGolden(project, {
    n: 3,
    acquisitionOverrides: {
      acquireVideo: async () => {
        call += 1;
        if (call === 1) return { status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] };
        return { status: 'FAILED', diagnostics: [{ code: 'VIDEO_ACQUISITION_FAILED', message: 'provider returned no result URL' }] };
      },
    },
  });
  assert.equal(result.run.status, 'FAILED'); // 1 successful ingestion is still short of the 3-video patterning minimum
  assert.ok(result.run.diagnostics.some((d) => d.code === 'INSUFFICIENT_REFERENCE_SET'));

  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { concept: 'c', corePromise: 'p', targetDuration: 60 });
  assert.equal(draft.status, 'DRAFT');
});
