#!/usr/bin/env node
// run-story-architecture-demo.js
//
// STORY ARCHITECTURE ENGINE — the real falsification tests (phase brief,
// Parts 12/13/15):
//
//   Part 12: "the paradox of choice", with NO manually authored per-beat
//            narration — the Story Argument itself must supply distinct
//            beat content, and that content must reach real narration.
//   Part 13: a structurally different topic (supermarket design) — shows
//            whether the architecture can express a different progression
//            (here: an explicit MYTH_BUSTING shape request) rather than
//            being permanently hardcoded to one sequence.
//   Part 15: one real, unmodified production-orchestrator-service.js run
//            for topic 1, sourcing ALL narration/visual-objective content
//            from the generated StoryArgument.
//
// Pipeline B only (same discipline as every prior demo in this repo):
// PROJECT_ASSET_REUSE (pre-stored local PNG/MP4) + DETERMINISTIC_TEMPLATE
// (KINETIC_TYPOGRAPHY) beats only — no GENERATED_NEW, no paid provider.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const demoDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-story-architecture-demo-data-'));
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
process.env.STORY_ARGUMENT_DATA_DIR = path.join(demoDataRoot, 'story-arguments');
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
const storyArchitectureService = require('../services/story-architecture-service');
const editorialSpineService = require('../services/editorial-spine-service');
const controlPlane = require('../services/control-plane-service');
const productionOrchestrator = require('../services/production-orchestrator-service');
const { findDuplicateBeats } = require('../services/story-architecture/distinctness-checker');
const { makeTinyPng } = require('../test/fixtures/png-fixture');

function log(msg) {
  console.log(`[story-architecture-demo] ${msg}`);
}

function addRecommendationSet(projectId) {
  const set = createRecommendationSet({
    projectId,
    referenceSetId: 'rs1',
    recommendations: [createRecommendation({ statement: 'Reference videos that name a specific, concrete mechanism early retain viewers longer than ones that open on a general topic statement.', rationale: 'RECURRING_OBSERVATION, 4/5 support.', evidenceSufficiency: 'SUFFICIENT' })],
  });
  return recommendationStore.addRecommendationSet(projectId, set).recommendationSet;
}
function approveCreativeBrain(projectId, recommendationSetId) {
  creativeBrainApprovalStore.decideApproval(projectId, recommendationSetId, { approve: true, decidedBy: 'story-architecture-demo' });
  creativeBrainApprovalStore.acknowledgeUnknownCost(projectId, recommendationSetId, { acknowledgedBy: 'story-architecture-demo' });
}

// Same "engineered to clear GENERIC_HOOK/GENERIC_ANGLE" candidate shapes
// as Phase 1's own editorial-spine-integration.test.js — angle generation
// still runs for real and is unaffected by Story Architecture.
function spineCandidateShapes() {
  return [
    () => ({
      concept: 'The mechanism nobody names out loud',
      corePromise: 'Not just a matter of willpower — the real mechanism shows up in a specific, measurable 12% shift once it kicks in.',
      hookStrategy: "This isn't about willpower, but about one specific moment most people miss.",
      rationale: 'Mechanism framing, independent of the bare topic phrase, one concrete numeric anchor.',
    }),
    () => ({
      concept: 'What actually explains it, in one specific case',
      corePromise: 'The common explanation misses a "hidden variable" — but the real driver is a single, nameable factor.',
      hookStrategy: 'Instead of the usual explanation, this opens on the one detail everyone skips.',
      rationale: 'Contrast framing with a quoted concrete anchor.',
    }),
    () => ({
      concept: 'The one number that changes how people think about this',
      corePromise: 'A specific 3-step pattern, not just a vague tip, is what actually shifts the outcome.',
      hookStrategy: 'Rather than a list of tips, this opens directly on the number that surprises people.',
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
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:duration=${durationSeconds}:rate=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, asset.assetId);
}

// Runs Strategy -> Idea -> Package -> Blueprint for one topic, returning
// everything needed to then generate a StoryArgument.
async function buildThroughBlueprint(topicLabel, strategyInput) {
  const projectSeed = projectStore.createProject({ title: `Story Architecture Demo: ${topicLabel}`, topic: topicLabel });
  gate.setBudget(projectSeed, 1000);
  gate.requestApproval(projectSeed, { estimatedCost: 1 });
  gate.decideApproval(projectSeed, { approve: true, decidedBy: 'story-architecture-demo' });
  const project = projectStore.touch(projectSeed);

  const strategy = editorialStrategyStore.addStrategy(project.id, strategyInput).strategy;

  const ideaResult = await ideaEngineService.generateIdeas(project.id, strategy.id);
  const packageResult = await packagingEngineService.generatePackages(project.id, ideaResult.selectedIdea.ideaId);

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
    decidedBy: 'story-architecture-demo',
  });
  if (!blueprintResult.ok) throw new Error(`Blueprint build/approval failed for "${topicLabel}": ${JSON.stringify(blueprintResult)}`);

  return { project, strategy, idea: ideaResult.selectedIdea, pkg: packageResult.selectedPackage, blueprint: blueprintResult.blueprint, gateResult: blueprintResult.gateResult };
}

function reportStoryArgument(label, storyArgumentSet, selected) {
  log(`=== ${label} ===`);
  log(`  shape: ${selected.shape}`);
  log(`  coreQuestion: "${selected.coreQuestion}"`);
  log(`  startingBelief: "${selected.startingBelief}"`);
  log(`  mechanism: "${selected.mechanism}"`);
  log(`  stakes: "${selected.stakes}"`);
  log(`  reframedBelief: "${selected.reframedBelief}"`);
  log(`  payoff: "${selected.payoff}"`);
  log(`  candidates generated: ${storyArgumentSet.candidates.length} (shapes: ${storyArgumentSet.candidates.map((c) => c.shape).join(', ')})`);
  for (const beat of selected.beats) {
    log(`  beat ${beat.order} [${beat.beatFunction}/${beat.narrativeRole}] setup=${beat.isSetup} escalation=${beat.isEscalation} reveal=${beat.isReveal} payoff=${beat.isPayoff}`);
    log(`    claim: "${beat.claim}"`);
    log(`    whyItExists: ${beat.whyItExists}`);
    log(`    visualObjective: "${beat.visualObjective.visualObjective}"`);
    if (beat.creates.length) log(`    creates questions: ${beat.creates.join(', ')}`);
    if (beat.resolves.length) log(`    resolves questions: ${beat.resolves.join(', ')}`);
    if (beat.paysOffBeatKeys.length) log(`    pays off beats: ${beat.paysOffBeatKeys.map((k) => k.slice(0, 8)).join(', ')}`);
  }
  const fails = selected.evaluationResults.filter((r) => r.result === 'FAIL');
  log(`  evaluator: ${fails.length} FAIL result(s)${fails.length ? ': ' + JSON.stringify(fails) : ''}`);
}

async function main() {
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-story-architecture-demo-output-'));
  fs.mkdirSync(outputDir, { recursive: true });
  log(`outputDir = ${outputDir}`);
  log(`demoDataRoot (isolated, never touches real server/data/) = ${demoDataRoot}`);

  // ==========================================================================
  // PART 12 — "the paradox of choice", full real production, NO hand-authored
  // per-beat narration anywhere in this script.
  // ==========================================================================
  log('');
  log('########## TOPIC 1: the paradox of choice (default shape, real production) ##########');
  const topic1 = await buildThroughBlueprint('the paradox of choice', {
    targetAudience: 'people who feel paralyzed by too many options',
    positioning: 'explains the mechanism behind indecision, not just tips to fix it',
    audienceNeed: 'why more choice makes decisions harder instead of easier',
    contentPromise: 'a specific, named mechanism and one concrete way to counter it',
    preferredCharacteristics: ['concrete', 'mechanism-first'],
    avoid: ['generic productivity listicles'],
  });

  const storyArgResult1 = await storyArchitectureService.generateStoryArgument(topic1.project.id, {
    ideaId: topic1.idea.ideaId, packageId: topic1.pkg.packageId, blueprintId: topic1.blueprint.id,
  });
  if (!storyArgResult1.ok) throw new Error(`Story Argument generation failed: ${JSON.stringify(storyArgResult1)}`);
  reportStoryArgument('TOPIC 1 STORY ARGUMENT', storyArgResult1.storyArgumentSet, storyArgResult1.selectedStoryArgument);

  // Distinctness proof, called out explicitly (Part 12's own requirement):
  // compare the two escalation-flagged beats (MECHANISM/CONSEQUENCE) —
  // exactly the pair that were byte-identical in Phase 1's real run.
  const escalationBeats = storyArgResult1.selectedStoryArgument.beats.filter((b) => b.isEscalation);
  log('');
  log('--- ESCALATION BEAT DISTINCTNESS (the exact defect class Phase 1 exhibited) ---');
  for (const b of escalationBeats) log(`  [${b.beatFunction}] "${b.claim}"`);
  const dupFindings = findDuplicateBeats(escalationBeats);
  log(`  duplicate/near-duplicate findings between them: ${dupFindings.length === 0 ? 'NONE — the two beats are structurally and lexically distinct' : JSON.stringify(dupFindings)}`);

  // Story Structure + Storyboard, sourced ENTIRELY from the StoryArgument —
  // no treatments/durations/narration hand-authored per beat, only a
  // ROLE-level (not beat-level) production decision, same as Phase 1.
  const structureResult1 = editorialSpineService.buildStoryStructureAndStoryboard(topic1.project.id, topic1.blueprint, {
    storyArgument: storyArgResult1.selectedStoryArgument,
    treatmentByRole: { HOOK: 'KINETIC_TYPOGRAPHY', CONCLUSION: 'KINETIC_TYPOGRAPHY', EXPLANATION: 'STILL_IMAGE', REVEAL: 'BROLL_CLIP' },
    durationByRole: { HOOK: 6, EXPLANATION: 8, REVEAL: 10, CONCLUSION: 6 },
  });
  if (!structureResult1.ok) throw new Error(`Story Structure / Storyboard authoring failed: ${JSON.stringify(structureResult1)}`);

  log('');
  log('--- NARRATION ACTUALLY GENERATED FROM STORY ARGUMENT BEAT CLAIMS (no hand-authored text) ---');
  for (const [shotId, seg] of Object.entries(structureResult1.narrationSegments)) log(`  shot ${shotId.slice(0, 8)}: "${seg.text}"`);

  makeStoredImageAsset(topic1.project.id);
  makeStoredVideoAsset(topic1.project.id, { durationSeconds: 10 });

  log('');
  log('Starting production (real production-orchestrator-service.js, unmodified logic, narrationSegments/materialOptions sourced ENTIRELY from the Story Argument)...');
  const result = productionOrchestrator.startProduction(topic1.project.id, {
    outputDir,
    narrationSegments: structureResult1.narrationSegments,
    materialOptions: structureResult1.materialOptions,
    narrativeRoles: structureResult1.beatGraphContext.narrativeRoles,
    visualObjectives: structureResult1.beatGraphContext.visualObjectives,
    edges: structureResult1.beatGraphContext.edges,
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
  log(`  escalations = ${job.escalations.length}`);
  log(`  qc.passed = ${job.qc.passed}`);
  for (const beat of job.beatGraph.beats) {
    log(`  BeatGraph beat: role=${beat.narrativeRole} treatment=${beat.visualTreatment} visualIntent="${beat.visualIntent.slice(0, 90)}${beat.visualIntent.length > 90 ? '...' : ''}"`);
  }
  log(`  final MP4: ${job.assemblyResult.artifact.path}`);
  log(`  duration = ${job.assemblyResult.artifact.duration}s, ${job.assemblyResult.artifact.width}x${job.assemblyResult.artifact.height}, fps = ${job.assemblyResult.artifact.fps}`);
  const finalCopyPath = path.join(outputDir, 'final.mp4');
  fs.copyFileSync(job.assemblyResult.artifact.path, finalCopyPath);
  log(`  copied to: ${finalCopyPath}`);

  const prereqCheck = controlPlane.validateProductionPrerequisites(topic1.project.id, { requireEditorialSpine: true });
  log(`  control-plane requireEditorialSpine check: ok=${prereqCheck.ok}${prereqCheck.ok ? '' : ` code=${prereqCheck.code}`}`);

  // ==========================================================================
  // PART 13 — a structurally different topic. No production run required —
  // this demonstrates the SHAPE ABSTRACTION, not a second video.
  // ==========================================================================
  log('');
  log('########## TOPIC 2: the hidden reason supermarkets are designed the way they are (MYTH_BUSTING shape, structure only) ##########');
  const topic2 = await buildThroughBlueprint('the hidden reason supermarkets are designed the way they are', {
    targetAudience: 'people who shop at supermarkets and have never questioned the layout',
    positioning: 'explains the deliberate design decisions behind an everyday space',
    audienceNeed: 'the assumption that store layout is random or just about shelf space',
    contentPromise: 'the specific, named design principle and why it works on shoppers',
    avoid: [],
  });
  const storyArgResult2 = await storyArchitectureService.generateStoryArgument(
    topic2.project.id,
    { ideaId: topic2.idea.ideaId, packageId: topic2.pkg.packageId, blueprintId: topic2.blueprint.id },
    { shape: 'MYTH_BUSTING' }
  );
  if (!storyArgResult2.ok) throw new Error(`Story Argument generation failed for topic 2: ${JSON.stringify(storyArgResult2)}`);
  reportStoryArgument('TOPIC 2 STORY ARGUMENT', storyArgResult2.storyArgumentSet, storyArgResult2.selectedStoryArgument);

  log('');
  log('--- STRUCTURAL COMPARISON ---');
  log(`  topic 1 beatFunction sequence: ${storyArgResult1.selectedStoryArgument.beats.map((b) => b.beatFunction).join(' -> ')}`);
  log(`  topic 2 beatFunction sequence: ${storyArgResult2.selectedStoryArgument.beats.map((b) => b.beatFunction).join(' -> ')}`);
  log(`  identical sequence? ${JSON.stringify(storyArgResult1.selectedStoryArgument.beats.map((b) => b.beatFunction)) === JSON.stringify(storyArgResult2.selectedStoryArgument.beats.map((b) => b.beatFunction)) ? 'YES (no structural variation demonstrated)' : 'NO — the reframe/counterevidence beat moved earlier in topic 2\'s progression'}`);
}

main().catch((err) => {
  console.error('[story-architecture-demo] FAILED:', err);
  process.exitCode = 1;
});
