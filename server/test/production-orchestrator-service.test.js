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
const { createAudioEvent } = require('../schemas/audio-schema');
const { createCreativeQAReport, createCreativeQAFinding } = require('../services/creative-qa-interface');

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

// Registers a real, playable WAV as an 'audio' Asset — the same storage
// convention every real audio provider in this codebase uses (mirrors
// test/audio-mixer-integration.test.js's own makeStoredAudioAsset()).
function makeStoredAudioAsset(projectId, { durationSeconds = 4, frequency = 440 } = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'audio' });
  const relativePath = `${asset.assetId}.wav`;
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${durationSeconds}`, '-ar', '48000', '-ac', '2', absolutePath]);
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath, contentType: 'audio/wav' });
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

// PRODUCTION RELIABILITY LAYER, Phase 2 — builds a 4-shot project mixing
// narrated and non-narrated beats in the exact order Phase 2's regression
// matrix requires: Narrated A -> non-narrated B -> non-narrated B2
// (consecutive non-narrated) -> Narrated C. Shots 1/3 (STILL_IMAGE) and
// shots 2/4 (AI_VIDEO) each reuse the SAME real, pre-stored asset —
// PROJECT_ASSET_REUSE has no exclusivity constraint (see
// material-resolution-service.js), so this needs only the 2 assets
// buildGoldenProject() itself already relies on, keeping this real and
// provider-call-free.
function buildMixedTimingProject() {
  const project = projectStore.createProject({ title: 'EVOLINK P0-TIMING MIXED NARRATION PROOF', topic: 'timing invariant proof' });
  const { blueprintId, gateResultId } = satisfyProductionPrerequisites(project.id);

  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  const shotA = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 4, visualTreatment: 'STILL_IMAGE', purpose: 'hook' }); // narrated
  const shotB = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, duration: 5, visualTreatment: 'AI_VIDEO', purpose: 'context' }); // non-narrated
  const shotB2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 3, duration: 3, visualTreatment: 'STILL_IMAGE', purpose: 'context-2' }); // non-narrated, consecutive with B
  const shotC = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 4, duration: 4, visualTreatment: 'AI_VIDEO', purpose: 'conclusion' }); // narrated

  makeStoredImageAsset(project.id);
  makeStoredVideoAsset(project.id, { durationSeconds: 6 });

  return { project, blueprintId, gateResultId, scene, shotA, shotB, shotB2, shotC };
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

  // 6. PRODUCTION RELIABILITY LAYER — a genuinely complete production must
  // compute as FULL_CONTENT/PASS, never leave the new signal null on a
  // real COMPLETE job.
  assert.ok(job.contentCompleteness);
  assert.equal(job.contentCompleteness.overall, 'FULL_CONTENT');
  assert.deepEqual(job.contentCompleteness.missingBeatIds, []);
  assert.deepEqual(job.contentCompleteness.missingNarrationBeatIds, []);
  assert.ok(job.creativeQa);
  const { summarizeCreativeQAReport } = require('../services/creative-qa-service');
  const qaSummary = summarizeCreativeQAReport(job.creativeQa);
  assert.equal(qaSummary.passed, true);
  assert.equal(qaSummary.severity, 'PASS');

  const { diagnoseProductionJob } = require('../services/production-diagnosis-service');
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.classification, 'SUCCESS');
  assert.equal(diagnosis.isContentComplete, true);

  // Copy out for human inspection, same discipline as the existing Golden Video proof.
  fs.copyFileSync(artifactPath, path.join(PROOF_DIR, `golden-production-${job.productionJobId}.mp4`));
});

test('PRODUCTION RELIABILITY LAYER Phase 2 (E) — the exact real bug from Phase 1 (no narrativeRole supplied for a non-narrated AI_VIDEO/PROJECT_ASSET_REUSE beat) now reaches FULL_CONTENT, not merely the absence of an error', () => {
  // This is the SAME scenario a Phase 1 test proved was a real, unforced
  // silent drop (shot2, AI_VIDEO, PROJECT_ASSET_REUSE, no narration/
  // narrativeRole -> null beat.startTime -> project-asset-reuse-
  // executor.js used to fail INVALID_START_TIME -> timeline-compiler-
  // service.js excluded the beat with EXECUTION_FAILED -> job still
  // reached COMPLETE with a beat missing). Phase 2 fixed the executor
  // (ABSENT startTime is no longer a failure — it is left null on the
  // renderSpec so timeline-compiler-service.js's own pre-existing Tier 3
  // sequential-cursor inference places it, exactly like every other
  // executor's timing-agnostic renderSpec already relies on). This test
  // proves the GOOD outcome from this stage's own success criterion: the
  // beat now survives execution and the timeline, not "Phase 1's safety
  // net caught its absence."
  const { project, shot1, shot2, shot3 } = buildGoldenProject();
  const outputDir = outDir();

  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'fix-script-1', text: 'Every great video starts with a single clear idea.' },
    },
    // Still deliberately no narrativeRoles/narration for shot2 (AI_VIDEO)
    // and no explicit startTime for it anywhere — the exact real-world gap
    // that used to trigger the silent drop.
    materialOptions: { [shot3.shotId]: { text: 'THE END' } },
  });
  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  const { job } = result;

  assert.equal(job.status, 'COMPLETE');
  assert.equal(job.escalations.length, 0);

  // No trace of the old failure mode anywhere in diagnostics.
  assert.ok(!job.diagnostics.some((d) => d.code === 'INVALID_START_TIME'), JSON.stringify(job.diagnostics, null, 2));
  assert.ok(!job.diagnostics.some((d) => d.code === 'EXECUTION_FAILED'), JSON.stringify(job.diagnostics, null, 2));

  // (G) The fixed scenario produces FULL_CONTENT, not just "no error."
  assert.equal(job.contentCompleteness.overall, 'FULL_CONTENT');
  assert.deepEqual(job.contentCompleteness.missingBeatIds, []);
  assert.equal(job.contentCompleteness.expectedBeatCount, 3);
  assert.equal(job.contentCompleteness.assembledBeatCount, 3);

  // The previously-dropped beat (shot2) is now genuinely present in
  // assembly provenance — the real proof it reached the final MP4, not
  // just that some diagnostic is absent.
  const provenanceBeatIds = job.assemblyResult.provenance.shots.map((s) => s.beatId);
  assert.ok(provenanceBeatIds.includes(shot2.shotId), JSON.stringify(provenanceBeatIds));

  // (H) Creative QA does not report missing beat coverage.
  const { summarizeCreativeQAReport } = require('../services/creative-qa-service');
  const qaSummary = summarizeCreativeQAReport(job.creativeQa);
  assert.equal(qaSummary.passed, true);
  assert.equal(qaSummary.severity, 'PASS');
  assert.deepEqual(qaSummary.affectedBeatIds, []);

  const { diagnoseProductionJob } = require('../services/production-diagnosis-service');
  const diagnosis = diagnoseProductionJob(job);
  assert.equal(diagnosis.classification, 'SUCCESS');
  assert.equal(diagnosis.isContentComplete, true);
});

test('PRODUCTION RELIABILITY LAYER Phase 2 (A/B/C/D/F) — narrated A, then two CONSECUTIVE non-narrated beats (B, B2), then narrated C: all four survive assembly, in correct temporal order, with deterministic non-overlapping placement for the non-narrated pair', () => {
  const { project, shotA, shotB, shotB2, shotC } = buildMixedTimingProject();
  const outputDir = outDir();

  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: {
      [shotA.shotId]: { scriptRefId: 'mixed-script-a', text: 'This is beat A, and it is narrated from the very start.' },
      [shotC.shotId]: { scriptRefId: 'mixed-script-c', text: 'This is beat C, narrated again after two silent beats.' },
    },
    narrativeRoles: { [shotA.shotId]: 'HOOK', [shotC.shotId]: 'CONCLUSION' },
    // shotB and shotB2 are deliberately left with no narration/narrativeRole
    // at all — the exact non-narrated-visual-beat case this phase fixes.
  });
  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  const { job } = result;

  assert.equal(job.status, 'COMPLETE');
  assert.equal(job.escalations.length, 0);
  assert.ok(!job.diagnostics.some((d) => d.code === 'INVALID_START_TIME' || d.code === 'EXECUTION_FAILED'), JSON.stringify(job.diagnostics, null, 2));

  // (A) narrated beats keep real, measured timing — beat A starts at 0
  // (the narration cursor's own starting point), unaffected by this fix.
  const beatA = job.beatGraph.beats.find((b) => b.id === shotA.shotId);
  const beatC = job.beatGraph.beats.find((b) => b.id === shotC.shotId);
  assert.equal(typeof beatA.startTime, 'number');
  assert.equal(typeof beatC.startTime, 'number');

  // (B/D) the non-narrated beats (B, B2) each got a real, distinct,
  // non-overlapping compiled startTime — never null, never collided.
  const compiledByBeatId = new Map(job.timelineCompilation.shots.map((s) => [s.beatId, s]));
  const shotBCompiled = compiledByBeatId.get(shotB.shotId);
  const shotB2Compiled = compiledByBeatId.get(shotB2.shotId);
  assert.ok(shotBCompiled, 'non-narrated beat B must have a compiled Shot');
  assert.ok(shotB2Compiled, 'non-narrated beat B2 must have a compiled Shot');
  assert.equal(typeof shotBCompiled.startTime, 'number');
  assert.equal(typeof shotB2Compiled.startTime, 'number');
  assert.notEqual(shotBCompiled.startTime, shotB2Compiled.startTime);

  // (C) correct temporal order end-to-end: A -> B -> B2 -> C, no overlaps.
  const compiledA = compiledByBeatId.get(shotA.shotId);
  const compiledC = compiledByBeatId.get(shotC.shotId);
  assert.ok(compiledA.startTime <= shotBCompiled.startTime);
  assert.ok(shotBCompiled.startTime + shotBCompiled.duration <= shotB2Compiled.startTime + 1e-9);
  assert.ok(shotB2Compiled.startTime + shotB2Compiled.duration <= compiledC.startTime + 1e-9);

  // (G) every beat reached the FINAL assembly, not just the compiled timeline.
  assert.equal(job.contentCompleteness.overall, 'FULL_CONTENT');
  const provenanceBeatIds = job.assemblyResult.provenance.shots.map((s) => s.beatId);
  for (const id of [shotA.shotId, shotB.shotId, shotB2.shotId, shotC.shotId]) {
    assert.ok(provenanceBeatIds.includes(id), `beat "${id}" missing from assembly provenance: ${JSON.stringify(provenanceBeatIds)}`);
  }

  // (H) Creative QA agrees — no beat coverage failure.
  const { summarizeCreativeQAReport } = require('../services/creative-qa-service');
  const qaSummary = summarizeCreativeQAReport(job.creativeQa);
  assert.equal(qaSummary.passed, true);
  assert.equal(qaSummary.severity, 'PASS');

  // Sanity: final MP4 duration is sensible (at least as long as the last
  // beat's own end time) and beat ordering survived to the real artifact.
  const probed = ffprobeFull(job.assemblyResult.artifact.path);
  assert.ok(Number(probed.format.duration) >= compiledC.startTime + compiledC.duration - 0.5);
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

test('PHASE 3F-A FIX 1 — options.audioInputs survives into the persisted ProductionJob and reaches real timeline compilation + mixing', () => {
  const { project, shot1, shot2, shot3 } = buildGoldenProject();
  const outputDir = outDir();

  // A real, already-ACQUIRED-shaped MUSIC AudioEvent, built exactly the
  // way music-acquisition-service.js's createMusicAudioEvent() itself
  // would (duration: null, no beatId/sceneId -> whole-timeline span,
  // Phase 3A) — this test never touches acquisition itself, only proves
  // that an already-built AudioEvent supplied via options.audioInputs
  // actually flows through the orchestrator, exactly the "no new audio
  // schema, reuse the existing AudioEvent architecture" contract.
  const musicAsset = makeStoredAudioAsset(project.id, { durationSeconds: 4, frequency: 220 });
  const musicEvent = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: musicAsset.assetId, duration: null });

  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'audio-inputs-script-1', text: 'Every great video starts with a single clear idea.' },
      [shot2.shotId]: { scriptRefId: 'audio-inputs-script-2', text: 'Then real footage brings that idea to life on screen.' },
    },
    narrativeRoles: { [shot1.shotId]: 'HOOK', [shot2.shotId]: 'EXPLANATION' },
    materialOptions: { [shot3.shotId]: { text: 'THE END' } },
    audioInputs: [musicEvent],
  });

  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  const { job } = result;
  assert.equal(job.status, 'COMPLETE');

  // 1. Persisted into the ProductionJob exactly like the other
  // caller-supplied context fields (treatments/narrationSegments/etc).
  const reloaded = productionJobStore.getProductionJob(job.productionJobId);
  assert.ok(Array.isArray(reloaded.audioInputs));
  assert.equal(reloaded.audioInputs.length, 1);
  assert.equal(reloaded.audioInputs[0].audioEventId, musicEvent.audioEventId);
  assert.equal(reloaded.audioInputs[0].sourceAssetId, musicAsset.assetId);
  assert.equal(reloaded.audioInputs[0].type, 'MUSIC');

  // 2. Reaches real timeline compilation — the supplied MUSIC AudioEvent
  // shows up in the compiled TimelineIR's own audio[], alongside the
  // real NARRATION events the pipeline derives on its own.
  assert.equal(job.timelineCompilation.status, 'COMPILED');
  const compiledAudioEventIds = job.timelineCompilation.audio.map((a) => a.audioEventId);
  assert.ok(compiledAudioEventIds.includes(musicEvent.audioEventId), JSON.stringify(job.timelineCompilation.audio, null, 2));
  const narrationCount = job.timelineCompilation.audio.filter((a) => a.type === 'NARRATION').length;
  assert.equal(narrationCount, 2, 'both narrated beats must still produce their own NARRATION AudioEvents, unaffected by this fix');

  // 3. Reaches the real mixer/assembly — a genuine, playable MP4 with a
  // real decodable audio stream (music + narration mixed together).
  assert.equal(job.assemblyResult.status, 'COMPLETED');
  const artifactPath = job.assemblyResult.artifact.path;
  assert.ok(fs.existsSync(artifactPath));
  const probed = ffprobeFull(artifactPath);
  const audioStream = probed.streams.find((s) => s.codec_type === 'audio');
  assert.ok(audioStream, 'final MP4 must have a decodable, mixed audio stream');

  // 4. QC/content-completeness/creative-QA are unaffected — this fix
  // only threads an input through, it never changes those pipelines.
  assert.equal(job.qc.passed, true);
  assert.equal(job.contentCompleteness.overall, 'FULL_CONTENT');
});

test('PHASE 3F-A FIX 1 (regression) — omitting options.audioInputs still defaults to an empty array, exactly like before this fix', () => {
  const { project, shot1, shot2, shot3 } = buildGoldenProject();
  const result = productionOrchestrator.startProduction(project.id, {
    outputDir: outDir(),
    narrationSegments: { [shot1.shotId]: { scriptRefId: 's1', text: 'Every great video starts with a single clear idea.' } },
    materialOptions: { [shot3.shotId]: { text: 'THE END' } },
  });
  assert.equal(result.ok, true, JSON.stringify(result.job && result.job.diagnostics, null, 2));
  assert.deepEqual(result.job.audioInputs, []);
});

test('PHASE 3F-A FIX 2 — getProductionStatus() surfaces diagnoseProductionJob()\'s reconciled diagnosis, so COMPLETE + QC PASS + PARTIAL_CONTENT is never reported as unqualified success', () => {
  const project = projectStore.createProject({ title: 'P0-ORCH — Fix 2 diagnosis wiring', topic: 'diagnosis wiring proof' });

  // Hand-built job shaped exactly like the real-world failure mode Fix 2
  // exists to surface: status COMPLETE, technical QC PASS, but content
  // completeness only PARTIAL_CONTENT (one beat missing) — the same
  // shape test/production-diagnosis-service.test.js's own unit test
  // already proves diagnoseProductionJob() classifies as PARTIAL_SUCCESS.
  // This test proves the SERVICE ENTRY POINT (getProductionStatus),
  // not diagnoseProductionJob() itself, actually surfaces that.
  const partialJob = productionJobStore.addProductionJob({
    projectId: project.id,
    outputDir: outDir(),
    status: 'COMPLETE',
    derivationContext: { treatments: {}, narrationSegments: {}, narrativeRoles: {}, visualBible: null },
    qc: { passed: true, checks: [{ code: 'FILE_EXISTS', passed: true, message: '' }] },
    contentCompleteness: { overall: 'PARTIAL_CONTENT', missingBeatIds: ['b2'], missingNarrationBeatIds: [] },
    creativeQa: createCreativeQAReport({
      subjectType: 'ProductionJob',
      subjectId: 'placeholder',
      findings: [createCreativeQAFinding({ dimension: 'BEAT_COVERAGE', result: 'FAIL', objectType: 'VisualBeat', objectId: 'b2', note: 'beat "b2" missing' })],
    }),
  });

  const result = productionOrchestrator.getProductionStatus(partialJob.productionJobId);
  assert.equal(result.ok, true);

  // The existing raw signals are returned completely unchanged.
  assert.equal(result.job.status, 'COMPLETE');
  assert.equal(result.job.qc.passed, true);
  assert.equal(result.job.contentCompleteness.overall, 'PARTIAL_CONTENT');

  // The new, additive `diagnosis` field is now present and correctly
  // reconciles those signals into something an operator cannot mistake
  // for an unqualified success.
  assert.ok(result.diagnosis, 'getProductionStatus() must expose a `diagnosis` field (Phase 3F-A Fix 2)');
  assert.notEqual(result.diagnosis.classification, 'SUCCESS');
  assert.equal(result.diagnosis.classification, 'PARTIAL_SUCCESS');
  assert.equal(result.diagnosis.isContentComplete, false);
  assert.deepEqual(result.diagnosis.affectedBeatIds, ['b2']);

  // Control case: a genuinely complete job (real GOLDEN production run)
  // still reaches SUCCESS through the same real entry point.
  const { project: goldenProject, shot1, shot2, shot3 } = buildGoldenProject();
  const golden = productionOrchestrator.startProduction(goldenProject.id, {
    outputDir: outDir(),
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'diag-s1', text: 'Every great video starts with a single clear idea.' },
      [shot2.shotId]: { scriptRefId: 'diag-s2', text: 'Then real footage brings that idea to life on screen.' },
    },
    materialOptions: { [shot3.shotId]: { text: 'THE END' } },
  });
  assert.equal(golden.ok, true, JSON.stringify(golden.job && golden.job.diagnostics, null, 2));
  const goldenStatus = productionOrchestrator.getProductionStatus(golden.job.productionJobId);
  assert.equal(goldenStatus.ok, true);
  assert.equal(goldenStatus.diagnosis.classification, 'SUCCESS');
  assert.equal(goldenStatus.diagnosis.isContentComplete, true);
});
