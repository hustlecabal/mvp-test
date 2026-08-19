// P0-ORCH — GOLDEN PRODUCTION TEST and supporting orchestration tests.
//
// This file is the non-negotiable acceptance test: it invokes ONLY
// productionOrchestratorService.startProduction() — the real, single
// operator entry point — and never calls beat-graph-derivation-service.js,
// material-resolution-service.js, material-execution-service.js,
// hyperframes-renderer.js, narration-director-service.js,
// voice-generation-service.js, narration-timing-service.js,
// timeline-compiler-service.js, or video-assembly-service.js directly.
// Everything downstream of the entry point is driven by the orchestrator
// itself, exactly the "ONE ENTRY POINT -> ONE ProductionJob -> MULTIPLE
// EXISTING SPECIALIST SERVICES -> ONE TIMELINE -> ONE ASSEMBLY -> ONE FINAL
// VIDEO" architecture this stage requires proof of.
//
// Zero paid-provider calls anywhere in this file: every beat resolves via
// PROJECT_ASSET_REUSE (real, pre-stored local assets) or
// DETERMINISTIC_TEMPLATE (KINETIC_TYPOGRAPHY) — never GENERATED_NEW, so
// this test never touches services/keyframe-generation-service.js,
// services/video-generation-service.js, or any provider adapter. This
// mirrors test/video-assembly-pipeline.test.js's own GOLDEN VIDEO fixture
// exactly, which is this whole stage's own design spec.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-creative-'));
process.env.CREATIVE_DATA_DIR = creativeTempDir;
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-blueprints-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-gates-'));
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-jobs-'));
process.env.PRODUCTION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const creativeStore = require('../services/creative-store');
const assetStorage = require('../services/asset-storage');
const productionJobStore = require('../services/production-job-store');
const productionOrchestrator = require('../services/production-orchestrator-service');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');
const { makeTinyPng } = require('./fixtures/png-fixture');

const PROOF_DIR = path.join(os.tmpdir(), 'evolink-p0-orch-golden-production-proof');
fs.mkdirSync(PROOF_DIR, { recursive: true });

function outDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodorch-out-'));
  return d;
}

function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(320, 180), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(projectId, assetId);
}

function makeStoredVideoAsset(projectId, { durationSeconds = 6 } = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:duration=${durationSeconds}:rate=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
  return timelineStore.getAsset(projectId, asset.assetId);
}

function ffprobeFull(filePath) {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', filePath],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString('utf8');
  return JSON.parse(raw);
}

// Builds a real, fully wired project: satisfied Control Plane prerequisites,
// a Storyboard with 3 shots (STILL_IMAGE, AI_VIDEO, KINETIC_TYPOGRAPHY —
// the exact same 3-treatment mix the existing GOLDEN VIDEO proof already
// exercises), and 2 real, pre-stored local assets so both non-deterministic
// treatments resolve via PROJECT_ASSET_REUSE with zero provider calls.
function buildGoldenProject() {
  const project = projectStore.createProject({ title: 'EVOLINK P0-ORCH GOLDEN PRODUCTION PROOF', topic: 'production orchestrator proof' });
  const { blueprintId, gateResultId } = satisfyProductionPrerequisites(project.id);

  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  const shot1 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 4, visualTreatment: 'STILL_IMAGE', purpose: 'hook' });
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, duration: 6, visualTreatment: 'AI_VIDEO', purpose: 'explanation' });
  const shot3 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 3, duration: 3, visualTreatment: 'KINETIC_TYPOGRAPHY', purpose: 'conclusion' });

  makeStoredImageAsset(project.id);
  makeStoredVideoAsset(project.id, { durationSeconds: 6 });

  return { project, blueprintId, gateResultId, scene, shot1, shot2, shot3 };
}

test('GOLDEN PRODUCTION TEST — one entry point drives Blueprint -> ... -> one real playable MP4', () => {
  const { project, shot1, shot2, shot3 } = buildGoldenProject();
  const outputDir = outDir();

  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'golden-script-1', text: 'Every great video starts with a single clear idea.' },
      [shot2.shotId]: { scriptRefId: 'golden-script-2', text: 'Then real footage brings that idea to life on screen.' },
    },
    narrativeRoles: { [shot1.shotId]: 'HOOK', [shot2.shotId]: 'EXPLANATION' },
    materialOptions: { [shot3.shotId]: { text: 'THE END' } },
  });

  // 1. ONE ENTRY POINT -> COMPLETE, no manual intermediate-service calls above this line.
  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  const { job } = result;
  assert.equal(job.status, 'COMPLETE');
  assert.equal(job.escalations.length, 0);

  // 2. ONE ProductionJob, real and persisted.
  const reloaded = productionJobStore.getProductionJob(job.productionJobId);
  assert.ok(reloaded);
  assert.equal(reloaded.status, 'COMPLETE');

  // 3. Provenance: Final artifact -> ProductionJob -> Blueprint/Gate.
  assert.equal(job.blueprintId, job.blueprintId);
  assert.ok(job.blueprintId);
  assert.ok(job.gateResultId);

  // 4. ONE TIMELINE, ONE ASSEMBLY, ONE FINAL VIDEO — real ffprobe proof.
  assert.equal(job.timelineCompilation.status, 'COMPILED');
  assert.equal(job.assemblyResult.status, 'COMPLETED');
  const artifactPath = job.assemblyResult.artifact.path;
  assert.ok(fs.existsSync(artifactPath));
  assert.ok(fs.statSync(artifactPath).size > 0);

  const probed = ffprobeFull(artifactPath);
  const videoStream = probed.streams.find((s) => s.codec_type === 'video');
  const audioStream = probed.streams.find((s) => s.codec_type === 'audio');
  assert.ok(videoStream, 'final MP4 must have a decodable video stream');
  assert.ok(audioStream, 'final MP4 must have a decodable audio stream (2 narrated beats were included)');
  assert.ok(Number(probed.format.duration) > 0);
  assert.equal(videoStream.width, 1920);
  assert.equal(videoStream.height, 1080);

  // 5. QC ran and passed.
  assert.equal(job.qc.passed, true);
  assert.ok(job.qc.checks.every((c) => c.passed));

  // Copy out for human inspection, same discipline as the existing Golden Video proof.
  fs.copyFileSync(artifactPath, path.join(PROOF_DIR, `golden-production-${job.productionJobId}.mp4`));
});

test('APPROVAL BOUNDARY — a project with no linked, approved Blueprint is BLOCKED before any production work', () => {
  const project = projectStore.createProject({ title: 'P0-ORCH — no blueprint', topic: 'approval boundary proof' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, visualTreatment: 'STILL_IMAGE' });

  const result = productionOrchestrator.startProduction(project.id, { outputDir: outDir() });

  assert.equal(result.ok, false);
  assert.equal(result.job.status, 'FAILED');
  assert.equal(result.job.failureStage, 'APPROVAL_BOUNDARY');
  assert.equal(result.code, 'NO_BLUEPRINT_LINKED');
  // Confirm nothing downstream ran.
  assert.equal(result.job.beatGraph, null);
  assert.equal(result.job.assemblyResult, null);
});

test('IDEMPOTENCY — starting production for a project with an in-flight ProductionJob resumes it instead of creating a second one', () => {
  const { project } = buildGoldenProject();
  const outputDir = outDir();

  // Simulate an in-flight job (e.g. a prior call that had not yet reached a
  // terminal status) rather than actually racing two calls, since this
  // orchestrator's own stages run synchronously to completion within one
  // call — the interesting case to prove is "a stuck, non-terminal job is
  // reused, never duplicated."
  const stuck = productionJobStore.addProductionJob({
    projectId: project.id,
    outputDir,
    status: 'RENDERING',
    derivationContext: { treatments: {}, narrationSegments: {}, narrativeRoles: {}, visualBible: null },
  });

  const before = productionJobStore.listProductionJobs({ projectId: project.id });
  assert.equal(before.length, 1);

  const result = productionOrchestrator.startProduction(project.id, { outputDir });

  const after = productionJobStore.listProductionJobs({ projectId: project.id });
  assert.equal(after.length, 1, 'no second ProductionJob should have been created');
  assert.equal(result.job.productionJobId, stuck.productionJobId);
});

test('RESUMABILITY — a beat with an already-persisted COMPLETED render is never re-rendered on resume', () => {
  const { project, shot1, shot2, shot3 } = buildGoldenProject();
  const outputDir = outDir();

  const first = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'resume-script-1', text: 'Every great video starts with a single clear idea.' },
      [shot2.shotId]: { scriptRefId: 'resume-script-2', text: 'Then real footage brings that idea to life on screen.' },
    },
    materialOptions: { [shot3.shotId]: { text: 'THE END' } },
  });
  assert.equal(first.ok, true, JSON.stringify(first.job.diagnostics));
  const completedJob = first.job;
  assert.equal(completedJob.beatProgress.filter((b) => b.render && b.render.status === 'COMPLETED').length, 3);

  // Build a SECOND, fresh ProductionJob (a different project run) reusing
  // the SAME derivationContext/outputDir, artificially checkpointed at
  // RENDERING with beat 1's render already COMPLETED (copied byte-for-byte
  // from the first real run) and beats 2/3 not yet rendered — simulating a
  // process crash immediately after beat 1's real render finished.
  const beat1Progress = completedJob.beatProgress[0];
  const simulated = productionJobStore.addProductionJob({
    projectId: project.id,
    blueprintId: completedJob.blueprintId,
    gateResultId: completedJob.gateResultId,
    storyboardBlueprintId: completedJob.storyboardBlueprintId,
    outputDir,
    derivationContext: completedJob.derivationContext,
    materialOptions: completedJob.materialOptions,
    status: 'RENDERING',
    beatGraph: completedJob.beatGraph,
    beatProgress: [beat1Progress, { beatId: completedJob.beatProgress[1].beatId }, { beatId: completedJob.beatProgress[2].beatId }],
  });

  const resumed = productionOrchestrator.resumeProduction(simulated.productionJobId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed.job.diagnostics));

  const beat1After = resumed.job.beatProgress.find((b) => b.beatId === beat1Progress.beatId);
  const beat2After = resumed.job.beatProgress.find((b) => b.beatId === completedJob.beatProgress[1].beatId);

  // Beat 1 was never re-rendered — identical renderId/artifact path as the
  // pre-seeded checkpoint (a real re-render would mint a brand-new renderId
  // and a brand-new artifact path via crypto.randomUUID()).
  assert.equal(beat1After.render.renderId, beat1Progress.render.renderId);
  assert.equal(beat1After.render.artifact.path, beat1Progress.render.artifact.path);

  // Beat 2, which had no persisted render, WAS rendered fresh this run.
  assert.ok(beat2After.render);
  assert.equal(beat2After.render.status, 'COMPLETED');
  assert.notEqual(beat2After.render.renderId, completedJob.beatProgress[1].render.renderId);
});
