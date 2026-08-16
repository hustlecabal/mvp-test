// reference-video-interpretation-approval-store.js
//
// INT-1D — persists one InterpretationApproval per (referenceVideoId,
// questionId) pair (schemas/reference-video-interpretation-approval-
// schema.js). Mirrors services/keyframe-generation-approval-store.js's
// exact convention: one JSON file per project id, `{ projectId, approvals:
// { [key]: approval } }`, keyed here by `${referenceVideoId}:${questionId}`.
//
// Deliberately separate from services/approval-gate.js's project-level
// `approvals` object — see the schema file's own header. services/
// reference-video-interpretation-service.js is the only place that reads
// BOTH this store and the project's shared credit ledger together.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const { createInterpretationApproval } = require('../schemas/reference-video-interpretation-approval-schema');

const INTERPRETATION_APPROVAL_DATA_DIR = process.env.INTERPRETATION_APPROVAL_DATA_DIR
  ? path.resolve(process.env.INTERPRETATION_APPROVAL_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'reference-video-interpretation-approvals');

fs.mkdirSync(INTERPRETATION_APPROVAL_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(INTERPRETATION_APPROVAL_DATA_DIR, `${projectId}.json`);
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

function key(referenceVideoId, questionId) {
  return `${referenceVideoId}:${questionId}`;
}

function getApproval(projectId, referenceVideoId, questionId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.approvals[key(referenceVideoId, questionId)] || createInterpretationApproval({ projectId, referenceVideoId, questionId });
}

function requestApproval(projectId, referenceVideoId, questionId, { estimatedCost, reason, requestedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = createInterpretationApproval({
    projectId,
    referenceVideoId,
    questionId,
    status: 'PENDING',
    estimatedCost: estimatedCost != null ? estimatedCost : null,
    reason: reason || null,
    requestedBy: requestedBy || null,
    requestedAt: new Date().toISOString(),
  });

  record.approvals[key(referenceVideoId, questionId)] = approval;
  saveRecord(record);
  return approval;
}

function decideApproval(projectId, referenceVideoId, questionId, { approve, decidedBy, reason } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[key(referenceVideoId, questionId)];
  if (!approval || approval.status !== 'PENDING') return null;

  approval.status = approve ? 'APPROVED' : 'REJECTED';
  approval.decidedAt = new Date().toISOString();
  approval.approvedBy = approve ? decidedBy || null : approval.approvedBy;
  if (reason) approval.reason = reason;

  record.approvals[key(referenceVideoId, questionId)] = approval;
  saveRecord(record);
  return approval;
}

function acknowledgeUnknownCost(projectId, referenceVideoId, questionId, { acknowledgedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[key(referenceVideoId, questionId)];
  if (!approval) return null;

  approval.unknownCostAcknowledged = true;
  approval.unknownCostAcknowledgedBy = acknowledgedBy || null;
  approval.unknownCostAcknowledgedAt = new Date().toISOString();

  record.approvals[key(referenceVideoId, questionId)] = approval;
  saveRecord(record);
  return approval;
}

module.exports = {
  INTERPRETATION_APPROVAL_DATA_DIR,
  getApproval,
  requestApproval,
  decideApproval,
  acknowledgeUnknownCost,
};
