#!/usr/bin/env node
// run-editorial-spine-demo.js
//
// PHASE 1 EDITORIAL SPINE — the real, end-to-end production test (Part 12):
//
//   STRATEGY -> IDEA -> PACKAGE -> BLUEPRINT -> STORY STRUCTURE -> BEATGRAPH
//   -> VISUAL OBJECTIVE -> MATERIAL RESOLUTION -> PRODUCTION
//
// Drives every new editorial-spine service through the REAL, existing
// production engine (production-orchestrator-service.js, unmodified in its
// own logic) to produce ONE real, playable MP4 — proving the editorial
// spine is not a dead-end data structure: the selected idea/package's own
// text (title, promise, hook) becomes the Blueprint's identity, the
// Blueprint's strategy fields become an explicit per-beat Story Structure,
// and that Story Structure's narrativeRole/visualObjective/edges land on
// the real BeatGraph the orchestrator renders from.
//
// Pipeline B only (same discipline as the earlier run-pipeline-b-demo.js):
// every beat resolves via PROJECT_ASSET_REUSE (pre-stored local PNG/MP4) or
// DETERMINISTIC_TEMPLATE (KINETIC_TYPOGRAPHY) — never GENERATED_NEW, no
// paid provider, no MCP auth. The Creative Brain angle-generation stage
// still runs for real (it is the existing, proven generate/evaluate/select
// pattern this whole phase reuses the CONCEPT of) but uses the fake,
// offline CreativeBrainProvider — the same, already-established testing
// convention (no ANTHROPIC_API_KEY exists in this environment).
//
// Topic: "the paradox of choice" — the exact worked example the preceding
// Editorial Intelligence Gap Audit's own Section 13 critical test used.
//
// Usage: node scripts/run-editorial-spine-demo.js [outputDir]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Same isolation pattern as run-pipeline-b-demo.js and every test file in
// this phase: these env vars must be set BEFORE requiring any store module
// below (each store resolves its data dir once at module-load time).
const demoDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-editorial-spine-demo-data-'));
process.env.ASSET_STORAGE_DIR = path.join(demoDataRoot, 'asset-storage');
process.env.PROJECT_DATA_DIR = path.join(demoDataRoot, 'projects');
process.env.CREATIVE_DATA_DIR = path.join(demoDataRoot, 'creative');
process.env.CREATIVE_BLUEPRINT_DATA_DIR = path.join(demoDataRoot, 'creative-blueprints');
process.env.PRE_PRODUCTION_GATE_DATA_DIR = path.join(demoDataRoot, 'pre-production-gates');
process.env.PRODUCTION_JOBS_DATA_DIR = path.join(demoDataRoot, 'production-jobs');
process.env.RECOMMENDATION_DATA_DIR = path.join(demoDataRoot, 'recommendations');
process.env.CREATIVE_BRAIN_APPROVAL_DATA_DIR = path.join(demoDataRoot, 'creative-brain-approvals');
process.env.HUMAN_VOICE_PROFILE_DATA_DIR = path.join(demoDataRoot, 'human-voice-profiles');
process.env.EDITORIAL_STRATEGY_DATA_DIR = path.join(demoDataRoot, 'editorial-strategies');
process.env.IDEA_DATA_DIR = path.join(demoDataRoot, 'ideas');
process.env.PACKAGE_DATA_DIR = path.join(demoDataRoot, 'packages');
process.env.STORY_STRUCTURE_DATA_DIR = path.join(demoDataRoot, 'story-structures');

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const recommendationStore = require('../services/recommendation-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const creativeBrainApprovalStore = require('../services/creative-brain-approval-store');
const { createFakeCreativeBrainProvider } = require('../services/creative-brain/fake-creative-brain-provider');
const editorialStrategyStore = require('../services/editorial-strategy-store');
const ideaEngineService = require('../services/idea-engine-service');
const packagingEngineService = require('../services/packaging-engine-service');
const editorialSpineService = require('../services/editorial-spine-service');
const controlPlane = require('../services/control-plane-service');
const productionOrchestrator = require('../services/production-orchestrator-service');
const { makeTinyPng } = require('../test/fixtures/png-fixture');

function log(msg) {
  console.log(`[editorial-spine-demo] ${msg}`);
}

function addRecommendationSet(projectId) {
  const set = createRecommendationSet({
    projectId,
    referenceSetId: 'rs1',
    recommendations: [
      createRecommendation({
        statement: 'Reference videos that name a specific, concrete mechanism early retain viewers longer than ones that open on a general topic statement.',
        rationale: 'RECURRING_OBSERVATION, 4/5 support.',
        evidenceSufficiency: 'SUFFICIENT',
      }),
    ],
  });
  return recommendationStore.addRecommendationSet(projectId, set).recommendationSet;
}

function approveCreativeBrain(projectId, recommendationSetId) {
  creativeBrainApprovalStore.decideApproval(projectId, recommendationSetId, { approve: true, decidedBy: 'editorial-spine-demo' });
  creativeBrainApprovalStore.acknowledgeUnknownCost(projectId, recommendationSetId, { acknowledgedBy: 'editorial-spine-demo' });
}

// Real, engineered-to-pass candidate shapes for the offline fake Creative
// Brain provider (same reasoning as test/editorial-spine-integration.test.js's
// spineCandidateShapes: real evaluation still runs, unmodified — these are
// just written to clear GENERIC_HOOK/GENERIC_ANGLE/etc for this topic).
function spineCandidateShapes() {
  return [
    () => ({
      concept: 'The mechanism behind choice overload',
      corePromise: 'Not just about willpower — the paralysis comes from a specific, measurable comparison cost that rises with every option added.',
      hookStrategy: "This isn't about indecision, but about one specific cost your brain pays for every extra option.",
      rationale: 'Mechanism framing with a concrete anchor, independent of the bare topic phrase.',
    }),
    () => ({
      concept: 'What actually explains it, in one specific case',
      corePromise: 'The common explanation is "too many choices" — but the real driver is a single, nameable comparison habit.',
      hookStrategy: 'Instead of blaming the number of options, this opens on the one habit that actually causes the freeze.',
      rationale: 'Contrast framing with a quoted concrete anchor.',
    }),
    () => ({
      concept: 'The one number that changes how people think about this',
      corePromise: 'A specific 3-step way to short-circuit the comparison habit, not just a vague tip to "trust your gut."',
      hookStrategy: 'Rather than another list of tips, this opens directly on the number of options where the freeze reliably kicks in.',
      rationale: 'Numeric-anchor framing with an explicit contrast marker.',
    }),
  ];
}
function spineCreativeBrainProvider() {
  return createFakeCreativeBrainProvider({ candidateShapes: spineCandidateShapes() });
}

function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(1920, 1080), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  timelineStore.setAssetApprovalStatus(projectId, assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, assetId);
}

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

async function main() {
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-editorial-spine-demo-output-'));
  fs.mkdirSync(outputDir, { recursive: true });
  log(`outputDir = ${outputDir}`);
  log(`demoDataRoot (isolated, never touches real server/data/) = ${demoDataRoot}`);

  // === STRATEGY ============================================================
  log('Creating project + budget...');
  const projectSeed = projectStore.createProject({ title: 'Editorial Spine Demo: The Paradox of Choice', topic: 'the paradox of choice' });
  gate.setBudget(projectSeed, 1000);
  gate.requestApproval(projectSeed, { estimatedCost: 1 });
  gate.decideApproval(projectSeed, { approve: true, decidedBy: 'editorial-spine-demo' });
  const project = projectStore.touch(projectSeed);
  log(`  project.id = ${project.id}`);

  log('Creating EditorialStrategy...');
  const strategyResult = editorialStrategyStore.addStrategy(project.id, {
    targetAudience: 'people who feel paralyzed by too many options',
    positioning: 'explains the mechanism behind indecision, not just tips to fix it',
    audienceNeed: 'why more choice makes decisions harder instead of easier',
    contentPromise: 'a specific, named mechanism and one concrete way to counter it',
    preferredCharacteristics: ['concrete', 'mechanism-first'],
    avoid: ['generic productivity listicles'],
  });
  const strategy = strategyResult.strategy;
  log(`  strategy.id = ${strategy.id}`);

  // === IDEA ============================================================
  log('Generating + scoring + selecting an Idea...');
  const ideaResult = await ideaEngineService.generateIdeas(project.id, strategy.id);
  if (!ideaResult.ok) throw new Error(`Idea generation failed: ${JSON.stringify(ideaResult)}`);
  const rejectedIdeas = ideaResult.ideaSet.candidates.filter((c) => !c.selected);
  log(`  candidates generated: ${ideaResult.ideaSet.candidates.length}`);
  log(`  SELECTED idea: "${ideaResult.selectedIdea.topic}"`);
  log(`    premise: ${ideaResult.selectedIdea.premise}`);
  for (const rejected of rejectedIdeas) {
    const failCount = rejected.evaluationResults.filter((r) => r.result === 'FAIL').length;
    log(`  rejected idea: "${rejected.topic}" (${failCount} FAIL result(s))`);
  }

  // === PACKAGE ============================================================
  log('Generating + scoring + selecting a Package...');
  const packageResult = await packagingEngineService.generatePackages(project.id, ideaResult.selectedIdea.ideaId);
  if (!packageResult.ok) throw new Error(`Package generation failed: ${JSON.stringify(packageResult)}`);
  const rejectedPackages = packageResult.packageSet.candidates.filter((c) => !c.selected);
  log(`  candidates generated: ${packageResult.packageSet.candidates.length}`);
  log(`  SELECTED title: "${packageResult.selectedPackage.title}"`);
  log(`  SELECTED thumbnail concept: "${packageResult.selectedPackage.thumbnailConcept}"`);
  log(`  core promise: "${packageResult.selectedPackage.promise}"`);
  for (const rejected of rejectedPackages) {
    const failCount = rejected.evaluationResults.filter((r) => r.result === 'FAIL').length;
    log(`  rejected package: "${rejected.title}" (${failCount} FAIL result(s))`);
  }

  // === BLUEPRINT ============================================================
  log('Requesting Creative Brain financial approval, then generating + approving the Blueprint + gate...');
  const recSet = addRecommendationSet(project.id);
  await require('../services/creative-brain-service').generateCreativeBlueprint(project.id, {
    recommendationSetId: recSet.id, topic: ideaResult.selectedIdea.topic, strategyId: strategy.id, selectedIdea: ideaResult.selectedIdea, selectedPackage: packageResult.selectedPackage, provider: spineCreativeBrainProvider(),
  });
  approveCreativeBrain(project.id, recSet.id);

  const blueprintResult = await editorialSpineService.buildApprovedBlueprint(project.id, {
    strategyId: strategy.id,
    selectedIdea: ideaResult.selectedIdea,
    selectedPackage: packageResult.selectedPackage,
    blueprintOptions: { recommendationSetId: recSet.id, targetDuration: 48, provider: spineCreativeBrainProvider() },
    decidedBy: 'editorial-spine-demo',
  });
  if (!blueprintResult.ok) throw new Error(`Blueprint build/approval failed: ${JSON.stringify(blueprintResult)}`);
  log(`  blueprint.id = ${blueprintResult.blueprint.id}, status = ${blueprintResult.blueprint.status}`);
  log(`  blueprint.title = "${blueprintResult.blueprint.title}" (authoritative from the selected Package)`);
  log(`  blueprint.corePromise = "${blueprintResult.blueprint.corePromise}"`);
  log(`  gate.machineAssessment = ${blueprintResult.gateResult.machineAssessment}, humanDecision = ${blueprintResult.gateResult.humanDecision}`);

  // === STORY STRUCTURE + STORYBOARD ============================================================
  log('Deriving Story Structure + authoring the real Storyboard (Pipeline B treatments only)...');
  const structureResult = editorialSpineService.buildStoryStructureAndStoryboard(project.id, blueprintResult.blueprint, {
    treatmentByRole: { HOOK: 'KINETIC_TYPOGRAPHY', CONCLUSION: 'KINETIC_TYPOGRAPHY', EXPLANATION: 'STILL_IMAGE', REVEAL: 'BROLL_CLIP' },
    durationByRole: { HOOK: 6, EXPLANATION: 8, REVEAL: 10, CONCLUSION: 6 },
  });
  if (!structureResult.ok) throw new Error(`Story Structure / Storyboard authoring failed: ${JSON.stringify(structureResult)}`);
  log(`  storyStructure.id = ${structureResult.storyStructure.id}, beats = ${structureResult.storyStructure.beats.length}`);
  for (const beat of structureResult.storyStructure.beats) {
    const shotId = structureResult.beatKeyToShotId[beat.beatKey];
    log(`  beat: role=${beat.narrativeRole} setup=${beat.isSetup} escalation=${beat.isEscalation} reveal=${beat.isReveal} payoff=${beat.isPayoff} shotId=${shotId.slice(0, 8)} visualObjective="${beat.visualObjective.visualObjective}" (${beat.visualObjective.visualMode})`);
  }
  log(`  edges: ${structureResult.storyStructure.edges.map((e) => `${e.kind}`).join(', ')}`);

  // === PRE-STORE LOCAL ASSETS (Pipeline B — no GENERATED_NEW) ============
  log('Pre-storing local assets for STILL_IMAGE/BROLL_CLIP beats...');
  const imageAsset = makeStoredImageAsset(project.id);
  const videoAsset = makeStoredVideoAsset(project.id, { durationSeconds: 10 });
  log(`  image asset: ${imageAsset.assetId}, video asset: ${videoAsset.assetId}`);

  // === MATERIAL / NARRATION OPTIONS, KEYED BY REAL shotId ============
  const beatsByRole = {};
  for (const beat of structureResult.storyStructure.beats) {
    beatsByRole[beat.narrativeRole] = beatsByRole[beat.narrativeRole] || [];
    beatsByRole[beat.narrativeRole].push(beat);
  }
  const shotIdFor = (beat) => structureResult.beatKeyToShotId[beat.beatKey];
  const hookShot = beatsByRole.HOOK[0];
  const conclusionShot = beatsByRole.CONCLUSION[0];
  const explanationShots = beatsByRole.EXPLANATION || [];
  const revealShot = beatsByRole.REVEAL[0];

  const materialOptions = {
    [shotIdFor(hookShot)]: { text: packageResult.selectedPackage.title.toUpperCase() },
    [shotIdFor(conclusionShot)]: { text: 'name the mechanism.\nbreak the habit.' },
  };
  // DISCOVERED DURING THIS PHASE'S OWN REAL TEST (documented in the final
  // report, not silently patched — see production-orchestrator-service.js,
  // untouched): its per-beat narration cursor only advances across
  // NARRATED beats, so an unnarrated beat sitting BEFORE the first narrated
  // beat gets the same inferred start time (0) that the first narrated
  // beat's own cursor also starts at, and timeline-compiler-service.js's
  // PRIMARY_OVERLAP_FORBIDDEN rule then excludes BOTH. The one existing,
  // safe way to avoid this without touching the production engine is to
  // never let an unnarrated beat be the very first beat when a narrated
  // beat immediately follows — so the HOOK beat gets a real narration
  // track too (on top of its on-screen kinetic-typography text above),
  // leaving only the CONCLUSION beat unnarrated, at the very END, where
  // the compiler's own accumulated cursor already correctly places it.
  const narrationSegments = {
    [shotIdFor(hookShot)]: { scriptRefId: 'demo-hook', text: ideaResult.selectedIdea.premise },
  };
  explanationShots.forEach((beat, i) => {
    narrationSegments[shotIdFor(beat)] = { scriptRefId: `demo-explanation-${i}`, text: i === 0 ? blueprintResult.blueprint.corePromise : `${beat.purpose} ${ideaResult.selectedIdea.premise}` };
  });
  narrationSegments[shotIdFor(revealShot)] = { scriptRefId: 'demo-reveal', text: packageResult.selectedPackage.curiosityMechanism };

  log('Starting production (real production-orchestrator-service.js, unmodified logic)...');
  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    narrationSegments,
    materialOptions,
    narrativeRoles: structureResult.beatGraphContext.narrativeRoles,
    visualObjectives: structureResult.beatGraphContext.visualObjectives,
    edges: structureResult.beatGraphContext.edges,
  });

  if (!result.ok) {
    log(`PRODUCTION DID NOT COMPLETE — status: ${result.job.status}, failureStage: ${result.job.failureStage || '(none)'}`);
    log(`Diagnostics: ${JSON.stringify(result.job.diagnostics, null, 2)}`);
    process.exitCode = 1;
    return;
  }

  const { job } = result;
  log('COMPLETE.');
  log(`  productionJobId = ${job.productionJobId}`);
  log(`  escalations = ${job.escalations.length} (0 required — no beat should have needed GENERATED_NEW)`);
  log(`  qc.passed = ${job.qc.passed}`);

  // === PROVE MATERIAL RESOLUTION SAW THE EDITORIAL INTENT ============
  const beatGraph = job.beatGraph;
  for (const beat of beatGraph.beats) {
    log(`  BeatGraph beat: id=${beat.id.slice(0, 8)} narrativeRole=${beat.narrativeRole} visualIntent="${beat.visualIntent}" visualMode=${beat.visualMode} treatment=${beat.visualTreatment}`);
  }
  log(`  BeatGraph edges: ${beatGraph.edges.map((e) => `${e.kind}(${e.fromBeatId.slice(0, 8)}->${e.toBeatId.slice(0, 8)})`).join(', ')}`);

  log(`  final MP4: ${job.assemblyResult.artifact.path}`);
  log(`  duration = ${job.assemblyResult.artifact.duration}s, ${job.assemblyResult.artifact.width}x${job.assemblyResult.artifact.height}, fps = ${job.assemblyResult.artifact.fps}`);

  const finalCopyPath = path.join(outputDir, 'final.mp4');
  fs.copyFileSync(job.assemblyResult.artifact.path, finalCopyPath);
  log(`  copied to: ${finalCopyPath}`);

  // === STRUCTURAL READINESS CHECK (Part 9) ============
  const prereqCheck = controlPlane.validateProductionPrerequisites(project.id, { requireEditorialSpine: true });
  log(`  control-plane requireEditorialSpine check: ok=${prereqCheck.ok}${prereqCheck.ok ? '' : ` code=${prereqCheck.code}`}`);
}

main().catch((err) => {
  console.error('[editorial-spine-demo] FAILED:', err);
  process.exitCode = 1;
});
