// Tests for services/reference-video-measurement-service.js — the
// orchestrator. FFmpeg/ffprobe are real (already-installed, capability-
// proven by this stage's own forensic audit); every fixture video is
// generated ON THE FLY with FFmpeg's own lavfi sources with KNOWN,
// hand-computable properties (a real cut at a known timestamp, a known
// silence gap) so assertions check exact expected numbers, never merely
// "a field exists" (Part 21). The full real-Apify-sourced proof lives in
// test/reference-video-measurement-pipeline.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const rvTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-rvstore-'));
process.env.REFERENCE_VIDEO_DATA_DIR = rvTempDir;
const measurementTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-mstore-'));
process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR = measurementTempDir;

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const referenceVideoStore = require('../services/reference-video-store');
const measurementStore = require('../services/reference-video-measurement-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const measurementService = require('../services/reference-video-measurement-service');

// P0 Hardening (finding J) — ingestReferenceVideo() now blocks on the
// project's approval-gate.js budget/approval state before making any real
// (billed, in production) Apify call. Pre-approved here so every existing
// test in this file exercising the acquisition/measurement pipeline is
// unaffected.
function newProject() {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

// A real, deterministic TWO-SHOT video: a solid red frame for exactly
// `shot1` seconds, concatenated with a solid blue frame for `shot2`
// seconds — a real, unambiguous cut at t=shot1 that FFmpeg's own scdet
// filter can (and, per this stage's manual verification, does) detect.
function makeTwoShotVideo({ shot1 = 2, shot2 = 2, width = 320, height = 180 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-src-'));
  const p = path.join(dir, 'two-shot.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:size=${width}x${height}:duration=${shot1}:rate=25`,
    '-f', 'lavfi', '-i', `color=c=blue:size=${width}x${height}:duration=${shot2}:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${shot1 + shot2}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[outv]',
    '-map', '[outv]', '-map', '2:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p,
  ]);
  return p;
}

// A real video with a KNOWN silent gap: a tone, then genuine digital
// silence (anullsrc), then a tone again — silencedetect should find
// exactly one real interval matching the known gap.
function makeVideoWithKnownSilence({ toneDur = 1, silenceDur = 1.5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-silence-'));
  const p = path.join(dir, 'with-silence.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:duration=${toneDur * 2 + silenceDur}:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${toneDur}`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:duration=${silenceDur}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${toneDur}`,
    '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[outa]',
    '-map', '0:v', '-map', '[outa]', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p,
  ]);
  return p;
}

function ingestFixtureVideo(project, videoPath, { withTranscript = true, transcriptWords = null } = {}) {
  const { Readable } = require('stream');
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fixture${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fixture000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 'Fixture', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/fixture.mp4', diagnostics: [] }),
    acquireTranscript: async () =>
      withTranscript
        ? { status: 'COMPLETED', transcript: { text: transcriptWords ? transcriptWords.map((w) => w.word).join(' ') : 'Hello there. Is this working? Yes it is.', language: 'en', words: transcriptWords || [], segments: transcriptWords ? [] : [{ text: 'Hello there. Is this working? Yes it is.', startTime: 0, endTime: 3 }] }, diagnostics: [] }
        : { status: 'FAILED', diagnostics: [{ code: 'NO_CAPTIONS', message: 'no captions' }] },
  };
  return ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fixture000001', provider, fetchImpl });
}

test('1. measureReferenceVideo FAILS with INVALID_REFERENCE_VIDEO for a non-existent project', () => {
  const m = measurementService.measureReferenceVideo('00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111');
  assert.equal(m.status, 'FAILED');
  assert.equal(m.diagnostics[0].code, 'INVALID_REFERENCE_VIDEO');
});

test('2. measureReferenceVideo FAILS with INVALID_REFERENCE_VIDEO for a non-existent ReferenceVideo id', async () => {
  const project = newProject();
  const m = measurementService.measureReferenceVideo(project.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(m.status, 'FAILED');
  assert.equal(m.diagnostics[0].code, 'INVALID_REFERENCE_VIDEO');
});

test('3. detectShots on a real two-shot fixture (red 2s + blue 2s) finds exactly one real cut and produces shots whose durations sum to the video\'s own duration', () => {
  const videoPath = makeTwoShotVideo({ shot1: 2, shot2: 2 });
  const result = measurementService.detectShots('ffmpeg', videoPath, 4);
  assert.equal(result.ok, true);
  assert.equal(result.shots.length, 2);
  assert.ok(Math.abs(result.shots[0].endTime - 2) < 0.1, `expected the real cut near t=2, got ${result.shots[0].endTime}`);
  const totalDuration = result.shots.reduce((sum, s) => sum + s.duration, 0);
  assert.ok(Math.abs(totalDuration - 4) < 0.01);
});

test('4. detectShots on a real single-color fixture (no cut at all) finds exactly one shot spanning the whole duration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-oneshot-'));
  const p = path.join(dir, 'one-shot.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:size=320x180:duration=3:rate=25', '-pix_fmt', 'yuv420p', p]);
  const result = measurementService.detectShots('ffmpeg', p, 3);
  assert.equal(result.ok, true);
  assert.deepEqual(result.shots.map((s) => [s.startTime, s.endTime]), [[0, 3]]);
});

test('5. measureAudio on a real fixture with a known 1.5s silent gap detects a real interval close to that gap', () => {
  const videoPath = makeVideoWithKnownSilence({ toneDur: 1, silenceDur: 1.5 });
  const result = measurementService.measureAudio('ffmpeg', videoPath, 3.5);
  assert.equal(result.ok, true);
  assert.equal(result.silenceIntervals.length, 1);
  assert.ok(Math.abs(result.silenceIntervals[0].duration - 1.5) < 0.15, `expected ~1.5s silence, got ${result.silenceIntervals[0].duration}`);
  assert.ok(Math.abs(result.totalSilenceDuration - 1.5) < 0.15);
  assert.ok(result.speechDuration < 2.5 && result.speechDuration > 1.5);
});

test('6. measureVisualChange on a real two-shot fixture returns a real, non-empty frame-difference distribution', () => {
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const result = measurementService.measureVisualChange('ffmpeg', videoPath);
  assert.equal(result.ok, true);
  assert.ok(result.distribution.count > 10);
  assert.ok(result.distribution.max > result.distribution.min);
  assert.ok(result.samples.length > 0);
});

test('7. planFrameSamples deduplicates near-identical timestamps (opening and a shot boundary within 0.15s collapse to one sample)', () => {
  const shots = [{ index: 0, startTime: 0, endTime: 0.1 }, { index: 1, startTime: 0.1, endTime: 4 }];
  const plan = measurementService.planFrameSamples(shots, 4);
  const times = plan.map((p) => p.time);
  const nearZero = times.filter((t) => t < 0.2);
  assert.equal(nearZero.length, 1, `expected the near-duplicate opening/shot-boundary timestamps to collapse, got ${JSON.stringify(times)}`);
});

test('8. checkOcrCapability reports unavailable in this environment, matching this stage\'s own forensic audit (no tesseract installed)', () => {
  const result = measurementService.checkOcrCapability();
  assert.equal(result.available, false);
  assert.ok(result.blocker);
});

test('9. probeFrameCount returns a real positive integer for a real fixture video', () => {
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const n = measurementService.probeFrameCount('ffprobe', videoPath);
  assert.ok(typeof n === 'number' && n > 0);
});

test('10. measureReferenceVideo end-to-end on a real ingested two-shot fixture: shot count, frame extraction, audio, and evidence pointers are all real and traceable', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 2, shot2: 2 });
  const rv = await ingestFixtureVideo(project, videoPath);
  assert.equal(rv.status, 'COMPLETE');

  const m = measurementService.measureReferenceVideo(project.id, rv.id);
  assert.equal(m.referenceVideoId, rv.id);
  assert.equal(m.shots.length, 2, 'the real cut in the fixture must be detected');
  assert.equal(m.shotRhythm.shotCount, 2);

  // every frame sample's evidence must point at the REAL video asset id
  assert.ok(m.frameSamples.length > 0);
  for (const sample of m.frameSamples) {
    assert.equal(sample.evidence.sourceId, rv.videoAssetId);
  }
  // at least one extracted frame must be a real, stored Asset
  const extracted = m.frameSamples.filter((s) => s.frameAssetId);
  assert.ok(extracted.length > 0);
  for (const sample of extracted) {
    const asset = timelineStore.getAsset(project.id, sample.frameAssetId);
    assert.equal(asset.type, 'reference_frame');
    assert.equal(asset.storage.status, 'STORED');
    assert.ok(assetStorage.storedFileExists(asset.storage.path));
    const bytes = fs.readFileSync(assetStorage.resolveStoredPath(asset.storage.path));
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8); // real JPEG magic bytes, not a stub
  }

  // audio measurement is real and points at the real audio asset
  assert.ok(m.audio);
  assert.equal(m.audio.technicalEvidence.sourceId, rv.audioAssetId);
  assert.equal(typeof m.audio.meanVolumeDb.value, 'number');
});

test('11. measureReferenceVideo reports INSUFFICIENT_EVIDENCE and leaves audio null when the ReferenceVideo has no audio Asset', async () => {
  const project = newProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvm-noaudio-'));
  const p = path.join(dir, 'no-audio.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:size=320x180:duration=2:rate=25', '-pix_fmt', 'yuv420p', '-an', p]);
  const rv = await ingestFixtureVideo(project, p, { withTranscript: false });
  assert.equal(rv.audioAssetId, null);

  const m = measurementService.measureReferenceVideo(project.id, rv.id);
  assert.equal(m.audio, null);
  assert.ok(m.diagnostics.some((d) => d.code === 'INSUFFICIENT_EVIDENCE'));
});

test('12. measureReferenceVideo reports TRANSCRIPT_MEASUREMENT_FAILED and leaves transcript/hook null when there is no transcript', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const rv = await ingestFixtureVideo(project, videoPath, { withTranscript: false });
  assert.equal(rv.transcript, null);

  const m = measurementService.measureReferenceVideo(project.id, rv.id);
  assert.equal(m.transcript, null);
  assert.equal(m.hook, null);
  assert.ok(m.diagnostics.some((d) => d.code === 'TRANSCRIPT_MEASUREMENT_FAILED'));
});

test('13. measureReferenceVideo, given a transcript with real word-level timestamps, produces real wordTiming/sentences/pauses traceable to those exact timestamps', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 2, shot2: 2 });
  const words = [
    { word: 'Hello', startTime: 0, endTime: 0.3 },
    { word: 'there.', startTime: 0.3, endTime: 0.6 },
    { word: 'Is', startTime: 2, endTime: 2.1 }, // 1.4s gap after "there." — a real pause
    { word: 'this', startTime: 2.1, endTime: 2.2 },
    { word: 'working?', startTime: 2.2, endTime: 2.6 },
  ];
  const rv = await ingestFixtureVideo(project, videoPath, { transcriptWords: words });
  assert.equal(rv.transcript.words.length, 5);

  const m = measurementService.measureReferenceVideo(project.id, rv.id);
  assert.equal(m.wordTiming.length, 5);
  assert.equal(m.wordTiming[0].duration, 0.3);
  assert.equal(m.transcript.pauseCount.value, 1);
  assert.ok(Math.abs(m.transcript.pauseDurationDistribution.max - 1.4) < 0.001);
  assert.equal(m.transcript.sentences.length, 2);
  assert.equal(m.hook.firstQuestionMarkTime, 2.2); // the word "working?" itself carries the "?"
});

test('14. DETERMINISM (Part 19): measuring the identical stored evidence twice produces byte-identical measurement VALUES (excluding id/createdAt and the one explicitly-documented exception: frameSamples[].frameAssetId, a freshly-minted identifier for a newly-stored — but byte-identical — extracted frame image each run; see schemas/reference-video-measurement-schema.js\'s createDeterminismNote)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 2, shot2: 2 });
  const rv = await ingestFixtureVideo(project, videoPath);

  const strip = (m) => {
    const clone = JSON.parse(JSON.stringify(m));
    delete clone.id;
    delete clone.createdAt;
    clone.frameSamples = clone.frameSamples.map((f) => ({ ...f, frameAssetId: f.frameAssetId ? 'PRESENT' : null }));
    return clone;
  };
  const first = strip(measurementService.measureReferenceVideo(project.id, rv.id));
  const second = strip(measurementService.measureReferenceVideo(project.id, rv.id));
  assert.deepEqual(first, second);
});

test('15. PROVENANCE: every top-level Measurement\'s evidence pointer resolves to a real, existing Asset or the ReferenceVideo itself — never a dangling/fabricated id', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const rv = await ingestFixtureVideo(project, videoPath);
  const m = measurementService.measureReferenceVideo(project.id, rv.id);

  const checkEvidence = (ev) => {
    if (!ev) return;
    if (ev.sourceType === 'REFERENCE_VIDEO_ASSET' || ev.sourceType === 'REFERENCE_AUDIO_ASSET') {
      assert.ok(timelineStore.getAsset(project.id, ev.sourceId), `evidence points at a real Asset (${ev.sourceId})`);
    }
    if (ev.sourceType === 'TRANSCRIPT' || ev.sourceType === 'SHOT_LIST') {
      assert.equal(ev.sourceId, rv.id);
    }
  };
  checkEvidence(m.video.technicalEvidence);
  checkEvidence(m.audio.technicalEvidence);
  checkEvidence(m.transcript ? { sourceType: 'TRANSCRIPT', sourceId: rv.id } : null);
  if (m.shotRhythm) checkEvidence(m.shotRhythm.shotsPerMinute.evidence);
  for (const shot of m.shots) checkEvidence(shot.evidence);
});

test('16. this file only ever invokes child_process via execFileSync/spawnSync with explicit argument arrays — no shell string, no eval, no dynamic command construction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video-measurement-service.js'), 'utf8');
  assert.doesNotMatch(source, /\beval\(/);
  assert.doesNotMatch(source, /new Function\(/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /exec\(/); // exec() (shell-interpreted) never used, only execFile/spawnSync
});

test('17. measureReferenceVideo is idempotent-safe to call repeatedly and always appends to the measurement store (free/local — never blocked like paid acquisition)', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const rv = await ingestFixtureVideo(project, videoPath);
  measurementService.measureReferenceVideo(project.id, rv.id);
  measurementService.measureReferenceVideo(project.id, rv.id);
  const all = measurementStore.listMeasurements(project.id);
  assert.equal(all.length, 2);
  const latest = measurementStore.getLatestMeasurementForReferenceVideo(project.id, rv.id);
  assert.equal(latest.id, all[1].id);
});

test('18. a video whose Asset was never stored produces a FAILED measurement with INVALID_REFERENCE_VIDEO, never a crash', async () => {
  const project = newProject();
  const videoPath = makeTwoShotVideo({ shot1: 1, shot2: 1 });
  const rv = await ingestFixtureVideo(project, videoPath);
  // simulate a corrupted/never-downloaded video asset
  timelineStore.updateAssetStorage(project.id, rv.videoAssetId, { status: 'FAILED' });
  const m = measurementService.measureReferenceVideo(project.id, rv.id);
  assert.equal(m.status, 'FAILED');
  assert.equal(m.diagnostics[0].code, 'INVALID_REFERENCE_VIDEO');
});
