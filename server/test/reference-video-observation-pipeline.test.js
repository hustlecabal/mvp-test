// INT-1C, Part 19 — the REAL observation proof, chained onto INT-1A's real
// acquisition proof and INT-1B's real measurement proof. Reuses the exact
// same real, captured Apify data (the real "Me at the zoo" video) and the
// same expiring-URL-skip-guard convention (Part 22/24's "do not make
// tests dependent on an external service being continuously available").
//
// Demonstrates the full traceability chain the task requires:
//   Observation -> Measurement -> Raw Evidence
// by asserting each real Observation's evidence resolves into the real,
// persisted ReferenceVideoMeasurements record, which itself was derived
// from the real, persisted ReferenceVideo and its real Asset files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-real-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-real-projects-'));
process.env.REFERENCE_VIDEO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-real-rvstore-'));
process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-real-mstore-'));
process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvo-real-ostore-'));

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const measurementStore = require('../services/reference-video-measurement-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const { measureReferenceVideo } = require('../services/reference-video-measurement-service');
const { deriveObservations } = require('../services/reference-video-observation-service');

const REAL_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const REAL_RESULT_URL = 'https://api.apify.com/v2/key-value-stores/R0N9jY9r9OljVp74n/records/jNQXAC9IVRw_Meatthezoo.mp4';

// Verbatim from Apify run 7S8x0DuGZugJ2qXKa (starvibe/youtube-video-transcript) — see INT-1A/INT-1B's final reports.
const REAL_ITEM = {
  title: 'Me at the zoo',
  description: 'Microplastics are accumulating in human brains at an alarming rate',
  published_at: '2005-04-24T03:31:52Z',
  view_count: 405031885,
  like_count: 19371347,
  comment_count: 10563237,
  thumbnail: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
  selected_language: 'English',
  transcript_text:
    "All right, so here we are, in front of the\nelephants the cool thing about these guys is that they\nhave really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to\nsay",
  transcript: [
    { start: 1.2, end: 3.36, text: 'All right, so here we are, in front of the\nelephants' },
    { start: 5.318, end: 7.974, text: 'the cool thing about these guys is that they\nhave really...' },
    { start: 7.974, end: 12.616, text: 'really really long trunks' },
    { start: 12.616, end: 14.367, text: "and that's cool" },
    { start: 14.421, end: 15.733, text: '(baaaaaaaaaaahhh!!)' },
    { start: 16.881, end: 18.881, text: "and that's pretty much all there is to\nsay" },
  ],
};

function realRelayProvider() {
  return {
    async resolveSource({ url }) {
      assert.equal(url, REAL_VIDEO_URL);
      return { status: 'COMPLETED', platform: 'YOUTUBE', externalId: 'jNQXAC9IVRw', normalizedUrl: REAL_VIDEO_URL, diagnostics: [] };
    },
    async acquireMetadata() {
      return {
        status: 'COMPLETED',
        metadata: { title: REAL_ITEM.title, description: REAL_ITEM.description, publishedAt: REAL_ITEM.published_at, retrievedAt: new Date().toISOString(), viewCount: REAL_ITEM.view_count, likeCount: REAL_ITEM.like_count, commentCount: REAL_ITEM.comment_count, category: null, tags: [], thumbnailUrl: REAL_ITEM.thumbnail },
        diagnostics: [],
      };
    },
    async acquireVideo() {
      return { status: 'COMPLETED', resultUrl: REAL_RESULT_URL, diagnostics: [] };
    },
    async acquireTranscript() {
      return {
        status: 'COMPLETED',
        transcript: { text: REAL_ITEM.transcript_text, language: REAL_ITEM.selected_language, segments: REAL_ITEM.transcript.map((c) => ({ text: c.text, startTime: c.start, endTime: c.end })) },
        diagnostics: [],
      };
    },
  };
}

async function realResultUrlIsStillLive() {
  try {
    const res = await fetch(REAL_RESULT_URL, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

test('REAL PROOF — deriving observations from the real "Me at the zoo" measurements produces evidence-backed, factual observations traceable through Measurements back to Raw Evidence, with no interpretation anywhere', async (t) => {
  if (!(await realResultUrlIsStillLive())) {
    t.skip("the ~3-day Apify key-value-store URL has expired — re-running the real acquisition would require a new (small) real spend; see INT-1A/INT-1B/INT-1C's final reports for the originally captured evidence");
    return;
  }

  const project = projectStore.createProject({ title: 'EVOLINK INT-1C REAL OBSERVATION PROOF', topic: 'Me at the zoo' });
  // P0 Hardening (finding J) — ingestReferenceVideo() now requires the
  // project's approval-gate.js budget/approval checkpoint before it will
  // make any real provider call.
  gate.setBudget(project, 1);
  gate.requestApproval(project, { estimatedCost: 0 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  projectStore.touch(project);
  const rv = await ingestReferenceVideo(project.id, { url: REAL_VIDEO_URL, provider: realRelayProvider() });
  assert.equal(rv.status, 'COMPLETE');

  const measurements = measureReferenceVideo(project.id, rv.id);
  console.log(`[INT-1C REAL PROOF] Measurements ${measurements.id} — shots=${measurements.shots.length}`);

  const set = deriveObservations(project.id, measurements.id);
  console.log(`[INT-1C REAL PROOF] ObservationSet ${set.id} — status ${set.status}, ${set.observations.length} observations`);
  for (const o of set.observations) console.log(`  [${o.category}/${o.methodology.ruleId}/${o.confidence}] ${o.statement}`);
  for (const d of set.diagnostics) console.log(`  DIAG ${d.code} (${d.ruleId}): ${d.message}`);

  assert.equal(set.referenceVideoId, rv.id);
  assert.equal(set.measurementsId, measurements.id);
  assert.ok(set.observations.length >= 6, 'the real video should produce at least 6 real observations across its categories');

  // --- Observation -> Measurement -> Raw Evidence traceability ---
  const stored = measurementStore.getMeasurement(project.id, measurements.id);
  assert.equal(stored.referenceVideoId, rv.id); // Measurements -> Raw Evidence
  for (const obs of set.observations) {
    assert.equal(obs.measurementsId, measurements.id);
    for (const ev of obs.evidence) {
      assert.equal(ev.measurementsId, measurements.id);
      assert.notEqual(getByPath(stored, ev.metricPath), undefined, `evidence path "${ev.metricPath}" must resolve inside the real, persisted measurements record`);
    }
  }

  // --- specific, hand-verifiable real observations ---
  const duration = set.observations.find((o) => o.methodology.ruleId === 'VIDEO_DURATION_MEASURED');
  assert.match(duration.statement, /18\.95 seconds/);

  const shotCount = set.observations.find((o) => o.methodology.ruleId === 'SHOT_COUNT_OBSERVED');
  assert.equal(shotCount.statement, 'The reference video contains 1 detected shot (cut-to-cut span).'); // the real, well-known fact
  assert.equal(shotCount.confidence, 'LOW'); // a single-shot (absence of cut) result — correctly weaker evidence

  const wpm = set.observations.find((o) => o.methodology.ruleId === 'WORDS_PER_MINUTE_OBSERVED');
  assert.match(wpm.statement, /123\.5 words per minute/);

  // --- honest capability diagnostics must always fire in this environment ---
  assert.ok(set.diagnostics.some((d) => d.code === 'OCR_UNAVAILABLE'));
  assert.ok(set.diagnostics.some((d) => d.code === 'SCENE_OBSERVATION_UNAVAILABLE'));

  // --- no interpretation leakage anywhere in the real output ---
  const banned = /\b(excellent|great|good|bad|poor|strong|weak|engaging|boring|effective|impressive|amazing|compelling|works because|the reason)\b/i;
  for (const obs of set.observations) assert.doesNotMatch(obs.statement, banned, `real observation statement must never contain a judgment word: "${obs.statement}"`);

  console.log('[INT-1C REAL PROOF] every observation above is a factual, evidence-linked statement — none interprets WHY the video works');
});
