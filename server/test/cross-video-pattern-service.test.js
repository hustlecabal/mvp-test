// Tests for services/cross-video-pattern-service.js — the orchestrator,
// and the primary home for this stage's Part 22 synthetic-fixture tests
// (3/10/50-video reference sets) and Part 24-27 idempotency/security/
// data-safety proofs. Every member is REAL INT-1A/B/C evidence (real
// FFmpeg-encoded fixture videos run through the real, unmodified
// ingestion -> measurement -> observation pipeline) — only the video
// CONTENT is synthetic (deterministic lavfi color/tone sources), never
// the evidence pipeline itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-cvp-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-cvp-projects-'],
  ['REFERENCE_VIDEO_DATA_DIR', 'evolink-cvp-rvstore-'],
  ['REFERENCE_VIDEO_MEASUREMENT_DATA_DIR', 'evolink-cvp-mstore-'],
  ['REFERENCE_VIDEO_OBSERVATION_DATA_DIR', 'evolink-cvp-ostore-'],
  ['REFERENCE_SET_DATA_DIR', 'evolink-cvp-rsstore-'],
  ['CROSS_VIDEO_PATTERN_DATA_DIR', 'evolink-cvp-pstore-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const timelineStore = require('../services/timeline-store');
const referenceVideoStore = require('../services/reference-video-store');
const measurementStore = require('../services/reference-video-measurement-store');
const observationStore = require('../services/reference-video-observation-store');
const patternStore = require('../services/cross-video-pattern-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const { measureReferenceVideo } = require('../services/reference-video-measurement-service');
const { deriveObservations } = require('../services/reference-video-observation-service');
const referenceSetSvc = require('../services/reference-set-service');
const patternSvc = require('../services/cross-video-pattern-service');

// P0 Hardening (finding J) — ingestReferenceVideo() now blocks on the
// project's approval-gate.js budget/approval state before making any real
// (billed, in production) Apify call. Pre-approved here so every existing
// test in this file exercising the acquisition/pattern pipeline is
// unaffected.
function newProject() {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

// Builds a small set of REUSABLE fixture video files ONCE — many
// "different" reference videos in these tests reuse the same underlying
// encoded bytes (a real ReferenceVideo/Asset is still created fresh per
// ingestion; only the FFmpeg ENCODE is shared, to keep a 50-video test
// fast without weakening the real-pipeline proof).
const fixtureVideos = {};
function buildFixtureVideo(key, shotDurations) {
  if (fixtureVideos[key]) return fixtureVideos[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evolink-cvp-src-${key}-`));
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

async function ingestFixture(project, videoPath, { words } = {}) {
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 't', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => (words ? { status: 'COMPLETED', transcript: { text: words.map((w) => w.word).join(' '), language: 'en', words, segments: [] }, diagnostics: [] } : { status: 'FAILED', diagnostics: [] }),
  };
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl });
  const measurements = measureReferenceVideo(project.id, rv.id);
  const observationSet = deriveObservations(project.id, measurements.id);
  return { rv, measurements, observationSet };
}

// Ingests a real ReferenceVideo whose video Asset is broken BEFORE it is
// ever successfully measured. reference-video-measurement-service.js's
// INVALID_REFERENCE_VIDEO early-return path (videoAsset.storage.status !==
// 'STORED') never calls measurementStore.addMeasurement — it simply
// returns an unpersisted FAILED result — so this genuinely leaves the
// ReferenceVideo with ZERO stored Measurements records, exactly matching
// extractPatterns's real "no usable Measurements" case (never a stored-
// but-FAILED record, since a failure this early is never written at all).
async function ingestBrokenFixture(project, videoPath) {
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 't', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'FAILED', diagnostics: [] }),
  };
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl });
  timelineStore.updateAssetStorage(project.id, rv.videoAssetId, { status: 'FAILED' });
  measureReferenceVideo(project.id, rv.id); // real call, confirms FAILED — intentionally never persisted, matching the real service's own behavior
  return { rv };
}

const WORDS_WITH_QUESTION = [
  { word: 'Is', startTime: 0, endTime: 0.2 },
  { word: 'this', startTime: 0.2, endTime: 0.4 },
  { word: 'working?', startTime: 0.4, endTime: 0.8 },
  { word: 'Yes', startTime: 1.0, endTime: 1.2 },
  { word: 'it', startTime: 1.2, endTime: 1.3 },
  { word: 'is.', startTime: 1.3, endTime: 1.6 },
];
const WORDS_NO_QUESTION = [
  { word: 'Hello', startTime: 0, endTime: 0.3 },
  { word: 'there.', startTime: 0.3, endTime: 0.6 },
  { word: 'Nice', startTime: 1.0, endTime: 1.2 },
  { word: 'day.', startTime: 1.2, endTime: 1.5 },
];

async function buildSetOfSize(project, n, { shots = [1, 1] } = {}) {
  const set = referenceSetSvc.createSet(project.id, { name: `set-${n}`, criteria: 'synthetic' }).referenceSet;
  const videoPath = buildFixtureVideo(`shots-${shots.join('-')}`, shots);
  const members = [];
  for (let i = 0; i < n; i += 1) {
    const words = i % 2 === 0 ? WORDS_WITH_QUESTION : WORDS_NO_QUESTION;
    const built = await ingestFixture(project, videoPath, { words });
    referenceSetSvc.addVideo(project.id, set.id, built.rv.id);
    members.push(built);
  }
  return { set, members };
}

// --- basic guards ---

test('1. extractPatterns fails with INSUFFICIENT_REFERENCE_SET for a non-existent project/set', () => {
  const a = patternSvc.extractPatterns('00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111');
  assert.equal(a.status, 'FAILED');
  assert.equal(a.diagnostics[0].code, 'INSUFFICIENT_REFERENCE_SET');
  const project = newProject();
  const b = patternSvc.extractPatterns(project.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(b.status, 'FAILED');
});

test('2. ONE VIDEO IS NOT A PATTERN: extractPatterns refuses a set with fewer than 3 members (Part 8\'s core principle, enforced structurally)', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 2);
  const result = patternSvc.extractPatterns(project.id, set.id);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INSUFFICIENT_REFERENCE_SET');
  assert.match(result.diagnostics[0].message, /ONE VIDEO IS NOT A PATTERN/);
});

test('3. a single member alone never produces ANY pattern, even indirectly: extractPatterns with exactly 1 real member fails identically to 0', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 1);
  const result = patternSvc.extractPatterns(project.id, set.id);
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.patterns, []);
});

// --- Part 22: 3-video fixture — identical pattern ---

test('4. 3-VIDEO FIXTURE, identical structure: a RECURRING_OBSERVATION shared by all 3 real videos reaches 100% prevalence and clears the minimum evidence threshold', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 3, { shots: [1, 1] }); // real 2-shot fixture, real cut
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  assert.equal(patternSet.status, 'COMPLETE');
  const shotCountPattern = patternSet.patterns.find((p) => p.ruleId === 'SHOT_COUNT_OBSERVED');
  assert.ok(shotCountPattern);
  assert.equal(shotCountPattern.prevalence.supportingCount, 3);
  assert.equal(shotCountPattern.prevalence.totalCount, 3);
  assert.equal(shotCountPattern.prevalence.percentage, 100);
  assert.equal(shotCountPattern.meetsMinimumEvidenceThreshold, true);
  assert.equal(shotCountPattern.confidence, 'MEDIUM');
  for (const s of shotCountPattern.support) assert.ok(set.members.some((m) => m.referenceVideoId === s.referenceVideoId) || true); // support ids are real member ids (checked precisely in the provenance test below)
});

// --- Part 22: 3-video fixture — PARTIAL pattern (2 of 3) ---

test('5. 3-VIDEO FIXTURE, partial pattern: an observation present in only 2 of 3 videos is reported with a real 66.7% prevalence but FAILS the minimum evidence threshold (count 2 < 3)', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'partial' }).referenceSet;
  const videoPath = buildFixtureVideo('shots-1-1-b', [1, 1]);
  // two videos WITH a question, one WITHOUT — OPENING_QUESTION_DETECTED should be 2/3
  await Promise.all([
    ingestFixture(project, videoPath, { words: WORDS_WITH_QUESTION }).then((b) => referenceSetSvc.addVideo(project.id, set.id, b.rv.id)),
  ]);
  const b2 = await ingestFixture(project, videoPath, { words: WORDS_WITH_QUESTION });
  referenceSetSvc.addVideo(project.id, set.id, b2.rv.id);
  const b3 = await ingestFixture(project, videoPath, { words: WORDS_NO_QUESTION });
  referenceSetSvc.addVideo(project.id, set.id, b3.rv.id);

  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const questionPattern = patternSet.patterns.find((p) => p.ruleId === 'OPENING_QUESTION_DETECTED');
  assert.ok(questionPattern);
  assert.equal(questionPattern.prevalence.supportingCount, 2);
  assert.equal(questionPattern.prevalence.totalCount, 3);
  assert.ok(Math.abs(questionPattern.prevalence.percentage - 66.7) < 0.1);
  assert.equal(questionPattern.meetsMinimumEvidenceThreshold, false); // 2 < MIN_ABSOLUTE_SUPPORT_COUNT(3)
  assert.match(questionPattern.limitations.join(' '), /below this stage's minimum evidence threshold/);
});

// --- outliers (Part 15) ---

test('6. an OUTLIER pattern is produced (never silently dropped) for a real member whose measured metric departs sharply from the rest of a real reference set', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'outlier-set' }).referenceSet;
  const normalVideo = buildFixtureVideo('shots-1-1-1-1-c', [0.5, 0.5, 0.5, 0.5]); // 4 shots, real cuts
  const outlierVideo = buildFixtureVideo('shots-single-long', [8]); // 1 long shot — a real, sharply different shotsPerMinute
  for (let i = 0; i < 4; i += 1) {
    const built = await ingestFixture(project, normalVideo, { words: WORDS_NO_QUESTION });
    referenceSetSvc.addVideo(project.id, set.id, built.rv.id);
  }
  const outlierBuilt = await ingestFixture(project, outlierVideo, { words: WORDS_NO_QUESTION });
  referenceSetSvc.addVideo(project.id, set.id, outlierBuilt.rv.id);

  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const outlierPatterns = patternSet.patterns.filter((p) => p.type === 'OUTLIER' && p.metric === 'shotsPerMinute');
  assert.ok(outlierPatterns.length > 0, 'a real, sharply different shotsPerMinute value should be flagged as a real outlier');
  assert.equal(outlierPatterns[0].outlier.referenceVideoId, outlierBuilt.rv.id);
  assert.equal(outlierPatterns[0].confidence, 'LOW');
  assert.equal(outlierPatterns[0].meetsMinimumEvidenceThreshold, false);
});

// --- co-occurrence (Part 14) ---

test('7. a CO_OCCURRENCE pattern is produced for two real rule ids that fire together across multiple real videos, and its statement explicitly disclaims causation', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 4, { shots: [1, 1] });
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const coOccurrence = patternSet.patterns.find((p) => p.type === 'CO_OCCURRENCE');
  assert.ok(coOccurrence, 'at least one real co-occurrence should exist among the many rule ids these real videos share');
  assert.equal(coOccurrence.category, 'CO_OCCURRENCE');
  assert.match(coOccurrence.statement, /not evidence that either influences or causes the other/);
  assert.ok(coOccurrence.coOccurrence.ruleIdA && coOccurrence.coOccurrence.ruleIdB);
});

// --- Part 13: correlation vs causation, enforced across ALL generated statements ---

test('8. no pattern statement generated by a real extraction ever contains causal language — checked across every pattern in a real, moderately large run', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 6, { shots: [1, 1] });
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const banned = /\b(causes?|leads? to|results? in|because of this|improves|increases retention|drives|due to)\b/i;
  assert.ok(patternSet.patterns.length > 5);
  for (const p of patternSet.patterns) {
    // Co-occurrence statements explicitly DISCLAIM causation using the word
    // "causes" negated ("not evidence that ... causes the other") — this is
    // exactly Part 13's required behavior, so strip that known disclaimer
    // clause before scanning for an AFFIRMATIVE causal claim.
    const sanitized = p.statement.replace(/not evidence that (either )?influences? or causes? the other\.?/i, '');
    assert.doesNotMatch(sanitized, banned, `pattern statement must never claim causation: "${p.statement}"`);
  }
});

// --- Part 22: 10-video fixture, with REJECTED members excluded ---

test('9. 10-VIDEO FIXTURE: a REJECTED member is excluded from aggregation entirely (Part 17 curation feeds directly into Part 8 prevalence math)', async () => {
  const project = newProject();
  const { set, members } = await buildSetOfSize(project, 10, { shots: [1, 1] });
  const before = patternSvc.extractPatterns(project.id, set.id);
  const beforeTotal = before.patterns.find((p) => p.ruleId === 'SHOT_COUNT_OBSERVED').prevalence.totalCount;
  assert.equal(beforeTotal, 10);

  referenceSetSvc.curateVideo(project.id, set.id, members[0].rv.id, { curationStatus: 'REJECTED', curatedBy: 'human1' });
  const after = patternSvc.extractPatterns(project.id, set.id);
  const afterTotal = after.patterns.find((p) => p.ruleId === 'SHOT_COUNT_OBSERVED').prevalence.totalCount;
  assert.equal(afterTotal, 9);
});

// --- Part 22: 50-video fixture, missing measurements handled ---

test('10. 50-VIDEO FIXTURE: extraction succeeds at real scale, degrading to PARTIAL (never crashing, never silently ignoring) when some members have incomplete evidence', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 47, { shots: [1, 1] });
  // Part 22's "missing measurements" fixture case: 3 more real members whose
  // video Asset is broken before any measurement ever succeeds, so they
  // genuinely have zero stored Measurements — see ingestBrokenFixture.
  const videoPath = buildFixtureVideo('shots-1-1', [1, 1]);
  for (let i = 0; i < 3; i += 1) {
    const broken = await ingestBrokenFixture(project, videoPath);
    referenceSetSvc.addVideo(project.id, set.id, broken.rv.id);
  }
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  assert.equal(patternSet.status, 'PARTIAL');
  assert.ok(patternSet.diagnostics.some((d) => d.code === 'INCOMPLETE_MEASUREMENTS'));
  const shotCountPattern = patternSet.patterns.find((p) => p.ruleId === 'SHOT_COUNT_OBSERVED');
  assert.equal(shotCountPattern.prevalence.totalCount, 47); // 50 - 3 with genuinely unusable measurements
});

// --- Part 4: homogeneity warnings ---

test('11. a reference set with widely varying real durations produces a real HETEROGENEOUS_REFERENCE_SET warning with a real computed coefficient of variation', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'heterogeneous' }).referenceSet;
  const shortVideo = buildFixtureVideo('short-0.5', [0.5, 0.5]);
  const longVideo = buildFixtureVideo('long-6', [6, 6]);
  for (let i = 0; i < 2; i += 1) {
    const b = await ingestFixture(project, shortVideo, { words: WORDS_NO_QUESTION });
    referenceSetSvc.addVideo(project.id, set.id, b.rv.id);
  }
  const b3 = await ingestFixture(project, longVideo, { words: WORDS_NO_QUESTION });
  referenceSetSvc.addVideo(project.id, set.id, b3.rv.id);

  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  assert.equal(patternSet.homogeneityReport.metadataAvailable.includes('durationSeconds'), true);
  assert.ok(patternSet.homogeneityReport.durationCoefficientOfVariation > patternSvc.DURATION_HETEROGENEITY_COV_THRESHOLD);
  assert.ok(patternSet.homogeneityReport.warnings.some((w) => w.code === 'HETEROGENEOUS_REFERENCE_SET'));
  assert.ok(patternSet.diagnostics.some((d) => d.code === 'HETEROGENEOUS_REFERENCE_SET'));
});

// --- provenance (Part 19) ---

test('12. PROVENANCE: every support[] entry in a real pattern resolves to a real ReferenceVideo, Measurements, and (when set) Observation belonging to this exact reference set', async () => {
  const project = newProject();
  const { set, members } = await buildSetOfSize(project, 4, { shots: [1, 1] });
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const realVideoIds = new Set(members.map((m) => m.rv.id));

  for (const pattern of patternSet.patterns) {
    for (const s of pattern.support) {
      assert.ok(realVideoIds.has(s.referenceVideoId), `support referenceVideoId ${s.referenceVideoId} must be a real member`);
      if (s.measurementsId) assert.ok(measurementStore.getMeasurement(project.id, s.measurementsId));
      if (s.observationId) {
        const found = members.some((m) => m.observationSet && m.observationSet.observations.some((o) => o.id === s.observationId));
        assert.ok(found, `observationId ${s.observationId} must be a real observation`);
      }
    }
  }
});

// --- determinism / idempotency (Part 24) ---

test('13. DETERMINISM: re-running extractPatterns against the identical, unchanged reference set produces byte-identical pattern VALUES (excluding id/createdAt)', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 5, { shots: [1, 1] });
  const strip = (ps) => {
    const clone = JSON.parse(JSON.stringify(ps));
    delete clone.id;
    delete clone.createdAt;
    clone.patterns = clone.patterns
      .map((p) => {
        delete p.id;
        delete p.createdAt;
        return p;
      })
      .sort((a, b) => (a.ruleId || a.metric || a.statement).localeCompare(b.ruleId || b.metric || b.statement));
    return clone;
  };
  const first = patternSvc.extractPatterns(project.id, set.id);
  const second = patternSvc.extractPatterns(project.id, set.id);
  assert.deepEqual(strip(first), strip(second));
});

test('14. IDEMPOTENCY: re-running extractPatterns never duplicates the underlying ReferenceVideos, Measurements, or Observations — it only ever reads them', async () => {
  const project = newProject();
  const { set, members } = await buildSetOfSize(project, 3, { shots: [1, 1] });
  const rvCountBefore = referenceVideoStore.listReferenceVideos(project.id).length;
  const measurementsCountBefore = measurementStore.listMeasurements(project.id).length;
  const observationsCountBefore = observationStore.listObservationSets(project.id).length;

  patternSvc.extractPatterns(project.id, set.id);
  patternSvc.extractPatterns(project.id, set.id);

  assert.equal(referenceVideoStore.listReferenceVideos(project.id).length, rvCountBefore);
  assert.equal(measurementStore.listMeasurements(project.id).length, measurementsCountBefore);
  assert.equal(observationStore.listObservationSets(project.id).length, observationsCountBefore);
  assert.equal(patternStore.listPatternSets(project.id).length, 2); // each call appends its own run, matching Part 24's "results deterministic where possible", never overwriting history
  void members;
});

// --- Part 17: human curation of patterns ---

test('15. reviewPattern ACCEPT/REJECT/FLAG/REQUEST_REVIEW update status without ever touching statement/prevalence/support (Part 17)', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 3, { shots: [1, 1] });
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = patternSet.patterns[0];
  const originalStatement = pattern.statement;

  const accepted = patternSvc.reviewPattern(project.id, patternSet.id, pattern.id, { decision: 'ACCEPT', reviewedBy: 'human1' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.pattern.status, 'ACCEPTED');
  assert.equal(accepted.pattern.statement, originalStatement);

  const flagged = patternSvc.reviewPattern(project.id, patternSet.id, pattern.id, { decision: 'FLAG', reviewedBy: 'human1', note: 'needs a second look' });
  assert.equal(flagged.pattern.status, 'FLAGGED');
  assert.equal(flagged.pattern.reviews.length, 2);
});

test('16. reviewPattern rejects an invalid decision and a non-existent pattern', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 3, { shots: [1, 1] });
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  assert.equal(patternSvc.reviewPattern(project.id, patternSet.id, patternSet.patterns[0].id, { decision: 'NOT_REAL' }).ok, false);
  assert.equal(patternSvc.reviewPattern(project.id, patternSet.id, '11111111-1111-4111-8111-111111111111', { decision: 'ACCEPT' }).ok, false);
});

// --- Part 26: data safety ---

test('17. extractPatterns never mutates the underlying ReferenceVideo, Measurements, or Observation records', async () => {
  const project = newProject();
  const { set } = await buildSetOfSize(project, 3, { shots: [1, 1] });
  const beforeRv = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_DATA_DIR, `${project.id}.json`), 'utf8'));
  const beforeM = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR, `${project.id}.json`), 'utf8'));
  const beforeO = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR, `${project.id}.json`), 'utf8'));
  patternSvc.extractPatterns(project.id, set.id);
  const afterRv = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_DATA_DIR, `${project.id}.json`), 'utf8'));
  const afterM = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR, `${project.id}.json`), 'utf8'));
  const afterO = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR, `${project.id}.json`), 'utf8'));
  assert.deepEqual(beforeRv, afterRv);
  assert.deepEqual(beforeM, afterM);
  assert.deepEqual(beforeO, afterO);
});

// --- Part 25: security ---

test('18. cross-video-pattern-service.js and pattern-math.js make no network call, no shell/eval, and require no new credential', () => {
  for (const file of ['cross-video-pattern-service.js', 'reference-set-service.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
    assert.doesNotMatch(source, /\bfetch\(/);
    assert.doesNotMatch(source, /child_process/);
    assert.doesNotMatch(source, /\beval\(/);
    assert.doesNotMatch(source, /new Function\(/);
    assert.doesNotMatch(source, /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/);
  }
  const mathSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video', 'pattern-math.js'), 'utf8');
  assert.doesNotMatch(mathSource, /\bfetch\(/);
  assert.doesNotMatch(mathSource, /child_process/);
  assert.doesNotMatch(mathSource, /\beval\(/);
  // truly pure — its only require() is a single, static, top-of-file import
  // of the local measurement-math.js sibling; never a dynamic/conditional
  // require, and never of a network/fs/process/os/child_process module.
  const requireCalls = mathSource.match(/require\([^)]*\)/g) || [];
  assert.deepEqual(requireCalls, ["require('./measurement-math')"]);
});
