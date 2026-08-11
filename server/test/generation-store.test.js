// Tests for services/generation-store.js — plain CRUD on generation job
// files, the same pattern as project-store.js. Uses a fresh temporary
// folder, never server/data/generation-jobs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-generation-store-test-'));
process.env.GENERATION_JOBS_DATA_DIR = tempDir;

const store = require('../services/generation-store');

test('1. createGenerationJob fills in id, defaults, and persists to disk', () => {
  const job = store.createGenerationJob({
    projectId: 'proj-1',
    shotId: 'shot-1',
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'A lighthouse at dusk',
  });

  assert.ok(job.id);
  assert.equal(job.status, 'REQUESTED');
  assert.equal(job.providerTaskId, null);
  assert.equal(job.estimatedCost, null);
  assert.equal(job.reservedCost, null);
  assert.equal(job.actualCost, null);
  assert.deepEqual(job.result, null);
  assert.equal(job.assetId, null);

  const filePath = path.join(tempDir, `${job.id}.json`);
  assert.ok(fs.existsSync(filePath), 'job file should exist on disk');
});

test('2. getGenerationJob retrieves a job by id', () => {
  const created = store.createGenerationJob({ projectId: 'proj-2', shotId: 'shot-2', provider: 'evolink' });
  const fetched = store.getGenerationJob(created.id);
  assert.deepEqual(fetched, created);
});

test('getGenerationJob returns null for an unknown id', () => {
  assert.equal(store.getGenerationJob('00000000-0000-0000-0000-000000000000'), null);
});

test('getGenerationJob refuses a path-traversal id instead of following it', () => {
  assert.equal(store.getGenerationJob('../../etc/passwd'), null);
});

test('3. updateGenerationJob changes allowed fields without touching identity fields', () => {
  const created = store.createGenerationJob({
    projectId: 'proj-3',
    shotId: 'shot-3',
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    prompt: 'original prompt',
  });

  const updated = store.updateGenerationJob(created.id, {
    status: 'SUBMITTED',
    providerTaskId: 'task-unified-123',
    progress: 10,
    prompt: 'a different prompt entirely', // not in UPDATABLE_FIELDS -- must be ignored
  });

  assert.equal(updated.status, 'SUBMITTED');
  assert.equal(updated.providerTaskId, 'task-unified-123');
  assert.equal(updated.progress, 10);
  assert.equal(updated.prompt, 'original prompt', 'prompt is an identity field and must not change');
});

test('updateGenerationJob returns null for an unknown job', () => {
  assert.equal(store.updateGenerationJob('00000000-0000-0000-0000-000000000000', { status: 'FAILED' }), null);
});

test('4. listGenerationJobs returns jobs, optionally filtered by project/shot/status', () => {
  store.createGenerationJob({ projectId: 'proj-list', shotId: 'shot-a', provider: 'evolink', status: 'REQUESTED' });
  const jobB = store.createGenerationJob({
    projectId: 'proj-list',
    shotId: 'shot-b',
    provider: 'evolink',
    status: 'COMPLETED',
  });
  store.createGenerationJob({ projectId: 'other-project', shotId: 'shot-c', provider: 'evolink' });

  const forProject = store.listGenerationJobs({ projectId: 'proj-list' });
  assert.equal(forProject.length, 2);

  const forShot = store.listGenerationJobs({ projectId: 'proj-list', shotId: 'shot-b' });
  assert.equal(forShot.length, 1);
  assert.equal(forShot[0].id, jobB.id);

  const completedOnly = store.listGenerationJobs({ projectId: 'proj-list', status: 'COMPLETED' });
  assert.equal(completedOnly.length, 1);
  assert.equal(completedOnly[0].id, jobB.id);
});
