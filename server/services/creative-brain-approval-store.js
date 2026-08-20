// creative-brain-approval-store.js
//
// CREATIVE BRAIN — persists one CreativeBrainApproval per (projectId,
// recommendationSetId) pair (schemas/creative-brain-approval-schema.js).
// Mirrors services/reference-video-interpretation-approval-store.js's
// exact convention: one JSON file per project id, `{ projectId, approvals:
// { [recommendationSetId]: approval } }`.
//
// Deliberately separate from services/approval-gate.js's project-level
// `approvals` object — approving a project for image/video generation is
// not authorization to spend on a Creative Brain LLM call.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const { createCreativeBrainApproval } = require('../schemas/creative-brain-approval-schema');

const CREATIVE_BRAIN_APPROVAL_DATA_DIR = process.env.CREATIVE_BRAIN_APPROVAL_DATA_DIR
  ? path.resolve(process.env.CREATIVE_BRAIN_APPROVAL_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'creative-brain-approvals');

fs.mkdirSync(CREATIVE_BRAIN_APPROVAL_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(CREATIVE_BRAIN_APPROVAL_DATA_DIR, `${projectId}.json`);
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

function getApproval(projectId, recommendationSetId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.approvals[recommendationSetId] || createCreativeBrainApproval({ projectId, recommendationSetId });
}

function requestApproval(projectId, recommendationSetId, { estimatedCost, reason, requestedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = createCreativeBrainApproval({
    projectId,
    recommendationSetId,
    status: 'PENDING',
    estimatedCost: estimatedCost != null ? estimatedCost : null,
    reason: reason || null,
    requestedBy: requestedBy || null,
    requestedAt: new Date().toISOString(),
  });

  record.approvals[recommendationSetId] = approval;
  saveRecord(record);
  return approval;
}

function decideApproval(projectId, recommendationSetId, { approve, decidedBy, reason } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[recommendationSetId];
  if (!approval || approval.status !== 'PENDING') return null;

  approval.status = approve ? 'APPROVED' : 'REJECTED';
  approval.decidedAt = new Date().toISOString();
  approval.approvedBy = approve ? decidedBy || null : approval.approvedBy;
  if (reason) approval.reason = reason;

  record.approvals[recommendationSetId] = approval;
  saveRecord(record);
  return approval;
}

function acknowledgeUnknownCost(projectId, recommendationSetId, { acknowledgedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const approval = record.approvals[recommendationSetId];
  if (!approval) return null;

  approval.unknownCostAcknowledged = true;
  approval.unknownCostAcknowledgedBy = acknowledgedBy || null;
  approval.unknownCostAcknowledgedAt = new Date().toISOString();

  record.approvals[recommendationSetId] = approval;
  saveRecord(record);
  return approval;
}

module.exports = {
  CREATIVE_BRAIN_APPROVAL_DATA_DIR,
  getApproval,
  requestApproval,
  decideApproval,
  acknowledgeUnknownCost,
};
