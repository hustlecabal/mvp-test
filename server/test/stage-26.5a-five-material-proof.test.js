// Stage 26.5A, Part 11 — the disposable five-material integration proof.
// Demonstrates the REAL pipeline for each of the five deterministic
// executors:
//
//   VisualBeat -> Material Resolution (Stage 26.3's real resolveMaterial(),
//   never a fabricated MaterialResolution) -> Material Execution
//
// One example per executor:
//   1. Existing image        -> PROJECT_ASSET_REUSE  (an existing VIDEO
//                                asset, placed verbatim, no motion synthesis)
//   2. Still image, Ken Burns -> STILL_IMAGE_MOTION   (an existing image
//                                asset, animated)
//   3. Kinetic typography     -> KINETIC_TYPOGRAPHY
//   4. Motion graphic         -> MOTION_GRAPHIC
//   5. Whiteboard             -> WHITEBOARD
//
// Render SPECIFICATIONS only — no AI image/video generation, no EvoLink/
// Google calls, no credits, no real server/data project. Uses the same
// disposable-project + temp-directory convention every other test in this
// codebase already uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-26.5a-proof-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-26.5a-proof-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-26.5a-proof-keyframes-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const materialResolutionService = require('../services/material-resolution-service');
const executionService = require('../services/material-execution-service');

test('Stage 26.5A Part 11 — disposable five-material integration proof: VisualBeat -> Material Resolution -> Material Execution for every executor', () => {
  // --- disposable project + one existing, approved, canonical image asset,
  // and one existing, approved video asset -----------------------------------
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.5A DISPOSABLE PROOF', topic: 'material execution proof' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);

  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'ESTABLISHING_FRAME',
    sourceShotVersion: storyboard.version,
  });

  const imageAsset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  timelineStore.updateAssetStorage(project.id, imageAsset.assetId, { status: 'STORED', provider: 'local', path: `${imageAsset.assetId}.png` });
  timelineStore.setAssetApprovalStatus(project.id, imageAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, imageAsset.assetId, { selectedBy: 'proof' });

  const videoAsset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  timelineStore.updateAssetStorage(project.id, videoAsset.assetId, { status: 'STORED', provider: 'local', path: `${videoAsset.assetId}.mp4` });
  timelineStore.setAssetApprovalStatus(project.id, videoAsset.assetId, 'APPROVED');

  const proof = {};

  // --- 1. Existing image -> PROJECT_ASSET_REUSE (existing video, placed verbatim) ---
  const existingImageBeat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, startTime: 0, duration: 5, narrativePurpose: 'Existing footage', visualTreatment: 'AI_VIDEO' });
  const existingImageResolution = materialResolutionService.resolveMaterial(project.id, existingImageBeat, {});
  assert.equal(existingImageResolution.status, 'RESOLVED', 'Material Resolution must genuinely resolve this beat, not be fabricated');
  assert.equal(existingImageResolution.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');
  proof.existingImage = executionService.executeMaterial(project.id, existingImageBeat, existingImageResolution);
  assert.equal(proof.existingImage.status, 'COMPLETED');
  assert.equal(proof.existingImage.executorType, 'PROJECT_ASSET_REUSE');
  assert.equal(proof.existingImage.renderSpec.assetId, videoAsset.assetId);
  assert.deepEqual(proof.existingImage.sourceAssetIds, [videoAsset.assetId]);

  // --- 2. Still image with Ken Burns -> STILL_IMAGE_MOTION ---
  const kenBurnsBeat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 2, startTime: 5, duration: 4, narrativePurpose: 'Still with camera motion', visualTreatment: 'STILL_IMAGE' });
  const kenBurnsResolution = materialResolutionService.resolveMaterial(project.id, kenBurnsBeat, {});
  assert.equal(kenBurnsResolution.status, 'RESOLVED');
  assert.equal(kenBurnsResolution.selectedMaterial.selectedAssetId, imageAsset.assetId);
  proof.stillImageKenBurns = executionService.executeMaterial(project.id, kenBurnsBeat, kenBurnsResolution, { motionKind: 'KEN_BURNS' });
  assert.equal(proof.stillImageKenBurns.status, 'COMPLETED');
  assert.equal(proof.stillImageKenBurns.executorType, 'STILL_IMAGE_MOTION');
  assert.equal(proof.stillImageKenBurns.renderSpec.motionKind, 'KEN_BURNS');
  assert.equal(proof.stillImageKenBurns.renderSpec.assetId, imageAsset.assetId);

  // --- 3. Kinetic typography -> KINETIC_TYPOGRAPHY ---
  const typographyBeat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 3, startTime: 9, duration: 2, narrativePurpose: 'Hook', visualTreatment: 'KINETIC_TYPOGRAPHY' });
  const typographyResolution = materialResolutionService.resolveMaterial(project.id, typographyBeat, {});
  assert.equal(typographyResolution.status, 'RESOLVED');
  assert.equal(typographyResolution.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');
  proof.kineticTypography = executionService.executeMaterial(project.id, typographyBeat, typographyResolution, { text: 'THE PROBLEM', sequencing: 'WORD_BY_WORD' });
  assert.equal(proof.kineticTypography.status, 'COMPLETED');
  assert.equal(proof.kineticTypography.executorType, 'KINETIC_TYPOGRAPHY');
  assert.deepEqual(proof.kineticTypography.renderSpec.units, ['THE', 'PROBLEM']);

  // --- 4. Motion graphic -> MOTION_GRAPHIC ---
  const motionGraphicBeat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 4, startTime: 11, duration: 4, narrativePurpose: 'Explain the numbers', visualTreatment: 'MOTION_GRAPHIC' });
  const motionGraphicResolution = materialResolutionService.resolveMaterial(project.id, motionGraphicBeat, {});
  assert.equal(motionGraphicResolution.status, 'RESOLVED');
  proof.motionGraphic = executionService.executeMaterial(project.id, motionGraphicBeat, motionGraphicResolution, {
    elements: [{ kind: 'TEXT', label: '$10,000' }, { kind: 'PROGRESS_BAR', props: { value: 0.7 } }],
  });
  assert.equal(proof.motionGraphic.status, 'COMPLETED');
  assert.equal(proof.motionGraphic.executorType, 'MOTION_GRAPHIC');
  assert.equal(proof.motionGraphic.renderSpec.elements.length, 2);

  // --- 5. Whiteboard -> WHITEBOARD ---
  const whiteboardBeat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 5, startTime: 15, duration: 3.2, narrativePurpose: 'Whiteboard explanation', visualTreatment: 'WHITEBOARD' });
  const whiteboardResolution = materialResolutionService.resolveMaterial(project.id, whiteboardBeat, {});
  assert.equal(whiteboardResolution.status, 'RESOLVED');
  proof.whiteboard = executionService.executeMaterial(project.id, whiteboardBeat, whiteboardResolution, {
    elements: [
      { kind: 'OBJECT', content: 'wallet', drawDuration: 0.6 },
      { kind: 'TEXT', content: '£100', drawDuration: 0.4 },
      { kind: 'ARROW', drawDuration: 0.5 },
      { kind: 'TEXT', content: '£80', drawDuration: 0.4 },
      { kind: 'EMPHASIS', content: '£80', drawDuration: 0.3, holdDuration: 0.6 },
    ],
  });
  assert.equal(proof.whiteboard.status, 'COMPLETED');
  assert.equal(proof.whiteboard.executorType, 'WHITEBOARD');
  assert.equal(proof.whiteboard.renderSpec.drawingOrder.length, 5);

  // --- every one of the five completed, every one used a distinct executorType ---
  const executorTypesUsed = Object.values(proof).map((r) => r.executorType);
  assert.deepEqual(executorTypesUsed.sort(), ['KINETIC_TYPOGRAPHY', 'MOTION_GRAPHIC', 'PROJECT_ASSET_REUSE', 'STILL_IMAGE_MOTION', 'WHITEBOARD']);
  assert.ok(Object.values(proof).every((r) => r.status === 'COMPLETED'));

  // --- no real project data was touched — this project only ever lived in the temp dirs above ---
  assert.notEqual(projectTempDir, path.join(__dirname, '..', 'data', 'projects'));

  // --- no asset was mutated by any of the five executions ---
  const finalImageAsset = timelineStore.getAsset(project.id, imageAsset.assetId);
  const finalVideoAsset = timelineStore.getAsset(project.id, videoAsset.assetId);
  assert.equal(finalImageAsset.approvalStatus, 'APPROVED');
  assert.equal(finalVideoAsset.approvalStatus, 'APPROVED');
  assert.equal(finalImageAsset.storage.status, 'STORED');
  assert.equal(finalVideoAsset.storage.status, 'STORED');
});
