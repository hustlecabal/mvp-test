// Tests for services/music/ai33-music-provider.js — PHASE 3C (interface
// compliance stub) + PHASE 3B (the real submit -> poll -> download
// implementation).
//
// PHASE 3B — a real generation endpoint is now documented and
// implemented (POST /v1s/task/music-generation, polled via GET
// /v1/task/{task_id} — see that file's own header for the exact
// documented-vs-inferred-vs-verified distinction). This file now tests:
//
//   1. The REAL module's honest degradation behavior for invalid
//      input/missing credential — never a thrown error, never a
//      fabricated success (tests B, E).
//   2. The REAL submit/poll/download logic against MOCKED HTTP responses
//      (section "L" below) — request mapping, auth headers, instrumental
//      vs custom mode, task id handling, the documented v1 polling
//      endpoint, pending->completed, failed task, timeout, and malformed
//      responses. No real network call is made by this file — see
//      test/ai33-music-provider-live.test.js (if present) or the Phase
//      3B final report for the real, credentialed attempt and its
//      outcome (blocked by this sandbox's own network egress policy).
//   3. An END-TO-END SIMULATION (tests I, I2 below, pre-existing) of what
//      a successful AI33 resolution looks like through the FULL
//      acquireMusic() -> Asset -> MUSIC AudioEvent ->
//      TimelineCompilationResult.audio[] pipeline, using a small,
//      locally-defined fake provider — proving the rest of the pipeline
//      is correct independent of the real provider's own HTTP details.

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

test('E. search() rejects an invalid request (empty searchQuery) with FAILED, before any credential/endpoint check', async () => {
  const result = await ai33MusicProvider.search(createMusicAcquisitionRequest({ provider: 'ai33', searchQuery: '' }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// ===========================================================================
// acquisition failure + Asset registration — real ai33 provider through the real dispatcher
// ===========================================================================

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

// ===========================================================================
// L — PHASE 3B: the real submit -> poll -> download logic, against
// MOCKED HTTP responses only (never a real network call). Covers the 10
// required cases: request mapping, auth header, instrumental request,
// task id handling, the documented v1 polling endpoint, pending ->
// completed, failed task, timeout, malformed response, provider-neutral
// result/provenance.
// ===========================================================================

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fetchImpl that serves one submit response, then poll responses in
// order (the last one repeats if more polls happen than responses
// supplied) — records every call (url + options) for assertion.
function makeSequencedFetch({ submitStatus = 200, submitBody, pollResponses = [] }) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (n === 0) {
      n++;
      return jsonResponse(submitStatus, submitBody);
    }
    const pollIndex = Math.min(n - 1, pollResponses.length - 1);
    n++;
    const resp = pollResponses[pollIndex];
    return jsonResponse(resp.status || 200, resp.body);
  };
  return { fetchImpl, calls };
}

const FAST_POLL = { pollIntervalMs: 1, timeoutMs: 500 };

test('L1. request mapping — simple/instrumental mode maps searchQuery -> gpt_description_prompt, defaults make_instrumental to true', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't1' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t1.mp3' } } } }],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1', { searchQuery: 'cinematic documentary background music about bees' }), { fetchImpl, ...FAST_POLL });
    assert.equal(result.status, 'COMPLETED');
    const submitCall = calls[0];
    assert.equal(submitCall.url, 'https://api.ai33.pro/v1s/task/music-generation');
    const body = JSON.parse(submitCall.options.body);
    assert.equal(body.gpt_description_prompt, 'cinematic documentary background music about bees');
    assert.equal(body.make_instrumental, true);
    assert.equal(body.title, undefined, 'simple mode must never send custom-mode fields');
    assert.equal(body.lyrics, undefined);
  });
});

test('L1b. request mapping — custom mode (lyrics present) maps title/lyrics/tags/vocalGender, never sends gpt_description_prompt', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't2' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t2.mp3' } } } }],
    });
    const request = musicRequest('p1', { title: 'The Hive', lyrics: 'la la la', tags: 'folk, acoustic', vocalGender: 'f' });
    const result = await ai33MusicProvider.search(request, { fetchImpl, ...FAST_POLL });
    assert.equal(result.status, 'COMPLETED');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.title, 'The Hive');
    assert.equal(body.lyrics, 'la la la');
    assert.equal(body.tags, 'folk, acoustic');
    assert.equal(body.vocal_gender, 'f');
    assert.equal(body.gpt_description_prompt, undefined, 'custom mode must never send simple-mode fields');
    assert.equal(body.make_instrumental, undefined);
  });
});

test('L2. authentication header — xi-api-key is sent on BOTH the submit and the poll request, never in the URL or body', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'super-secret-key', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't3' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t3.mp3' } } } }],
    });
    await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers['xi-api-key'], 'super-secret-key');
    assert.equal(calls[1].options.headers['xi-api-key'], 'super-secret-key');
    assert.ok(!calls[0].url.includes('super-secret-key'));
    assert.ok(!calls[1].url.includes('super-secret-key'));
    assert.ok(!JSON.stringify(calls[0].options.body).includes('super-secret-key'));
  });
});

test('L3. instrumental request — an explicit instrumental:false is honored, never silently overridden to true', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't4' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t4.mp3' } } } }],
    });
    await ai33MusicProvider.search(musicRequest('p1', { instrumental: false }), { fetchImpl, ...FAST_POLL });
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.make_instrumental, false);
  });
});

test('L4. task id handling — the submitted task_id is reused verbatim in the poll URL and in the final providerAssetId/provenance', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 'task-abc-123' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/x.mp3' } } } }],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.ok(calls[1].url.includes('task-abc-123'));
    assert.equal(result.candidates[0].providerAssetId, 'task-abc-123');
    assert.equal(result.candidates[0].providerMetadata.taskId, 'task-abc-123');
  });
});

test('L5. documented polling endpoint — GET {baseUrl}/v1/task/{task_id}, the DOCUMENTED common mechanism, never the TTS-only /v3/task/{task_id} assumption', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't5' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t5.mp3' } } } }],
    });
    await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.equal(calls[1].url, 'https://api.ai33.pro/v1/task/t5');
    assert.ok(!calls[1].url.includes('/v3/'), 'must never reuse the TTS-only v3 polling assumption for Music');
  });
});

test('L6. pending -> completed flow — an in-progress status is polled again (not treated as done or as a failure), and the eventual "done" status resolves', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl, calls } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't6' },
      pollResponses: [
        { body: { success: true, data: { status: 'pending', metadata: {} } } },
        { body: { success: true, data: { status: 'doing', metadata: {} } } },
        { body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t6.mp3', duration: 42, model: 'suno-v4' } } } },
      ],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(calls.length, 4, '1 submit + 3 polls');
    assert.equal(result.candidates[0].downloadUrl, 'https://cdn.ai33.pro/t6.mp3');
    assert.equal(result.candidates[0].durationSeconds, 42);
    assert.equal(result.candidates[0].providerMetadata.model, 'suno-v4');
  });
});

test('L7. failed task — an unrecognized/error status is surfaced as AI33_TASK_FAILED, never silently retried forever', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't7' },
      pollResponses: [{ body: { success: true, data: { status: 'failed', metadata: {} } } }],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'AI33_TASK_FAILED');
    assert.deepEqual(result.candidates, []);
  });
});

test('L8. timeout — a task that never leaves an in-progress status within the deadline is AI33_TASK_TIMEOUT, never hangs forever', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't8' },
      pollResponses: [{ body: { success: true, data: { status: 'doing', metadata: {} } } }],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, pollIntervalMs: 5, timeoutMs: 30 });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'AI33_TASK_TIMEOUT');
  });
});

test('L9. malformed provider response — submit missing task_id, poll missing data.status, and completed-with-no-audio_url are all AI33_MALFORMED_RESPONSE, never a crash', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    // (a) submit response has no task_id
    const noTaskId = makeSequencedFetch({ submitBody: { success: true } });
    const r1 = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl: noTaskId.fetchImpl, ...FAST_POLL });
    assert.equal(r1.status, 'FAILED');
    assert.equal(r1.diagnostics[0].code, 'AI33_MALFORMED_RESPONSE');

    // (b) poll response missing data.status entirely
    const noStatus = makeSequencedFetch({ submitBody: { success: true, task_id: 't9b' }, pollResponses: [{ body: { success: true, data: {} } }] });
    const r2 = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl: noStatus.fetchImpl, ...FAST_POLL });
    assert.equal(r2.status, 'FAILED');
    assert.equal(r2.diagnostics[0].code, 'AI33_MALFORMED_RESPONSE');

    // (c) "done" but no metadata.audio_url
    const noAudioUrl = makeSequencedFetch({ submitBody: { success: true, task_id: 't9c' }, pollResponses: [{ body: { success: true, data: { status: 'done', metadata: {} } } }] });
    const r3 = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl: noAudioUrl.fetchImpl, ...FAST_POLL });
    assert.equal(r3.status, 'FAILED');
    assert.equal(r3.diagnostics[0].code, 'AI33_MALFORMED_RESPONSE');

    // (d) submit body is not valid JSON at all
    const badJsonFetch = async () => new Response('not json', { status: 200 });
    const r4 = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl: badJsonFetch, ...FAST_POLL });
    assert.equal(r4.status, 'FAILED');
    assert.equal(r4.diagnostics[0].code, 'AI33_MALFORMED_RESPONSE');
  });
});

test('L10. provider-neutral result/provenance — the returned MusicSearchResult/candidate carries only the declared MusicCandidate shape plus additive providerMetadata; no raw AI33 response object leaks through', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl } = makeSequencedFetch({
      submitBody: { success: true, task_id: 't10' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/t10.mp3', duration: 12, model: 'suno-v4' } } } }],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    const candidate = result.candidates[0];
    const declaredKeys = ['providerAssetId', 'sourceUrl', 'downloadUrl', 'audioBuffer', 'durationSeconds', 'format', 'attribution', 'licenseSummary', 'providerMetadata'];
    assert.deepEqual(Object.keys(candidate).sort(), declaredKeys.sort());
    assert.equal(candidate.audioBuffer, null, 'AI33 is a downloadUrl provider, mode #1 — never audioBuffer');
    assert.deepEqual(Object.keys(candidate.providerMetadata).sort(), ['provider', 'operation', 'taskId', 'model', 'mode'].sort());
    assert.equal(candidate.providerMetadata.provider, 'ai33');
  });
});

test('L11. STEP 8 integration — a mocked-but-documented-shape end-to-end AI33 resolution flows through acquireMusic() -> Asset -> createMusicAudioEvent() with provenance preserved (no real network call)', async () => {
  const project = makeProject();
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl } = makeSequencedFetch({
      submitBody: { success: true, task_id: 'integration-task-1' },
      pollResponses: [{ body: { success: true, data: { status: 'done', metadata: { audio_url: 'https://cdn.ai33.pro/integration.mp3', duration: 20, model: 'suno-v4' } } } }],
    });
    // The download step is a SEPARATE fetch call (services/asset-storage.js's
    // downloadAsset(), via the existing mode #1 downloadUrl path) — this
    // wraps the same mocked fetchImpl to also serve the audio bytes for
    // that specific URL, never touching the real network.
    const combinedFetch = async (url, options) => {
      if (url === 'https://cdn.ai33.pro/integration.mp3') {
        const buffer = buildFixtureMp3Buffer();
        return new Response(buffer, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(buffer.length) } });
      }
      return fetchImpl(url, options);
    };

    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'ai33', sceneId: 'scene-X' }), { fetchImpl: combinedFetch });

    assert.equal(result.status, 'ACQUIRED');
    assert.equal(result.provider, 'ai33');
    assert.equal(result.providerAssetId, 'integration-task-1');
    assert.ok(result.assetId);
    assert.equal(result.providerMetadata.taskId, 'integration-task-1');
    assert.equal(result.providerMetadata.model, 'suno-v4');
    assert.equal(result.providerMetadata.mode, 'simple');

    const asset = timelineStore.getAsset(project.id, result.assetId);
    assert.ok(asset, 'the existing Asset model registered this — no second asset model invented');
    assert.equal(asset.type, 'audio');
    assert.equal(asset.storage.status, 'STORED');

    const audioEvent = musicAcquisitionService.createMusicAudioEvent(result);
    assert.equal(audioEvent.type, 'MUSIC');
    assert.equal(audioEvent.sourceAssetId, result.assetId);
    assert.equal(audioEvent.sceneId, 'scene-X');
    assert.equal(audioEvent.duration, null, 'scene-span inference preserved, unchanged by this provider');

    // PHASE 3B HARDENING — TASK 4: provenance must reach the persisted
    // Asset record itself, not just the transient result, reusing the
    // SAME Asset.model/generationId fields voice-generation-service.js's
    // own AI33 TTS integration already established (schemas/production-
    // schema.js's createAsset()) — no second provenance system invented.
    assert.equal(asset.provider, 'ai33');
    assert.equal(asset.model, 'suno-v4');
    assert.equal(asset.generationId, 'integration-task-1');
  });
});

// ===========================================================================
// M — PHASE 3B HARDENING REVIEW: status-value discipline and poll-side
// malformed-JSON handling.
// ===========================================================================

test('M1. an in-progress-LOOKING status with zero evidence behind it ("queued") is treated as AI33_TASK_FAILED, never silently absorbed as in-progress', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const { fetchImpl } = makeSequencedFetch({
      submitBody: { success: true, task_id: 'm1' },
      pollResponses: [{ body: { success: true, data: { status: 'queued', metadata: {} } } }],
    });
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'AI33_TASK_FAILED', 'queued/submitted are not documented or TTS-verified in-progress values — must never be invented as such');
  });
});

test('M2. poll response body that is not valid JSON is AI33_MALFORMED_RESPONSE, never a crash (distinct from the already-covered submit-side case)', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    let call = 0;
    const fetchImpl = async () => {
      call++;
      if (call === 1) return jsonResponse(200, { success: true, task_id: 'm2' });
      return new Response('not json at all', { status: 200 });
    };
    const result = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl, ...FAST_POLL });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'AI33_MALFORMED_RESPONSE');
  });
});

test('M3. HTTP-level errors on submit and on poll are both surfaced as PROVIDER_HTTP_ERROR, distinct from AI33_MALFORMED_RESPONSE', async () => {
  await withEnv('EVOLINK_AI33_API_KEY', 'k', async () => {
    const submitHttpError = async () => new Response('Internal Server Error', { status: 500 });
    const r1 = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl: submitHttpError, ...FAST_POLL });
    assert.equal(r1.status, 'FAILED');
    assert.equal(r1.diagnostics[0].code, 'PROVIDER_HTTP_ERROR');

    let call = 0;
    const pollHttpError = async () => {
      call++;
      if (call === 1) return jsonResponse(200, { success: true, task_id: 'm3' });
      return new Response('Bad Gateway', { status: 502 });
    };
    const r2 = await ai33MusicProvider.search(musicRequest('p1'), { fetchImpl: pollHttpError, ...FAST_POLL });
    assert.equal(r2.status, 'FAILED');
    assert.equal(r2.diagnostics[0].code, 'PROVIDER_HTTP_ERROR');
  });
});
