// Tests for services/material-executors/project-asset-reuse-executor.js —
// deterministic ASSET_PLACEMENT render specs, never a mutation of the
// source asset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-par-executor-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const executor = require('../services/material-executors/project-asset-reuse-executor');

function buildProjectWithAsset(overrides = {}) {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', ...overrides });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.png` });
  return { project, asset };
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'STILL_IMAGE', ...overrides });
}

function candidate(assetId, overrides = {}) {
  return createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: assetId, ...overrides });
}

// --- B — PROJECT_ASSET_REUSE ---------------------------------------------------------

test('B1. a valid, STORED, non-rejected asset produces a COMPLETED ASSET_PLACEMENT render spec referencing the real assetId', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId) });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'PROJECT_ASSET_REUSE');
  assert.equal(result.beatId, b.id);
  assert.equal(result.renderSpec.type, 'ASSET_PLACEMENT');
  assert.equal(result.renderSpec.assetId, asset.assetId);
  assert.deepEqual(result.sourceAssetIds, [asset.assetId]);
  assert.equal(result.diagnostics.length, 0);
});

test('B2. a missing asset (never created) fails with ASSET_NOT_FOUND', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate('does-not-exist') });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.renderSpec, null);
  assert.equal(result.diagnostics[0].code, 'ASSET_NOT_FOUND');
});

test('B3. a REJECTED asset fails with ASSET_REJECTED', () => {
  const { project, asset } = buildProjectWithAsset();
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId) });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_REJECTED');
});

test('B3b. an asset that was never archived (storage status NOT_ARCHIVED) fails with ASSET_NOT_USABLE', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId) });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_NOT_USABLE');
});

test('B4. deterministic output — identical input produces an identical render spec across repeated calls', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();
  const options = { startTime: 2, duration: 4, position: { x: 0.1, y: 0.2 }, scale: 1.2 };

  const first = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options });
  const second = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options });

  assert.deepEqual(first.renderSpec, second.renderSpec);
});

test('B5. the source asset is never mutated by execution — before/after snapshot is identical', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));

  executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { scale: 2, position: { x: 1, y: 1 } } });
  executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId) });

  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(before, after);
});

test('B6. invalid timing (negative startTime, zero/negative duration) fails structurally', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();

  const negativeStart = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { startTime: -1, duration: 3 } });
  assert.equal(negativeStart.status, 'FAILED');
  assert.equal(negativeStart.diagnostics[0].code, 'INVALID_START_TIME');

  const zeroDuration = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { startTime: 0, duration: 0 } });
  assert.equal(zeroDuration.status, 'FAILED');
  assert.equal(zeroDuration.diagnostics[0].code, 'INVALID_DURATION');
});

test('B7. a missing selectedAssetId fails with MISSING_ASSET_ID rather than throwing', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat();

  assert.doesNotThrow(() => {
    const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(null) });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'MISSING_ASSET_ID');
  });
});

test('B8. no provider/network calls — services/material-executors/project-asset-reuse-executor.js requires only timeline-store and the execution schema', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executors', 'project-asset-reuse-executor.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../timeline-store', '../../schemas/material-execution-schema'].sort());
});
