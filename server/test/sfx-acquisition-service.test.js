// Tests for services/sfx-acquisition-service.js — PHASE 3E. Mirrors
// test/music-acquisition-service.test.js's own discipline exactly (real
// temp-dir project/asset stores, no network — the fixture provider stands
// in for a real one), applied to the new, separate SFX domain. Never
// imports or touches services/music-acquisition-service.js or anything
// under services/music/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-sfx-acq-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-sfx-acq-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const sfxAcquisitionService = require('../services/sfx-acquisition-service');
const fixtureSfxProvider = require('../services/sfx/fixture-sfx-provider');
const { createSfxAcquisitionRequest, createSfxCandidate } = require('../schemas/sfx-acquisition-schema');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { compileTimeline } = require('../services/timeline-compiler-service');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function sfxRequest(projectId, overrides = {}) {
  return createSfxAcquisitionRequest({ projectId, provider: 'fixture', searchQuery: 'soft whoosh transition', ...overrides });
}

async function withTempProvider(name, providerModule, fn) {
  sfxAcquisitionService.SFX_PROVIDER_MODULES[name] = providerModule;
  try {
    return await fn();
  } finally {
    delete sfxAcquisitionService.SFX_PROVIDER_MODULES[name];
  }
}

// ===========================================================================
// A. successful acquisition + asset lifecycle (URL-backed candidate)
// ===========================================================================

test('A. acquireSfx downloads, validates, and registers a real audio Asset for a valid URL-backed fixture candidate', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { beatId: 'beat-1' }), { fetchImpl: fixtureSfxProvider.fakeFetchImpl });

  assert.equal(result.status, 'ACQUIRED');
  assert.equal(result.provider, 'fixture');
  assert.equal(result.providerAssetId, 'fixture-sfx-1');
  assert.equal(result.durationSeconds, fixtureSfxProvider.FIXTURE_DURATION_SECONDS);
  assert.equal(result.format, 'wav');
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.assetId);

  const asset = timelineStore.getAsset(project.id, result.assetId);
  assert.ok(asset);
  assert.equal(asset.type, 'audio', 'an SFX asset must use the same audio Asset type NARRATION/MUSIC already use — no new asset type');
  assert.equal(asset.storage.status, 'STORED');
  assert.equal(asset.shotId, 'beat-1');
});

// ===========================================================================
// B. AudioEvent integration
// ===========================================================================

test('B. a successful SfxAcquisitionResult becomes a real AudioEvent, type SFX, using the EXISTING Phase 3A schema', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { beatId: 'beat-1' }), { fetchImpl: fixtureSfxProvider.fakeFetchImpl });

  const audioEvent = sfxAcquisitionService.createSfxAudioEvent(result);
  assert.equal(audioEvent.type, 'SFX');
  assert.equal(audioEvent.status, 'READY');
  assert.equal(audioEvent.sourceAssetId, result.assetId);
  assert.equal(audioEvent.beatId, 'beat-1');
  assert.equal(audioEvent.duration, null, 'left absent by default, mirroring createMusicAudioEvent() exactly — a caller wanting the real one-shot length passes it explicitly');
});

test('B2. createSfxAudioEvent refuses a non-ACQUIRED result rather than fabricating an event for it', () => {
  assert.throws(() => sfxAcquisitionService.createSfxAudioEvent({ status: 'NO_CANDIDATES' }), /ACQUIRED/);
});

test('B3. an explicit duration override is honored verbatim — the recommended convention for a real one-shot SFX hit', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { beatId: 'beat-1' }), { fetchImpl: fixtureSfxProvider.fakeFetchImpl });
  const audioEvent = sfxAcquisitionService.createSfxAudioEvent(result, { duration: result.durationSeconds });
  assert.equal(audioEvent.duration, fixtureSfxProvider.FIXTURE_DURATION_SECONDS);
});

// ===========================================================================
// C. PHASE 3A INTEGRATION — TimelineCompilationResult.audio[], unmodified
// compiler, proving the beat-attached model the audit identified as SFX's
// natural default
// ===========================================================================

test('C. a beat-attached SFX AudioEvent enters TimelineCompilationResult.audio[] via the EXISTING, unmodified Phase 3A compiler', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { beatId: 'b1' }), { fetchImpl: fixtureSfxProvider.fakeFetchImpl });
  const sfxEvent = sfxAcquisitionService.createSfxAudioEvent(result, { duration: result.durationSeconds });

  const beat = createVisualBeat({ id: 'b1', sceneId: 's1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 3, duration: 4 });
  const graph = createBeatGraph({ projectId: project.id, beats: [beat] });
  const resolution = createMaterialResolution({ beatId: beat.id, status: 'RESOLVED', selectedMaterial: createCandidateResult({ candidate: 'M1', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', role: 'PRIMARY' }) });
  const execution = createExecutionResult({ beatId: beat.id, materialId: 'M1', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 4, renderSpec: null, sourceAssetIds: [] });

  const timelineCompilation = compileTimeline(graph, [resolution], [execution], [sfxEvent]);

  assert.equal(timelineCompilation.audio.length, 1);
  assert.equal(timelineCompilation.audio[0].type, 'SFX');
  assert.equal(timelineCompilation.audio[0].sourceAssetId, result.assetId);
  assert.equal(timelineCompilation.audio[0].startTime, 3, 'the beat\'s own compiled startTime — no explicit startTime was ever set on the AudioEvent');
  assert.equal(timelineCompilation.audio[0].duration, fixtureSfxProvider.FIXTURE_DURATION_SECONDS, 'the real one-shot length, since B3\'s explicit-duration convention was used here');
  assert.equal(timelineCompilation.shots.length, 1, 'visual compilation is completely unaffected');
});

// ===========================================================================
// D. dispatch
// ===========================================================================

test('D. SFX request -> provider dispatch -> registered fixture provider -> provider-neutral result, deterministically', async () => {
  const project = makeProject();
  const first = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { beatId: null }), { fetchImpl: fixtureSfxProvider.fakeFetchImpl });
  assert.equal(first.status, 'ACQUIRED');
  assert.deepEqual(
    Object.keys(first).sort(),
    ['id', 'status', 'projectId', 'beatId', 'sceneId', 'assetId', 'provider', 'providerAssetId', 'sourceUrl', 'downloadUrl', 'durationSeconds', 'format', 'attribution', 'licenseSummary', 'searchQuery', 'checksum', 'acquiredAt', 'diagnostics'].sort()
  );
});

// ===========================================================================
// E. failure semantics
// ===========================================================================

test('E1. an unknown provider name is a structured UNSUPPORTED_PROVIDER result, never a thrown error', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'not-a-real-provider' }));
  assert.equal(result.status, 'UNSUPPORTED_PROVIDER');
});

test('E2. a provider with no credential is a structured MISSING_CREDENTIAL result, never a thrown error, never a network call', async () => {
  const project = makeProject();
  await withTempProvider('fake-no-cred', { credential: () => null, search: async () => { throw new Error('must not be called'); } }, async () => {
    const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'fake-no-cred' }));
    assert.equal(result.status, 'MISSING_CREDENTIAL');
  });
});

test('E3. a provider whose search() throws never propagates — a structured PROVIDER_FAILED result is returned', async () => {
  const project = makeProject();
  await withTempProvider(
    'fake-throws',
    { credential: () => 'x', search: async () => { throw new Error('boom'); } },
    async () => {
      const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'fake-throws' }));
      assert.equal(result.status, 'PROVIDER_FAILED');
    }
  );
});

test('E4. zero search candidates is a structured NO_CANDIDATES result', async () => {
  const project = makeProject();
  const { createSfxSearchResult } = require('../services/sfx/sfx-provider-interface');
  await withTempProvider('fake-empty', { credential: () => 'x', search: async () => createSfxSearchResult({ status: 'COMPLETED', candidates: [] }) }, async () => {
    const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'fake-empty' }));
    assert.equal(result.status, 'NO_CANDIDATES');
  });
});

test('E5. a malformed candidate (no downloadUrl, no audioBuffer) is a structured PROVIDER_FAILED result, never a crash', async () => {
  const project = makeProject();
  const { createSfxSearchResult } = require('../services/sfx/sfx-provider-interface');
  await withTempProvider(
    'fake-malformed',
    { search: async () => createSfxSearchResult({ status: 'COMPLETED', candidates: [createSfxCandidate({ providerAssetId: 'x' })] }), credential: () => 'x' },
    async () => {
      const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'fake-malformed' }));
      assert.equal(result.status, 'PROVIDER_FAILED');
      assert.equal(result.diagnostics[0].code, 'MALFORMED_CANDIDATE');
    }
  );
});

test('E6. a download failure is a structured PROVIDER_FAILED result, never a thrown error, and never registers an Asset', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id), {
    fetchImpl: async () => {
      throw new Error('simulated network failure during download');
    },
  });
  assert.equal(result.status, 'PROVIDER_FAILED');
  assert.equal(timelineStore.listAssets(project.id).length, 0);
});

test('E7. a downloaded file that is not real audio is REJECTED_INVALID, never silently registered', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id), {
    fetchImpl: async () => new Response(Buffer.from('<html>not audio</html>'), { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(result.status, 'REJECTED_INVALID');
  assert.equal(result.diagnostics[0].code, 'UNRECOGNIZED_AUDIO_FORMAT');
  assert.equal(timelineStore.listAssets(project.id).length, 0);
});

test('E8. an empty/missing searchQuery is a structured PROVIDER_FAILED result before any provider is even reached', async () => {
  const project = makeProject();
  const result = await sfxAcquisitionService.acquireSfx(createSfxAcquisitionRequest({ projectId: project.id, provider: 'fixture', searchQuery: '' }));
  assert.equal(result.status, 'PROVIDER_FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// ===========================================================================
// E9-E10. PHASE 3E — byte-backed candidates (audioBuffer), the mode
// elevenlabs-sfx-provider.js's real contract requires
// ===========================================================================

test('E9. a byte-backed candidate (audioBuffer, no downloadUrl) is stored, validated, and registered exactly like a URL-backed one — no URL shim required', async () => {
  const project = makeProject();
  const { createSfxSearchResult } = require('../services/sfx/sfx-provider-interface');
  const wavBuffer = fixtureSfxProvider.buildFixtureWavBuffer();
  await withTempProvider(
    'fake-byte-backed',
    {
      credential: () => 'x',
      search: async () => createSfxSearchResult({ status: 'COMPLETED', candidates: [{ providerAssetId: 'gen-1', downloadUrl: null, audioBuffer: wavBuffer, format: 'wav' }] }),
    },
    async () => {
      const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'fake-byte-backed', beatId: 'beat-9' }));
      assert.equal(result.status, 'ACQUIRED');
      const asset = timelineStore.getAsset(project.id, result.assetId);
      assert.ok(asset);
      assert.equal(asset.storage.status, 'STORED');
      assert.equal(asset.storage.contentType, 'audio/wav');
      assert.equal(asset.shotId, 'beat-9');
    }
  );
});

test('E10. a byte-backed candidate whose bytes are not real audio is REJECTED_INVALID before anything is written to disk', async () => {
  const project = makeProject();
  const { createSfxSearchResult } = require('../services/sfx/sfx-provider-interface');
  await withTempProvider(
    'fake-byte-backed-invalid',
    {
      credential: () => 'x',
      search: async () => createSfxSearchResult({ status: 'COMPLETED', candidates: [{ providerAssetId: 'gen-2', downloadUrl: null, audioBuffer: Buffer.from('not audio at all'), format: null }] }),
    },
    async () => {
      const result = await sfxAcquisitionService.acquireSfx(sfxRequest(project.id, { provider: 'fake-byte-backed-invalid' }));
      assert.equal(result.status, 'REJECTED_INVALID');
      assert.equal(result.diagnostics[0].code, 'UNRECOGNIZED_AUDIO_FORMAT');
      assert.equal(timelineStore.listAssets(project.id).length, 0);
    }
  );
});

// ===========================================================================
// F. listAvailableSfxProviders
// ===========================================================================

test('F. listAvailableSfxProviders never includes the fixture test provider', () => {
  assert.equal(sfxAcquisitionService.listAvailableSfxProviders().includes('fixture'), false);
});

test('F2. listAvailableSfxProviders reports "elevenlabs" if and only if EVOLINK_ELEVENLABS_API_KEY is actually configured', () => {
  const original = process.env.EVOLINK_ELEVENLABS_API_KEY;
  try {
    delete process.env.EVOLINK_ELEVENLABS_API_KEY;
    assert.deepEqual(sfxAcquisitionService.listAvailableSfxProviders(), []);
    process.env.EVOLINK_ELEVENLABS_API_KEY = 'test-key';
    assert.deepEqual(sfxAcquisitionService.listAvailableSfxProviders(), ['elevenlabs']);
  } finally {
    if (original === undefined) delete process.env.EVOLINK_ELEVENLABS_API_KEY;
    else process.env.EVOLINK_ELEVENLABS_API_KEY = original;
  }
});
