// Tests for services/approval-gate.js directly. This module works purely
// on plain JS objects in memory, so no server or temp folder is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../services/approval-gate');

function newProject() {
  // A stripped-down stand-in for a real project — just enough shape for
  // the gate to work with, matching what project-store.js would give us.
  return { id: 'test-project', approvals: {}, creditLedger: {} };
}

test('a fresh project cannot proceed (nothing approved yet)', () => {
  const project = newProject();
  const result = gate.canProceed(project);
  assert.equal(result.allowed, false);
});

test('requestApproval moves status to PENDING and records details', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: 50, note: 'first storyboard pass' });

  assert.equal(project.approvals.status, 'PENDING');
  assert.equal(project.approvals.estimatedCost, 50);
  assert.equal(project.approvals.note, 'first storyboard pass');
  assert.ok(project.approvals.requestedAt);
});

test('a PENDING project still cannot proceed', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: 10 });
  assert.equal(gate.canProceed(project).allowed, false);
});

test('decideApproval(approve: true) moves status to APPROVED', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: 10 });
  const updated = gate.decideApproval(project, { approve: true, decidedBy: 'Opeyemi' });

  assert.ok(updated);
  assert.equal(project.approvals.status, 'APPROVED');
  assert.equal(project.approvals.decidedBy, 'Opeyemi');
  assert.ok(project.approvals.decidedAt);
});

test('decideApproval(approve: false) moves status to REJECTED', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: false });

  assert.equal(project.approvals.status, 'REJECTED');
});

test('decideApproval returns null when there is nothing pending', () => {
  const project = newProject(); // status is NONE, never requested
  assert.equal(gate.decideApproval(project, { approve: true }), null);
});

test('an APPROVED project with no budget limit can proceed', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });

  assert.equal(gate.canProceed(project).allowed, true);
});

test('an APPROVED project within its budget can proceed', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 40 });
  gate.decideApproval(project, { approve: true });

  assert.equal(gate.canProceed(project).allowed, true);
});

test('an APPROVED project that would exceed its budget cannot proceed', () => {
  const project = newProject();
  gate.setBudget(project, 20);
  gate.requestApproval(project, { estimatedCost: 40 });
  gate.decideApproval(project, { approve: true });

  const result = gate.canProceed(project);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /budget/i);
});

test('a REJECTED project cannot proceed', () => {
  const project = newProject();
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: false });

  assert.equal(gate.canProceed(project).allowed, false);
});
