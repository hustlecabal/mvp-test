// evolink-reference-resolver.js
//
// Stage 17 — the ONLY place that turns an approved, locally-archived
// reference asset into an EvoLink-hosted URL usable in a real image
// generation's `image_urls` field. Sits between services/asset-storage.js
// + services/timeline-store.js (Stores) and
// providers/evolink/evolink-client.js's uploadBase64File (Provider) — an
// orchestration role, per docs/architecture/control-surfaces.md's Services
// layer definition (Services = business logic, orchestrating between
// Stores and Providers; neither a Store nor a Provider should know about
// the other directly).
//
// WHY THIS EXISTS (Stage 17, Part 2): our approved reference assets are
// private local files (services/asset-storage.js) — not publicly
// reachable URLs. EvoLink's image generation `image_urls` field requires a
// directly, publicly accessible URL (verified, docs/integrations/
// evolink-api.md) and does NOT accept inline base64/data-URI image data
// in the generation request itself (verified against
// evolink.ai/docs/en/api-manual/image-series/{nanobanana,gpt-image-2}/...).
// EvoLink DOES document a separate, official file-upload API
// (files-api.evolink.ai/api/v1/files/upload/base64) that accepts base64
// image data and returns an EvoLink-hosted, publicly reachable URL (valid
// 72 hours). This file uses exactly that documented mechanism — never a
// third-party host, never an invented URL, never exposing our own
// filesystem to the internet directly.
//
// Deliberately NOT wired automatically into
// services/keyframe-generation-service.js's generateKeyframe(): uploading
// a reference image to EvoLink is itself a real, live network action, so
// it must always be an explicit, separate step a caller performs BEFORE
// requesting a generation with providerName: 'evolink-image' and
// pre-resolved imageParameters.referenceImageUrls — never a silent side
// effect of calling generateKeyframe.

const fs = require('fs');
const path = require('path');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const evolinkClient = require('../providers/evolink/evolink-client');

// An explicit allowlist (never "pass whatever contentType is on record"
// straight through) — matches the same defensive-allowlist pattern
// asset-storage.js's own sniffImageFormat()/ALLOWED_EXTENSIONS already use.
const SUPPORTED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Resolves ONE reference (by assetId) to an EvoLink-hosted URL. Returns
// { ok: true, assetId, url, expiresAt } or { ok: false, assetId, reason } —
// never throws for an ordinary "can't resolve this one" case, so a caller
// resolving several references can decide per-reference what to do (Stage
// 17, Part 16: "reference URL cannot be safely exposed" is a STOP
// condition for the CALLER to enforce, not something this function hides
// by throwing partway through a batch).
async function resolveReferenceImageUrl(projectId, assetId, { uploadImpl = evolinkClient.uploadBase64File } = {}) {
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) {
    return { ok: false, assetId, reason: `No asset "${assetId}" found in project "${projectId}".` };
  }
  if (asset.approvalStatus !== 'APPROVED') {
    return {
      ok: false,
      assetId,
      reason: `Asset "${assetId}" is not APPROVED (status: ${asset.approvalStatus}) — only an approved reference may be sent to a real provider.`,
    };
  }
  if (!asset.storage || asset.storage.status !== 'STORED' || !asset.storage.path) {
    return {
      ok: false,
      assetId,
      reason: `Asset "${assetId}" is not STORED locally (storage.status: ${asset.storage ? asset.storage.status : 'none'}).`,
    };
  }

  let fullPath;
  try {
    fullPath = assetStorage.resolveStoredPath(asset.storage.path);
  } catch (err) {
    return { ok: false, assetId, reason: `Refused to resolve asset "${assetId}"'s stored path: ${err.message}` };
  }
  if (!fs.existsSync(fullPath)) {
    return { ok: false, assetId, reason: `Asset "${assetId}"'s stored file is missing on disk at the recorded path.` };
  }

  if (!SUPPORTED_CONTENT_TYPES.has(asset.storage.contentType)) {
    return {
      ok: false,
      assetId,
      reason: `Asset "${assetId}" has an unsupported content type for upload: "${asset.storage.contentType}".`,
    };
  }

  const buffer = fs.readFileSync(fullPath);
  const dataUrl = `data:${asset.storage.contentType};base64,${buffer.toString('base64')}`;

  let response;
  try {
    response = await uploadImpl(dataUrl, { fileName: `${assetId}${path.extname(asset.storage.path)}` });
  } catch (err) {
    return { ok: false, assetId, reason: `EvoLink file upload failed: ${err.message}` };
  }

  const fileUrl = response && response.data && response.data.file_url;
  if (!fileUrl) {
    return { ok: false, assetId, reason: 'EvoLink upload response did not include a data.file_url.' };
  }

  return { ok: true, assetId, url: fileUrl, expiresAt: (response.data && response.data.expires_at) || null };
}

// Resolves MULTIPLE references (Stage 16's referenceDetails shape —
// [{assetId, roleType, role}]) in order. Returns { referenceImageUrls,
// unresolved } — referenceImageUrls is exactly the shape
// evolink-image-mapper.js's toEvolinkImageRequest() already expects
// (parameters.referenceImageUrls: [{assetId, url}]); unresolved lists
// every reference that could NOT be resolved, with its reason, so a
// caller can decide whether to proceed, warn, or stop.
async function resolveReferenceImageUrls(projectId, referenceDetails, options = {}) {
  const referenceImageUrls = [];
  const unresolved = [];

  for (const ref of referenceDetails) {
    const result = await resolveReferenceImageUrl(projectId, ref.assetId, options);
    if (result.ok) {
      referenceImageUrls.push({ assetId: result.assetId, url: result.url });
    } else {
      unresolved.push({ assetId: ref.assetId, roleType: ref.roleType, reason: result.reason });
    }
  }

  return { referenceImageUrls, unresolved };
}

module.exports = {
  SUPPORTED_CONTENT_TYPES,
  resolveReferenceImageUrl,
  resolveReferenceImageUrls,
};
