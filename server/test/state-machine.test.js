// Tests for schemas/state-machine.js, using real projects created through
// the actual project store (so this tests the real thing, not a stand-in).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-state-machine-test-'));
process.env.PROJECT_DATA_DIR = tempDir;

const store = require('../services/project-store');
const gate = require('../services/approval-gate');
const stateMachine = require('../schemas/state-machine');

// Walks a project step by step along the normal forward path, up to (and
// including) targetState. Fails loudly if any step along the way is
// unexpectedly rejected, since that would mean the "normal path" itself is
// broken and every test built on top of it would be unreliable.
const FORWARD_PATH = [
  'RESEARCH',
  'CREATIVE_REVIEW',
  'SCRIPTING',
  'SCRIPT_REVIEW',
  'VISUAL_DEVELOPMENT',
  'VISUAL_REVIEW',
  'STORYBOARD',
  'GENERATION_REVIEW',
  'CALIBRATION',
  'KEYFRAME_GENERATION',
  'KEYFRAME_REVIEW',
  'MOTION_GENERATION',
  'FINAL_REVIEW',
  'COMPLETE',
];

function walkTo(project, targetState) {
  for (const state of FORWARD_PATH) {
    const result = stateMachine.transition(project, state);
    assert.equal(result.ok, true, `expected to reach ${state}, got: ${result.reason}`);
    if (state === targetState) return;
  }
  throw new Error(`${targetState} is not on the forward path`);
}

test('state machine defines all 15 required production states', () => {
  assert.equal(stateMachine.STATES.length, 15);
  assert.deepEqual(stateMachine.STATES, [
    'PLANNING',
    'RESEARCH',
    'CREATIVE_REVIEW',
    'SCRIPTING',
    'SCRIPT_REVIEW',
    'VISUAL_DEVELOPMENT',
    'VISUAL_REVIEW',
    'STORYBOARD',
    'GENERATION_REVIEW',
    'CALIBRATION',
    'KEYFRAME_GENERATION',
    'KEYFRAME_REVIEW',
    'MOTION_GENERATION',
    'FINAL_REVIEW',
    'COMPLETE',
  ]);
});

test('1. a new project has the correct initial production state', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  assert.equal(project.status, 'PLANNING');
});

test('2. a project can move from one valid state to another', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  const result = stateMachine.transition(project, 'RESEARCH');

  assert.equal(result.ok, true);
  assert.equal(project.status, 'RESEARCH');
});

test('3. an invalid state transition is rejected', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  // PLANNING cannot jump straight to SCRIPTING
  const result = stateMachine.transition(project, 'SCRIPTING');

  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.equal(project.status, 'PLANNING', 'status must be unchanged after a rejected transition');
});

test('an unknown state name is rejected outright', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  const result = stateMachine.transition(project, 'NOT_A_REAL_STATE');

  assert.equal(result.ok, false);
  assert.equal(project.status, 'PLANNING');
});

test('4. generation cannot begin without approval', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  walkTo(project, 'GENERATION_REVIEW');

  const result = stateMachine.transition(project, 'CALIBRATION');

  assert.equal(result.ok, false);
  assert.match(result.reason, /gate/i);
  assert.equal(project.status, 'GENERATION_REVIEW', 'status must be unchanged after a blocked transition');
});

test('5. generation cannot begin when the budget gate rejects it', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, 10);
  gate.requestApproval(project, { estimatedCost: 999 });
  gate.decideApproval(project, { approve: true }); // approved, but way over budget

  walkTo(project, 'GENERATION_REVIEW');
  const result = stateMachine.transition(project, 'CALIBRATION');

  assert.equal(result.ok, false);
  assert.match(result.reason, /budget/i);
  assert.equal(project.status, 'GENERATION_REVIEW');
});

test('6. approved and budget-valid generation can enter the appropriate generation state', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });

  walkTo(project, 'GENERATION_REVIEW');
  const result = stateMachine.transition(project, 'CALIBRATION');

  assert.equal(result.ok, true);
  assert.equal(project.status, 'CALIBRATION');
});

test('a full walk from PLANNING all the way to COMPLETE succeeds with one approval', () => {
  const project = store.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 50 });
  gate.decideApproval(project, { approve: true });

  walkTo(project, 'COMPLETE');
  assert.equal(project.status, 'COMPLETE');
});

test('COMPLETE is terminal — nothing can transition out of it', () => {
  assert.deepEqual(stateMachine.TRANSITIONS.COMPLETE, []);
});

test('canTransition and isGenerationState work as plain lookups', () => {
  assert.equal(stateMachine.canTransition('PLANNING', 'RESEARCH'), true);
  assert.equal(stateMachine.canTransition('PLANNING', 'COMPLETE'), false);
  assert.equal(stateMachine.canTransition('PLANNING', 'NOT_REAL'), false);

  assert.equal(stateMachine.isGenerationState('KEYFRAME_GENERATION'), true);
  assert.equal(stateMachine.isGenerationState('STORYBOARD'), false);
});
