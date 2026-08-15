// Tests for services/material-executors/still-image-motion-executor.js —
// deterministic Ken-Burns-family camera-motion instructions, never AI video
// generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-sim-executor-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const executor = require('../services/material-executors/still-image-motion-executor');

function buildProjectWithAsset() {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.png` });
  return { project, asset };
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, duration: 5, visualTreatment: 'STILL_IMAGE', ...overrides });
}

function candidate(assetId, overrides = {}) {
  return createCandidateResult({ candidate: 'x', selectedAssetId: assetId, ...overrides });
}

// --- C — STILL_IMAGE_MOTION ------------------------------------------------------------

test('C1. every documented motion kind produces a COMPLETED result with a distinct, correct transform', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();

  for (const motionKind of executor.STILL_IMAGE_MOTION_KINDS) {
    const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { motionKind } });
    assert.equal(result.status, 'COMPLETED', `${motionKind} should complete`);
    assert.equal(result.renderSpec.motionKind, motionKind);
    assert.deepEqual(
      { startScale: result.renderSpec.startScale, endScale: result.renderSpec.endScale, startPosition: result.renderSpec.startPosition, endPosition: result.renderSpec.endPosition },
      executor.MOTION_TRANSFORMS[motionKind]
    );
  }
});

test('C2. deterministic output — identical input produces an identical render spec across repeated calls', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();
  const options = { motionKind: 'KEN_BURNS', fadeIn: 0.5 };

  const first = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options });
  const second = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options });

  assert.deepEqual(first.renderSpec, second.renderSpec);
});

test('C3. an invalid duration fails structurally', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { duration: -2 } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_DURATION');
});

test('C4. an invalid transform (malformed manual override) fails structurally, never silently falls back', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { transform: { startScale: 'not-a-number' } } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_TRANSFORM');
});

test('C4b. an invalid motionKind fails structurally', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { motionKind: 'SPIN_360' } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_MOTION_KIND');
});

test('C5. a beat resolved to STILL_IMAGE via GENERATED_NEW (no concrete asset yet) fails with NO_SOURCE_IMAGE — AI image generation is out of scope', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat();
  const generatedCandidate = createCandidateResult({ candidate: 'GENERATED_NEW+STILL_IMAGE', materialSource: 'GENERATED_NEW', visualTreatment: 'STILL_IMAGE', selectedAssetId: null });

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: generatedCandidate });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'NO_SOURCE_IMAGE');
});

test('C6. a REJECTED source asset fails with ASSET_REJECTED', () => {
  const { project, asset } = buildProjectWithAsset();
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_REJECTED');
});

test('C7. the source asset is never mutated by execution', () => {
  const { project, asset } = buildProjectWithAsset();
  const b = beat();
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));

  for (const motionKind of executor.STILL_IMAGE_MOTION_KINDS) {
    executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(asset.assetId), options: { motionKind } });
  }

  assert.equal(JSON.stringify(timelineStore.getAsset(project.id, asset.assetId)), before);
});
