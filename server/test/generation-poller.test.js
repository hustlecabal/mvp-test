// Tests for services/generation-poller.js — the repeat-until-settled loop
// around generation-service.js's checkGenerationOnce(). All provider
// calls are faked; sleeping is faked too (an instant no-op), so these
// tests run fast despite "polling" several times.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-poller-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-poller-jobs-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-poller-creative-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-poller-blueprints-'));
const gateDataTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-poller-gates-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateDataTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const stateMachine = require('../schemas/state-machine');
const generationService = require('../services/generation-service');
const poller = require('../services/generation-poller');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');

const FORWARD_PATH = [
  'RESEARCH', 'CREATIVE_REVIEW', 'SCRIPTING', 'SCRIPT_REVIEW', 'VISUAL_DEVELOPMENT',
  'VISUAL_REVIEW', 'STORYBOARD', 'GENERATION_REVIEW', 'CALIBRATION', 'KEYFRAME_GENERATION',
];

function walkTo(project, targetState) {
  for (const state of FORWARD_PATH) {
    const result = stateMachine.transition(project, state);
    assert.equal(result.ok, true, `expected to reach ${state}: ${result.reason}`);
    if (state === targetState) return;
  }
}

async function submitReadyJob(providerOverrides = {}) {
  const created = projectStore.createProject({ title: 'Poll test', topic: 'x' });
  const scene = timelineStore.addScene(created.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(created.id, { sceneId: scene.sceneId });

  const project = projectStore.getProject(created.id);
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 100 });
  gate.decideApproval(project, { approve: true });
  walkTo(project, 'KEYFRAME_GENERATION');
  projectStore.touch(project);
  satisfyProductionPrerequisites(created.id);

  const providers = {
    evolink: {
      createGeneration: async () => ({
        generationId: 'task-unified-poll-1',
        status: 'SUBMITTED',
        progress: 0,
        reservedCost: 10,
        results: [],
        error: null,
      }),
      getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 0, results: [], error: null, reservedCost: null }),
      getGenerationResult: async () => ({}),
      ...providerOverrides,
    },
  };

  const result = await generationService.requestGeneration(
    { projectId: created.id, shotId: shot.shotId, provider: 'evolink', model: 'seedance-2.5-text-to-video', task: 'text-to-video', prompt: 'x', parameters: {} },
    { providers }
  );

  return { job: result.job, providers, projectId: created.id };
}

const instantSleep = async () => {};

test('polling stops as soon as the job completes', async () => {
  let callCount = 0;
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => {
      callCount += 1;
      if (callCount < 3) {
        return { status: 'PROCESSING', progress: callCount * 30, results: [], error: null, reservedCost: null };
      }
      return { status: 'COMPLETED', progress: 100, results: ['https://example.com/video.mp4'], error: null, reservedCost: null };
    },
  });

  const result = await poller.pollGenerationJob(job.id, { maxAttempts: 10, sleepImpl: instantSleep, providers });

  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'COMPLETED');
  assert.equal(callCount, 3, 'polling should stop the moment it completes, not keep going');
});

test('17. polling stops and marks TIMED_OUT after maxAttempts while still processing', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 10, results: [], error: null, reservedCost: null }),
  });

  const result = await poller.pollGenerationJob(job.id, { maxAttempts: 3, sleepImpl: instantSleep, providers });

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.job.status, 'TIMED_OUT');
  assert.ok(result.job.timedOutAt);
});

test('a timeout does not mean the provider task failed -- no error is fabricated', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 10, results: [], error: null, reservedCost: null }),
  });

  const result = await poller.pollGenerationJob(job.id, { maxAttempts: 2, sleepImpl: instantSleep, providers });
  assert.equal(result.job.error, null, 'TIMED_OUT must not invent a provider error');
});

test('18. polling never creates a second generation job', async () => {
  const { job, projectId, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 10, results: [], error: null, reservedCost: null }),
  });

  const before = generationStore.listGenerationJobs({ projectId }).length;
  await poller.pollGenerationJob(job.id, { maxAttempts: 5, sleepImpl: instantSleep, providers });
  const after = generationStore.listGenerationJobs({ projectId }).length;

  assert.equal(after, before, 'polling must never create a new job');
});

test('polling an already-finished job is a no-op that does not call the provider', async () => {
  const { job, providers } = await submitReadyJob();
  generationStore.updateGenerationJob(job.id, { status: 'COMPLETED' });

  let called = false;
  const watchedProviders = {
    evolink: { ...providers.evolink, getGenerationStatus: async () => { called = true; return {}; } },
  };

  const result = await poller.pollGenerationJob(job.id, { sleepImpl: instantSleep, providers: watchedProviders });

  assert.equal(result.polled, false);
  assert.equal(called, false);
});

test('polling an unknown job id reports a clear error instead of throwing', async () => {
  const result = await poller.pollGenerationJob('00000000-0000-0000-0000-000000000000', { sleepImpl: instantSleep });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No generation job found/);
});
