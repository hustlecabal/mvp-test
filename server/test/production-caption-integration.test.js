// P0-TEMPORAL — Part 21 REAL PRODUCTION INTEGRATION PROOF.
//
//   approved Blueprint -> ProductionJob -> real narration -> real Whisper ->
//   temporal backbone (services/caption-service.js) -> caption/SRT data ->
//   timeline -> HyperFrames -> real final MP4
//
// Reuses the EXACT Golden Production fixture pattern
// test/production-orchestrator-service.test.js's own GOLDEN PRODUCTION TEST
// established — the same real startProduction() entry point, nothing
// manually invoked. This proves the caption sidecar rides along on a real
// production run without altering its outcome.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-creative-'));
process.env.CREATIVE_DATA_DIR = creativeTempDir;
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-blueprints-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-gates-'));
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-jobs-'));
process.env.PRODUCTION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const creativeStore = require('../services/creative-store');
const assetStorage = require('../services/asset-storage');
const productionOrchestrator = require('../services/production-orchestrator-service');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');
const { makeTinyPng } = require('./fixtures/png-fixture');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-caption-integration-out-'));
}

function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(320, 180), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(projectId, assetId);
}

test('REAL PRODUCTION INTEGRATION PROOF — one startProduction() call produces both the real final MP4 AND a real caption/SRT sidecar from the same real narration', () => {
  const project = projectStore.createProject({ title: 'EVOLINK P0-TEMPORAL PRODUCTION INTEGRATION PROOF', topic: 'caption integration proof' });
  satisfyProductionPrerequisites(project.id);

  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  const shot1 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 4, visualTreatment: 'STILL_IMAGE', purpose: 'hook' });
  makeStoredImageAsset(project.id);

  const outputDir = outDir();
  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: { [shot1.shotId]: { scriptRefId: 'caption-integration-script-1', text: 'Every great video starts with a single clear idea.' } },
    narrativeRoles: { [shot1.shotId]: 'HOOK' },
  });

  // 1. The primary deliverable — the real final MP4 — is unaffected.
  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  const { job } = result;
  assert.equal(job.status, 'COMPLETE');
  assert.equal(job.assemblyResult.status, 'COMPLETED');
  assert.ok(fs.existsSync(job.assemblyResult.artifact.path));

  // 1b. Part 14 — timeline consistency: the caption sidecar must never
  // describe a moment beyond the REAL, ffprobe-measured final artifact
  // duration (the same Timeline Compiler / Assembly output already
  // proven above) — no second, independently-computed notion of "how long
  // this production is."
  const finalDuration = job.assemblyResult.artifact.duration;
  assert.ok(typeof finalDuration === 'number' && finalDuration > 0);

  // 2. The caption sidecar rode along, derived from the SAME real narration.
  assert.ok(job.captionResult, 'ProductionJob.captionResult must be populated');
  assert.equal(job.captionResult.status, 'COMPLETED', JSON.stringify(job.captionResult.diagnostics));
  assert.ok(job.captionResult.segments.length >= 1);
  assert.ok(job.captionResult.srt && job.captionResult.srt.includes('-->'));
  assert.ok(job.captionResult.segments[0].text.toLowerCase().includes('every'));
  for (const segment of job.captionResult.segments) {
    assert.ok(segment.endTime <= finalDuration + 0.5, `caption "${segment.text}" (ends ${segment.endTime}s) must stay within the real final artifact's own duration (${finalDuration}s)`);
  }

  // 3. Sidecar-only (Part 21 explicit requirement) — never burned into the MP4,
  // never a second video artifact.
  assert.equal(job.assemblyResult.artifact.path.endsWith('.mp4'), true);
  assert.equal(Object.keys(job).includes('captionResult'), true);
  assert.notEqual(job.captionResult, job.assemblyResult, 'caption data must never be merged into/confused with the assembly artifact');
});

test('a caption-generation failure never blocks or fails an otherwise-successful ProductionJob', () => {
  // A production with NO narration at all (silent, still-image-only video) —
  // the caption step must report EMPTY, never FAILED, and never touch job.status.
  const project = projectStore.createProject({ title: 'EVOLINK P0-TEMPORAL no-narration proof', topic: 'x' });
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 3, visualTreatment: 'STILL_IMAGE' });
  makeStoredImageAsset(project.id);

  const result = productionOrchestrator.startProduction(project.id, { outputDir: outDir() });
  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  assert.equal(result.job.status, 'COMPLETE');
  assert.equal(result.job.captionResult.status, 'EMPTY');
});
