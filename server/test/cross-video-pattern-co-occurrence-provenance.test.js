// INT-1E-PATCH — focused tests for CO_OCCURRENCE support provenance
// (Part 7). Verifies that each CO_OCCURRENCE support entry now carries
// the exact two real observation ids (and their shared measurementsId)
// responsible for that video's contribution, traceable all the way to
// real evidence — never a bare referenceVideoId, never an invented id.
//
// This file is deliberately narrow: it does NOT re-test pattern detection
// rules, thresholds, confidence math, ReferenceSet behavior, measurement
// logic, or observation logic — all of that is already covered by
// test/cross-video-pattern-service.test.js (still passing, unmodified
// expectations for everything except CO_OCCURRENCE support shape).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-cvpprov-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-cvpprov-projects-'],
  ['REFERENCE_VIDEO_DATA_DIR', 'evolink-cvpprov-rvstore-'],
  ['REFERENCE_VIDEO_MEASUREMENT_DATA_DIR', 'evolink-cvpprov-mstore-'],
  ['REFERENCE_VIDEO_OBSERVATION_DATA_DIR', 'evolink-cvpprov-ostore-'],
  ['REFERENCE_SET_DATA_DIR', 'evolink-cvpprov-rsstore-'],
  ['CROSS_VIDEO_PATTERN_DATA_DIR', 'evolink-cvpprov-pstore-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const referenceVideoStore = require('../services/reference-video-store');
const measurementStore = require('../services/reference-video-measurement-store');
const observationStore = require('../services/reference-video-observation-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const { measureReferenceVideo } = require('../services/reference-video-measurement-service');
const { deriveObservations } = require('../services/reference-video-observation-service');
const referenceSetSvc = require('../services/reference-set-service');
const patternSvc = require('../services/cross-video-pattern-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

let cachedVideoPath = null;
function buildFixtureVideo() {
  if (cachedVideoPath) return cachedVideoPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cvpprov-src-'));
  const p = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=160x90:duration=1:rate=15',
    '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:duration=1:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[outv]',
    '-map', '[outv]', '-map', '2:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p,
  ]);
  cachedVideoPath = p;
  return p;
}

const WORDS = [
  { word: 'Is', startTime: 0, endTime: 0.2 },
  { word: 'this', startTime: 0.2, endTime: 0.4 },
  { word: 'working?', startTime: 0.4, endTime: 0.8 },
];

async function ingestFixture(project) {
  const videoPath = buildFixtureVideo();
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 't', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'COMPLETED', transcript: { text: WORDS.map((w) => w.word).join(' '), language: 'en', words: WORDS, segments: [] }, diagnostics: [] }),
  };
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl });
  const measurements = measureReferenceVideo(project.id, rv.id);
  const observationSet = deriveObservations(project.id, measurements.id);
  return { rv, measurements, observationSet };
}

async function build3VideoSet(project) {
  const set = referenceSetSvc.createSet(project.id, { name: 'co-occurrence-provenance', criteria: 'synthetic' }).referenceSet;
  const members = [];
  for (let i = 0; i < 3; i += 1) {
    const built = await ingestFixture(project);
    referenceSetSvc.addVideo(project.id, set.id, built.rv.id);
    members.push(built);
  }
  return { set, members };
}

function firstCoOccurrencePattern(patternSet) {
  const pattern = patternSet.patterns.find((p) => p.type === 'CO_OCCURRENCE' && p.support.length > 0);
  assert.ok(pattern, 'expected at least one CO_OCCURRENCE pattern with non-empty support');
  return pattern;
}

// --- Part 7, items 1-6: real provenance chain ---

test('1. CO_OCCURRENCE support entries carry observationIds (plural), not just referenceVideoId', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  for (const s of pattern.support) {
    assert.ok(Array.isArray(s.observationIds), 'support.observationIds must be an array');
    assert.equal(s.observationIds.length, 2, 'a co-occurrence is backed by exactly two observations per contributing video');
  }
});

test('2. every observationId in a CO_OCCURRENCE support entry resolves to a real, persisted observation', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  for (const s of pattern.support) {
    const measurements = measurementStore.getMeasurement(project.id, s.measurementsId);
    assert.ok(measurements, `Measurements "${s.measurementsId}" must really exist`);
    const observationSet = observationStore.getLatestObservationSetForMeasurements(project.id, s.measurementsId);
    assert.ok(observationSet, 'an ObservationSet for this measurementsId must really exist');
    for (const obsId of s.observationIds) {
      const found = observationSet.observations.find((o) => o.id === obsId);
      assert.ok(found, `observationId "${obsId}" must resolve to a real, persisted observation`);
    }
  }
});

test('3. every resolved observation genuinely belongs to the reference video its support entry names', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  for (const s of pattern.support) {
    const observationSet = observationStore.getLatestObservationSetForMeasurements(project.id, s.measurementsId);
    for (const obsId of s.observationIds) {
      const obs = observationSet.observations.find((o) => o.id === obsId);
      assert.equal(obs.referenceVideoId, s.referenceVideoId);
    }
  }
});

test('4. the two resolved observations are exactly the ones that generated this co-occurrence (their rule ids match ruleIdA/ruleIdB)', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  const { ruleIdA, ruleIdB } = pattern.coOccurrence;
  for (const s of pattern.support) {
    const observationSet = observationStore.getLatestObservationSetForMeasurements(project.id, s.measurementsId);
    const ruleIds = s.observationIds.map((id) => observationSet.observations.find((o) => o.id === id).methodology.ruleId).sort();
    assert.deepEqual(ruleIds, [ruleIdA, ruleIdB].sort());
  }
});

test('5. each resolved observation retains its original, real evidence linkage (never stripped or replaced)', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  for (const s of pattern.support) {
    const observationSet = observationStore.getLatestObservationSetForMeasurements(project.id, s.measurementsId);
    for (const obsId of s.observationIds) {
      const obs = observationSet.observations.find((o) => o.id === obsId);
      assert.ok(Array.isArray(obs.evidence) && obs.evidence.length > 0, 'observation must retain its own real evidence[] array');
      assert.equal(obs.evidence[0].measurementsId, s.measurementsId);
    }
  }
});

test('6. support.measurementsId is real, exists, and is shared by both underlying observations (not invented, not plural where a single value is truthful)', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  for (const s of pattern.support) {
    assert.ok(s.measurementsId, 'measurementsId must be populated');
    const measurements = measurementStore.getMeasurement(project.id, s.measurementsId);
    assert.ok(measurements);
    const observationSet = observationStore.getLatestObservationSetForMeasurements(project.id, s.measurementsId);
    for (const obsId of s.observationIds) {
      const obs = observationSet.observations.find((o) => o.id === obsId);
      assert.equal(obs.measurementsId, s.measurementsId);
    }
  }
});

// --- Part 7, item 7: malformed provenance fails structurally ---

test('7. validateCoOccurrenceProvenance rejects malformed input structurally — never repairs, never invents a replacement id', () => {
  const realObsA = { id: 'obs-a', referenceVideoId: 'rv-1', measurementsId: 'm-1', methodology: { ruleId: 'RULE_A' }, evidence: [] };
  const realObsB = { id: 'obs-b', referenceVideoId: 'rv-1', measurementsId: 'm-1', methodology: { ruleId: 'RULE_B' }, evidence: [] };

  // valid case — sanity check the happy path first
  const valid = patternSvc.validateCoOccurrenceProvenance({ obsA: realObsA, obsB: realObsB, referenceVideoId: 'rv-1', ruleIdA: 'RULE_A', ruleIdB: 'RULE_B' });
  assert.equal(valid.ok, true);
  assert.equal(valid.measurementsId, 'm-1');

  // missing observation
  const missing = patternSvc.validateCoOccurrenceProvenance({ obsA: null, obsB: realObsB, referenceVideoId: 'rv-1', ruleIdA: 'RULE_A', ruleIdB: 'RULE_B' });
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostic.code, 'INVALID_CO_OCCURRENCE_PROVENANCE');

  // observation belongs to a different video than claimed
  const wrongVideo = patternSvc.validateCoOccurrenceProvenance({ obsA: { ...realObsA, referenceVideoId: 'rv-999' }, obsB: realObsB, referenceVideoId: 'rv-1', ruleIdA: 'RULE_A', ruleIdB: 'RULE_B' });
  assert.equal(wrongVideo.ok, false);
  assert.equal(wrongVideo.diagnostic.code, 'INVALID_CO_OCCURRENCE_PROVENANCE');

  // observation's own rule id doesn't match the claimed rule id
  const wrongRule = patternSvc.validateCoOccurrenceProvenance({ obsA: { ...realObsA, methodology: { ruleId: 'SOME_OTHER_RULE' } }, obsB: realObsB, referenceVideoId: 'rv-1', ruleIdA: 'RULE_A', ruleIdB: 'RULE_B' });
  assert.equal(wrongRule.ok, false);
  assert.equal(wrongRule.diagnostic.code, 'INVALID_CO_OCCURRENCE_PROVENANCE');

  // the two observations resolve to different Measurements records — structurally impossible today, still checked
  const mismatchedMeasurements = patternSvc.validateCoOccurrenceProvenance({ obsA: realObsA, obsB: { ...realObsB, measurementsId: 'm-2' }, referenceVideoId: 'rv-1', ruleIdA: 'RULE_A', ruleIdB: 'RULE_B' });
  assert.equal(mismatchedMeasurements.ok, false);
  assert.equal(mismatchedMeasurements.diagnostic.code, 'INVALID_CO_OCCURRENCE_PROVENANCE');

  // no ID is ever invented on failure — the diagnostic never carries a fabricated observation/measurement id
  assert.equal(missing.measurementsId, undefined);
});

// --- Part 5/7 items 8-10: backward compatibility for other pattern types + unrelated fields ---

test('8. unrelated CO_OCCURRENCE fields (statement, prevalence, confidence, limitations, coOccurrence) are unaffected by the provenance patch', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  assert.match(pattern.statement, /co-occur in \d+ of \d+ reference video\(s\)/);
  assert.match(pattern.statement, /not evidence that either influences or causes the other/);
  assert.equal(pattern.prevalence.supportingCount, pattern.support.length);
  assert.ok(['MEDIUM', 'LOW'].includes(pattern.confidence));
  assert.ok(pattern.limitations.some((l) => /not evidence of a causal or influential relationship/.test(l)));
  assert.ok(pattern.coOccurrence.ruleIdA && pattern.coOccurrence.ruleIdB);
});

test('9. RECURRING_OBSERVATION support entries are unchanged: singular observationId still populated, plural observationIds stays empty', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = patternSet.patterns.find((p) => p.type === 'RECURRING_OBSERVATION');
  assert.ok(pattern);
  for (const s of pattern.support) {
    assert.ok(s.observationId, 'RECURRING_OBSERVATION must keep using the existing singular observationId');
    assert.deepEqual(s.observationIds, [], 'RECURRING_OBSERVATION support must not populate the CO_OCCURRENCE-only observationIds field');
  }
});

test('10. NUMERIC_DISTRIBUTION support entries are unchanged: value still populated, observationId/observationIds stay empty', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = patternSet.patterns.find((p) => p.type === 'NUMERIC_DISTRIBUTION');
  assert.ok(pattern);
  for (const s of pattern.support) {
    assert.equal(typeof s.value, 'number');
    assert.equal(s.observationId, null);
    assert.deepEqual(s.observationIds, []);
  }
});

// --- Part 9: determinism ---

test('11. re-running extractPatterns against identical source data produces identical CO_OCCURRENCE support (same referenceVideoId, same observationIds, same measurementsId)', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const first = patternSvc.extractPatterns(project.id, set.id);
  const second = patternSvc.extractPatterns(project.id, set.id);
  const firstPattern = firstCoOccurrencePattern(first);
  const secondPattern = second.patterns.find((p) => p.type === 'CO_OCCURRENCE' && p.coOccurrence.ruleIdA === firstPattern.coOccurrence.ruleIdA && p.coOccurrence.ruleIdB === firstPattern.coOccurrence.ruleIdB);
  assert.ok(secondPattern);
  const normalize = (support) => support.map((s) => ({ referenceVideoId: s.referenceVideoId, measurementsId: s.measurementsId, observationIds: [...s.observationIds].sort() })).sort((a, b) => a.referenceVideoId.localeCompare(b.referenceVideoId));
  assert.deepEqual(normalize(firstPattern.support), normalize(secondPattern.support));
});

// --- Part 9/12: data safety ---

test('12. repeated extraction never mutates source Measurements or Observations', async () => {
  const project = newProject();
  const { set, members } = await build3VideoSet(project);
  const before = members.map((m) => ({
    measurements: JSON.stringify(measurementStore.getMeasurement(project.id, m.measurements.id)),
    observations: JSON.stringify(observationStore.getLatestObservationSetForMeasurements(project.id, m.measurements.id)),
  }));
  patternSvc.extractPatterns(project.id, set.id);
  patternSvc.extractPatterns(project.id, set.id);
  const after = members.map((m) => ({
    measurements: JSON.stringify(measurementStore.getMeasurement(project.id, m.measurements.id)),
    observations: JSON.stringify(observationStore.getLatestObservationSetForMeasurements(project.id, m.measurements.id)),
  }));
  assert.deepEqual(before, after);
});

// --- Part 7 item 13: human review still cannot touch machine-derived fields ---

test('13. reviewPattern on a CO_OCCURRENCE pattern still never touches support/observationIds/measurementsId', async () => {
  const project = newProject();
  const { set } = await build3VideoSet(project);
  const patternSet = patternSvc.extractPatterns(project.id, set.id);
  const pattern = firstCoOccurrencePattern(patternSet);
  const supportBefore = JSON.stringify(pattern.support);
  const reviewed = patternSvc.reviewPattern(project.id, patternSet.id, pattern.id, { decision: 'ACCEPT', reviewedBy: 'human1' });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.pattern.status, 'ACCEPTED');
  assert.equal(JSON.stringify(reviewed.pattern.support), supportBefore);
});

// --- Part 10: security ---

test('14. the provenance patch introduces no network/shell/eval calls and no new credential in cross-video-pattern-service.js', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'cross-video-pattern-service.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /\beval\(/);
  assert.doesNotMatch(source, /new Function\(/);
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/);
});
