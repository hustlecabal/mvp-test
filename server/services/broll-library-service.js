// broll-library-service.js
//
// Stage 26.5B, Part 3 — the B-roll library: registers a BRollSegment record
// (schemas/broll-schema.js) against an EXISTING, already-stored video
// Asset, and provides deterministic lookup/listing/archival on top of it.
// One JSON file per project id, following the exact convention every other
// store in this codebase already uses (services/keyframe-store.js,
// services/keyframe-handoff-service.js): { projectId, segments: [] }.
//
// THIS FILE NEVER DOWNLOADS, FETCHES, OR CALLS A PROVIDER. It has no path
// to services/asset-storage.js's download functions, no path to any
// provider client, and no path to services/approval-gate.js or any credit
// ledger. The only thing it ever writes to disk is its own small JSON
// index of B-roll metadata records — it never creates a second copy of a
// video's bytes, and it never mutates the Asset record it references
// (services/timeline-store.js's getAsset/addAsset/updateAssetStorage are
// used read-only here, exactly once each, only to VALIDATE the referenced
// asset at registration time).
//
// It also never decides anything for Material Resolution: it does not
// rank, score, or select a B-roll segment for a beat, and it does not
// infer or upgrade a licensing status the caller didn't explicitly supply.
// It only produces clean, validated records for a LATER integration stage
// to consume (see getBrollCandidatesForResolution below) — Material
// Resolution remains the sole decision-maker, exactly as it already is for
// every other material source.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const timelineStore = require('./timeline-store');
const { createBrollSegment, LICENSING_STATUSES, SOURCE_TYPES, BROLL_STATUSES } = require('../schemas/broll-schema');

const BROLL_DATA_DIR = process.env.BROLL_DATA_DIR
  ? path.resolve(process.env.BROLL_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'broll');

fs.mkdirSync(BROLL_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(BROLL_DATA_DIR, `${projectId}.json`);
}

function loadLibrary(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveLibrary(library) {
  fs.writeFileSync(fileFor(library.projectId), JSON.stringify(library, null, 2));
}

// Same "create an empty record the first time it's touched, but only if
// the project itself exists" rule as keyframeStore.ensurePlan /
// keyframeHandoffService.ensureRecord.
function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, segments: [] };
    saveLibrary(library);
  }
  return library;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
//
// Validates, in order: the project exists; assetId was supplied; the
// referenced Asset exists in THIS project; the Asset's type is 'video'
// (never a still image or any other asset type); the Asset's storage
// status is 'STORED' (its bytes must already be safely on disk — never a
// pending/failed/not-yet-archived asset); source.type and licensing.status
// were both explicitly supplied and are recognized values. Nothing here is
// ever inferred or defaulted — a caller that omits licensing gets a
// structured rejection, never a silent UNKNOWN.
//
// Duplicate protection: if a segment already exists for this exact
// (projectId, assetId) pair, the EXISTING record is returned unchanged
// (alreadyExisted: true) — mirrors services/asset-storage.js's
// downloadAsset never re-downloading/overwriting an existing file for an
// assetId. No second segment, and no second binary, is ever created.
function registerBrollSegment(projectId, overrides = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, reason: `No project found with id "${projectId}"` };

  const { assetId, source, media, descriptiveMetadata, licensing, usage } = overrides;

  if (!assetId) return { ok: false, reason: 'assetId is required' };

  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) return { ok: false, reason: `No asset found with id "${assetId}" in project "${projectId}"` };

  if (asset.type !== 'video') {
    return { ok: false, reason: `Asset "${assetId}" has type "${asset.type}", but a B-roll segment can only reference a "video" asset.` };
  }

  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return { ok: false, reason: `Asset "${assetId}" storage status is "${storageStatus}", not "STORED". A B-roll segment can only reference an asset whose bytes are already stored.` };
  }

  if (!source || !source.type) {
    return { ok: false, reason: 'source.type is required' };
  }
  if (!SOURCE_TYPES.includes(source.type)) {
    return { ok: false, reason: `source.type "${source.type}" is not a recognized source type (${SOURCE_TYPES.join(', ')})` };
  }

  if (!licensing || !licensing.status) {
    return { ok: false, reason: 'licensing.status is required — licensing is never inferred or defaulted' };
  }
  if (!LICENSING_STATUSES.includes(licensing.status)) {
    return { ok: false, reason: `licensing.status "${licensing.status}" is not a recognized licensing status (${LICENSING_STATUSES.join(', ')})` };
  }

  const library = ensureLibrary(projectId);

  const existing = library.segments.find((s) => s.assetId === assetId);
  if (existing) {
    return { ok: true, segment: existing, alreadyExisted: true };
  }

  const segment = createBrollSegment({ projectId, assetId, source, media, descriptiveMetadata, licensing, usage });
  library.segments.push(segment);
  saveLibrary(library);

  return { ok: true, segment, alreadyExisted: false };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function getBrollSegment(projectId, segmentId) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  return library.segments.find((s) => s.id === segmentId) || null;
}

// Same simple array-filter approach as timelineStore.listAssets /
// keyframeStore.listKeyframes.
function listBrollSegments(projectId, { status, licensingStatus, sourceType, assetId } = {}) {
  const library = ensureLibrary(projectId);
  if (!library) return null;

  let segments = library.segments;
  if (status) segments = segments.filter((s) => s.status === status);
  if (licensingStatus) segments = segments.filter((s) => s.licensing.status === licensingStatus);
  if (sourceType) segments = segments.filter((s) => s.source.type === sourceType);
  if (assetId) segments = segments.filter((s) => s.assetId === assetId);
  return segments;
}

// REST-style lookup without already knowing the project — same pattern as
// timelineStore.findAssetById / keyframeStore.findKeyframeById.
function findBrollSegmentById(segmentId) {
  for (const project of projectStore.listProjects()) {
    const library = loadLibrary(project.id);
    if (!library) continue;
    const segment = library.segments.find((s) => s.id === segmentId);
    if (segment) return { project, segment };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------
//
// Archives the B-ROLL RECORD only — never touches the underlying Asset
// (its storage.status, approvalStatus, and every other field are left
// completely alone). An archived segment simply stops being returned by
// getBrollCandidatesForResolution() below; it is never deleted, so its
// history is always reconstructable.
function archiveBrollSegment(projectId, segmentId, { archivedBy, reason } = {}) {
  const library = ensureLibrary(projectId);
  if (!library) return null;

  const index = library.segments.findIndex((s) => s.id === segmentId);
  if (index === -1) return null;

  if (library.segments[index].status === 'ARCHIVED') {
    return { ok: false, reason: 'This B-roll segment is already archived.' };
  }

  library.segments[index] = {
    ...library.segments[index],
    status: 'ARCHIVED',
    archivedAt: new Date().toISOString(),
    archivedBy: archivedBy || null,
    archiveReason: reason || null,
  };
  saveLibrary(library);

  return { ok: true, segment: library.segments[index] };
}

// ---------------------------------------------------------------------------
// Material Resolution consumption point
// ---------------------------------------------------------------------------
//
// Validates one segment's fitness to be OFFERED as a candidate — exists,
// belongs to this project, and is ACTIVE (not archived). This performs no
// eligibility/licensing decision of its own (that is Material Resolution's
// job, exactly as the existing context.brollSegments mechanism in
// services/material-resolution-service.js already keeps that decision
// there) — it only guards against handing a stale/archived/nonexistent
// record to a resolver at all.
function resolveBrollSegmentForMaterialResolution(projectId, segmentId) {
  const segment = getBrollSegment(projectId, segmentId);
  if (!segment) return { ok: false, reason: `No B-roll segment found with id "${segmentId}" in project "${projectId}"` };
  if (segment.status !== 'ACTIVE') {
    return { ok: false, reason: `B-roll segment "${segmentId}" has status "${segment.status}", not "ACTIVE", and cannot be offered as a candidate.` };
  }
  return { ok: true, segment };
}

// The clean, validated candidate set a future Material Resolution
// integration stage can consume (e.g. to populate
// context.brollSegments) — every ACTIVE segment for this project, licensing
// status preserved exactly as registered. This function makes NO
// eligibility decision (UNKNOWN/RESTRICTED/REJECTED segments are included
// here too, exactly as registered) — filtering by licensing outcome is
// Material Resolution's job, not this library's.
function getBrollCandidatesForResolution(projectId) {
  return listBrollSegments(projectId, { status: 'ACTIVE' });
}

module.exports = {
  BROLL_DATA_DIR,
  LICENSING_STATUSES,
  SOURCE_TYPES,
  BROLL_STATUSES,
  registerBrollSegment,
  getBrollSegment,
  listBrollSegments,
  findBrollSegmentById,
  archiveBrollSegment,
  resolveBrollSegmentForMaterialResolution,
  getBrollCandidatesForResolution,
};
