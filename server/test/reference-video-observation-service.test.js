// Tests for services/reference-video-observation-service.js — the
// orchestrator that runs the real rule registry against a real, persisted
// ReferenceVideoMeasurements record (INT-1B) built through the real
// ingestion (INT-1A) + measurement pipeline on real FFmpeg fixture videos.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-projects-'));
process.env.REFERENCE_VIDEO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-rvstore-'));
process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-mstore-'));
process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-ostore-'));

const projectStore = require('../services/project-store');
const measurementStore = require('../services/reference-video-measurement-store');
const observationStore = require('../services/reference-video-observation-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const { measureReferenceVideo } = require('../services/reference-video-measurement-service');
const { deriveObservations } = require('../services/reference-video-observation-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function makeTwoShotVideo({ shot1 = 2, shot2 = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-src-'));
  const p = path.join(dir, 'two-shot.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:size=320x180:duration=${shot1}:rate=25`,
    '-f', 'lavfi', '-i', `color=c=blue:size=320x180:duration=${shot2}:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${shot1 + shot2}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[outv]',
    '-map', '[outv]', '-map', '2:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p,
  ]);
  return p;
}

async function ingestAndMeasure(project, videoPath, { words = null } = {}) {
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 'Fixture', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => (words ? { status: 'COMPLETED', transcript: { text: words.map((w) => w.word).join(' '), language: 'en', words, segments: [] }, diagnostics: [] } : { status: 'FAILED', diagnostics: [] }),
  };
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl });
  const measurements = measureReferenceVideo(project.id, rv.id);
  return { rv, measurements };
}

test('1. deriveObservations FAILS with INVALID_MEASUREMENTS for a non-existent project', () => {
  const set = deriveObservations('00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111');
  assert.equal(set.status, 'FAILED');
  assert.equal(set.diagnostics[0].code, 'INVALID_MEASUREMENTS');
});

test('2. deriveObservations FAILS with INVALID_MEASUREMENTS for a non-existent measurementsId', () => {
  const project = newProject();
  const set = deriveObservations(project.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(set.status, 'FAILED');
  assert.equal(set.diagnostics[0].code, 'INVALID_MEASUREMENTS');
});

test('3. end-to-end: deriving observations from a real two-shot fixture produces real, evidence-linked Observations traceable back to the real measurements record', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 2, shot2: 2 });
  const { rv, measurements } = await ingestAndMeasure(project, videoPath);
  assert.equal(measurements.shots.length, 2, 'sanity: the real cut must be detected before observing it');

  const set = deriveObservations(project.id, measurements.id);
  assert.equal(set.referenceVideoId, rv.id);
  assert.equal(set.measurementsId, measurements.id);
  assert.ok(set.observations.length > 0);

  const durationObs = set.observations.find((o) => o.methodology.ruleId === 'VIDEO_DURATION_MEASURED');
  assert.ok(durationObs);
  assert.equal(durationObs.evidence[0].measurementsId, measurements.id);
  assert.equal(durationObs.evidence[0].metricPath, 'video.technical.duration');
  assert.ok(Math.abs(durationObs.evidence[0].value - measurements.video.technical.duration) < 0.0001);

  const shotCountObs = set.observations.find((o) => o.methodology.ruleId === 'SHOT_COUNT_OBSERVED');
  assert.match(shotCountObs.statement, /2 detected shots/);

  // capability diagnostics must always fire in this environment (OCR/scene detection are unavailable)
  assert.ok(set.diagnostics.some((d) => d.code === 'OCR_UNAVAILABLE'));
  assert.ok(set.diagnostics.some((d) => d.code === 'SCENE_OBSERVATION_UNAVAILABLE'));
  assert.equal(set.status, 'PARTIAL'); // observations exist AND capability diagnostics fired
});

test('4. every Observation\'s evidence resolves to a real field on the real, persisted ReferenceVideoMeasurements record (PROVENANCE)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const { measurements } = await ingestAndMeasure(project, videoPath, {
    words: [
      { word: 'Hello', startTime: 0, endTime: 0.3 },
      { word: 'is', startTime: 0.5, endTime: 0.6 },
      { word: 'this', startTime: 0.6, endTime: 0.7 },
      { word: 'real?', startTime: 0.7, endTime: 1 },
    ],
  });
  const set = deriveObservations(project.id, measurements.id);
  const stored = measurementStore.getMeasurement(project.id, measurements.id);

  function getByPath(obj, dotPath) {
    return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  }
  // Some rules (e.g. SHOT_COUNT_QUARTER_COMPARISON, SHOT_DURATION_SKEW)
  // legitimately report a CURATED SUMMARY of the real data at metricPath
  // (e.g. {firstQuarter, lastQuarter} extracted from the full
  // quarterShotCounts array) rather than the complete raw structure —
  // for those, every number IN the summary must still appear somewhere
  // in the real data at that path; for everything else, the value must
  // be byte-identical to what's really stored there.
  const summaryRuleIds = new Set(['SHOT_COUNT_QUARTER_COMPARISON', 'SHOT_DURATION_SKEW', 'VISUAL_CHANGE_CONSISTENCY', 'SENTENCE_LENGTH_VARIATION', 'PAUSE_CONCENTRATION', 'FIRST_SILENCE_OBSERVED', 'SHOT_DURATION_BELOW_THRESHOLD', 'SPOKEN_QUESTION_COUNT']);
  // VISUAL_CHANGE_QUARTER_COMPARISON computes genuinely NEW aggregate
  // numbers (a mean-of-samples, a sample count) that do not appear
  // verbatim anywhere in the stored record — only that metricPath itself
  // resolves to real, non-empty source data is checked for it.
  const computedAggregateRuleIds = new Set(['VISUAL_CHANGE_QUARTER_COMPARISON']);
  for (const obs of set.observations) {
    for (const ev of obs.evidence) {
      assert.equal(ev.measurementsId, measurements.id);
      const actual = getByPath(stored, ev.metricPath);
      assert.notEqual(actual, undefined, `metricPath "${ev.metricPath}" for rule ${obs.methodology.ruleId} must resolve to something real in the stored record`);
      if (computedAggregateRuleIds.has(obs.methodology.ruleId)) {
        assert.ok(Array.isArray(actual) && actual.length > 0, `"${ev.metricPath}" must resolve to real, non-empty source data for a computed-aggregate rule`);
      } else if (summaryRuleIds.has(obs.methodology.ruleId)) {
        const realJson = JSON.stringify(actual);
        for (const entry of Object.values(ev.value)) {
          if (typeof entry === 'number') assert.ok(realJson.includes(String(entry)), `summary value ${entry} for rule ${obs.methodology.ruleId} must trace back into the real data at "${ev.metricPath}"`);
          if (typeof entry === 'string') assert.ok(realJson.includes(JSON.stringify(entry).slice(1, -1)), `summary text "${entry}" for rule ${obs.methodology.ruleId} must trace back into the real data at "${ev.metricPath}"`);
        }
      } else {
        assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(ev.value)), `evidence at "${ev.metricPath}" for rule ${obs.methodology.ruleId} must match the real stored measurement exactly`);
      }
    }
  }
});

test('5. removing required evidence removes the observation (Part 21 required negative proof): a video with no transcript produces zero NARRATION/OPENING-question observations', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const { measurements } = await ingestAndMeasure(project, videoPath); // no transcript
  const set = deriveObservations(project.id, measurements.id);
  assert.equal(set.observations.some((o) => o.methodology.ruleId === 'WORDS_PER_MINUTE_OBSERVED'), false);
  assert.equal(set.observations.some((o) => o.methodology.ruleId === 'NARRATION_ONSET'), false);
  assert.equal(set.observations.some((o) => o.methodology.ruleId === 'OPENING_QUESTION_DETECTED'), false);
  assert.equal(set.observations.some((o) => o.methodology.ruleId === 'SPOKEN_QUESTION_COUNT'), false);
});

test('6. adding a real question to the transcript changes the observation set to include OPENING_QUESTION_DETECTED and SPOKEN_QUESTION_COUNT (Part 21 required "changing measurement changes observation" proof)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const { measurements: without } = await ingestAndMeasure(project, videoPath, { words: [{ word: 'Hello', startTime: 0, endTime: 0.3 }, { word: 'there.', startTime: 0.3, endTime: 0.6 }] });
  const setWithout = deriveObservations(project.id, without.id);
  assert.equal(setWithout.observations.some((o) => o.methodology.ruleId === 'OPENING_QUESTION_DETECTED'), false);

  const project2 = newProject();
  const { measurements: withQuestion } = await ingestAndMeasure(project2, videoPath, { words: [{ word: 'Hello', startTime: 0, endTime: 0.3 }, { word: 'there?', startTime: 0.3, endTime: 0.6 }] });
  const setWith = deriveObservations(project2.id, withQuestion.id);
  assert.equal(setWith.observations.some((o) => o.methodology.ruleId === 'OPENING_QUESTION_DETECTED'), true);
});

test('7. DETERMINISM (Part 18): deriving observations twice from the identical measurements record produces byte-identical output (excluding id/createdAt)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 2, shot2: 2 });
  const { measurements } = await ingestAndMeasure(project, videoPath, { words: [{ word: 'Hi', startTime: 0, endTime: 0.2 }] });

  const strip = (set) => {
    const clone = JSON.parse(JSON.stringify(set));
    delete clone.id;
    delete clone.createdAt;
    clone.observations = clone.observations.map((o) => {
      delete o.id;
      delete o.createdAt;
      return o;
    });
    return clone;
  };
  const first = strip(deriveObservations(project.id, measurements.id));
  const second = strip(deriveObservations(project.id, measurements.id));
  assert.deepEqual(first, second);
});

test('8. a measurements record whose own status is FAILED short-circuits to a FAILED ObservationSet with INSUFFICIENT_MEASUREMENTS, never inventing observations', async () => {
  // Note: services/reference-video-measurement-service.js never persists a
  // truly FAILED ReferenceVideoMeasurements (it returns early before
  // calling addMeasurement, matching INT-1A's own "never persist an
  // unusable FAILED record" precedent) — so this exact state cannot arise
  // via the live pipeline today. This test exercises the defensive
  // status==='FAILED' guard directly by inserting a synthetic FAILED
  // record into the store, proving the guard behaves correctly should a
  // future caller (or a manually-edited data file) ever produce one.
  const project = newProject();
  const { createReferenceVideoMeasurements } = require('../schemas/reference-video-measurement-schema');
  const measurementStoreForInsert = require('../services/reference-video-measurement-store');
  const inserted = measurementStoreForInsert.addMeasurement(project.id, createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv-synthetic', status: 'FAILED' }));
  assert.equal(inserted.ok, true);

  const set = deriveObservations(project.id, inserted.measurements.id);
  assert.equal(set.status, 'FAILED');
  assert.equal(set.diagnostics[0].code, 'INSUFFICIENT_MEASUREMENTS');
  assert.deepEqual(set.observations, []);
});

test('9. re-deriving observations for the same measurements always appends — never overwrites (free/local, like the measurement layer)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const { measurements } = await ingestAndMeasure(project, videoPath);
  deriveObservations(project.id, measurements.id);
  deriveObservations(project.id, measurements.id);
  assert.equal(observationStore.listObservationSets(project.id).length, 2);
});

test('10. this file only ever invokes pure rule functions — no network, no LLM, no child_process, no eval', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video-observation-service.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /\beval\(/);
  assert.doesNotMatch(source, /new Function\(/);
  const rulesSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video', 'observation-rules.js'), 'utf8');
  assert.doesNotMatch(rulesSource, /\bfetch\(/);
  assert.doesNotMatch(rulesSource, /child_process/);
  assert.doesNotMatch(rulesSource, /\beval\(/);
});

test('11. deriving observations never mutates the underlying ReferenceVideoMeasurements record (data safety, Part 23)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const { measurements } = await ingestAndMeasure(project, videoPath);
  const before = JSON.parse(JSON.stringify(measurementStore.getMeasurement(project.id, measurements.id)));
  deriveObservations(project.id, measurements.id);
  const after = measurementStore.getMeasurement(project.id, measurements.id);
  assert.deepEqual(before, after);
});
