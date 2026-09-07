// Tests for services/music-acquisition-service.js — PHASE 3B. Mirrors
// test/media-acquisition-service.test.js's own discipline exactly (real
// temp-dir project/asset stores, no network, no API key — the fixture
// provider stands in for a real one), applied to the new, separate MUSIC
// domain. Never imports or touches services/media-acquisition-service.js
// or anything under services/media-acquisition/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-music-acq-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-music-acq-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const musicAcquisitionService = require('../services/music-acquisition-service');
const fixtureMusicProvider = require('../services/music/fixture-music-provider');
const { createMusicAcquisitionRequest } = require('../schemas/music-acquisition-schema');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { compileTimeline } = require('../services/timeline-compiler-service');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function musicRequest(projectId, overrides = {}) {
  return createMusicAcquisitionRequest({ projectId, provider: 'fixture', searchQuery: 'ambient piano', ...overrides });
}

// Injects a temporary, throwaway provider module into the real dispatch
// table for the duration of `fn`, then removes it — the same spirit as
// media-acquisition-service.test.js's own env-var save/restore around
// PEXELS_API_KEY, applied to the dispatch table itself since Phase 3B
// deliberately registers no second real provider to intercept via fetchImpl.
async function withTempProvider(name, providerModule, fn) {
  musicAcquisitionService.MUSIC_PROVIDER_MODULES[name] = providerModule;
  try {
    return await fn();
  } finally {
    delete musicAcquisitionService.MUSIC_PROVIDER_MODULES[name];
  }
}

// ===========================================================================
// A. successful acquisition + asset lifecycle
// ===========================================================================

test('A. acquireMusic downloads, validates, and registers a real audio Asset for a valid fixture candidate', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { beatId: null, sceneId: 'scene-1' }), { fetchImpl: fixtureMusicProvider.fakeFetchImpl });

  assert.equal(result.status, 'ACQUIRED');
  assert.equal(result.provider, 'fixture');
  assert.equal(result.providerAssetId, 'fixture-music-1');
  assert.equal(result.durationSeconds, fixtureMusicProvider.FIXTURE_DURATION_SECONDS);
  assert.equal(result.format, 'wav');
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.assetId);

  const asset = timelineStore.getAsset(project.id, result.assetId);
  assert.ok(asset, 'the Asset must actually be registered');
  assert.equal(asset.type, 'audio', 'a Music asset must use the same audio Asset type NARRATION already uses — no new asset type');
  assert.equal(asset.storage.status, 'STORED');
  assert.equal(asset.provider, 'fixture');
  assert.equal(asset.sceneId, 'scene-1');
});

// ===========================================================================
// B. audio integration — MUSIC AudioEvent
// ===========================================================================

test('B. a successful MusicAcquisitionResult becomes a real AudioEvent, type MUSIC, using the EXISTING Phase 3A schema', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id), { fetchImpl: fixtureMusicProvider.fakeFetchImpl });

  const audioEvent = musicAcquisitionService.createMusicAudioEvent(result);
  assert.equal(audioEvent.type, 'MUSIC');
  assert.equal(audioEvent.status, 'READY');
  assert.equal(audioEvent.sourceAssetId, result.assetId);
  assert.equal(audioEvent.duration, null, 'duration is left ABSENT so the compiler can infer a scene/timeline span — never silently pinned to the raw source clip length');
  assert.equal(audioEvent.startTime, null, 'placement is a caller/compiler decision, never invented by acquisition');
  // The raw source duration is still available separately, for a future mixing/looping decision.
  assert.equal(result.durationSeconds, fixtureMusicProvider.FIXTURE_DURATION_SECONDS);
});

test('B3. an explicit duration override is honored verbatim, for a caller that wants playback capped to the raw source length', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id), { fetchImpl: fixtureMusicProvider.fakeFetchImpl });
  const audioEvent = musicAcquisitionService.createMusicAudioEvent(result, { duration: result.durationSeconds });
  assert.equal(audioEvent.duration, fixtureMusicProvider.FIXTURE_DURATION_SECONDS);
});

test('B2. createMusicAudioEvent refuses a non-ACQUIRED result rather than fabricating an event for it', () => {
  assert.throws(() => musicAcquisitionService.createMusicAudioEvent({ status: 'NO_CANDIDATES' }), /ACQUIRED/);
});

// ===========================================================================
// C. PHASE 3A INTEGRATION — TimelineCompilationResult.audio[], unmodified
// ===========================================================================

test('C. a MUSIC AudioEvent produced by acquisition enters TimelineCompilationResult.audio[] via the EXISTING, unmodified Phase 3A compiler — no timing architecture change required', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id), { fetchImpl: fixtureMusicProvider.fakeFetchImpl });
  const musicEvent = musicAcquisitionService.createMusicAudioEvent(result); // no beatId/sceneId -> whole-timeline span

  const beat1 = createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: project.id, beats: [beat1] });
  const resolution = createMaterialResolution({ beatId: beat1.id, status: 'RESOLVED', selectedMaterial: createCandidateResult({ candidate: 'M1', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', role: 'PRIMARY' }) });
  const execution = createExecutionResult({ beatId: beat1.id, materialId: 'M1', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 5, renderSpec: null, sourceAssetIds: [] });

  const timelineCompilation = compileTimeline(graph, [resolution], [execution], [musicEvent]);

  assert.equal(timelineCompilation.audio.length, 1);
  assert.equal(timelineCompilation.audio[0].type, 'MUSIC');
  assert.equal(timelineCompilation.audio[0].sourceAssetId, result.assetId);
  assert.equal(timelineCompilation.audio[0].startTime, 0);
  assert.equal(timelineCompilation.audio[0].duration, 5); // whole compiled-timeline span, Phase 3A's own Tier inference — untouched
  assert.equal(timelineCompilation.shots.length, 1, 'visual compilation is completely unaffected');
});

// ===========================================================================
// D. dispatch
// ===========================================================================

test('D. Music request -> provider dispatch -> registered fixture provider -> provider-neutral result, deterministically', async () => {
  const project = makeProject();
  const first = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { beatId: null }), { fetchImpl: fixtureMusicProvider.fakeFetchImpl });
  assert.equal(first.status, 'ACQUIRED');
  // No provider-internal shape (candidate objects, raw fetch Response, etc.) leaks into the result.
  assert.deepEqual(
    Object.keys(first).sort(),
    // PHASE 3B — providerMetadata added: additive, optional generation
    // provenance (see schemas/music-acquisition-schema.js's own comment).
    ['id', 'status', 'projectId', 'beatId', 'sceneId', 'assetId', 'provider', 'providerAssetId', 'sourceUrl', 'downloadUrl', 'durationSeconds', 'format', 'attribution', 'licenseSummary', 'searchQuery', 'checksum', 'acquiredAt', 'providerMetadata', 'diagnostics'].sort()
  );
});

// ===========================================================================
// E. failure semantics — every non-success is structured, never thrown, never silent
// ===========================================================================

test('E1. an unknown provider name is a structured UNSUPPORTED_PROVIDER result, never a thrown error', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'not-a-real-provider' }));
  assert.equal(result.status, 'UNSUPPORTED_PROVIDER');
});

test('E2. a provider with no credential is a structured MISSING_CREDENTIAL result, never a thrown error, never a network call', async () => {
  const project = makeProject();
  let called = false;
  await withTempProvider('fake-uncredentialed', { search: async () => { called = true; }, credential: () => null }, async () => {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'fake-uncredentialed' }));
    assert.equal(result.status, 'MISSING_CREDENTIAL');
  });
  assert.equal(called, false, 'search() must never be called when the credential gate already failed');
});

test('E3. a provider whose search() throws never propagates — a structured PROVIDER_FAILED result is returned', async () => {
  const project = makeProject();
  await withTempProvider('fake-throwing', { search: async () => { throw new Error('simulated provider outage'); }, credential: () => 'x' }, async () => {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'fake-throwing' }));
    assert.equal(result.status, 'PROVIDER_FAILED');
    assert.equal(result.diagnostics[0].code, 'PROVIDER_SEARCH_THREW');
  });
});

test('E4. zero search candidates is a structured NO_CANDIDATES result', async () => {
  const project = makeProject();
  const { createMusicSearchResult } = require('../services/music/music-provider-interface');
  await withTempProvider('fake-empty', { search: async () => createMusicSearchResult({ status: 'COMPLETED', candidates: [] }), credential: () => 'x' }, async () => {
    const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'fake-empty' }));
    assert.equal(result.status, 'NO_CANDIDATES');
  });
});

test('E5. a malformed candidate (no downloadUrl) is a structured PROVIDER_FAILED result, never a crash', async () => {
  const project = makeProject();
  const { createMusicSearchResult } = require('../services/music/music-provider-interface');
  const { createMusicCandidate } = require('../schemas/music-acquisition-schema');
  await withTempProvider(
    'fake-malformed',
    { search: async () => createMusicSearchResult({ status: 'COMPLETED', candidates: [createMusicCandidate({ providerAssetId: 'x' })] }), credential: () => 'x' },
    async () => {
      const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'fake-malformed' }));
      assert.equal(result.status, 'PROVIDER_FAILED');
      assert.equal(result.diagnostics[0].code, 'MALFORMED_CANDIDATE');
    }
  );
});

test('E6. a download failure is a structured PROVIDER_FAILED result, never a thrown error, and never registers an Asset', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id), {
    fetchImpl: async () => {
      throw new Error('simulated network failure during download');
    },
  });
  assert.equal(result.status, 'PROVIDER_FAILED');
  assert.equal(timelineStore.listAssets(project.id).length, 0, 'no Asset must be registered when the download itself fails');
});

test('E7. a downloaded file that is not real audio (e.g. an HTML error page served with a 200) is REJECTED_INVALID, never silently registered as a valid asset', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id), {
    fetchImpl: async () => new Response(Buffer.from('<html>not audio</html>'), { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(result.status, 'REJECTED_INVALID');
  assert.equal(result.diagnostics[0].code, 'UNRECOGNIZED_AUDIO_FORMAT');
  assert.equal(timelineStore.listAssets(project.id).length, 0, 'no Asset must be registered for invalid audio');
});

test('E8. an empty/missing searchQuery is a structured PROVIDER_FAILED result before any provider is even reached', async () => {
  const project = makeProject();
  const result = await musicAcquisitionService.acquireMusic(createMusicAcquisitionRequest({ projectId: project.id, provider: 'fixture', searchQuery: '' }));
  assert.equal(result.status, 'PROVIDER_FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// ===========================================================================
// E9-E11. PHASE 3D — byte-backed candidates (audioBuffer), the mode a
// generative provider with no separate URL uses (services/music/
// elevenlabs-music-provider.js's real contract) — see schemas/music-
// acquisition-schema.js's own header for why this mode exists.
// ===========================================================================

test('E9. a byte-backed candidate (audioBuffer, no downloadUrl) is stored, validated, and registered exactly like a URL-backed one — no URL shim required', async () => {
  const project = makeProject();
  const { createMusicSearchResult } = require('../services/music/music-provider-interface');
  const wavBuffer = fixtureMusicProvider.buildFixtureWavBuffer();
  await withTempProvider(
    'fake-byte-backed',
    {
      credential: () => 'x',
      search: async () => createMusicSearchResult({ status: 'COMPLETED', candidates: [{ providerAssetId: 'gen-1', downloadUrl: null, audioBuffer: wavBuffer, format: 'wav' }] }),
    },
    async () => {
      const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'fake-byte-backed', sceneId: 'scene-9' }));
      assert.equal(result.status, 'ACQUIRED');
      assert.equal(result.providerAssetId, 'gen-1');
      assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);

      const asset = timelineStore.getAsset(project.id, result.assetId);
      assert.ok(asset);
      assert.equal(asset.type, 'audio');
      assert.equal(asset.storage.status, 'STORED');
      assert.equal(asset.storage.contentType, 'audio/wav');
      assert.equal(asset.sceneId, 'scene-9');

      const audioEvent = musicAcquisitionService.createMusicAudioEvent(result);
      assert.equal(audioEvent.type, 'MUSIC');
      assert.equal(audioEvent.sourceAssetId, result.assetId);
    }
  );
});

test('E10. a byte-backed candidate whose bytes are not real audio is REJECTED_INVALID before anything is written to disk, never silently registered', async () => {
  const project = makeProject();
  const { createMusicSearchResult } = require('../services/music/music-provider-interface');
  await withTempProvider(
    'fake-byte-backed-invalid',
    {
      credential: () => 'x',
      search: async () => createMusicSearchResult({ status: 'COMPLETED', candidates: [{ providerAssetId: 'gen-2', downloadUrl: null, audioBuffer: Buffer.from('not audio at all'), format: null }] }),
    },
    async () => {
      const result = await musicAcquisitionService.acquireMusic(musicRequest(project.id, { provider: 'fake-byte-backed-invalid' }));
      assert.equal(result.status, 'REJECTED_INVALID');
      assert.equal(result.diagnostics[0].code, 'UNRECOGNIZED_AUDIO_FORMAT');
      assert.equal(timelineStore.listAssets(project.id).length, 0);
    }
  );
});

// ===========================================================================
// F. listAvailableMusicProviders never includes the fixture
// ===========================================================================

test('F. listAvailableMusicProviders never includes the fixture test provider', () => {
  assert.equal(musicAcquisitionService.listAvailableMusicProviders().includes('fixture'), false);
});

test('F2. listAvailableMusicProviders reports "ai33" if and only if EVOLINK_AI33_API_KEY is actually configured — never hardcoded true/false', () => {
  const original = process.env.EVOLINK_AI33_API_KEY;
  try {
    delete process.env.EVOLINK_AI33_API_KEY;
    assert.deepEqual(musicAcquisitionService.listAvailableMusicProviders(), []);

    process.env.EVOLINK_AI33_API_KEY = 'test-key';
    assert.deepEqual(musicAcquisitionService.listAvailableMusicProviders(), ['ai33']);
  } finally {
    if (original === undefined) delete process.env.EVOLINK_AI33_API_KEY;
    else process.env.EVOLINK_AI33_API_KEY = original;
  }
});

test('F3. listAvailableMusicProviders reports "elevenlabs" if and only if EVOLINK_ELEVENLABS_API_KEY is actually configured (PHASE 3D) — independent of the AI33 credential', () => {
  const originalEleven = process.env.EVOLINK_ELEVENLABS_API_KEY;
  const originalAi33 = process.env.EVOLINK_AI33_API_KEY;
  try {
    delete process.env.EVOLINK_ELEVENLABS_API_KEY;
    delete process.env.EVOLINK_AI33_API_KEY;
    assert.deepEqual(musicAcquisitionService.listAvailableMusicProviders(), []);

    process.env.EVOLINK_ELEVENLABS_API_KEY = 'test-eleven-key';
    assert.deepEqual(musicAcquisitionService.listAvailableMusicProviders(), ['elevenlabs']);
  } finally {
    if (originalEleven === undefined) delete process.env.EVOLINK_ELEVENLABS_API_KEY;
    else process.env.EVOLINK_ELEVENLABS_API_KEY = originalEleven;
    if (originalAi33 === undefined) delete process.env.EVOLINK_AI33_API_KEY;
    else process.env.EVOLINK_AI33_API_KEY = originalAi33;
  }
});
