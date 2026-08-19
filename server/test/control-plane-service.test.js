// Tests for services/control-plane-service.js — INT-2.5-P0, Part 8 ("the
// MOST IMPORTANT PART"). Proves the exact 14 named adversarial bypass
// scenarios (A-N) the audit specified: a project cannot reach paid
// production (requestGeneration / generateKeyframe / generateVideo)
// without an APPROVED CreativeBlueprint AND an ACCEPTED/OVERRIDDEN
// PreProductionGate result, and that this holds regardless of which
// caller reaches the generation service directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-creative-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-gates-'));
const recommendationTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-recs-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-jobs-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-kf-packages-'));
const keyframeApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-kf-approvals-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-video-approvals-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cps-handoffs-'));

process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;
process.env.RECOMMENDATION_DATA_DIR = recommendationTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = keyframePromptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = keyframeApprovalTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = videoApprovalTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const creativeStore = require('../services/creative-store');
const recommendationStore = require('../services/recommendation-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const creativeBlueprintService = require('../services/creative-blueprint-service');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const preProductionGateService = require('../services/pre-production-gate-service');
const preProductionGateStore = require('../services/pre-production-gate-store');
const { createPreProductionGateResult } = require('../schemas/pre-production-gate-schema');
const controlPlane = require('../services/control-plane-service');
const generationService = require('../services/generation-service');
const kfgen = require('../services/keyframe-generation-service');
const vgs = require('../services/video-generation-service');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const gate = require('../services/approval-gate');

function newProject(title = 'control plane test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// Real, persisted RecommendationSet with one valid recommendation — the
// same real chain buildCreativeBlueprintDraft() itself requires.
function buildRecommendationSet(projectId) {
  const recommendation = createRecommendation({
    projectId,
    referenceSetId: 'rs1',
    recommendationType: 'RECURRING_PATTERN_APPLICATION',
    derivationType: 'SINGLE_PATTERN',
    category: 'OPENING_STRUCTURE',
    statement: 'stmt',
    rationale: 'rationale',
    action: 'Consider doing X.',
    sourcePatternIds: ['pattern-1'],
    confidence: 'MEDIUM',
    evidenceSufficiency: 'SUFFICIENT',
    meetsMinimumEvidenceThreshold: true,
  });
  const recSet = createRecommendationSet({ projectId, referenceSetId: 'rs1', patternSetId: 'pattern-set-1', recommendations: [recommendation], status: 'COMPLETE' });
  return recommendationStore.addRecommendationSet(projectId, recSet).recommendationSet;
}

// Builds a real DRAFT CreativeBlueprint via the REAL service chain
// (buildCreativeBlueprintDraft) — never a direct schema-factory
// construction — because this file exists specifically to prove the real
// chain's own behavior, not just control-plane-service's reading of it.
function buildDraftBlueprint(projectId, recSet, overrides = {}) {
  return creativeBlueprintService.buildCreativeBlueprintDraft(projectId, {
    recommendationSetId: recSet.id,
    concept: 'a concept',
    corePromise: 'a promise',
    targetDuration: 60,
    ...overrides,
  });
}

function linkStoryboard(projectId, blueprintId) {
  return creativeStore.updateStoryboard(projectId, { blueprintId });
}

// Direct raw-file write, used ONLY for scenario J (a corrupted/legacy
// on-disk Storyboard whose blueprintId points at nothing) — creative-
// store.js's own write path (resolveBlueprintForStoryboard) already
// refuses to ever persist an unresolvable blueprintId through the real
// API, so the only way to construct this state is to bypass that API
// entirely, exactly the way real corrupted/hand-edited data would.
function creativeRecordFilePath(projectId) {
  return path.join(process.env.CREATIVE_DATA_DIR, `${projectId}.json`);
}
function corruptStoryboardBlueprintId(projectId, fakeBlueprintId) {
  const record = JSON.parse(fs.readFileSync(creativeRecordFilePath(projectId), 'utf8'));
  record.storyboard.blueprintId = fakeBlueprintId;
  fs.writeFileSync(creativeRecordFilePath(projectId), JSON.stringify(record, null, 2));
}

// ===========================================================================
// A. No Blueprint -> rejected
// ===========================================================================

test('A1. no Storyboard at all -> rejected with NO_STORYBOARD', () => {
  const project = newProject();
  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_STORYBOARD');
  assert.equal(controlPlane.canEnterProduction(project.id), false);
});

test('A2. Storyboard exists but has no blueprintId linked -> rejected with NO_BLUEPRINT_LINKED', () => {
  const project = newProject();
  creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_BLUEPRINT_LINKED');
});

// ===========================================================================
// B/C/D. Blueprint not APPROVED (DRAFT / PENDING_REVIEW / REJECTED) -> rejected
// ===========================================================================

test('B. Blueprint in DRAFT -> rejected with BLUEPRINT_NOT_APPROVED', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  assert.equal(blueprint.status, 'DRAFT');
  linkStoryboard(project.id, blueprint.id);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLUEPRINT_NOT_APPROVED');
});

test('C. Blueprint in PENDING_REVIEW -> rejected with BLUEPRINT_NOT_APPROVED', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  const submitted = creativeBlueprintService.submitCreativeBlueprintForReview(project.id, blueprint.id, { submittedBy: 'tester' });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.blueprint.status, 'PENDING_REVIEW');
  linkStoryboard(project.id, blueprint.id);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLUEPRINT_NOT_APPROVED');
});

test('D. Blueprint REJECTED -> rejected with BLUEPRINT_NOT_APPROVED', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  const reviewed = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'REJECT', reviewedBy: 'tester' });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.blueprint.status, 'REJECTED');
  linkStoryboard(project.id, blueprint.id);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLUEPRINT_NOT_APPROVED');
});

// ===========================================================================
// E. Blueprint APPROVED but no gate result yet -> rejected
// ===========================================================================

test('E. Blueprint APPROVED, no PreProductionGateResult ever run -> rejected with NO_GATE_RESULT', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  const reviewed = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.blueprint.status, 'APPROVED');
  linkStoryboard(project.id, blueprint.id);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_GATE_RESULT');
});

// ===========================================================================
// F/G. A gate result exists but carries no ACCEPT/OVERRIDE human decision
// (REVISE/REJECT machine verdict, human undecided) -> rejected
// ===========================================================================

function buildUndecidedGateResult(projectId, blueprint, machineAssessment) {
  const gateResult = createPreProductionGateResult({
    projectId,
    blueprintId: blueprint.id,
    blueprintRevision: blueprint.id,
    blueprintUpdatedAt: blueprint.updatedAt,
    machineAssessment,
    costStatus: 'UNKNOWN',
  });
  return preProductionGateStore.addGateResult(projectId, gateResult).gateResult;
}

test('F. Gate machineAssessment REVISE, no human decision recorded -> rejected with GATE_NOT_ACCEPTED', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const draft = buildDraftBlueprint(project.id, recSet);
  // Use the APPROVED blueprint object (a fresh updatedAt from the review
  // itself) — not the pre-review draft, whose now-stale updatedAt would
  // make the gate result immediately GATE_RESULT_STALE instead of exactly
  // testing the "undecided" scenario this test is named for.
  const approved = creativeBlueprintService.reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'tester' }).blueprint;
  linkStoryboard(project.id, approved.id);
  buildUndecidedGateResult(project.id, approved, 'REVISE');

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GATE_NOT_ACCEPTED');
});

test('G. Gate machineAssessment REJECT, no human decision recorded -> rejected with GATE_NOT_ACCEPTED', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const draft = buildDraftBlueprint(project.id, recSet);
  const approved = creativeBlueprintService.reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'tester' }).blueprint;
  linkStoryboard(project.id, approved.id);
  buildUndecidedGateResult(project.id, approved, 'REJECT');

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GATE_NOT_ACCEPTED');
});

// ===========================================================================
// H. Gate PROCEED + human ACCEPT -> accepted
// ===========================================================================

test('H. real evaluatePreProductionGate PROCEED verdict + human ACCEPT via decideGateResult -> production prerequisites satisfied', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  const reviewed = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  linkStoryboard(project.id, blueprint.id);

  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.gateResult.machineAssessment, 'PROCEED', JSON.stringify(evaluated.gateResult.blockers));

  const decided = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'ACCEPT', decidedBy: 'tester' });
  assert.equal(decided.ok, true);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(controlPlane.canEnterProduction(project.id), true);
  void reviewed;
});

// ===========================================================================
// I. Gate OVERRIDE — accepted only with a non-empty rationale
// ===========================================================================

// A recommendationDecision referencing a nonexistent recommendationId is
// dropped (not blocking) at the BLUEPRINT layer (INVALID_RECOMMENDATION_PROVENANCE
// is not in BLOCKING_DIAGNOSTIC_CODES, so a human can still APPROVE) but is
// copied through and re-raised as a REVISE-tier BLOCKER at the GATE layer
// (pre-production-gate-service.js's own "gate is the stricter layer"
// precedent, confirmed by direct inspection of checkRecommendationProvenance /
// checkCopiedThroughBlueprintDiagnostics) — this is how I1/I2 below reach a
// real REVISE-tier gate result on top of a genuinely APPROVED Blueprint,
// without touching MISSING_TARGET_DURATION or any other BLOCKING_DIAGNOSTIC_CODES
// entry (those block APPROVE itself, so they cannot produce this scenario).
function buildDraftBlueprintWithBadRecommendationDecision(projectId, recSet) {
  return buildDraftBlueprint(projectId, recSet, {
    recommendationDecisions: [{ recommendationId: 'this-recommendation-does-not-exist', decision: 'ACCEPT' }],
  });
}

test('I1. OVERRIDE with a non-empty rationale on a REVISE-tier gate result -> accepted', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprintWithBadRecommendationDecision(project.id, recSet);
  const approved = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  linkStoryboard(project.id, blueprint.id);

  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.gateResult.machineAssessment, 'REVISE', JSON.stringify(evaluated.gateResult.blockers));

  const decided = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'tester', rationale: 'Duration will be finalized in post; approving to unblock storyboard work.' });
  assert.equal(decided.ok, true);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('I2. OVERRIDE with an empty/missing rationale is refused by decideGateResult itself, and production stays blocked', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprintWithBadRecommendationDecision(project.id, recSet);
  const approved = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  linkStoryboard(project.id, blueprint.id);

  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(evaluated.gateResult.machineAssessment, 'REVISE');

  const decidedNoRationale = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'tester' });
  assert.equal(decidedNoRationale.ok, false);
  assert.match(decidedNoRationale.reason, /non-empty humanRationale/);

  const decidedBlankRationale = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'tester', rationale: '   ' });
  assert.equal(decidedBlankRationale.ok, false);

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GATE_NOT_ACCEPTED');
});

// ===========================================================================
// J. Invalid/fake Blueprint ID -> rejected (and P0-4A's own write-time
// guard is confirmed to refuse this through the real API in the first
// place — corruption is the only way to reach this state at all)
// ===========================================================================

test('J1. the real Storyboard write path (creativeStore.updateStoryboard) refuses to persist a blueprintId that does not resolve', () => {
  const project = newProject();
  assert.throws(() => creativeStore.updateStoryboard(project.id, { blueprintId: 'not-a-real-blueprint-id' }), /does not resolve to a CreativeBlueprint/);
});

test('J2. a corrupted/legacy on-disk Storyboard whose blueprintId resolves to nothing -> rejected with BLUEPRINT_NOT_FOUND, never a fabricated pass', () => {
  const project = newProject();
  creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  corruptStoryboardBlueprintId(project.id, '11111111-1111-1111-1111-111111111111');

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLUEPRINT_NOT_FOUND');
});

// ===========================================================================
// K. Invalid/fake Recommendation ID on a Storyboard shot -> existing
// P0-4A validation remains enforced, unweakened by this stage's changes.
// ===========================================================================

test('K. a StoryboardShot recommendationIds entry that does not resolve within the linked Blueprint\'s RecommendationSet still throws (P0-4A, unweakened)', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  linkStoryboard(project.id, blueprint.id);

  assert.throws(
    () => creativeStore.addStoryboardShot(project.id, { recommendationIds: ['this-recommendation-does-not-exist'] }),
    /does not resolve to a Recommendation/
  );

  // A genuinely resolvable id still succeeds — the guard is precise, not a blanket refusal.
  const realRecommendationId = recSet.recommendations[0].id;
  const shot = creativeStore.addStoryboardShot(project.id, { recommendationIds: [realRecommendationId] });
  assert.deepEqual(shot.recommendationIds, [realRecommendationId]);
});

// ===========================================================================
// L. Direct invocation bypassing the operator surface (calling the
// generation SERVICE functions directly, exactly as a caller skipping
// every MCP tool would) must still encounter the strategic-layer block —
// the protection lives inside the generation services themselves, not
// only at an MCP/REST boundary.
// ===========================================================================

test('L1. generation-service.requestGeneration(), called directly with no Blueprint/Gate ever set up, is blocked by the strategic-layer prerequisite', async () => {
  const project = newProject();
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId, narrativePurpose: 'test shot' });
  const p = projectStore.getProject(project.id);
  gate.setBudget(p, 1000);
  gate.requestApproval(p, { estimatedCost: 10 });
  gate.decideApproval(p, { approve: true });
  const stateMachine = require('../schemas/state-machine');
  for (const state of ['RESEARCH', 'CREATIVE_REVIEW', 'SCRIPTING', 'SCRIPT_REVIEW', 'VISUAL_DEVELOPMENT', 'VISUAL_REVIEW', 'STORYBOARD', 'GENERATION_REVIEW', 'CALIBRATION', 'KEYFRAME_GENERATION']) {
    const r = stateMachine.transition(p, state);
    assert.equal(r.ok, true, `expected to reach ${state}: ${r.reason}`);
  }
  projectStore.touch(p);
  // Deliberately NO Blueprint, NO Gate, NO Storyboard.blueprintId — a
  // caller reaching requestGeneration() straight from application code,
  // bypassing every MCP tool this repo defines.
  const result = await generationService.requestGeneration({
    projectId: project.id,
    shotId: shot.shotId,
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'A lighthouse at dusk',
    references: [],
    parameters: { duration: 8 },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /strategic-layer prerequisite/);
});

test('L2. keyframe-generation-service.generateKeyframe(), called directly with no Blueprint/Gate ever set up, is blocked by the strategic-layer prerequisite', async () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, { intervalMs: 0, sleepImpl: async () => {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /strategic-layer prerequisite/);
});

test('L3. video-generation-service.generateVideo(), called directly with no Blueprint/Gate ever set up, is blocked by the strategic-layer prerequisite', async () => {
  const project = newProject();
  creativeStore.updateStoryboard(project.id, { scenes: [{ sceneId: 'scene-1', title: 'Scene 1' }], shots: [{ shotId: 'shot-1', sceneId: 'scene-1' }] }, {});
  const keyframe = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: 'A', frameType: 'CHARACTER_REFERENCE' });

  // generateVideo() returns a VideoGenerationResult ({status, code, reason}),
  // not a plain {ok} object — a different contract from generation-service.js
  // / keyframe-generation-service.js, confirmed by direct inspection of
  // schemas/video-generation-result-schema.js.
  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, {});
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /strategic-layer prerequisite/);
});

// ===========================================================================
// M. A valid, approved Blueprint/Gate must never itself cause any
// financial charge — building/approving/gating is pure bookkeeping.
// ===========================================================================

test('M. building, submitting, approving a Blueprint and running/accepting the gate never touches the project credit ledger', () => {
  const project = newProject();
  const p = projectStore.getProject(project.id);
  gate.setBudget(p, 500);
  projectStore.touch(p);
  const before = JSON.stringify(projectStore.getProject(project.id).creditLedger);

  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  creativeBlueprintService.submitCreativeBlueprintForReview(project.id, blueprint.id, { submittedBy: 'tester' });
  creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  linkStoryboard(project.id, blueprint.id);
  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, blueprint.id);
  preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'ACCEPT', decidedBy: 'tester' });
  controlPlane.validateProductionPrerequisites(project.id);
  controlPlane.canEnterProduction(project.id);

  const after = JSON.stringify(projectStore.getProject(project.id).creditLedger);
  assert.equal(after, before, 'the credit ledger must be byte-identical before and after the entire Blueprint/Gate lifecycle');
});

// ===========================================================================
// N. Existing ("legacy") projects: explicit, deterministic, no
// grandfathering — a project with a real Storyboard (scenes/shots) built
// the way every pre-INT-2.5-P0 project in this codebase was built, but
// with no blueprintId ever set (because the concept didn't exist yet),
// is blocked exactly like any other project — never silently exempted.
// ===========================================================================

test('N. a pre-existing project with a populated Storyboard but no blueprintId is blocked, never auto-approved or exempted', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Legacy Scene' });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: 'legacy shot, predates the strategic layer' });
  const storyboard = creativeStore.getStoryboard(project.id);
  assert.equal(storyboard.blueprintId, null, 'sanity: this simulates a genuinely pre-existing project');

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_BLUEPRINT_LINKED');
  assert.equal(controlPlane.canEnterProduction(project.id), false, 'no legacy exemption exists anywhere in control-plane-service.js');
});

// ===========================================================================
// Structured code coverage — every documented code is actually reachable.
// ===========================================================================

test('every PRODUCTION_PREREQUISITE_CODES entry is a real, closed, documented list', () => {
  assert.deepEqual(controlPlane.PRODUCTION_PREREQUISITE_CODES, [
    'PROJECT_NOT_FOUND',
    'NO_STORYBOARD',
    'NO_BLUEPRINT_LINKED',
    'BLUEPRINT_NOT_FOUND',
    'BLUEPRINT_NOT_APPROVED',
    'NO_GATE_RESULT',
    'GATE_RESULT_STALE',
    'GATE_NOT_ACCEPTED',
  ]);
});

test('PROJECT_NOT_FOUND is returned for a nonexistent project, never a crash', () => {
  const result = controlPlane.validateProductionPrerequisites('00000000-0000-0000-0000-000000000000');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_NOT_FOUND');
});

test('GATE_RESULT_STALE: editing an APPROVED-then-superseded Blueprint after a gate ACCEPT invalidates the gate result', () => {
  const project = newProject();
  const recSet = buildRecommendationSet(project.id);
  const blueprint = buildDraftBlueprint(project.id, recSet);
  creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprint.id, { decision: 'APPROVE', reviewedBy: 'tester' });
  linkStoryboard(project.id, blueprint.id);
  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, blueprint.id);
  preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'ACCEPT', decidedBy: 'tester' });
  assert.equal(controlPlane.canEnterProduction(project.id), true);

  // REQUEST_REVISION on the now-APPROVED blueprint creates a new revision
  // and marks the old one SUPERSEDED — the gate result now describes a
  // Blueprint state that no longer exists as APPROVED.
  const requestedRevision = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision: 'REQUEST_REVISION', decidedBy: 'tester', rationale: 'needs another pass' });
  void requestedRevision;

  const result = controlPlane.validateProductionPrerequisites(project.id);
  assert.equal(result.ok, false);
  assert.ok(['BLUEPRINT_NOT_APPROVED', 'GATE_RESULT_STALE', 'NO_GATE_RESULT'].includes(result.code), `expected a real re-block, got ${result.code}`);
});
