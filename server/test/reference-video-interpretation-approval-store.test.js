// Tests for services/reference-video-interpretation-approval-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rviapproval-projects-'));
process.env.INTERPRETATION_APPROVAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rviapproval-'));

const projectStore = require('../services/project-store');
const approvalStore = require('../services/reference-video-interpretation-approval-store');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. getApproval returns a fresh NONE-status approval before anything is requested', () => {
  const project = newProject();
  const approval = approvalStore.getApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION');
  assert.equal(approval.status, 'NONE');
});

test('2. requestApproval creates a PENDING approval with the given estimated cost', () => {
  const project = newProject();
  const approval = approvalStore.requestApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { estimatedCost: 0.02, requestedBy: 'tester' });
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.estimatedCost, 0.02);
  assert.equal(approval.requestedBy, 'tester');
});

test('3. decideApproval approves a pending request', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { estimatedCost: 0.02 });
  const decided = approvalStore.decideApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { approve: true, decidedBy: 'tester' });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.approvedBy, 'tester');
});

test('4. decideApproval rejects a pending request when approve: false', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { estimatedCost: 0.02 });
  const decided = approvalStore.decideApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { approve: false, decidedBy: 'tester' });
  assert.equal(decided.status, 'REJECTED');
});

test('5. decideApproval returns null when there is nothing PENDING to decide', () => {
  const project = newProject();
  assert.equal(approvalStore.decideApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { approve: true }), null);
});

test('6. approvals are scoped independently per (referenceVideoId, questionId) pair', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { estimatedCost: 0.01 });
  approvalStore.decideApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { approve: true, decidedBy: 'x' });
  const otherQuestion = approvalStore.getApproval(project.id, 'rv1', 'OPENING_STRUCTURAL_PURPOSE');
  const otherVideo = approvalStore.getApproval(project.id, 'rv2', 'PACING_PATTERN_EXPLANATION');
  assert.equal(otherQuestion.status, 'NONE');
  assert.equal(otherVideo.status, 'NONE');
});

test('7. acknowledgeUnknownCost marks the flag and records who acknowledged it', () => {
  const project = newProject();
  approvalStore.requestApproval(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', {});
  const acknowledged = approvalStore.acknowledgeUnknownCost(project.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { acknowledgedBy: 'human1' });
  assert.equal(acknowledged.unknownCostAcknowledged, true);
  assert.equal(acknowledged.unknownCostAcknowledgedBy, 'human1');
});

test('8. two different projects never see each other\'s interpretation approvals', () => {
  const projectA = newProject();
  const projectB = newProject();
  approvalStore.requestApproval(projectA.id, 'rv1', 'PACING_PATTERN_EXPLANATION', { estimatedCost: 0.01 });
  const inB = approvalStore.getApproval(projectB.id, 'rv1', 'PACING_PATTERN_EXPLANATION');
  assert.equal(inB.status, 'NONE');
});
