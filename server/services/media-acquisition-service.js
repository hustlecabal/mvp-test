// media-acquisition-service.js
//
// MEDIA ACQUISITION — the service this stage's own instructions require:
// "Material Resolution decides WHAT kind of material should represent a
// beat. Media Acquisition decides HOW to obtain the requested stock
// material." This file is the boundary that makes that true in code:
//
//   - it is never called from services/material-resolution-service.js
//     (that file stays 100% pure/synchronous — see this file's own
//     "WHY THIS IS NEVER CALLED SYNCHRONOUSLY" section below)
//   - it never makes a creative decision (which treatment, which beat) —
//     every field it acts on (provider, mediaType, searchQuery, ...) is
//     supplied by its caller, never inferred here
//   - it never selects a provider on the caller's behalf and NEVER falls
//     back from one provider to another on failure (this stage's own
//     explicit rule #10 — "do not implement automatic provider
//     fallback"). A caller that wants Pixabay tried after Pexels fails
//     must call this twice, explicitly, itself.
//
// WHY THIS IS NEVER CALLED SYNCHRONOUSLY FROM THE ORCHESTRATOR: services/
// production-orchestrator-service.js's own header documents, verified by
// that stage's own measurement, that its entire pipeline after
// DERIVING_BEATS is deliberately synchronous/blocking (execFileSync
// throughout — real Chrome, real FFmpeg, real espeak-ng/faster-whisper).
// A network fetch is inherently asynchronous in Node; adding one inside
// that synchronous chain would either require rewriting that established
// contract (exactly what services/material-executors/generated-new-
// executor.js's own header says this codebase avoids for GENERATED_NEW)
// or silently block the event loop in a new way that chain was never
// designed for. So Media Acquisition follows GENERATED_NEW's own
// precedent exactly: services/material-executors/stock-media-executor.js
// (synchronous) only ever CHECKS whether a beat's stock media was already
// acquired (a plain store read); acquireMedia() below is what actually
// performs it, run either explicitly (the acquire_stock_media MCP tool)
// or by a caller ahead of a production run — never invoked mid-run.
//
// COST: real, but zero-credit — Pexels/Pixabay are free APIs. This file
// therefore never calls services/approval-gate.js and never touches the
// budget/credit ledger; there is nothing to authorize spend for. It IS
// still a real network call that can fail, so every non-ACQUIRED outcome
// is a structured, diagnosed result (schemas/media-acquisition-schema.js's
// ACQUISITION_STATUSES) — never a thrown error, never a silent retry.

const crypto = require('crypto');
const fs = require('fs');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const mediaAcquisitionStore = require('./media-acquisition-store');
const validator = require('./media-acquisition/media-asset-validator');
const pexelsImageProvider = require('./media-acquisition/pexels-image-provider');
const pexelsVideoProvider = require('./media-acquisition/pexels-video-provider');
const pixabayImageProvider = require('./media-acquisition/pixabay-image-provider');
const pixabayVideoProvider = require('./media-acquisition/pixabay-video-provider');
const fakeStockMediaProvider = require('./media-acquisition/fake-stock-media-provider');
const { createMediaAcquisitionResult, createAcquisitionDiagnostic } = require('../schemas/media-acquisition-schema');

// The single dispatch table every provider name resolves through — adding
// a new provider means adding one entry here and one new module under
// services/media-acquisition/, never touching anything else in this file
// (this stage's own "provider-agnostic... without modifying Material
// Resolution or downstream rendering" objective).
const PROVIDER_MODULES = {
  pexels: { image: pexelsImageProvider, video: pexelsVideoProvider },
  pixabay: { image: pixabayImageProvider, video: pixabayVideoProvider },
  'fake-stock-media': { image: fakeStockMediaProvider, video: fakeStockMediaProvider },
};

// Real providers only — 'fake-stock-media' is deliberately excluded (it
// never requires a credential and must never appear as "available" to a
// real production run; see fake-stock-media-provider.js's own header).
// Consulted by services/production-orchestrator-service.js to build the
// injectable context.stockMediaProviders Material Resolution's own
// candidate-generation block reads — never called from inside
// resolveMaterial() itself.
function listAvailableProviders() {
  const REAL_PROVIDERS = ['pexels', 'pixabay'];
  return REAL_PROVIDERS.filter((name) => {
    const modules = PROVIDER_MODULES[name];
    return (modules.image && modules.image.credential()) || (modules.video && modules.video.credential());
  });
}

function fail(request, status, code, message) {
  return createMediaAcquisitionResult({
    status,
    projectId: request ? request.projectId : null,
    beatId: request ? request.beatId : null,
    sceneId: request ? request.sceneId : null,
    provider: request ? request.provider : null,
    mediaType: request ? request.mediaType : null,
    searchQuery: request ? request.searchQuery : null,
    diagnostics: [createAcquisitionDiagnostic({ code, message })],
  });
}

// Persists the outcome (success or failure) when a real project is given —
// mirrors services/media-acquisition-store.js's own header ("record the
// outcome of every attempt"). Never throws if the project doesn't exist —
// the result is still returned to the caller either way.
function persistIfPossible(request, result) {
  if (request && request.projectId) {
    mediaAcquisitionStore.recordAcquisition(request.projectId, result);
  }
  return result;
}

// Public entry point.
//   request — schemas/media-acquisition-schema.js createMediaAcquisitionRequest()
//   options.fetchImpl — injectable, passed straight through to the
//     provider's search() and to services/asset-storage.js's downloadAsset()
//     (the same convention every other real-provider adapter in this
//     codebase already uses — see services/reference-video/apify-
//     acquisition-provider.js)
async function acquireMedia(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return fail(request, 'PROVIDER_FAILED', 'INVALID_REQUEST', 'searchQuery is required');
  }

  const modules = PROVIDER_MODULES[request.provider];
  const providerModule = modules ? modules[request.mediaType] : null;
  if (!providerModule) {
    return persistIfPossible(
      request,
      fail(request, 'UNSUPPORTED_PROVIDER', 'UNSUPPORTED_PROVIDER', `provider "${request.provider}" with mediaType "${request.mediaType}" is not a recognized, supported combination`)
    );
  }

  if (!providerModule.credential()) {
    return persistIfPossible(
      request,
      fail(request, 'MISSING_CREDENTIAL', 'MISSING_CREDENTIAL', `provider "${request.provider}" has no credential configured in this environment`)
    );
  }

  // --- search ---
  let searchResult;
  try {
    searchResult = await providerModule.search(request, { fetchImpl });
  } catch (error) {
    return persistIfPossible(request, fail(request, 'PROVIDER_FAILED', 'PROVIDER_SEARCH_THREW', `provider "${request.provider}" threw during search: ${error && error.message ? error.message : String(error)}`));
  }
  if (searchResult.status !== 'COMPLETED') {
    const code = searchResult.diagnostics[0] ? searchResult.diagnostics[0].code : 'PROVIDER_SEARCH_FAILED';
    const message = searchResult.diagnostics.map((d) => d.message).join('; ') || `provider "${request.provider}" search did not complete`;
    return persistIfPossible(request, fail(request, 'PROVIDER_FAILED', code, message));
  }
  if (searchResult.candidates.length === 0) {
    return persistIfPossible(request, fail(request, 'NO_CANDIDATES', 'NO_CANDIDATES', `provider "${request.provider}" returned no candidates for query "${request.searchQuery}"`));
  }

  // Deterministic selection — always the provider's own top-ranked result,
  // never randomized, never re-ranked by this file.
  const candidate = searchResult.candidates[0];

  // --- cache check (requirement #7) ---
  const cached = request.projectId ? mediaAcquisitionStore.findByProviderAsset(request.projectId, request.provider, candidate.providerAssetId) : null;
  if (cached && cached.assetId) {
    const asset = timelineStore.getAsset(request.projectId, cached.assetId);
    if (asset && asset.storage && asset.storage.status === 'STORED') {
      return persistIfPossible(request, createMediaAcquisitionResult({ ...cached, id: crypto.randomUUID(), beatId: request.beatId, sceneId: request.sceneId, fromCache: true, acquiredAt: new Date().toISOString() }));
    }
  }

  // --- download ---
  const assetId = crypto.randomUUID();
  let downloaded;
  try {
    downloaded = await assetStorage.downloadAsset(candidate.downloadUrl, assetId, { fetchImpl });
  } catch (error) {
    return persistIfPossible(request, fail(request, 'PROVIDER_FAILED', error.code || 'DOWNLOAD_FAILED', error.message || 'download failed'));
  }

  // --- validate ---
  const validation =
    request.mediaType === 'image'
      ? validator.validateImage(downloaded.path, { minWidth: request.minWidth, minHeight: request.minHeight, candidateWidth: candidate.width, candidateHeight: candidate.height })
      : validator.validateVideo(downloaded.path, { minDurationSeconds: request.minDurationSeconds, maxDurationSeconds: request.maxDurationSeconds, minWidth: request.minWidth, minHeight: request.minHeight });

  if (!validation.ok) {
    // A rejected candidate's bytes are never left behind under a real
    // assetId — they were never registered as an Asset, so nothing else
    // in this codebase could reference them; removing them avoids an
    // orphaned file accumulating in services/asset-storage.js's directory.
    if (!downloaded.alreadyExisted) fs.rmSync(downloaded.path, { force: true });
    return persistIfPossible(
      request,
      createMediaAcquisitionResult({
        status: 'REJECTED_INVALID',
        projectId: request.projectId,
        beatId: request.beatId,
        sceneId: request.sceneId,
        provider: request.provider,
        providerAssetId: candidate.providerAssetId,
        mediaType: request.mediaType,
        sourceUrl: candidate.sourceUrl,
        downloadUrl: candidate.downloadUrl,
        searchQuery: request.searchQuery,
        diagnostics: [createAcquisitionDiagnostic({ code: validation.code, message: validation.message })],
      })
    );
  }

  const checksum = validator.computeChecksum(downloaded.path);

  // --- register the Asset (existing model only — schemas/production-
  // schema.js's Asset, stored through the existing services/asset-
  // storage.js; never a second asset-management system) ---
  timelineStore.addAsset(request.projectId, {
    assetId,
    type: request.mediaType === 'image' ? 'keyframe' : 'video',
    sceneId: request.sceneId || null,
    shotId: request.beatId || null,
    provider: request.provider,
    url: candidate.sourceUrl,
  });
  timelineStore.updateAssetStorage(request.projectId, assetId, {
    status: 'STORED',
    provider: 'local',
    path: downloaded.relativePath,
    contentType: downloaded.contentType || (request.mediaType === 'image' ? `image/${validation.format}` : 'video/mp4'),
    sizeBytes: downloaded.sizeBytes,
    archivedAt: new Date().toISOString(),
  });

  const result = createMediaAcquisitionResult({
    status: 'ACQUIRED',
    projectId: request.projectId,
    beatId: request.beatId,
    sceneId: request.sceneId,
    assetId,
    provider: request.provider,
    providerAssetId: candidate.providerAssetId,
    mediaType: request.mediaType,
    sourceUrl: candidate.sourceUrl,
    downloadUrl: candidate.downloadUrl,
    width: validation.width,
    height: validation.height,
    durationSeconds: validation.durationSeconds || null,
    format: validation.format,
    attribution: candidate.attribution,
    licenseSummary: candidate.licenseSummary,
    searchQuery: request.searchQuery,
    checksum,
    fromCache: false,
  });

  return persistIfPossible(request, result);
}

module.exports = { PROVIDER_MODULES, listAvailableProviders, acquireMedia };
