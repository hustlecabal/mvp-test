// video-generation-approval-store.js
//
// Stage 22B-Part-3 — persists one VideoGenerationApproval per keyframe
// (schemas/video-generation-approval-schema.js), exactly mirroring
// services/keyframe-generation-approval-store.js's file layout and
// request/decide lifecycle: one JSON file per project —
// `{ projectId, approvals: { [keyframeId]: approval } }`.
//
// Deliberately separate from services/approval-gate.js's project-level
// `approvals` object AND from services/keyframe-generation-approval-
// store.js's own per-keyframe IMAGE approval — approving either of those
// is NOT sufficient authorization to generate a video.
// services/video-generation-service.js is the only place that reads both
// this store and the project's shared credit ledger together to check
// budget.
//
// UNLIKE keyframe-generation-approval-store.js: decideApproval() below
// DOES set `approvedAt` on approval (see the schema file's header comment
// for why this store does not repeat that known quirk).

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const { createVideoGenerationApproval } = require('../schemas/video-generation-approval-schema');

const VIDEO_GENERATION_APPROVAL_DATA_DIR = process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR
  ? path.resolve(process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'video-generation-approvals');

fs.mkdirSync(VIDEO_GENERATION_APPROVAL_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(VIDEO_GENERATION_APPROVAL_DATA_DIR, `${projectId}.json`);
}

function loadRecord(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveRecord(record) {
  fs.writeFileSync(fileFor(record.projectId), JSON.stringify(record, null, 2));
}

function ensureRecord(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let record = loadRecord(projectId);
  if (!record) {
    record = { projectId, approvals: {} };
    saveRecord(record);
  }
  return record;
}

// Returns the keyframe's current video generation approval, or a fresh
// (status 'NONE') one if none has ever been requested — never null for a
// real project, so callers never have to null-check before reading
// `.status`.
function getApproval(projectId, keyframeId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.approvals[keyframeId] || createVideoGenerationApproval({ projectId, keyframeId });
}

// Starts (or restarts) the approval process for one keyframe's video
// generation. A full reset to a fresh PENDING record — same convention as
// keyframe-generation-approval-store.js's requestApproval() and
// approval-gate.js's requestApproval(): requesting again always discards
// any prior decision rather than layering on top of it.
function requestApproval(
  projectId,
  keyframeId,
  {
    sceneId,
    shotId,
    videoPromptPackageId,
    videoPromptPackageVersion,
    canonicalKeyframeAssetId,
    provider,
    model,
    executionParameters,
    estimatedCost,
    reason,
    requestedBy,
  } = {}
) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = createVideoGenerationApproval({
    projectId,
    keyframeId,
    sceneId: sceneId || null,
    shotId: shotId || null,
    videoPromptPackageId: videoPromptPackageId || null,
    videoPromptPackageVersion: videoPromptPackageVersion != null ? videoPromptPackageVersion : null,
    canonicalKeyframeAssetId: canonicalKeyframeAssetId || null,
    provider: provider || null,
    model: model || null,
    executionParameters: executionParameters || null,
    status: 'PENDING',
    estimatedCost: estimatedCost != null ? estimatedCost : null,
    reason: reason || null,
    requestedBy: requestedBy || null,
    requestedAt: new Date().toISOString(),
  });

  record.approvals[keyframeId] = approval;
  saveRecord(record);
  return approval;
}

// Approves or rejects the current PENDING approval. Returns null if there
// is nothing pending to decide (never invents a decision on an approval
// nobody requested) — same "no-op, not an error" convention as
// keyframe-generation-approval-store.js's decideApproval().
function decideApproval(projectId, keyframeId, { approve, decidedBy, reason } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[keyframeId];
  if (!approval || approval.status !== 'PENDING') return null;

  const decidedAt = new Date().toISOString();
  approval.status = approve ? 'APPROVED' : 'REJECTED';
  approval.decidedAt = decidedAt;
  approval.approvedBy = approve ? decidedBy || null : approval.approvedBy;
  approval.approvedAt = approve ? decidedAt : approval.approvedAt;
  if (reason) approval.reason = reason;

  record.approvals[keyframeId] = approval;
  saveRecord(record);
  return approval;
}

// Same UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL policy as approval-gate.js's
// acknowledgeUnknownCost() and keyframe-generation-approval-store.js's own
// version, scoped to this keyframe's video generation approval.
function acknowledgeUnknownCost(projectId, keyframeId, { acknowledgedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[keyframeId];
  if (!approval) return null;

  approval.unknownCostAcknowledged = true;
  approval.unknownCostAcknowledgedBy = acknowledgedBy || null;
  approval.unknownCostAcknowledgedAt = new Date().toISOString();

  record.approvals[keyframeId] = approval;
  saveRecord(record);
  return approval;
}

// Bulk read for the operator queue engine and video-generation-service's
// duplicate/eligibility checks across many keyframes at once — mirrors
// keyframe-generation-approval-store.js's listApprovals() exactly (Part
// 26: one file read regardless of keyframe count). Returns a plain object
// keyed by keyframeId.
function listApprovals(projectId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.approvals;
}

module.exports = {
  VIDEO_GENERATION_APPROVAL_DATA_DIR,
  getApproval,
  requestApproval,
  decideApproval,
  acknowledgeUnknownCost,
  listApprovals,
};
