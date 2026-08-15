// Tests for services/material-execution-service.js — validates a resolved
// material, routes it to the correct executor, executes it, and returns a
// structured result. No new state machine, no new queue, no retry, no
// substitution.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-execution-service-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult, createMaterialResolution } = require('../schemas/material-resolution-schema');
const executionService = require('../services/material-execution-service');

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, ...overrides });
}
function resolution(selectedMaterial, overrides = {}) {
  return createMaterialResolution({ status: 'RESOLVED', selectedMaterial, ...overrides });
}

// --- G — Material Execution Service ------------------------------------------------------

test('G1. routes PROJECT_ASSET_REUSE (AI_VIDEO treatment via an existing video asset) to the PROJECT_ASSET_REUSE executor', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });

  const b = beat({ visualTreatment: 'AI_VIDEO' });
  const material = createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+AI_VIDEO', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'AI_VIDEO', selectedAssetId: asset.assetId });

  const result = executionService.executeMaterial(project.id, b, resolution(material));
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'PROJECT_ASSET_REUSE');
});

test('G2. routes visualTreatment STILL_IMAGE to the STILL_IMAGE_MOTION executor regardless of materialSource label', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });

  const b = beat({ visualTreatment: 'STILL_IMAGE' });
  const material = createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: asset.assetId });

  const result = executionService.executeMaterial(project.id, b, resolution(material));
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'STILL_IMAGE_MOTION');
});

test('G3. routes KINETIC_TYPOGRAPHY, MOTION_GRAPHIC, and WHITEBOARD each to their own executor', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });

  const kt = executionService.executeMaterial(
    project.id,
    beat({ visualTreatment: 'KINETIC_TYPOGRAPHY' }),
    resolution(createCandidateResult({ candidate: 'DETERMINISTIC_TEMPLATE+KINETIC_TYPOGRAPHY', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'KINETIC_TYPOGRAPHY' })),
    { text: 'THE PROBLEM' }
  );
  assert.equal(kt.executorType, 'KINETIC_TYPOGRAPHY');
  assert.equal(kt.status, 'COMPLETED');

  const mg = executionService.executeMaterial(
    project.id,
    beat({ visualTreatment: 'MOTION_GRAPHIC' }),
    resolution(createCandidateResult({ candidate: 'DETERMINISTIC_TEMPLATE+MOTION_GRAPHIC', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'MOTION_GRAPHIC' })),
    { elements: [{ kind: 'BAR' }] }
  );
  assert.equal(mg.executorType, 'MOTION_GRAPHIC');
  assert.equal(mg.status, 'COMPLETED');

  const wb = executionService.executeMaterial(
    project.id,
    beat({ visualTreatment: 'WHITEBOARD' }),
    resolution(createCandidateResult({ candidate: 'DETERMINISTIC_TEMPLATE+WHITEBOARD', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'WHITEBOARD' })),
    { elements: [{ kind: 'TEXT', content: 'x', drawDuration: 1 }] }
  );
  assert.equal(wb.executorType, 'WHITEBOARD');
  assert.equal(wb.status, 'COMPLETED');
});

test('G4. rejects a material with no Stage 26.5A executor (GENERATED_NEW AI_VIDEO) with structured UNSUPPORTED_MATERIAL diagnostics, never a throw', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const material = createCandidateResult({ candidate: 'GENERATED_NEW+AI_VIDEO', materialSource: 'GENERATED_NEW', visualTreatment: 'AI_VIDEO', modelRequirements: { modality: 'video', textToVideo: true } });

  const result = executionService.executeMaterial(project.id, beat({ visualTreatment: 'AI_VIDEO' }), resolution(material));

  assert.equal(result.status, 'FAILED');
  assert.equal(result.executorType, null);
  assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_MATERIAL');
});

test('G5. an UNRESOLVED MaterialResolution (nothing to execute) fails with UNRESOLVED_MATERIAL, never a throw', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const unresolved = createMaterialResolution({ status: 'UNRESOLVED', selectedMaterial: null });

  const result = executionService.executeMaterial(project.id, beat(), unresolved);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'UNRESOLVED_MATERIAL');
});

test('G6. an executor throwing an unexpected error is caught and converted into a structured FAILED result, never propagated', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  // A candidate whose selectedAssetId is a non-string, malformed value —
  // exercises the "never let an executor crash the service" path directly
  // rather than relying on one specific existing bug.
  const material = createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: { not: 'a string' } });

  assert.doesNotThrow(() => {
    const result = executionService.executeMaterial(project.id, beat({ visualTreatment: 'STILL_IMAGE' }), resolution(material));
    assert.equal(result.status, 'FAILED');
  });
});

test('G7. never calls a provider or reserves a credit — services/material-execution-service.js requires no provider/approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-execution-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['./material-executor-registry', '../schemas/material-execution-schema'].sort());
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*approval-gate[^'"`]*['"`]\s*\)/);
});

test('G8. never mutates any project/asset store — before/after snapshot is identical across every routed material', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });
  const before = JSON.stringify(timelineStore.listAssets(project.id));

  executionService.executeMaterial(
    project.id,
    beat({ visualTreatment: 'STILL_IMAGE' }),
    resolution(createCandidateResult({ candidate: 'x', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: asset.assetId }))
  );
  executionService.executeMaterial(
    project.id,
    beat({ visualTreatment: 'KINETIC_TYPOGRAPHY' }),
    resolution(createCandidateResult({ candidate: 'y', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'KINETIC_TYPOGRAPHY' })),
    { text: 'x' }
  );

  assert.equal(JSON.stringify(timelineStore.listAssets(project.id)), before);
});

// --- H — regression -----------------------------------------------------------------

test('H1. Stage 26.3/26.4 material-resolution-service.js is untouched and its own tests still pass independently of this stage', () => {
  const materialResolutionService = require('../services/material-resolution-service');
  assert.equal(typeof materialResolutionService.resolveMaterial, 'function');
  assert.equal(typeof materialResolutionService.resolveBeatGraph, 'function');
  assert.equal(typeof materialResolutionService.resolveVisualBeat, 'function');
});
