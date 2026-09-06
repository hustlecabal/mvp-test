// Tests for services/music/ai33-music-provider.js — PHASE 3C.
//
// AI33 Pro Music has no confirmed generation endpoint on the real, live
// API (see that file's own header for the exact discovery evidence: every
// plausible path returned a real 404, while the known-real
// /v3/text-to-speech and /v3/voices endpoints return structured JSON
// validation errors). This file therefore tests two genuinely different
// things:
//
//   1. The REAL ai33-music-provider.js module's own honest behavior today
//      — always a structured UNAVAILABLE, never a thrown error, never a
//      fabricated success. This is "graceful unavailable-provider
//      behaviour" tested against the real module, not a mock of it.
//   2. An END-TO-END SIMULATION of what a successful AI33 resolution would
//      look like once a real endpoint is confirmed — using a small,
//      locally-defined fake provider shaped like a real AI33 result
//      (MP3 output, matching services/voice/ai33-voice-provider.js's own
//      real, verified MP3 narration output), proving the REST of the
//      pipeline (acquireMusic -> Asset -> MUSIC AudioEvent ->
//      TimelineCompilationResult.audio[]) is already correct and ready
//      for the real provider the moment it exists — without pretending
//      the real module itself already works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-music-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-music-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const musicAcquisitionService = require('../services/music-acquisition-service');
const ai33MusicProvider = require('../services/music/ai33-music-provider');
const { assertImplementsMusicProviderInterface, createMusicSearchResult } = require('../services/music/music-provider-interface');
const { createMusicAcquisitionRequest, createMusicCandidate } = require('../schemas/music-acquisition-schema');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { compileTimeline } = require('../services/timeline-compiler-service');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function musicRequest(projectId, overrides = {}) {
  return createMusicAcquisitionRequest({ projectId, provider: 'ai33', searchQuery: 'uplifting corporate background music', ...overrides });
}

function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

// ===========================================================================
// A. provider interface compliance
// ===========================================================================

test('A. ai33-music-provider.js implements the Phase 3B MusicProvider interface', () => {
  assert.doesNotThrow(() => assertImplementsMusicProviderInterface(ai33MusicProvider));
  assert.equal(ai33MusicProvider.PROVIDER_NAME, 'ai33');
});

// ===========================================================================
// B / graceful unavailable-provider behaviour — the REAL module's real, honest behavior
// ===========================================================================

test('B. search() reports MISSING_CREDENTIAL (UNAVAILABLE) when EVOLINK_AI33_API_KEY is not set, never throws', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', undefined, async () => {
    const result = await ai33MusicProvider.search(musicRequest('p1'));
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics[0].code, 'MISSING_CREDENTIAL');
  });
});

test('C. search() reports AI33_MUSIC_ENDPOINT_NOT_CONFIRMED (UNAVAILABLE) when a credential exists — the real, live, honest state today, with no candidate ever fabricated', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'test-key', async () => {
    const result = await ai33MusicProvider.search(musicRequest('p1'));
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics[0].code, 'AI33_MUSIC_ENDPOINT_NOT_CONFIRMED');
    assert.match(result.diagnostics[0].message, /404/);
    assert.deepEqual(result.candidates, []);
  });
});

test('E. search() rejects an invalid request (empty searchQuery) with FAILED, before any credential/endpoint check', async () => {
  const result = await ai33MusicProvider.search(createMusicAcquisitionRequest({ provider: 'ai33', searchQuery: '' }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// ===========================================================================
// acquisition failure + Asset registration — real ai33 provider through the real dispatcher
// ===========================================================================

test('F. acquireMusic() with the real "ai33" provider (credential present, no endpoint confirmed) is a structured PROVIDER_FAILED result, and registers no Asset', async () => {
  const project = makeProject();
  await withEnv('EVOLINK_AI33_API_KEY', 'test-key', async () => {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id));
    assert.equal(result.status, 'PROVIDER_FAILED');
    assert.equal(result.diagnostics[0].code, 'AI33_MUSIC_ENDPOINT_NOT_CONFIRMED');
    assert.equal(timelineStore.listAssets(project.id).length, 0);
  });
});

test('G. acquireMusic() with the real "ai33" provider and no credential is MISSING_CREDENTIAL, never a thrown error', async () => {
  const project = makeProject();
  await withEnv('EVOLINK_AI33_API_KEY', undefined, async () => {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id));
    assert.equal(result.status, 'MISSING_CREDENTIAL');
  });
});

// ===========================================================================
// malformed response — an AI33-shaped candidate missing its audio URL
// ===========================================================================

test('H. a malformed AI33-shaped candidate (no downloadUrl, mirroring a real AI33 task completing with no metadata.audio_url) is a structured PROVIDER_FAILED result, never a crash', async () => {
  const project = makeProject();
  const malformedAi33 = {
    credential: () => 'test-key',
    search: async () => createMusicSearchResult({ status: 'COMPLETED', candidates: [createMusicCandidate({ providerAssetId: 'ai33-task-123', format: 'mp3' })] }), // no downloadUrl — mirrors a real AI33 "done" task with no metadata.audio_url
  };
  musicAcquisitionService.MUSIC_PROVIDER_MODULES['ai33-malformed-sim'] = malformedAi33;
  try {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'ai33-malformed-sim' }));
    assert.equal(result.status, 'PROVIDER_FAILED');
    assert.equal(result.diagnostics[0].code, 'MALFORMED_CANDIDATE');
  } finally {
    delete musicAcquisitionService.MUSIC_PROVIDER_MODULES['ai33-malformed-sim'];
  }
});

// ===========================================================================
// SIMULATED successful AI33 resolution — end-to-end, AI33-shaped
// (MP3 output, real task-id-style providerAssetId), proving the pipeline
// is already correct and ready for the real provider once it exists.
// ===========================================================================

// A syntactically valid MP3 signature (ID3v2 header) — matches services/
// asset-storage.js's own AUDIO_SIGNATURES check, verified against a real
// AI33 narration response earlier this project (every real AI33 audio
// file observed starts "ID3" — see asset-storage.js's own comment).
function buildFixtureMp3Buffer() {
  const header = Buffer.from('ID3', 'ascii');
  const padding = Buffer.alloc(64, 0);
  return Buffer.concat([header, padding]);
}

test('I. a successful AI33-shaped resolution (simulated: real endpoint confirmed, real task completed) produces a real Asset, a MUSIC AudioEvent, and enters TimelineCompilationResult.audio[] with correct scene-span timing', async () => {
  const project = makeProject();
  const FIXTURE_URL = 'https://api.ai33.pro/fixtures/simulated-ai33-music-task.mp3';
  const simulatedAi33 = {
    credential: () => 'test-key',
    search: async () =>
      createMusicSearchResult({
        status: 'COMPLETED',
        candidates: [
          createMusicCandidate({
            providerAssetId: 'ai33-task-real-shape-1',
            sourceUrl: FIXTURE_URL,
            downloadUrl: FIXTURE_URL,
            durationSeconds: 30,
            format: 'mp3',
            attribution: 'AI33 Pro Music (simulated)',
            licenseSummary: 'Generated — commercial use per AI33 Pro terms',
          }),
        ],
      }),
  };
  const fetchImpl = async (url) => {
    if (url !== FIXTURE_URL) throw new Error(`unexpected URL: ${url}`);
    const buffer = buildFixtureMp3Buffer();
    return new Response(buffer, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(buffer.length) } });
  };

  musicAcquisitionService.MUSIC_PROVIDER_MODULES['ai33-success-sim'] = simulatedAi33;
  try {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'ai33-success-sim', sceneId: 'scene-A' }), { fetchImpl });

    // --- Asset registration ---
    assert.equal(result.status, 'ACQUIRED');
    assert.equal(result.providerAssetId, 'ai33-task-real-shape-1');
    assert.equal(result.format, 'mp3');
    const asset = timelineStore.getAsset(project.id, result.assetId);
    assert.ok(asset);
    assert.equal(asset.type, 'audio');
    assert.equal(asset.storage.status, 'STORED');
    assert.equal(asset.storage.contentType, 'audio/mpeg');

    // --- MUSIC AudioEvent creation ---
    const audioEvent = musicAcquisitionService.createMusicAudioEvent(result);
    assert.equal(audioEvent.type, 'MUSIC');
    assert.equal(audioEvent.sourceAssetId, result.assetId);
    assert.equal(audioEvent.sceneId, 'scene-A');
    assert.equal(audioEvent.duration, null, 'left absent so the compiler infers the real scene span, never pinned to the raw 30s source clip');

    // --- compiler registration + scene-span timing (Phase 3A, unmodified) ---
    const beat1 = createVisualBeat({ id: crypto.randomUUID(), sceneId: 'scene-A', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 0, duration: 4 });
    const beat2 = createVisualBeat({ id: crypto.randomUUID(), sceneId: 'scene-A', shotId: 'sh2', sequence: 2, visualTreatment: 'STILL_IMAGE', startTime: 4, duration: 6 });
    const beat3 = createVisualBeat({ id: crypto.randomUUID(), sceneId: 'scene-B', shotId: 'sh3', sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 10, duration: 3 });
    const graph = createBeatGraph({ projectId: project.id, beats: [beat1, beat2, beat3] });
    const resolutions = [beat1, beat2, beat3].map((b, i) => createMaterialResolution({ beatId: b.id, status: 'RESOLVED', selectedMaterial: createCandidateResult({ candidate: `M${i}`, materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', role: 'PRIMARY' }) }));
    const executions = [
      createExecutionResult({ beatId: beat1.id, materialId: 'M0', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 4, renderSpec: null, sourceAssetIds: [] }),
      createExecutionResult({ beatId: beat2.id, materialId: 'M1', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 6, renderSpec: null, sourceAssetIds: [] }),
      createExecutionResult({ beatId: beat3.id, materialId: 'M2', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 3, renderSpec: null, sourceAssetIds: [] }),
    ];

    const timelineCompilation = compileTimeline(graph, resolutions, executions, [audioEvent]);
    assert.equal(timelineCompilation.audio.length, 1);
    assert.equal(timelineCompilation.audio[0].startTime, 0); // scene-A's own earliest compiled shot
    assert.equal(timelineCompilation.audio[0].duration, 10); // scene-A spans [0,10) — beat3 (scene-B) never included
    assert.equal(timelineCompilation.shots.length, 3, 'visual compilation is completely unaffected by the simulated AI33 music event');
  } finally {
    delete musicAcquisitionService.MUSIC_PROVIDER_MODULES['ai33-success-sim'];
  }
});

test('I2. the same simulated AI33 resolution, with no beatId/sceneId, spans the whole compiled timeline — no second cursor', async () => {
  const project = makeProject();
  const FIXTURE_URL = 'https://api.ai33.pro/fixtures/simulated-ai33-music-task-2.mp3';
  const simulatedAi33 = {
    credential: () => 'test-key',
    search: async () => createMusicSearchResult({ status: 'COMPLETED', candidates: [createMusicCandidate({ providerAssetId: 'ai33-task-2', sourceUrl: FIXTURE_URL, downloadUrl: FIXTURE_URL, durationSeconds: 45, format: 'mp3' })] }),
  };
  const fetchImpl = async (url) => new Response(buildFixtureMp3Buffer(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

  musicAcquisitionService.MUSIC_PROVIDER_MODULES['ai33-success-sim-2'] = simulatedAi33;
  try {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'ai33-success-sim-2' }), { fetchImpl });
    const audioEvent = musicAcquisitionService.createMusicAudioEvent(result); // no beatId/sceneId

    const beat = createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 0, duration: 8 });
    const graph = createBeatGraph({ projectId: project.id, beats: [beat] });
    const resolution = createMaterialResolution({ beatId: beat.id, status: 'RESOLVED', selectedMaterial: createCandidateResult({ candidate: 'M1', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', role: 'PRIMARY' }) });
    const execution = createExecutionResult({ beatId: beat.id, materialId: 'M1', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 8, renderSpec: null, sourceAssetIds: [] });

    const timelineCompilation = compileTimeline(graph, [resolution], [execution], [audioEvent]);
    assert.equal(timelineCompilation.audio[0].startTime, 0);
    assert.equal(timelineCompilation.audio[0].duration, 8); // whole compiled-timeline span
  } finally {
    delete musicAcquisitionService.MUSIC_PROVIDER_MODULES['ai33-success-sim-2'];
  }
});

// ===========================================================================
// reuse of existing AI33 infrastructure
// ===========================================================================

test('J. ai33-music-provider.js reuses the SAME base URL constant/override convention as services/voice/ai33-voice-provider.js', () => {
  assert.equal(ai33MusicProvider.DEFAULT_BASE_URL, 'https://api.ai33.pro');
});

test('K. ai33-music-provider.js reads the SAME credential env var as narration (EVOLINK_AI33_API_KEY) — no second AI33 credential invented', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'shared-key-value', async () => {
    assert.equal(ai33MusicProvider.credential(), 'shared-key-value');
  });
});
