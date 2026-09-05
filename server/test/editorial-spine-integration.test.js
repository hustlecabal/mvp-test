// editorial-spine-integration.test.js — PHASE 1 EDITORIAL SPINE, Part 11's
// required integration test:
//
//   Strategy -> Idea -> Package -> Blueprint -> Story Structure -> BeatGraph
//
// produces a valid, production-ready editorial object. This is the ONE
// test that proves the full chain — every individual stage already has its
// own focused unit tests (editorial-strategy-store, idea-engine-service,
// packaging-engine-service, story-structure-service, creative-brain-
// service's package-integration tests, control-plane-service's
// requireEditorialSpine tests); this file proves they compose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [envVar, prefix] of [
  ['PROJECT_DATA_DIR', 'evolink-spine-projects-'],
  ['CREATIVE_DATA_DIR', 'evolink-spine-creative-'],
  ['CREATIVE_BLUEPRINT_DATA_DIR', 'evolink-spine-blueprints-'],
  ['PRE_PRODUCTION_GATE_DATA_DIR', 'evolink-spine-gates-'],
  ['RECOMMENDATION_DATA_DIR', 'evolink-spine-recs-'],
  ['CREATIVE_BRAIN_APPROVAL_DATA_DIR', 'evolink-spine-cbapprovals-'],
  ['HUMAN_VOICE_PROFILE_DATA_DIR', 'evolink-spine-hvp-'],
  ['EDITORIAL_STRATEGY_DATA_DIR', 'evolink-spine-strategies-'],
  ['IDEA_DATA_DIR', 'evolink-spine-ideas-'],
  ['PACKAGE_DATA_DIR', 'evolink-spine-packages-'],
  ['STORY_STRUCTURE_DATA_DIR', 'evolink-spine-storystructures-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const recommendationStore = require('../services/recommendation-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const creativeBrainApprovalStore = require('../services/creative-brain-approval-store');
const { createFakeCreativeBrainProvider } = require('../services/creative-brain/fake-creative-brain-provider');
const editorialStrategyStore = require('../services/editorial-strategy-store');
const ideaEngineService = require('../services/idea-engine-service');
const packagingEngineService = require('../services/packaging-engine-service');
const editorialSpineService = require('../services/editorial-spine-service');
const controlPlane = require('../services/control-plane-service');
const { deriveBeatGraph } = require('../services/beat-graph-derivation-service');

function newProject() {
  const project = projectStore.createProject({ title: 'editorial spine integration', topic: 'the paradox of choice' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

function addRecommendationSet(projectId) {
  const set = createRecommendationSet({
    projectId,
    referenceSetId: 'rs1',
    recommendations: [
      createRecommendation({ statement: 'Reference videos naming a specific number early retain viewers longer.', rationale: 'NUMERIC pattern, 4/5 support.', evidenceSufficiency: 'SUFFICIENT' }),
    ],
  });
  return recommendationStore.addRecommendationSet(projectId, set).recommendationSet;
}

function approveCreativeBrain(projectId, recommendationSetId) {
  creativeBrainApprovalStore.decideApproval(projectId, recommendationSetId, { approve: true, decidedBy: 'tester' });
  creativeBrainApprovalStore.acknowledgeUnknownCost(projectId, recommendationSetId, { acknowledgedBy: 'tester' });
}

// The default fake-creative-brain-provider.js ANGLE_SHAPES are deliberately
// varied for ITS OWN test file's purposes and are not guaranteed to clear
// every anti-slop evaluation dimension for an arbitrary topic (creative-
// brain-service.test.js's own tests 15/16 guard against this with an `if
// (diagnostics.length === 0)` check rather than assuming it). This
// integration test needs a real, clean APPROVE to prove the FULL chain
// reaches production readiness, so it supplies its own candidateShapes —
// each with a genuine contrast-marker/numeric/quoted concrete anchor in
// its hookStrategy (clears GENERIC_HOOK) and a corePromise that never
// echoes the bare topic string (clears GENERIC_ANGLE) — real evaluation
// still runs against these, unmodified; they are simply engineered to pass
// it, exactly as test 15's genericHookProvider is engineered to fail it.
function spineCandidateShapes() {
  return [
    () => ({
      concept: 'The mechanism nobody names out loud',
      corePromise: 'Not just a matter of willpower — the real mechanism shows up in a specific, measurable 12% shift once it kicks in.',
      hookStrategy: "This isn't about willpower, but about one specific moment most people miss.",
      rationale: 'Mechanism framing, deliberately independent of the bare topic phrase, one concrete numeric anchor.',
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

test('Strategy -> Idea -> Package -> Blueprint -> Story Structure -> BeatGraph produces a valid, production-ready editorial object', async () => {
  const project = newProject();
  const recSet = addRecommendationSet(project.id);

  // --- STRATEGY ------------------------------------------------------------
  const strategyResult = editorialStrategyStore.addStrategy(project.id, {
    targetAudience: 'people who feel paralyzed by too many options',
    positioning: 'explains the mechanism behind indecision, not just tips to fix it',
    audienceNeed: 'why more choice makes decisions harder instead of easier',
    contentPromise: 'a specific, named mechanism and one concrete way to counter it',
    preferredCharacteristics: ['concrete', 'mechanism-first'],
    avoid: ['generic productivity listicles'],
  });
  assert.equal(strategyResult.ok, true);
  const strategy = strategyResult.strategy;

  // --- IDEA ------------------------------------------------------------
  const ideaResult = await ideaEngineService.generateIdeas(project.id, strategy.id);
  assert.equal(ideaResult.ok, true);
  assert.equal(ideaResult.ideaSet.candidates.length, 3);
  assert.equal(ideaResult.ideaSet.candidates.filter((c) => c.selected).length, 1);
  const selectedIdea = ideaResult.selectedIdea;

  // --- PACKAGE ------------------------------------------------------------
  const packageResult = await packagingEngineService.generatePackages(project.id, selectedIdea.ideaId);
  assert.equal(packageResult.ok, true);
  assert.equal(packageResult.packageSet.candidates.length, 3);
  assert.equal(packageResult.packageSet.candidates.filter((c) => c.selected).length, 1);
  const selectedPackage = packageResult.selectedPackage;

  // --- BLUEPRINT (Creative Brain angle generation, package-authoritative
  // identity, real human review + real pre-production gate) -------------
  // First call requests the (still-required, unmodified) Creative Brain
  // financial approval; the second, after approval, actually generates.
  await require('../services/creative-brain-service').generateCreativeBlueprint(project.id, {
    recommendationSetId: recSet.id, topic: selectedIdea.topic, strategyId: strategy.id, selectedIdea, selectedPackage, provider: spineCreativeBrainProvider(),
  });
  approveCreativeBrain(project.id, recSet.id);

  const blueprintResult = await editorialSpineService.buildApprovedBlueprint(project.id, {
    strategyId: strategy.id,
    selectedIdea,
    selectedPackage,
    blueprintOptions: { recommendationSetId: recSet.id, targetDuration: 45, provider: spineCreativeBrainProvider() },
  });
  assert.equal(blueprintResult.ok, true, JSON.stringify(blueprintResult));
  assert.equal(blueprintResult.blueprint.status, 'APPROVED');
  assert.equal(blueprintResult.blueprint.title, selectedPackage.title);
  assert.equal(blueprintResult.blueprint.corePromise, selectedPackage.promise);
  assert.equal(blueprintResult.blueprint.strategyId, strategy.id);
  assert.equal(blueprintResult.blueprint.ideaId, selectedIdea.ideaId);
  assert.equal(blueprintResult.blueprint.packageId, selectedPackage.packageId);
  assert.ok(['ACCEPT', 'OVERRIDE'].includes(blueprintResult.gateResult.humanDecision));

  // --- STORY STRUCTURE + STORYBOARD ---------------------------------------
  // treatmentByRole is keyed by narrativeRole (the one thing known in
  // advance, since beatKey is freshly randomized by every derivation) —
  // a real, non-GENERATED_NEW-eligible production decision, exactly the
  // pattern the earlier Pipeline B demo used, applied here per role
  // instead of per hand-authored shot.
  const { MIN_BEATS } = require('../services/story-structure-service');
  const treatmentByRole = { HOOK: 'KINETIC_TYPOGRAPHY', CONCLUSION: 'KINETIC_TYPOGRAPHY', EXPLANATION: 'STILL_IMAGE', REVEAL: 'STILL_IMAGE' };

  const structureResult = editorialSpineService.buildStoryStructureAndStoryboard(project.id, blueprintResult.blueprint, { treatmentByRole });
  assert.equal(structureResult.ok, true, JSON.stringify(structureResult));
  assert.ok(structureResult.storyStructure.beats.length >= MIN_BEATS);
  assert.equal(structureResult.storyboard.shots.length, structureResult.storyStructure.beats.length);
  assert.equal(structureResult.storyboard.blueprintId, blueprintResult.blueprint.id);
  assert.ok(structureResult.storyboard.shots.every((s) => s.visualTreatment === 'KINETIC_TYPOGRAPHY' || s.visualTreatment === 'STILL_IMAGE'), 'every shot must carry a real, non-GENERATED_NEW-eligible visualTreatment');

  // --- BEATGRAPH — proves the editorial intent actually reaches the real
  // production data structure production-orchestrator-service.js consumes.
  const derivation = deriveBeatGraph(structureResult.storyboard, structureResult.beatGraphContext);
  assert.equal(derivation.status, 'DERIVED');
  assert.equal(derivation.beatGraph.beats.length, structureResult.storyStructure.beats.length);
  assert.equal(derivation.beatGraph.edges.length, structureResult.storyStructure.edges.length);

  const hookOutputBeat = derivation.beatGraph.beats.find((b) => b.narrativeRole === 'HOOK');
  assert.ok(hookOutputBeat, 'a HOOK beat must exist in the final BeatGraph');
  assert.ok(hookOutputBeat.visualIntent && hookOutputBeat.visualIntent.length > 0);
  const conclusionOutputBeat = derivation.beatGraph.beats.find((b) => b.narrativeRole === 'CONCLUSION');
  assert.ok(conclusionOutputBeat, 'a CONCLUSION beat must exist in the final BeatGraph');

  // --- PROMISE TRACEABILITY (Part 10) — Package -> Blueprint.corePromise
  // -> StoryStructure.corePromise, an explicit, checkable chain.
  assert.equal(structureResult.storyStructure.corePromise, blueprintResult.blueprint.corePromise);
  assert.equal(structureResult.storyStructure.corePromise, selectedPackage.promise);

  // --- STRUCTURAL READINESS (Part 9) — the extended, opt-in control-plane
  // check confirms every editorial-spine link is present and SELECTED.
  const prereqCheck = controlPlane.validateProductionPrerequisites(project.id, { requireEditorialSpine: true });
  assert.equal(prereqCheck.ok, true, JSON.stringify(prereqCheck));
});
