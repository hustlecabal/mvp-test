// Tests for services/video-generation-approval-store.js — Stage 22B-Part-3's
// VIDEO_GENERATION_APPROVAL, kept entirely separate from
// services/approval-gate.js's project-level approvals AND from services/
// keyframe-generation-approval-store.js's own per-keyframe IMAGE approval.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vga-store-projects-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vga-store-approvals-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;

const projectStore = require('../services/project-store');
const approvalStore = require('../services/video-generation-approval-store');

function newProject(title = 'vga store test') {
  return projectStore.createProject({ title, topic: 'x' });
}

const baseFields = {
  sceneId: 'scene-1',
  shotId: 'shot-1',
  videoPromptPackageId: 'vpkg-1',
  videoPromptPackageVersion: 1,
  canonicalKeyframeAssetId: 'asset-1',
  provider: 'evolink',
  model: 'seedance-2.0-mini-image-to-video',
  executionParameters: { duration: 5 },
};

test('getApproval returns a fresh NONE-status object before any request, never null', () => {
  const project = newProject();
  const approval = approvalStore.getApproval(project.id, 'kf-1');
  assert.equal(approval.status, 'NONE');
  assert.equal(approval.projectId, project.id);
  assert.equal(approval.keyframeId, 'kf-1');
});

test('requestApproval creates a PENDING approval binding to the exact package/canonical-asset/provider/model', () => {
  const project = newProject();
  const approval = approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5, reason: 'first attempt', requestedBy: 'human' });
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.videoPromptPackageId, 'vpkg-1');
  assert.equal(approval.videoPromptPackageVersion, 1);
  assert.equal(approval.canonicalKeyframeAssetId, 'asset-1');
  assert.equal(approval.provider, 'evolink');
  assert.equal(approval.model, 'seedance-2.0-mini-image-to-video');
  assert.deepEqual(approval.executionParameters, { duration: 5 });
  assert.equal(approval.estimatedCost, 5);
  assert.equal(approval.requestedBy, 'human');
  assert.ok(approval.requestedAt);
});

test('requesting again fully resets a prior decision to a fresh PENDING request', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  approvalStore.decideApproval(project.id, 'kf-1', { approve: true, decidedBy: 'human' });
  assert.equal(approvalStore.getApproval(project.id, 'kf-1').status, 'APPROVED');

  const restarted = approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, videoPromptPackageVersion: 2, estimatedCost: 3 });
  assert.equal(restarted.status, 'PENDING');
  assert.equal(restarted.videoPromptPackageVersion, 2);
  assert.equal(restarted.approvedBy, null, 'a fresh request must not carry over the previous decision');
  assert.equal(restarted.approvedAt, null, 'a fresh request must not carry over the previous decision');
});

test('decideApproval(approve: true) approves a pending request and DOES set approvedAt', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  const approved = approvalStore.decideApproval(project.id, 'kf-1', { approve: true, decidedBy: 'human' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.approvedBy, 'human');
  assert.ok(approved.decidedAt);
  // Deliberately DIFFERENT from keyframe-generation-approval-store.js's
  // known quirk (approvedAt stays null forever there) — see this store's
  // schema-file header comment for why this store does not repeat it.
  assert.ok(approved.approvedAt, 'this store must set approvedAt on approval, unlike the known keyframe-approval-store quirk');
  assert.equal(approved.approvedAt, approved.decidedAt);
});

test('decideApproval(approve: false) rejects a pending request and does NOT set approvedAt', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  const rejected = approvalStore.decideApproval(project.id, 'kf-1', { approve: false, decidedBy: 'human', reason: 'too risky' });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'too risky');
  assert.equal(rejected.approvedAt, null);
});

test('decideApproval returns null when there is nothing pending', () => {
  const project = newProject();
  assert.equal(approvalStore.decideApproval(project.id, 'kf-1', { approve: true }), null);
});

test('decideApproval returns null for an already-decided approval (no re-deciding)', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  approvalStore.decideApproval(project.id, 'kf-1', { approve: true, decidedBy: 'human' });
  assert.equal(approvalStore.decideApproval(project.id, 'kf-1', { approve: false, decidedBy: 'human2' }), null);
});

test('acknowledgeUnknownCost records the acknowledgement', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: null });
  const acked = approvalStore.acknowledgeUnknownCost(project.id, 'kf-1', { acknowledgedBy: 'human' });
  assert.equal(acked.unknownCostAcknowledged, true);
  assert.equal(acked.unknownCostAcknowledgedBy, 'human');
  assert.ok(acked.unknownCostAcknowledgedAt);
});

test('listApprovals returns every keyframe approval for a project, keyed by keyframeId', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  approvalStore.requestApproval(project.id, 'kf-2', { ...baseFields, videoPromptPackageId: 'vpkg-2', estimatedCost: 3 });
  const all = approvalStore.listApprovals(project.id);
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all['kf-1'].videoPromptPackageId, 'vpkg-1');
  assert.equal(all['kf-2'].videoPromptPackageId, 'vpkg-2');
});

test('approvals for different keyframes in the same project are fully independent', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  approvalStore.decideApproval(project.id, 'kf-1', { approve: true, decidedBy: 'human' });

  assert.equal(approvalStore.getApproval(project.id, 'kf-2').status, 'NONE');
  assert.equal(approvalStore.getApproval(project.id, 'kf-1').status, 'APPROVED');
});

test('approvals are isolated per project', () => {
  const projectA = newProject('A');
  const projectB = newProject('B');
  approvalStore.requestApproval(projectA.id, 'kf-1', { ...baseFields, estimatedCost: 5 });
  assert.equal(approvalStore.getApproval(projectB.id, 'kf-1').status, 'NONE');
});
