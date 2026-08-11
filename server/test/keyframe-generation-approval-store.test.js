// Tests for services/keyframe-generation-approval-store.js — Stage 13B,
// Part 5's KEYFRAME_GENERATION_APPROVAL, kept entirely separate from
// services/approval-gate.js's project-level approvals.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfga-store-projects-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfga-store-approvals-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const approvalStore = require('../services/keyframe-generation-approval-store');

function newProject(title = 'kfga store test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// --- 5. generation approval ----------------------------------------------------------

test('5. getApproval returns a fresh NONE-status object before any request, never null', () => {
  const project = newProject();
  const approval = approvalStore.getApproval(project.id, 'kf-1');
  assert.equal(approval.status, 'NONE');
  assert.equal(approval.projectId, project.id);
  assert.equal(approval.keyframeId, 'kf-1');
});

test('requestApproval creates a PENDING approval referencing the exact prompt package', () => {
  const project = newProject();
  const approval = approvalStore.requestApproval(project.id, 'kf-1', {
    promptPackageId: 'pkg-1',
    promptPackageVersion: 2,
    estimatedCost: 5,
    reason: 'first attempt',
    requestedBy: 'human',
  });
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.promptPackageId, 'pkg-1');
  assert.equal(approval.promptPackageVersion, 2);
  assert.equal(approval.estimatedCost, 5);
  assert.equal(approval.requestedBy, 'human');
  assert.ok(approval.requestedAt);
});

test('requesting again fully resets a prior decision to a fresh PENDING request', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 1, estimatedCost: 5 });
  approvalStore.decideApproval(project.id, 'kf-1', { approve: true, decidedBy: 'human' });
  assert.equal(approvalStore.getApproval(project.id, 'kf-1').status, 'APPROVED');

  const restarted = approvalStore.requestApproval(project.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 2, estimatedCost: 3 });
  assert.equal(restarted.status, 'PENDING');
  assert.equal(restarted.promptPackageVersion, 2);
  assert.equal(restarted.approvedBy, null, 'a fresh request must not carry over the previous decision');
});

test('decideApproval(approve: true) approves a pending request', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 1, estimatedCost: 5 });
  const approved = approvalStore.decideApproval(project.id, 'kf-1', { approve: true, decidedBy: 'human' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.approvedBy, 'human');
  assert.ok(approved.decidedAt);
});

test('decideApproval(approve: false) rejects a pending request', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 1, estimatedCost: 5 });
  const rejected = approvalStore.decideApproval(project.id, 'kf-1', { approve: false, decidedBy: 'human', reason: 'too risky' });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'too risky');
});

test('decideApproval returns null when there is nothing pending', () => {
  const project = newProject();
  assert.equal(approvalStore.decideApproval(project.id, 'kf-1', { approve: true }), null);
});

test('acknowledgeUnknownCost sets the same UNKNOWN_COST_POLICY fields approval-gate.js uses', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 1 }); // no estimatedCost -> unknown
  const acknowledged = approvalStore.acknowledgeUnknownCost(project.id, 'kf-1', { acknowledgedBy: 'human' });
  assert.equal(acknowledged.unknownCostAcknowledged, true);
  assert.equal(acknowledged.unknownCostAcknowledgedBy, 'human');
  assert.ok(acknowledged.unknownCostAcknowledgedAt);
});

// --- isolation from project.approvals -------------------------------------------------

test('this store never reads or writes project.approvals or project.creditLedger', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  approvalStore.requestApproval(project.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 1, estimatedCost: 5 });
  approvalStore.decideApproval(project.id, 'kf-1', { approve: true });

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.approvals.estimatedCost, 10, 'the keyframe approval must never overwrite the project-level approval');
  assert.equal(reloaded.creditLedger.limit, 100);
});

test('project isolation: keyframe generation approvals never leak between projects', () => {
  const a = newProject('A');
  const b = newProject('B');
  approvalStore.requestApproval(a.id, 'kf-1', { promptPackageId: 'pkg-1', promptPackageVersion: 1, estimatedCost: 5 });
  assert.equal(approvalStore.getApproval(b.id, 'kf-1').status, 'NONE');
});

// --- safety: no forbidden imports -----------------------------------------------------

test('services/keyframe-generation-approval-store.js has no require() of any provider or generation-service module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-generation-approval-store.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service/i.test(req), `unexpected import: ${req}`);
  }
});
