// Tests for services/reference-video-ingestion-service.js — INT-1A, the
// orchestrator. Every network-facing method is a small, injected FAKE
// provider (implementing services/reference-video/acquisition-provider-
// interface.js) — the same "small injected fake providers... to exercise
// every failure code deterministically and quickly" convention test/
// voice-generation-service.test.js already established. FFmpeg/ffprobe
// are real (already-installed, capability-proven) — this file never fakes
// those, only the network boundary. The Whisper fallback test uses the
// REAL espeak-ng + faster-whisper pipeline (26.9B) for a genuine, if
// small, end-to-end proof. The full real-Apify pipeline proof lives in
// test/reference-video-ingestion-pipeline.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-ingest-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-ingest-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const rvTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-ingest-store-'));
process.env.REFERENCE_VIDEO_DATA_DIR = rvTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const referenceVideoStore = require('../services/reference-video-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function makeVideoFile({ durationSeconds = 2, withAudio = true, width = 320, height = 180 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-src-'));
  const p = path.join(dir, 'src.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:duration=${durationSeconds}:rate=25`];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p);
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', p);
  }
  execFileSync('ffmpeg', args);
  return p;
}

function fetchImplServing(filePath) {
  return async () => {
    const buf = fs.readFileSync(filePath);
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
      body: Readable.toWeb(Readable.from(buf)),
    };
  };
}

function fakeProvider(overrides = {}) {
  return {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: 'abc12345678', normalizedUrl: 'https://www.youtube.com/watch?v=abc12345678', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 'Test', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/result.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'COMPLETED', transcript: { text: 'hello world', language: 'en', segments: [{ text: 'hello world', startTime: 0, endTime: 2 }] }, diagnostics: [] }),
    ...overrides,
  };
}

// --- 1-3. happy path -----------------------------------------------------------------------

test('1. a full COMPLETE ingestion produces real video+audio Assets, real ffprobe technical facts, and a provider transcript', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 2 });
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider(), fetchImpl: fetchImplServing(src) });

  assert.equal(rv.status, 'COMPLETE');
  assert.deepEqual(rv.diagnostics, []);
  assert.equal(rv.source.platform, 'YOUTUBE');
  assert.equal(rv.source.externalId, 'abc12345678');
  assert.ok(rv.videoAssetId);
  assert.ok(rv.audioAssetId);
  assert.equal(rv.videoTechnical.width, 320);
  assert.equal(rv.videoTechnical.videoCodec, 'h264');
  assert.equal(rv.audioTechnical.audioCodec, 'pcm_s16le');
  assert.equal(rv.transcript.source, 'ACQUISITION_PROVIDER');
  assert.equal(rv.transcript.segments.length, 1);

  const videoAsset = timelineStore.getAsset(project.id, rv.videoAssetId);
  assert.equal(videoAsset.type, 'video');
  assert.equal(videoAsset.storage.status, 'STORED');
  const audioAsset = timelineStore.getAsset(project.id, rv.audioAssetId);
  assert.equal(audioAsset.type, 'audio');
  assert.equal(audioAsset.storage.status, 'STORED');
});

test('2. the ReferenceVideo is actually persisted — listReferenceVideos reflects it', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider(), fetchImpl: fetchImplServing(src) });
  const listed = referenceVideoStore.listReferenceVideos(project.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, rv.id);
});

test('3. a video with NO audio stream still ingests as PARTIAL, with a clear AUDIO_EXTRACTION_FAILED diagnostic', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1, withAudio: false });
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider(), fetchImpl: fetchImplServing(src) });
  assert.equal(rv.status, 'PARTIAL');
  assert.equal(rv.audioAssetId, null);
  assert.ok(rv.diagnostics.some((d) => d.code === 'AUDIO_EXTRACTION_FAILED'));
  assert.ok(rv.videoAssetId); // video itself still succeeded
});

// --- 4-9. PARTIAL / non-fatal degradation ---------------------------------------------------

test('4. missing metadata alone degrades to PARTIAL, never FAILED', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider({ acquireMetadata: async () => ({ status: 'UNAVAILABLE', metadata: null, diagnostics: [] }) }),
    fetchImpl: fetchImplServing(src),
  });
  assert.equal(rv.status, 'PARTIAL');
  assert.equal(rv.metadata, null);
  assert.ok(rv.diagnostics.some((d) => d.code === 'METADATA_UNAVAILABLE'));
  assert.ok(rv.videoAssetId);
});

test('5. missing transcript alone (provider has none, Whisper fallback disabled) degrades to PARTIAL, never FAILED — the task\'s own worked example', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider({ acquireTranscript: async () => ({ status: 'UNAVAILABLE', transcript: null, diagnostics: [] }) }),
    fetchImpl: fetchImplServing(src),
    allowWhisperFallback: false,
  });
  assert.equal(rv.status, 'PARTIAL');
  assert.equal(rv.transcript, null);
  assert.ok(rv.diagnostics.some((d) => d.code === 'TRANSCRIPT_UNAVAILABLE'));
});

// --- 6-11. FAILED cases -----------------------------------------------------------------------

test('6. an invalid reference URL fails with INVALID_REFERENCE_URL and is never persisted', async () => {
  const project = newProject();
  const rv = await ingestReferenceVideo(project.id, {
    url: 'not a url',
    provider: fakeProvider({ resolveSource: async () => ({ status: 'FAILED', diagnostics: [{ code: 'INVALID_REFERENCE_URL', message: 'bad url' }] }) }),
  });
  assert.equal(rv.status, 'FAILED');
  assert.equal(rv.diagnostics[0].code, 'INVALID_REFERENCE_URL');
  assert.deepEqual(referenceVideoStore.listReferenceVideos(project.id), []);
});

test('7. an unsupported platform fails with UNSUPPORTED_PLATFORM', async () => {
  const project = newProject();
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://vimeo.com/12345',
    provider: fakeProvider({ resolveSource: async () => ({ status: 'UNSUPPORTED', diagnostics: [{ code: 'UNSUPPORTED_PLATFORM', message: 'vimeo' }] }) }),
  });
  assert.equal(rv.status, 'FAILED');
  assert.equal(rv.diagnostics[0].code, 'UNSUPPORTED_PLATFORM');
});

test('8. VIDEO_ACQUISITION_FAILED fails the whole ingestion — a ReferenceVideo with no video asset is not persisted as COMPLETE/PARTIAL', async () => {
  const project = newProject();
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider({ acquireVideo: async () => ({ status: 'FAILED', resultUrl: null, diagnostics: [{ code: 'VIDEO_ACQUISITION_FAILED', message: 'provider could not download' }] }) }),
  });
  assert.equal(rv.status, 'FAILED');
  assert.equal(rv.videoAssetId, null);
  assert.ok(rv.diagnostics.some((d) => d.code === 'VIDEO_ACQUISITION_FAILED'));
});

test('9. VIDEO_FILE_INVALID — the provider claims success but the file cannot actually be downloaded', async () => {
  const project = newProject();
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider(),
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }),
  });
  assert.equal(rv.status, 'FAILED');
  assert.equal(rv.diagnostics[0].code, 'VIDEO_FILE_INVALID');
});

test('10. an oversized download is refused via the existing maxBytes cap (services/asset-storage.js), reported as VIDEO_FILE_INVALID', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 2 });
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider(),
    fetchImpl: fetchImplServing(src),
    maxVideoBytes: 10, // far smaller than any real video — forces the cap
  });
  assert.equal(rv.status, 'FAILED');
  assert.equal(rv.diagnostics[0].code, 'VIDEO_FILE_INVALID');
});

test('11. ingesting against a nonexistent project fails structurally rather than throwing', async () => {
  await assert.doesNotReject(async () => {
    const rv = await ingestReferenceVideo('does-not-exist', { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider() });
    assert.equal(rv.status, 'FAILED');
  });
});

// --- 12-14. idempotency (Part 15/20) --------------------------------------------------------

test('12. re-ingesting the exact same reference returns the SAME record and never re-calls acquireMetadata/acquireVideo/acquireTranscript', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  let calls = { acquireMetadata: 0, acquireVideo: 0, acquireTranscript: 0 };
  const provider = fakeProvider({
    acquireMetadata: async (...a) => { calls.acquireMetadata++; return fakeProvider().acquireMetadata(...a); },
    acquireVideo: async (...a) => { calls.acquireVideo++; return fakeProvider().acquireVideo(...a); },
    acquireTranscript: async (...a) => { calls.acquireTranscript++; return fakeProvider().acquireTranscript(...a); },
  });

  const rv1 = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider, fetchImpl: fetchImplServing(src) });
  const rv2 = await ingestReferenceVideo(project.id, { url: 'https://youtu.be/abc12345678', provider, fetchImpl: fetchImplServing(src) }); // a different URL FORM for the same video

  assert.equal(rv1.id, rv2.id);
  assert.equal(rv1.videoAssetId, rv2.videoAssetId);
  assert.equal(calls.acquireMetadata, 1);
  assert.equal(calls.acquireVideo, 1);
  assert.equal(calls.acquireTranscript, 1);
  assert.equal(referenceVideoStore.listReferenceVideos(project.id).length, 1, 'no duplicate record was created');
  assert.equal(timelineStore.listAssets(project.id).filter((a) => a.type === 'video').length, 1, 'no duplicate video binary was created');
});

test('13. two DIFFERENT reference videos in the same project each get their own record and their own assets', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const providerB = fakeProvider({ resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: 'differentVid1', normalizedUrl: 'https://www.youtube.com/watch?v=differentVid1', diagnostics: [] }) });

  const rvA = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider(), fetchImpl: fetchImplServing(src) });
  const rvB = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=differentVid1', provider: providerB, fetchImpl: fetchImplServing(src) });

  assert.notEqual(rvA.id, rvB.id);
  assert.notEqual(rvA.videoAssetId, rvB.videoAssetId);
  assert.equal(referenceVideoStore.listReferenceVideos(project.id).length, 2);
});

test('14. idempotency does not silently overwrite or corrupt the first ingested record\'s data', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const provider = fakeProvider();
  const rv1 = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider, fetchImpl: fetchImplServing(src) });
  await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider, fetchImpl: fetchImplServing(src) });
  const stillThere = referenceVideoStore.getReferenceVideo(project.id, rv1.id);
  assert.deepEqual(stillThere, rv1);
});

// --- 15. provider boundary --------------------------------------------------------------------

test('15. an incomplete provider (missing a required interface method) throws immediately, never silently degrades', async () => {
  const project = newProject();
  await assert.rejects(() => ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: { acquireMetadata: async () => {}, acquireVideo: async () => {}, acquireTranscript: async () => {} } }), /resolveSource/);
});

// --- 16-18. Whisper fallback (real espeak-ng + real faster-whisper) ---------------------------

test('16. when the provider has no transcript, a real local Whisper fallback runs against the real extracted audio and produces a real, word-level, LOCAL_WHISPER-sourced transcript', async () => {
  const project = newProject();
  const speechDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-speech-'));
  const speechWav = path.join(speechDir, 'speech.wav');
  execFileSync('espeak-ng', ['-w', speechWav, 'This proves the real local whisper fallback pipeline works end to end.']);
  const videoWithSpeech = path.join(speechDir, 'video.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:duration=4:rate=25', '-i', speechWav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoWithSpeech]);

  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider({ acquireTranscript: async () => ({ status: 'UNAVAILABLE', transcript: null, diagnostics: [] }) }),
    fetchImpl: fetchImplServing(videoWithSpeech),
    allowWhisperFallback: true,
  });

  assert.equal(rv.transcript.source, 'LOCAL_WHISPER');
  assert.ok(rv.transcript.words.length > 0);
  assert.ok(rv.transcript.words[0].startTime !== null);
  assert.match(rv.transcript.text.toLowerCase(), /whisper|pipeline|real/);
  assert.equal(rv.status, 'COMPLETE');
});

test('17. Whisper fallback never runs (and never overwrites) when the provider already supplied a transcript', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider(), fetchImpl: fetchImplServing(src), allowWhisperFallback: true });
  assert.equal(rv.transcript.source, 'ACQUISITION_PROVIDER');
});

test('18. Whisper fallback is skipped (not attempted) when audio extraction itself failed — never runs against a nonexistent file', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1, withAudio: false });
  const rv = await ingestReferenceVideo(project.id, {
    url: 'https://www.youtube.com/watch?v=abc12345678',
    provider: fakeProvider({ acquireTranscript: async () => ({ status: 'UNAVAILABLE', transcript: null, diagnostics: [] }) }),
    fetchImpl: fetchImplServing(src),
    allowWhisperFallback: true,
  });
  assert.equal(rv.transcript, null);
  assert.ok(rv.diagnostics.some((d) => d.code === 'TRANSCRIPT_UNAVAILABLE'));
});

// --- 19-20. data isolation / no mutation ------------------------------------------------------

test('19. every path written during ingestion stays inside the temp override directories, never server/data', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider: fakeProvider(), fetchImpl: fetchImplServing(src) });
  const videoAsset = timelineStore.getAsset(project.id, rv.videoAssetId);
  const resolvedPath = assetStorage.resolveStoredPath(videoAsset.storage.path);
  assert.ok(resolvedPath.startsWith(assetStorageDir));
  assert.doesNotMatch(resolvedPath, /server\/data/);
});

test('20. the caller-supplied provider object is never mutated', async () => {
  const project = newProject();
  const src = makeVideoFile({ durationSeconds: 1 });
  const provider = fakeProvider();
  const before = JSON.stringify(Object.keys(provider));
  await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=abc12345678', provider, fetchImpl: fetchImplServing(src) });
  assert.equal(JSON.stringify(Object.keys(provider)), before);
});

// --- 21. security ------------------------------------------------------------------------------

test('21. services/reference-video-ingestion-service.js only invokes child_process via execFileSync with explicit argument arrays; no shell/eval', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video-ingestion-service.js'), 'utf8');
  const codeOnly = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /\beval\(/);
  assert.doesNotMatch(codeOnly, /new Function/);
  assert.doesNotMatch(codeOnly, /shell:\s*true/);
  assert.doesNotMatch(codeOnly, /\bexec\(|\bspawn\(/);
  assert.match(codeOnly, /require\('child_process'\)/);
});
