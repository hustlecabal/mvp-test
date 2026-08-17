// Tests for services/pre-production-gate-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgstore-projects-'));
process.env.PRE_PRODUCTION_GATE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgstore-'));

const projectStore = require('../services/project-store');
const gateStore = require('../services/pre-production-gate-store');
const { createPreProductionGateResult } = require('../schemas/pre-production-gate-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addGateResult fails for a non-existent project', () => {
  const result = gateStore.addGateResult('00000000-0000-4000-8000-000000000000', createPreProductionGateResult());
  assert.equal(result.ok, false);
});

test('2. addGateResult stores a result and getGateResult retrieves it by id', () => {
  const project = newProject();
  const gateResult = createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1', machineAssessment: 'PROCEED' });
  const saved = gateStore.addGateResult(project.id, gateResult);
  assert.equal(saved.ok, true);
  assert.equal(gateStore.getGateResult(project.id, saved.gateResult.id).machineAssessment, 'PROCEED');
});

test('3. addGateResult stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const gateResult = createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1', machineAssessment: 'PROCEED' });
  gateStore.addGateResult(project.id, gateResult);
  gateResult.machineAssessment = 'CORRUPTED';
  assert.equal(gateStore.listGateResults(project.id)[0].machineAssessment, 'PROCEED');
});

test('4. listGateResults returns null for a non-existent project, [] for one with none yet', () => {
  assert.equal(gateStore.listGateResults('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(gateStore.listGateResults(project.id), []);
});

test('5. listGateResults filters by blueprintId when given', () => {
  const project = newProject();
  gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1' }));
  gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b2' }));
  assert.equal(gateStore.listGateResults(project.id, { blueprintId: 'b1' }).length, 1);
  assert.equal(gateStore.listGateResults(project.id).length, 2);
});

test('6. re-running the gate against the same blueprint APPENDS a new result rather than overwriting the prior one (audit-trail requirement)', () => {
  const project = newProject();
  gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1', createdAt: '2020-01-01T00:00:00.000Z' }));
  gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1', createdAt: '2021-01-01T00:00:00.000Z' }));
  assert.equal(gateStore.listGateResults(project.id, { blueprintId: 'b1' }).length, 2);
});

test('7. getLatestGateResultForBlueprint returns the most recently created result for that blueprint only', () => {
  const project = newProject();
  gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1', createdAt: '2020-01-01T00:00:00.000Z' }));
  const second = gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1', createdAt: '2021-01-01T00:00:00.000Z' }));
  gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b2', createdAt: '2022-01-01T00:00:00.000Z' }));
  assert.equal(gateStore.getLatestGateResultForBlueprint(project.id, 'b1').id, second.gateResult.id);
});

test('8. recordHumanDecision updates ONLY humanDecision/humanDecidedBy/humanDecidedAt/humanRationale, never machineAssessment/blockers/warnings', () => {
  const project = newProject();
  const gateResult = createPreProductionGateResult({
    projectId: project.id,
    blueprintId: 'b1',
    machineAssessment: 'REJECT',
    blockers: [{ code: 'CONTRADICTORY_STRUCTURE', message: 'bad', category: 'STRUCTURAL_FEASIBILITY' }],
  });
  const saved = gateStore.addGateResult(project.id, gateResult);
  const updated = gateStore.recordHumanDecision(project.id, saved.gateResult.id, { humanDecision: 'OVERRIDE', humanDecidedBy: 'human1', humanRationale: 'accepting the risk' });
  assert.equal(updated.humanDecision, 'OVERRIDE');
  assert.equal(updated.humanDecidedBy, 'human1');
  assert.equal(updated.humanRationale, 'accepting the risk');
  assert.equal(updated.machineAssessment, 'REJECT');
  assert.equal(updated.blockers.length, 1);
  assert.equal(updated.blockers[0].code, 'CONTRADICTORY_STRUCTURE');
});

test('9. recordHumanDecision returns null for a non-existent project or gate result', () => {
  const project = newProject();
  const saved = gateStore.addGateResult(project.id, createPreProductionGateResult({ projectId: project.id, blueprintId: 'b1' }));
  assert.equal(gateStore.recordHumanDecision('00000000-0000-4000-8000-000000000000', saved.gateResult.id, { humanDecision: 'ACCEPT' }), null);
  assert.equal(gateStore.recordHumanDecision(project.id, '11111111-1111-4111-8111-111111111111', { humanDecision: 'ACCEPT' }), null);
});

test('10. two different projects never see each other\'s gate results', () => {
  const projectA = newProject();
  const projectB = newProject();
  gateStore.addGateResult(projectA.id, createPreProductionGateResult({ projectId: projectA.id, blueprintId: 'b1' }));
  assert.deepEqual(gateStore.listGateResults(projectB.id), []);
});
