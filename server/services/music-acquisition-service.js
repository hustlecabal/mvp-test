// music-acquisition-service.js
//
// PHASE 3B — MUSIC ACQUISITION. Mirrors services/media-acquisition-
// service.js's own PATTERN exactly (a flat provider dispatch table,
// credential-gated availability, search -> download -> validate ->
// register -> return a structured result, never a thrown error) applied
// to a new, separate domain: MUSIC. This file NEVER imports, calls, or
// modifies anything in services/media-acquisition-service.js,
// schemas/media-acquisition-schema.js, or services/media-acquisition/ —
// Phase 3B's own scope boundary forbids any change to the existing,
// audited visual stock-media architecture. Copying the pattern here is
// not touching it.
//
// RAW AUDIO ONLY (Phase 3B's own non-negotiable boundary): this file
// obtains and registers source audio bytes. It never applies gain, fades,
// ducking, normalization, or any other processing — those belong entirely
// to a future mixing layer (Phase 3D).
//
// NO AUTOMATIC PROVIDER FALLBACK (same explicit rule the visual stock-
// media path already established, "rule #10" — see media-acquisition-
// service.js's own header): this file never selects a provider on the
// caller's behalf and never retries a different provider after a
// failure. A caller that wants a second provider tried must call this
// again, explicitly, itself — exactly the discipline already proven
// correct for Pexels/Pixabay (see the Phase 3 provider-architecture
// audit's own findings).
//
// PHASE 3C — one real provider now exists: services/music/ai33-music-
// provider.js. It genuinely reuses this codebase's existing, verified
// AI33 credential/base-URL infrastructure, but its real, live behavior
// today is a structured UNAVAILABLE — the real AI33 Pro API has no
// confirmed Music generation endpoint at any tested path (see that
// file's own header for the exact discovery evidence). This is an
// honest reflection of the real API's current capability, never a
// fabricated contract. Adding a second real provider later means adding
// one new module under services/music/ and one new entry in
// MUSIC_PROVIDER_MODULES below — never touching anything else in this
// file, the same "single dispatch table" objective media-acquisition-
// service.js's own header already established.

const crypto = require('crypto');
const fs = require('fs');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const fixtureMusicProvider = require('./music/fixture-music-provider');
const ai33MusicProvider = require('./music/ai33-music-provider');
const { createMusicAcquisitionResult, createMusicAcquisitionDiagnostic } = require('../schemas/music-acquisition-schema');
const { createAudioEvent } = require('../schemas/audio-schema');

const MUSIC_PROVIDER_MODULES = {
  fixture: fixtureMusicProvider,
  ai33: ai33MusicProvider,
};

// Real providers only — 'fixture' is deliberately excluded (it never
// requires a credential and must never appear as "available" to a real
// production run; see fixture-music-provider.js's own header). "ai33"
// IS included: it has a real credential-gated adapter, exactly the same
// "available means credentialed, not necessarily functionally complete"
// meaning services/media-acquisition-service.js's own
// listAvailableProviders() already establishes for the visual providers
// — a credentialed-but-currently-UNAVAILABLE provider is reported the
// same way a credentialed-but-broken one would be; acquireMusic()'s own
// search() call still surfaces the real, honest UNAVAILABLE diagnostic.
function listAvailableMusicProviders() {
  const REAL_PROVIDERS = ['ai33'];
  return REAL_PROVIDERS.filter((name) => {
    const providerModule = MUSIC_PROVIDER_MODULES[name];
    return providerModule && providerModule.credential();
  });
}

function fail(request, status, code, message) {
  return createMusicAcquisitionResult({
    status,
    projectId: request ? request.projectId : null,
    beatId: request ? request.beatId : null,
    sceneId: request ? request.sceneId : null,
    provider: request ? request.provider : null,
    searchQuery: request ? request.searchQuery : null,
    diagnostics: [createMusicAcquisitionDiagnostic({ code, message })],
  });
}

// Public entry point.
//   request — schemas/music-acquisition-schema.js createMusicAcquisitionRequest()
//   options.fetchImpl — injectable, passed straight through to the
//     provider's search() (when it accepts one) and to
//     services/asset-storage.js's downloadAsset() — the same convention
//     every other real-provider adapter in this codebase already uses.
async function acquireMusic(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return fail(request, 'PROVIDER_FAILED', 'INVALID_REQUEST', 'searchQuery is required');
  }

  const providerModule = MUSIC_PROVIDER_MODULES[request.provider];
  if (!providerModule) {
    return fail(request, 'UNSUPPORTED_PROVIDER', 'UNSUPPORTED_PROVIDER', `provider "${request.provider}" is not a recognized Music provider`);
  }

  if (!providerModule.credential()) {
    return fail(request, 'MISSING_CREDENTIAL', 'MISSING_CREDENTIAL', `provider "${request.provider}" has no credential configured in this environment`);
  }

  // --- search ---
  let searchResult;
  try {
    searchResult = await providerModule.search(request);
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

  // Deterministic selection — always the provider's own top-ranked
  // result, never randomized, never re-ranked by this file.
  const candidate = searchResult.candidates[0];
  if (typeof candidate.downloadUrl !== 'string' || candidate.downloadUrl.length === 0) {
    return fail(request, 'PROVIDER_FAILED', 'MALFORMED_CANDIDATE', `provider "${request.provider}" returned a candidate with no downloadUrl`);
  }

  // --- download (existing, generic, format-agnostic asset-storage.js function — never a Music-specific storage path) ---
  const assetId = crypto.randomUUID();
  let downloaded;
  try {
    downloaded = await assetStorage.downloadAsset(candidate.downloadUrl, assetId, { fetchImpl });
  } catch (error) {
    return fail(request, 'PROVIDER_FAILED', error.code || 'DOWNLOAD_FAILED', error.message || 'download failed');
  }

  // --- validate: real signature check via the EXISTING asset-storage.js
  // sniffer — never a new/duplicated audio-format detector. A candidate
  // that downloads successfully but is not real, recognizable audio
  // (e.g. an HTML error page returned with a 200) is REJECTED_INVALID,
  // never silently registered as though it were valid. ---
  let buffer;
  try {
    buffer = fs.readFileSync(downloaded.path);
  } catch (error) {
    return fail(request, 'PROVIDER_FAILED', 'DOWNLOAD_UNREADABLE', `downloaded file could not be read: ${error.message}`);
  }
  const format = assetStorage.sniffAudioFormat(buffer);
  if (!format) {
    if (!downloaded.alreadyExisted) fs.rmSync(downloaded.path, { force: true });
    return createMusicAcquisitionResult({
      status: 'REJECTED_INVALID',
      projectId: request.projectId,
      beatId: request.beatId,
      sceneId: request.sceneId,
      provider: request.provider,
      providerAssetId: candidate.providerAssetId,
      sourceUrl: candidate.sourceUrl,
      downloadUrl: candidate.downloadUrl,
      searchQuery: request.searchQuery,
      diagnostics: [createMusicAcquisitionDiagnostic({ code: 'UNRECOGNIZED_AUDIO_FORMAT', message: 'downloaded file is not a recognized audio format (WAV or MP3)' })],
    });
  }

  const checksum = `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;

  // --- register the Asset (existing model only — schemas/production-
  // schema.js's Asset, type 'audio', the exact same type services/voice-
  // generation-service.js's real NARRATION audio already uses; stored
  // through the EXISTING services/asset-storage.js; never a second
  // asset-management system) ---
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

  return createMusicAcquisitionResult({
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

// PHASE 3A INTEGRATION — the one, small, pure mapping this stage's own
// acceptance criteria require: a successful MusicAcquisitionResult
// becomes an ordinary schemas/audio-schema.js AudioEvent, type: MUSIC.
// Uses the EXISTING AudioEvent shape verbatim — no MusicEvent schema, no
// second audio-event model.
//
// `duration` is deliberately left ABSENT (null) here, NOT set to the raw
// source clip's own durationSeconds (that value is preserved separately —
// see result.durationSeconds itself, still available to any future
// mixing/looping decision). Setting AudioEvent.duration would be an
// explicit Tier-1 override in timeline-compiler-service.js's own
// precedence, silently defeating Phase 3A's whole-timeline/scene-span
// inference (the entire point of a MUSIC bed with no beatId/sceneId, or
// with only a sceneId) — a music bed's PLAYBACK length is a placement
// decision belonging to the caller/compiler, never something acquisition
// (which only knows the SOURCE file's own raw length) should silently
// impose. A caller that genuinely wants playback capped to the raw
// source length (no scene/timeline span, no future looping) passes
// `{ duration: result.durationSeconds }` in `overrides` explicitly.
// startTime/beatId/sceneId are likewise the caller's decision, consistent
// with Phase 3A's own span-representation rule (schemas/audio-schema.js's
// header) — this function only carries through whatever the result/
// caller already specified, it never decides where in the video the
// music belongs.
function createMusicAudioEvent(result, overrides = {}) {
  if (!result || result.status !== 'ACQUIRED') {
    throw new Error('createMusicAudioEvent requires an ACQUIRED MusicAcquisitionResult');
  }
  return createAudioEvent({
    type: 'MUSIC',
    status: 'READY',
    sourceAssetId: result.assetId,
    duration: null,
    beatId: result.beatId || null,
    sceneId: result.sceneId || null,
    ...overrides,
  });
}

module.exports = {
  MUSIC_PROVIDER_MODULES,
  listAvailableMusicProviders,
  acquireMusic,
  createMusicAudioEvent,
};
