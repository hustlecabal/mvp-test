// Stage 26.5B, Part 5 — the required integration proof:
//
//   real project -> real stored video Asset fixture -> registered B-roll
//   segment -> VisualBeat -> real resolveMaterial() -> winning
//   BROLL_LIBRARY candidate -> executeMaterial() -> BROLL_CLIP execution
//   -> deterministic renderSpec
//
// The resolved candidate is NEVER fabricated here — it comes from the
// actual Stage 26.5B Part 4 resolver, exactly as production code would
// produce it. This is the same discipline
// test/stage-26.5a-five-material-proof.test.js already established for the
// five Stage 26.5A executors.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-exec-proof-projects-'));
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-exec-proof-library-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const brollLibraryService = require('../services/broll-library-service');
const materialResolutionService = require('../services/material-resolution-service');
const executionService = require('../services/material-execution-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.mp4` });
  return timelineStore.getAsset(projectId, asset.assetId);
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'BROLL_CLIP', ...overrides });
}

test('Stage 26.5B Part 5 — full real path: VisualBeat -> resolveMaterial() -> BROLL_LIBRARY winner -> executeMaterial() -> BROLL_CLIP', () => {
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.5B PART 5 DISPOSABLE PROOF', topic: 'broll execution proof' });
  const asset = makeStoredVideoAsset(project.id);
  // TREATMENT_TO_ASSET_TYPES maps BROLL_CLIP -> ['video'] too, so this same
  // video asset would otherwise ALSO survive as an independent
  // PROJECT_ASSET_REUSE candidate for a BROLL_CLIP-treatment beat (see
  // test/broll-material-resolution-integration.test.js's own helper
  // comment for the full explanation). REJECTED is the existing mechanism
  // that excludes it from THAT path without affecting B-roll eligibility
  // (broll-library-service.js never reads approvalStatus) — isolates this
  // proof to the BROLL_LIBRARY path specifically.
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  const assetAfterSetup = timelineStore.getAsset(project.id, asset.assetId); // the baseline for the "unchanged" comparison below

  const registration = brollLibraryService.registerBrollSegment(project.id, {
    assetId: asset.assetId,
    source: { type: 'LOCAL_UPLOAD', originalReference: 'city-street.mp4' },
    licensing: { status: 'LICENSED' },
    descriptiveMetadata: { tags: ['city', 'street'], mood: 'busy' },
  });
  assert.equal(registration.ok, true);

  const b = beat();

  // --- Material Resolution: the REAL Stage 26.5B Part 4 resolver, never fabricated ---
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED', 'the real resolver must genuinely resolve this beat');
  assert.equal(resolution.selectedMaterial.materialSource, 'BROLL_LIBRARY');
  assert.equal(resolution.selectedMaterial.visualTreatment, 'BROLL_CLIP');
  assert.equal(resolution.selectedMaterial.selectedAssetId, asset.assetId);
  assert.equal(resolution.selectedMaterial.brollSegment.segmentId, registration.segment.id);

  // --- Material Execution: the REAL Stage 26.5A/26.5B Part 5 service, routed through the registry ---
  const execution = executionService.executeMaterial(project.id, b, resolution);

  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'BROLL_CLIP');
  assert.equal(execution.beatId, b.id);
  assert.equal(execution.materialId, resolution.selectedMaterial.candidate);
  assert.deepEqual(execution.sourceAssetIds, [asset.assetId]);
  assert.equal(execution.diagnostics.length, 0);

  const spec = execution.renderSpec;
  assert.equal(spec.type, 'BROLL_CLIP');
  assert.equal(spec.sourceAssetId, asset.assetId);
  assert.equal(spec.brollSegmentId, registration.segment.id);
  assert.equal(spec.trimIn, 0);
  assert.equal(spec.playbackRate, 1);
  assert.equal(spec.fit, 'COVER');
  assert.equal(spec.audioPolicy, 'MUTE');

  // --- reversing B-roll registration order does not change the result ---
  const projectB = projectStore.createProject({ title: 'REVERSED ORDER', topic: 'x' });
  const assetsB = [makeStoredVideoAsset(projectB.id), makeStoredVideoAsset(projectB.id)];
  for (const a of [...assetsB].reverse()) {
    timelineStore.setAssetApprovalStatus(projectB.id, a.assetId, 'REJECTED'); // isolate PROJECT_ASSET_REUSE, see broll-material-resolution-integration.test.js's own helper for why
    const r = brollLibraryService.registerBrollSegment(projectB.id, { assetId: a.assetId, source: { type: 'LOCAL_UPLOAD' }, licensing: { status: 'LICENSED' } });
    assert.equal(r.ok, true);
  }
  const resolutionB = materialResolutionService.resolveMaterial(projectB.id, beat(), {});
  const executionB = executionService.executeMaterial(projectB.id, beat(), resolutionB);
  assert.equal(executionB.status, 'COMPLETED');
  assert.equal(executionB.executorType, 'BROLL_CLIP');

  // Forward-order equivalent, to compare structural shape (not identical
  // ids — different project/segments — but the SAME deterministic shape
  // and decision process).
  const projectA2 = projectStore.createProject({ title: 'FORWARD ORDER', topic: 'x' });
  const assetsA2 = [makeStoredVideoAsset(projectA2.id), makeStoredVideoAsset(projectA2.id)];
  for (const a of assetsA2) {
    timelineStore.setAssetApprovalStatus(projectA2.id, a.assetId, 'REJECTED');
    const r = brollLibraryService.registerBrollSegment(projectA2.id, { assetId: a.assetId, source: { type: 'LOCAL_UPLOAD' }, licensing: { status: 'LICENSED' } });
    assert.equal(r.ok, true);
  }
  const resolutionA2 = materialResolutionService.resolveMaterial(projectA2.id, beat(), {});
  const executionA2 = executionService.executeMaterial(projectA2.id, beat(), resolutionA2);
  assert.equal(executionA2.status, executionB.status);
  assert.equal(executionA2.executorType, executionB.executorType);
  assert.deepEqual(Object.keys(executionA2.renderSpec).sort(), Object.keys(executionB.renderSpec).sort());

  // --- Asset remains unchanged ---
  const assetAfter = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(assetAfter.storage.status, 'STORED');
  assert.equal(assetAfter.approvalStatus, 'REJECTED'); // set deliberately during fixture setup, above — never touched again after that
  assert.deepEqual(assetAfter, assetAfterSetup, 'the Asset record must be byte-for-byte identical after resolution + execution');

  // --- B-roll record remains unchanged ---
  const segmentAfter = brollLibraryService.getBrollSegment(project.id, registration.segment.id);
  assert.deepEqual(segmentAfter, registration.segment, 'the BRollSegment record must be byte-for-byte identical after resolution + execution');

  // --- no second asset was created ---
  assert.equal(timelineStore.listAssets(project.id).length, 1);

  // --- no second B-roll segment was created ---
  assert.equal(brollLibraryService.listBrollSegments(project.id).length, 1);

  // --- deterministic: repeating the whole path again produces the identical execution shape ---
  const resolutionAgain = materialResolutionService.resolveMaterial(project.id, b, {});
  const executionAgain = executionService.executeMaterial(project.id, b, resolutionAgain);
  assert.deepEqual(executionAgain.renderSpec, execution.renderSpec);
  assert.equal(executionAgain.executorType, execution.executorType);
  assert.deepEqual(executionAgain.sourceAssetIds, execution.sourceAssetIds);
  assert.deepEqual(executionAgain.diagnostics, execution.diagnostics);

  // --- no real project data was touched — this project only ever lived in the temp dirs above ---
  assert.notEqual(projectTempDir, path.join(__dirname, '..', 'data', 'projects'));
  assert.notEqual(brollTempDir, path.join(__dirname, '..', 'data', 'broll'));
});

test('no network call occurs anywhere in the executed path — static scan of every file this proof exercises', () => {
  for (const file of [
    path.join('services', 'material-resolution-service.js'),
    path.join('services', 'material-execution-service.js'),
    path.join('services', 'broll-library-service.js'),
    path.join('services', 'material-executors', 'broll-executor.js'),
  ]) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
      assert.doesNotMatch(text, pattern, `${file} must not contain a network/eval/child_process call`);
    }
  }
});
