#!/usr/bin/env node
// run-pipeline-b-demo.js
//
// CLI demo: produces ONE real, playable MP4 through Pipeline B only —
// PROJECT_ASSET_REUSE (pre-stored local PNG/MP4) + DETERMINISTIC_TEMPLATE
// (KINETIC_TYPOGRAPHY) beats. No GENERATED_NEW, no paid provider, no MCP
// auth, no stock-media acquisition, no API key of any kind.
//
// This mirrors test/production-orchestrator-service.test.js's GOLDEN
// PRODUCTION TEST setup pattern verbatim: same control-plane fixture
// helper, same asset-storage helpers, same single entry point
// (productionOrchestrator.startProduction()). The only deliberate
// deviation from that test is swapping its AI_VIDEO shot for BROLL_CLIP
// (both map to asset type 'video' and both resolve via
// PROJECT_ASSET_REUSE — see material-resolution-service.js's
// TREATMENT_TO_ASSET_TYPES — but BROLL_CLIP can never be mistaken for a
// GENERATED_NEW-eligible treatment the way AI_VIDEO's name might suggest).
//
// Usage: node scripts/run-pipeline-b-demo.js [outputDir]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Same isolation pattern as production-orchestrator-service.test.js's GOLDEN
// PRODUCTION TEST: these env vars must be set BEFORE requiring any store
// module below, since each store resolves its data dir once at module-load
// time. Without this, a plain run would write demo data into the real
// server/data/ directories.
const demoDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-pipeline-b-demo-data-'));
process.env.ASSET_STORAGE_DIR = path.join(demoDataRoot, 'asset-storage');
process.env.PROJECT_DATA_DIR = path.join(demoDataRoot, 'projects');
process.env.CREATIVE_DATA_DIR = path.join(demoDataRoot, 'creative');
process.env.CREATIVE_BLUEPRINT_DATA_DIR = path.join(demoDataRoot, 'creative-blueprints');
process.env.PRE_PRODUCTION_GATE_DATA_DIR = path.join(demoDataRoot, 'pre-production-gates');
process.env.PRODUCTION_JOBS_DATA_DIR = path.join(demoDataRoot, 'production-jobs');

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const creativeStore = require('../services/creative-store');
const assetStorage = require('../services/asset-storage');
const productionOrchestrator = require('../services/production-orchestrator-service');
const { satisfyProductionPrerequisites } = require('../test/helpers/control-plane-fixture');
const { makeTinyPng } = require('../test/fixtures/png-fixture');

function log(msg) {
  console.log(`[pipeline-b-demo] ${msg}`);
}

// Same pattern as production-orchestrator-service.test.js's
// makeStoredImageAsset: a real, well-formed PNG (dependency-free fixture),
// stored via the real asset-storage path, marked APPROVED so Material
// Resolution ranks it as the best (only) candidate.
function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(1920, 1080), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, {
    status: 'STORED',
    provider: 'local',
    path: stored.relativePath,
    contentType: stored.contentType,
  });
  timelineStore.setAssetApprovalStatus(projectId, assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, assetId);
}

// Same pattern as makeStoredVideoAsset in the golden test: a REAL,
// ffprobe-valid MP4 synthesized locally via ffmpeg's testsrc2 source — not
// the 53-byte stub at providers/fake-video/fixtures/sample-video.mp4,
// which is not a playable video and would fail real assembly/ffprobe.
function makeStoredVideoAsset(projectId, { durationSeconds = 10 } = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:duration=${durationSeconds}:rate=25`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath,
  ]);
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, asset.assetId);
}

function main() {
  const outputDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-pipeline-b-demo-'));
  fs.mkdirSync(outputDir, { recursive: true });
  log(`outputDir = ${outputDir}`);
  log(`demoDataRoot (isolated, never touches real server/data/) = ${demoDataRoot}`);

  log('Creating project...');
  const project = projectStore.createProject({
    title: 'Demo: Why most side projects never see the light of day',
    topic: "Why most side projects never see the light of day — and what fixes that, in three steps.",
  });
  log(`  project.id = ${project.id}`);

  log('Building + approving a CreativeBlueprint and accepting its PreProductionGate (fixture helper, no fake-provider call needed)...');
  const { blueprintId, gateResultId } = satisfyProductionPrerequisites(project.id);
  log(`  blueprintId = ${blueprintId}`);
  log(`  gateResultId = ${gateResultId}`);

  log('Building storyboard: 1 scene, 6 shots, no AI_VIDEO/HYBRID/GENERATED_NEW anywhere...');
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });

  // Note: for shots with a narrationSegment (below), the storyboard
  // `duration` here is only a nominal placeholder — the orchestrator's
  // narration-timing-service.js *replaces* it with the real, measured
  // espeak-ng audio duration (Tier 1 timing). Only the two narration-free
  // KINETIC_TYPOGRAPHY shots (1 and 6) actually keep this literal value.
  const shot1 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 8, visualTreatment: 'KINETIC_TYPOGRAPHY', purpose: 'title card' });
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, duration: 8, visualTreatment: 'STILL_IMAGE', purpose: 'hook' });
  const shot3 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 3, duration: 10, visualTreatment: 'BROLL_CLIP', purpose: 'step one' });
  const shot4 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 4, duration: 12, visualTreatment: 'KINETIC_TYPOGRAPHY', purpose: 'step two' });
  const shot5 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 5, duration: 8, visualTreatment: 'BROLL_CLIP', purpose: 'step three' });
  const shot6 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 6, duration: 8, visualTreatment: 'KINETIC_TYPOGRAPHY', purpose: 'closing card' });
  log(`  shots: ${[shot1, shot2, shot3, shot4, shot5, shot6].map((s) => `${s.shotId.slice(0, 8)}(${s.visualTreatment})`).join(', ')}`);

  log('Pre-storing local assets: 1 PNG for STILL_IMAGE, 1 MP4 for BROLL_CLIP (each reused across multiple beats)...');
  const imageAsset = makeStoredImageAsset(project.id);
  const videoAsset = makeStoredVideoAsset(project.id, { durationSeconds: 10 });
  log(`  image asset: ${imageAsset.assetId}`);
  log(`  video asset: ${videoAsset.assetId}`);

  log('Starting production (startProduction is synchronous — drives every stage to COMPLETE or the first failure/escalation)...');
  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments: {
      [shot2.shotId]: {
        scriptRefId: 'demo-script-2',
        text: "It's never the code. It's never the idea. It's the gap between 'I built it' and 'anyone saw it.' Most side projects don't die from a bad line of code — they die quietly, in a folder nobody opens twice, because the person who built them never let a stranger see the thing before it felt finished.",
      },
      [shot3.shotId]: {
        scriptRefId: 'demo-script-3',
        text: 'Step one: stop building features nobody asked for. Pick one real person, hand them the roughest version that works, and watch what they actually do with it — not what they say they will do.',
      },
      [shot5.shotId]: {
        scriptRefId: 'demo-script-5',
        text: 'Step three: ship the smallest version loud, not the biggest version quiet. A tiny thing ten people actually use beats a huge thing zero people have ever seen.',
      },
    },
    narrativeRoles: {
      [shot2.shotId]: 'HOOK',
      [shot3.shotId]: 'EXPLANATION',
      [shot5.shotId]: 'EXPLANATION',
    },
    materialOptions: {
      [shot1.shotId]: { text: 'WHY MOST SIDE PROJECTS DIE' },
      [shot4.shotId]: { text: 'Step two: measure.\nDid they open it? Did they come back?\nNumbers beat opinions.' },
      [shot6.shotId]: { text: 'ship loud, learn fast' },
    },
  });

  // The real poll-a-job-by-id read path (getProductionStatus) — exercised
  // here even though startProduction() already returned synchronously to
  // a terminal status, so this script proves both entry points work.
  const statusCheck = productionOrchestrator.getProductionStatus(result.job.productionJobId);
  log(`getProductionStatus(${result.job.productionJobId}).status = ${statusCheck.job.status}`);

  if (!result.ok) {
    log(`PRODUCTION DID NOT COMPLETE — status: ${result.job.status}, failureStage: ${result.job.failureStage || '(none)'}`);
    if (result.job.escalated || (result.job.escalations && result.job.escalations.length > 0)) {
      log('ESCALATED — this means a beat tried to resolve toward GENERATED_NEW (or another required-but-missing material). Fix the beat mapping and re-run:');
      log(JSON.stringify(result.job.escalations, null, 2));
    }
    log('Diagnostics:');
    log(JSON.stringify(result.job.diagnostics, null, 2));
    process.exitCode = 1;
    return;
  }

  const { job } = result;
  log('COMPLETE.');
  log(`  productionJobId = ${job.productionJobId}`);
  log(`  blueprintId = ${job.blueprintId}, gateResultId = ${job.gateResultId}`);
  log(`  escalations = ${job.escalations.length}`);
  log(`  qc.passed = ${job.qc.passed}`);
  log(`  final MP4 (orchestrator-attached path): ${job.assemblyResult.artifact.path}`);
  log(`  duration = ${job.assemblyResult.artifact.duration}s, ${job.assemblyResult.artifact.width}x${job.assemblyResult.artifact.height}, fps = ${job.assemblyResult.artifact.fps}`);

  const finalCopyPath = path.join(outputDir, 'final.mp4');
  fs.copyFileSync(job.assemblyResult.artifact.path, finalCopyPath);
  log(`  copied to: ${finalCopyPath}`);
}

main();
