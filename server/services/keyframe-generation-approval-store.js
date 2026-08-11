// keyframe-generation-approval-store.js
//
// Stage 13B, Part 5 — persists one KeyframeGenerationApproval per
// keyframe (schemas/keyframe-generation-approval-schema.js). One JSON
// file per project — `{ projectId, approvals: { [keyframeId]: approval } }`
// — same "one file per project id" convention as
// services/creative-store.js / services/keyframe-store.js.
//
// Deliberately separate from services/approval-gate.js's project-level
// `approvals` object: requesting/deciding a keyframe generation approval
// here NEVER reads or writes project.approvals, project.creditLedger, or
// any other project field. services/keyframe-generation-service.js is the
// only place that reads BOTH this store and the project's shared credit
// ledger together, to check budget.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const { createKeyframeGenerationApproval } = require('../schemas/keyframe-generation-approval-schema');

const KEYFRAME_GENERATION_APPROVAL_DATA_DIR = process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR
  ? path.resolve(process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'keyframe-generation-approvals');

fs.mkdirSync(KEYFRAME_GENERATION_APPROVAL_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(KEYFRAME_GENERATION_APPROVAL_DATA_DIR, `${projectId}.json`);
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

// Returns the keyframe's current approval object, or a fresh (status
// 'NONE') one if none has ever been requested — never null for a real
// project, so callers never have to null-check before reading `.status`.
function getApproval(projectId, keyframeId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.approvals[keyframeId] || createKeyframeGenerationApproval({ projectId, keyframeId });
}

// Starts (or restarts) the approval process for one keyframe generation.
// Mirrors approval-gate.js's requestApproval(): a full reset to a fresh
// PENDING record, same as requesting project-level approval again resets
// any prior decision.
function requestApproval(projectId, keyframeId, { promptPackageId, promptPackageVersion, estimatedCost, reason, requestedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = createKeyframeGenerationApproval({
    projectId,
    keyframeId,
    promptPackageId: promptPackageId || null,
    promptPackageVersion: promptPackageVersion != null ? promptPackageVersion : null,
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
// nobody requested).
function decideApproval(projectId, keyframeId, { approve, decidedBy, reason } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[keyframeId];
  if (!approval || approval.status !== 'PENDING') return null;

  approval.status = approve ? 'APPROVED' : 'REJECTED';
  approval.decidedAt = new Date().toISOString();
  approval.approvedBy = approve ? decidedBy || null : approval.approvedBy;
  if (reason) approval.reason = reason;

  record.approvals[keyframeId] = approval;
  saveRecord(record);
  return approval;
}

// Part 6 — same UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL policy as
// approval-gate.js's acknowledgeUnknownCost(), scoped to this keyframe's
// approval object instead of the project's.
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

// Stage 14, Part 13 — bulk read for the operator queue engine (and any
// future caller that needs every keyframe's approval for a project at
// once). Returns a plain object keyed by keyframeId, backed by exactly
// ONE file read regardless of how many keyframes the project has —
// calling getApproval() once per keyframe in a loop would instead re-open
// this same file N times. No new business rule: this is the same
// record.approvals map getApproval() already reads from, just returned
// whole instead of narrowed to one keyframe.
function listApprovals(projectId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.approvals;
}

module.exports = {
  KEYFRAME_GENERATION_APPROVAL_DATA_DIR,
  getApproval,
  requestApproval,
  decideApproval,
  acknowledgeUnknownCost,
  listApprovals,
};
