#!/usr/bin/env node
// run-creative-production-compiler-demo.js
//
// THE REAL PRODUCTION TEST for the Creative Production Contract -> Timeline
// IR compiler seam. Builds the milestone's own 28-second acceptance
// example, validates it, compiles it via
// services/creative-production-compiler-service.js, PERSISTS the compiled
// result into a real project through creativeStore's own existing write
// API (addStoryboardScene/addStoryboardShot/updateVisualBible — no new
// persistence mechanism), then runs the EXISTING, UNMODIFIED
// production-orchestrator-service.js against it. Pipeline B discipline
// throughout (same as every prior demo in this repo this session): real
// FFmpeg/HyperFrames rendering, real espeak-ng/faster-whisper narration,
// PROJECT_ASSET_REUSE (pre-stored fixtures) + DETERMINISTIC_TEMPLATE
// (KINETIC_TYPOGRAPHY) beats only — no GENERATED_NEW, no paid provider.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const demoDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cpc-compiler-demo-data-'));
process.env.ASSET_STORAGE_DIR = path.join(demoDataRoot, 'asset-storage');
process.env.PROJECT_DATA_DIR = path.join(demoDataRoot, 'projects');
process.env.CREATIVE_DATA_DIR = path.join(demoDataRoot, 'creative');
process.env.PRE_PRODUCTION_GATE_DATA_DIR = path.join(demoDataRoot, 'pre-production-gates');
process.env.PRODUCTION_JOBS_DATA_DIR = path.join(demoDataRoot, 'production-jobs');
process.env.RECOMMENDATION_DATA_DIR = path.join(demoDataRoot, 'recommendations');
process.env.CREATIVE_BRAIN_APPROVAL_DATA_DIR = path.join(demoDataRoot, 'creative-brain-approvals');
process.env.HUMAN_VOICE_PROFILE_DATA_DIR = path.join(demoDataRoot, 'human-voice-profiles');

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const recommendationStore = require('../services/recommendation-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const creativeBrainApprovalStore = require('../services/creative-brain-approval-store');
const { createFakeCreativeBrainProvider } = require('../services/creative-brain/fake-creative-brain-provider');
const creativeStore = require('../services/creative-store');
const creativeBlueprintService = require('../services/creative-blueprint-service');
const preProductionGateService = require('../services/pre-production-gate-service');
const productionOrchestrator = require('../services/production-orchestrator-service');
const { compileCreativeProjectToTimeline } = require('../services/creative-production-compiler-service');
const { build } = require('./build-creative-production-contract-example');
const { makeTinyPng } = require('../test/fixtures/png-fixture');

function log(msg) {
  console.log(`[creative-production-compiler-demo] ${msg}`);
}

function addRecommendationSet(projectId) {
  const set = createRecommendationSet({
    projectId,
    referenceSetId: 'rs1',
    recommendations: [createRecommendation({ statement: 'A clear, sequential mechanism explanation retains viewers longer than a scattered one.', rationale: 'RECURRING_OBSERVATION, 4/5 support.', evidenceSufficiency: 'SUFFICIENT' })],
  });
  return recommendationStore.addRecommendationSet(projectId, set).recommendationSet;
}
function approveCreativeBrain(projectId, recommendationSetId) {
  creativeBrainApprovalStore.decideApproval(projectId, recommendationSetId, { approve: true, decidedBy: 'creative-production-compiler-demo' });
  creativeBrainApprovalStore.acknowledgeUnknownCost(projectId, recommendationSetId, { acknowledgedBy: 'creative-production-compiler-demo' });
}
function candidateShapes() {
  return [
    () => ({
      concept: 'The mechanism nobody names out loud',
      corePromise: 'Not just willpower — a specific, measurable 12% shift once it kicks in.',
      hookStrategy: "This isn't about willpower, but about one specific moment most people miss.",
      rationale: 'Mechanism framing with a concrete numeric anchor.',
    }),
  ];
}
function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(1920, 1080), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  timelineStore.setAssetApprovalStatus(projectId, assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, assetId);
}

async function main() {
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cpc-compiler-demo-output-'));
  fs.mkdirSync(outputDir, { recursive: true });
  log(`outputDir = ${outputDir}`);
  log(`demoDataRoot (isolated, never touches real server/data/) = ${demoDataRoot}`);

  // 1. Build the canonical 28-second example.
  const { storyboard, visualBible, generationUnits, knownAssetIds } = build();
  log(`canonical example: ${storyboard.shots.length} creative shots, ${generationUnits.length} GenerationUnits`);

  // 2. Validate + 3. Compile it into Timeline IR (Storyboard + context).
  const compiled = compileCreativeProjectToTimeline({ storyboard, visualBible, generationUnits, knownAssetIds });
  if (!compiled.ok) {
    console.error('[creative-production-compiler-demo] COMPILATION REJECTED:', JSON.stringify(compiled.diagnostics, null, 2));
    process.exitCode = 1;
    return;
  }
  log(`compiled: ${compiled.storyboard.shots.length} compiled shots (atomic generation operations), ${compiled.context.edges.length} edge(s)`);
  log(`provenance: ${compiled.provenance.map((p) => `${p.compiledShotId}<-${p.parentShotId}`).join(', ')}`);

  // --- stand up a real project ready for production (same approval chain every prior demo this session used) ---
  const projectSeed = projectStore.createProject({ title: 'Creative Production Compiler Demo', topic: 'the paradox of choice' });
  gate.setBudget(projectSeed, 1000);
  gate.requestApproval(projectSeed, { estimatedCost: 1 });
  gate.decideApproval(projectSeed, { approve: true, decidedBy: 'creative-production-compiler-demo' });
  const project = projectStore.touch(projectSeed);

  const recSet = addRecommendationSet(project.id);
  const creativeBrainService = require('../services/creative-brain-service');
  const blueprintOptions = { recommendationSetId: recSet.id, topic: 'the paradox of choice', targetDuration: 28, provider: createFakeCreativeBrainProvider({ candidateShapes: candidateShapes() }) };
  const firstAttempt = await creativeBrainService.generateCreativeBlueprint(project.id, blueprintOptions);
  if (!firstAttempt.ok && firstAttempt.code !== 'CREATIVE_BRAIN_APPROVAL_REQUIRED') throw new Error(`Blueprint generation failed: ${JSON.stringify(firstAttempt)}`);
  approveCreativeBrain(project.id, recSet.id);
  const blueprintResult = await creativeBrainService.generateCreativeBlueprint(project.id, blueprintOptions);
  if (!blueprintResult.ok) throw new Error(`Blueprint generation failed: ${JSON.stringify(blueprintResult)}`);
  const submitted = creativeBlueprintService.submitCreativeBlueprintForReview(project.id, blueprintResult.blueprint.id, { submittedBy: 'creative-production-compiler-demo' });
  const approved = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprintResult.blueprint.id, { decision: 'APPROVE', reviewedBy: 'creative-production-compiler-demo' });
  if (!submitted.ok || !approved.ok) throw new Error(`Blueprint submit/approve failed: submitted=${JSON.stringify(submitted)} approved=${JSON.stringify(approved)}`);
  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, approved.blueprint.id);
  const decision = evaluated.gateResult.machineAssessment === 'PROCEED' ? 'ACCEPT' : 'OVERRIDE';
  const decided = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision, decidedBy: 'creative-production-compiler-demo', rationale: decision === 'OVERRIDE' ? 'Compiler demo — overriding to proceed with a controlled example.' : undefined });
  if (!decided.ok) throw new Error(`Gate decision failed: ${JSON.stringify(decided)}`);

  // 4. Persist the COMPILED Timeline IR into the real project — via
  // creativeStore's OWN EXISTING write API, no new persistence mechanism,
  // no manual Timeline IR editing (every field below came straight out of
  // `compiled`, none hand-tweaked for this project).
  creativeStore.updateVisualBible(project.id, { characters: visualBible.characters, locations: visualBible.locations, props: visualBible.props });
  for (const scene of compiled.storyboard.scenes) {
    creativeStore.addStoryboardScene(project.id, { sceneId: scene.sceneId, title: scene.title, order: scene.order });
  }
  for (const shot of compiled.storyboard.shots) {
    creativeStore.addStoryboardShot(project.id, { ...shot });
  }
  creativeStore.updateStoryboard(project.id, { blueprintId: approved.blueprint.id });

  // --- assign real, provider-free treatments: single-unit shots render as
  // KINETIC_TYPOGRAPHY (narrated text, no asset needed); the split 15s
  // shot's two units both render as STILL_IMAGE against one shared,
  // pre-stored PROJECT_ASSET_REUSE image — no GENERATED_NEW anywhere. ---
  makeStoredImageAsset(project.id);
  const singleUnitCompiledShotIds = compiled.provenance.filter((p) => compiled.provenance.filter((q) => q.parentShotId === p.parentShotId).length === 1).map((p) => p.compiledShotId);
  const splitUnitCompiledShotIds = compiled.provenance.filter((p) => compiled.provenance.filter((q) => q.parentShotId === p.parentShotId).length > 1).map((p) => p.compiledShotId);

  const treatments = {};
  for (const id of singleUnitCompiledShotIds) treatments[id] = 'KINETIC_TYPOGRAPHY';
  for (const id of splitUnitCompiledShotIds) treatments[id] = 'STILL_IMAGE';

  // Every compiled beat is narrated here (rather than exercising this
  // compiler's own documented "first-unit-only" narration remap rule,
  // already covered by test/creative-production-compiler-service.test.js)
  // specifically to avoid a KNOWN, PRE-EXISTING, out-of-scope
  // production-orchestrator-service.js limitation: its narration-timing
  // cursor only advances across NARRATED beats, so an unnarrated beat
  // sandwiched between two narrated ones collides in time with the second
  // narrated beat (PRIMARY_OVERLAP_FORBIDDEN) — documented in this
  // session's own prior Story Architecture milestone, deliberately left
  // unfixed there for the same reason it is not fixed here: "do not
  // modify the Production Orchestrator" for this milestone too.
  const gen0401a = compiled.provenance.find((p) => p.parentShotId === 'shot-04-01').compiledShotId;
  const gen0402a = compiled.provenance.find((p) => p.parentShotId === 'shot-04-02' && p.order < compiled.provenance.find((q) => q.parentShotId === 'shot-04-02' && q.compiledShotId !== p.compiledShotId).order).compiledShotId;
  const gen0402b = compiled.provenance.find((p) => p.parentShotId === 'shot-04-02' && p.compiledShotId !== gen0402a).compiledShotId;
  const gen0403a = compiled.provenance.find((p) => p.parentShotId === 'shot-04-03').compiledShotId;
  const narrationSegments = {
    [gen0401a]: { text: 'More options should make choosing easier.' },
    [gen0402a]: { text: 'It does the opposite.' },
    [gen0402b]: { text: 'Every option you reject still costs you something.' },
    [gen0403a]: { text: 'Cut your options to three before you compare, and the paralysis disappears.' },
  };

  log('');
  log('Starting production (real production-orchestrator-service.js, UNMODIFIED, driven entirely by the compiled Timeline IR)...');
  const result = productionOrchestrator.startProduction(project.id, { outputDir, treatments, narrationSegments, visualBible: compiled.context.visualBible });

  if (!result.ok && !result.escalated) {
    log(`PRODUCTION DID NOT COMPLETE — status: ${result.job.status}, failureStage: ${result.job.failureStage || '(none)'}`);
    log(`Diagnostics: ${JSON.stringify(result.job.diagnostics, null, 2)}`);
    process.exitCode = 1;
    return;
  }
  const { job } = result;
  log(`job status: ${job.status}`);
  log(`escalations: ${JSON.stringify(job.escalations, null, 2)}`);
  if (job.diagnostics && job.diagnostics.length) log(`diagnostics: ${JSON.stringify(job.diagnostics, null, 2)}`);

  if (job.assemblyResult && job.assemblyResult.status === 'COMPLETED') {
    log('COMPLETE.');
    log(`  final MP4: ${job.assemblyResult.artifact.path}`);
    log(`  duration = ${job.assemblyResult.artifact.duration}s, ${job.assemblyResult.artifact.width}x${job.assemblyResult.artifact.height}, fps = ${job.assemblyResult.artifact.fps}`);
    const finalCopyPath = path.join(outputDir, 'final.mp4');
    fs.copyFileSync(job.assemblyResult.artifact.path, finalCopyPath);
    log(`  copied to: ${finalCopyPath}`);
  } else {
    log('NO ASSEMBLED MP4 — reporting the exact execution boundary reached (see diagnostics/escalations above), not fabricating success.');
  }
}

main().catch((err) => {
  console.error('[creative-production-compiler-demo] FAILED:', err);
  process.exitCode = 1;
});
