// sfx-acquisition-service.js
//
// PHASE 3E — SFX ACQUISITION. Mirrors services/music-acquisition-
// service.js field-for-field and logic-for-logic (the Phase 3E audit's
// own §6/§2 conclusion: SFX acquisition mechanics are identical to
// MUSIC's — search a provider, obtain bytes via a URL or directly,
// register the same generic Asset). This file NEVER imports or modifies
// services/music-acquisition-service.js, schemas/music-acquisition-
// schema.js, or services/music/ — a separate, parallel domain, exactly
// like Phase 3B/3C kept MUSIC separate from the existing visual stock-
// media architecture.
//
// NOT ROUTED THROUGH MaterialResolution/MaterialExecution (Phase 3E's own
// explicit instruction, and the audit's own §7 conclusion): those models
// are VISUAL-material-specific (MATERIAL_SOURCES/VISUAL_TREATMENTS/
// EXECUTOR_TYPES are all visual enums) — SFX remains a separate, simpler
// audio acquisition path, exactly like MUSIC.
//
// RAW AUDIO ONLY: this file obtains and registers source audio bytes. It
// never applies gain, fades, ducking, normalization — those belong
// entirely to services/audio-mixer-service.js.
//
// NO AUTOMATIC PROVIDER FALLBACK: same explicit rule every acquisition
// path in this codebase already follows.

const crypto = require('crypto');
const fs = require('fs');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const fixtureSfxProvider = require('./sfx/fixture-sfx-provider');
const elevenlabsSfxProvider = require('./sfx/elevenlabs-sfx-provider');
const { createSfxAcquisitionResult, createSfxAcquisitionDiagnostic } = require('../schemas/sfx-acquisition-schema');
const { createAudioEvent } = require('../schemas/audio-schema');

const SFX_PROVIDER_MODULES = {
  fixture: fixtureSfxProvider,
  elevenlabs: elevenlabsSfxProvider,
};

// Real providers only — 'fixture' is deliberately excluded, mirroring
// music-acquisition-service.js's own listAvailableMusicProviders()
// exactly.
function listAvailableSfxProviders() {
  const REAL_PROVIDERS = ['elevenlabs'];
  return REAL_PROVIDERS.filter((name) => {
    const providerModule = SFX_PROVIDER_MODULES[name];
    return providerModule && providerModule.credential();
  });
}

function fail(request, status, code, message) {
  return createSfxAcquisitionResult({
    status,
    projectId: request ? request.projectId : null,
    beatId: request ? request.beatId : null,
    sceneId: request ? request.sceneId : null,
    provider: request ? request.provider : null,
    searchQuery: request ? request.searchQuery : null,
    diagnostics: [createSfxAcquisitionDiagnostic({ code, message })],
  });
}

// Public entry point. Identical shape/logic to music-acquisition-
// service.js's own acquireMusic() — see that file's own comments for the
// full reasoning behind each step; not repeated verbatim here to avoid
// drift between two copies of the same prose, only the code.
async function acquireSfx(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return fail(request, 'PROVIDER_FAILED', 'INVALID_REQUEST', 'searchQuery is required');
  }

  const providerModule = SFX_PROVIDER_MODULES[request.provider];
  if (!providerModule) {
    return fail(request, 'UNSUPPORTED_PROVIDER', 'UNSUPPORTED_PROVIDER', `provider "${request.provider}" is not a recognized SFX provider`);
  }

  if (!providerModule.credential()) {
    return fail(request, 'MISSING_CREDENTIAL', 'MISSING_CREDENTIAL', `provider "${request.provider}" has no credential configured in this environment`);
  }

  let searchResult;
  try {
    searchResult = await providerModule.search(request, { fetchImpl });
  } catch (error) {
    return fail(request, 'PROVIDER_FAILED', 'PROVIDER_SEARCH_THREW', `provider "${request.provider}" threw during search: ${error && error.message ? error.message : String(error)}`);
  }
  if (searchResult.status !== 'COMPLETED') {
    const code = searchResult.diagnostics[0] ? searchResult.diagnostics[0].code : 'PROVIDER_SEARCH_FAILED';
    const message = searchResult.diagnostics.map((d) => d.message).join('; ') || `provider "${request.provider}" search did not complete`;
    return fail(request, 'PROVIDER_FAILED', code, message);
  }
  if (!Array.isArray(searchResult.candidates) || searchResult.candidates.length === 0) {
    return fail(request, 'NO_CANDIDATES', 'NO_CANDIDATES', `provider "${request.provider}" returned no candidates for query "${request.searchQuery}"`);
  }

  const candidate = searchResult.candidates[0];
  const hasDownloadUrl = typeof candidate.downloadUrl === 'string' && candidate.downloadUrl.length > 0;
  const hasAudioBuffer = Buffer.isBuffer(candidate.audioBuffer) && candidate.audioBuffer.length > 0;
  if (!hasDownloadUrl && !hasAudioBuffer) {
    return fail(request, 'PROVIDER_FAILED', 'MALFORMED_CANDIDATE', `provider "${request.provider}" returned a candidate with neither a downloadUrl nor audio bytes`);
  }

  const assetId = crypto.randomUUID();
  let downloaded;
  if (hasDownloadUrl) {
    try {
      downloaded = await assetStorage.downloadAsset(candidate.downloadUrl, assetId, { fetchImpl });
    } catch (error) {
      return fail(request, 'PROVIDER_FAILED', error.code || 'DOWNLOAD_FAILED', error.message || 'download failed');
    }
  } else {
    try {
      const stored = assetStorage.storeUploadedAudio(candidate.audioBuffer, assetId);
      downloaded = { ...stored, alreadyExisted: false };
    } catch (error) {
      if (error instanceof assetStorage.AssetStorageError && error.code === 'unsupported_format') {
        return createSfxAcquisitionResult({
          status: 'REJECTED_INVALID',
          projectId: request.projectId,
          beatId: request.beatId,
          sceneId: request.sceneId,
          provider: request.provider,
          providerAssetId: candidate.providerAssetId,
          sourceUrl: candidate.sourceUrl,
          searchQuery: request.searchQuery,
          diagnostics: [createSfxAcquisitionDiagnostic({ code: 'UNRECOGNIZED_AUDIO_FORMAT', message: 'provider-returned audio bytes are not a recognized audio format (WAV or MP3)' })],
        });
      }
      return fail(request, 'PROVIDER_FAILED', error.code || 'STORE_FAILED', error.message || 'storing provider-returned audio bytes failed');
    }
  }

  let buffer;
  try {
    buffer = fs.readFileSync(downloaded.path);
  } catch (error) {
    return fail(request, 'PROVIDER_FAILED', 'DOWNLOAD_UNREADABLE', `downloaded file could not be read: ${error.message}`);
  }
  const format = assetStorage.sniffAudioFormat(buffer);
  if (!format) {
    if (!downloaded.alreadyExisted) fs.rmSync(downloaded.path, { force: true });
    return createSfxAcquisitionResult({
      status: 'REJECTED_INVALID',
      projectId: request.projectId,
      beatId: request.beatId,
      sceneId: request.sceneId,
      provider: request.provider,
      providerAssetId: candidate.providerAssetId,
      sourceUrl: candidate.sourceUrl,
      downloadUrl: candidate.downloadUrl,
      searchQuery: request.searchQuery,
      diagnostics: [createSfxAcquisitionDiagnostic({ code: 'UNRECOGNIZED_AUDIO_FORMAT', message: 'downloaded file is not a recognized audio format (WAV or MP3)' })],
    });
  }

  const checksum = `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;

  timelineStore.addAsset(request.projectId, {
    assetId,
    type: 'audio',
    sceneId: request.sceneId || null,
    shotId: request.beatId || null,
    provider: request.provider,
    url: candidate.sourceUrl,
  });
  timelineStore.updateAssetStorage(request.projectId, assetId, {
    status: 'STORED',
    provider: 'local',
    path: downloaded.relativePath,
    contentType: format.contentType,
    sizeBytes: buffer.length,
    archivedAt: new Date().toISOString(),
  });

  return createSfxAcquisitionResult({
    status: 'ACQUIRED',
    projectId: request.projectId,
    beatId: request.beatId,
    sceneId: request.sceneId,
    assetId,
    provider: request.provider,
    providerAssetId: candidate.providerAssetId,
    sourceUrl: candidate.sourceUrl,
    downloadUrl: candidate.downloadUrl,
    durationSeconds: candidate.durationSeconds,
    format: candidate.format,
    attribution: candidate.attribution,
    licenseSummary: candidate.licenseSummary,
    searchQuery: request.searchQuery,
    checksum,
  });
}

// PHASE 3E INTEGRATION — a successful SfxAcquisitionResult becomes an
// ordinary schemas/audio-schema.js AudioEvent, type: SFX. Uses the
// EXISTING AudioEvent shape verbatim — no SfxEvent schema.
//
// `duration` defaults to ABSENT (null), mirroring createMusicAudioEvent()
// exactly: if left null AND beatId is set, the compiler infers the
// event's span as its WHOLE beat's own compiled duration (proven by
// test/timeline-compiler-audio.test.js's own test C) — correct for an SFX
// that should be understood as "somewhere in this beat" but NOT what a
// real one-shot hit normally wants. A caller producing a real one-shot
// SFX should therefore normally pass `{ duration: result.durationSeconds
// }` explicitly (exactly music's own documented convention) — this
// function does not decide that for the caller, matching Phase 3A's own
// "acquisition never imposes a placement decision" rule.
function createSfxAudioEvent(result, overrides = {}) {
  if (!result || result.status !== 'ACQUIRED') {
    throw new Error('createSfxAudioEvent requires an ACQUIRED SfxAcquisitionResult');
  }
  return createAudioEvent({
    type: 'SFX',
    status: 'READY',
    sourceAssetId: result.assetId,
    duration: null,
    beatId: result.beatId || null,
    sceneId: result.sceneId || null,
    ...overrides,
  });
}

module.exports = {
  SFX_PROVIDER_MODULES,
  listAvailableSfxProviders,
  acquireSfx,
  createSfxAudioEvent,
};
