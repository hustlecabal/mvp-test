// editorial-spine-service.js
//
// PHASE 1 EDITORIAL SPINE — the thin coordinator that drives an already-
// generated/selected Idea and Package through the REST of the real,
// existing chain: Creative Brain (angle generation) -> CreativeBlueprint
// review/approval -> Pre-Production Gate -> Story Structure derivation ->
// real Storyboard authoring -> the exact BeatGraph derivation context
// beat-graph-derivation-service.js already accepts.
//
// COORDINATION ONLY (same discipline creative-brain-service.js's own
// header documents for itself): no creative reasoning happens in this
// file, no second representation of any record it touches, and it drives
// EXISTING human-authority functions (reviewCreativeBlueprint/
// decideGateResult) exactly as a human operator would — it does not
// bypass them, weaken them, or introduce a second approval mechanism.
//
// This file does NOT generate the Idea or the Package itself — call
// idea-engine-service.js / packaging-engine-service.js first (they are
// independent, directly testable/callable on their own) and pass the
// resulting selected Idea/Package in.

const creativeBrainService = require('./creative-brain-service');
const creativeBlueprintService = require('./creative-blueprint-service');
const preProductionGateService = require('./pre-production-gate-service');
const storyStructureService = require('./story-structure-service');
const storyStructureStore = require('./story-structure-store');

// Drives Creative Brain generation through to an APPROVED Blueprint with an
// ACCEPTED/OVERRIDDEN gate result — the exact chain control-plane-
// service.js's validateProductionPrerequisites() checks for — using the
// selected Idea's topic and the selected Package as authoritative identity
// (see creative-brain-service.js's own `selectedPackage` handling).
//
//   blueprintOptions — everything generateCreativeBlueprint() itself needs
//     that this file cannot supply on its own: referenceSetId/
//     recommendationSetId (a real RecommendationSet still has to exist —
//     this phase reuses that EXISTING precondition rather than building a
//     new acquisition/analysis system), format, targetDuration, provider
//     (a CreativeBrainProvider — e.g. a fake provider in tests),
//     candidateCount.
async function buildApprovedBlueprint(projectId, { strategyId, selectedIdea, selectedPackage, blueprintOptions = {}, decidedBy = 'editorial-spine' } = {}) {
  const generated = await creativeBrainService.generateCreativeBlueprint(projectId, {
    ...blueprintOptions,
    topic: selectedIdea.topic,
    strategyId,
    selectedIdea,
    selectedPackage,
  });
  if (!generated.ok) return { ok: false, code: generated.code, reason: generated.reason, diagnostics: generated.diagnostics };

  const submitted = creativeBlueprintService.submitCreativeBlueprintForReview(projectId, generated.blueprint.id, { submittedBy: decidedBy });
  if (!submitted.ok) return { ok: false, code: 'SUBMIT_FAILED', reason: submitted.reason };

  const approved = creativeBlueprintService.reviewCreativeBlueprint(projectId, generated.blueprint.id, { decision: 'APPROVE', reviewedBy: decidedBy });
  if (!approved.ok) return { ok: false, code: 'APPROVE_FAILED', reason: approved.reason };

  const evaluated = preProductionGateService.evaluatePreProductionGate(projectId, approved.blueprint.id);
  if (!evaluated.ok) return { ok: false, code: 'GATE_EVALUATION_FAILED', reason: evaluated.reason };

  // A clean PROCEED verdict is ACCEPTed; anything else is OVERRIDDEN with
  // an explicit rationale — mirrors this codebase's own existing test
  // convention (test/control-plane-service.test.js scenarios H/I1) rather
  // than inventing a new decision policy.
  const decision = evaluated.gateResult.machineAssessment === 'PROCEED' ? 'ACCEPT' : 'OVERRIDE';
  const decided = preProductionGateService.decideGateResult(projectId, evaluated.gateResult.id, {
    decision,
    decidedBy,
    rationale: decision === 'OVERRIDE' ? `Editorial spine demo: overriding a ${evaluated.gateResult.machineAssessment} verdict to proceed with a controlled demo topic.` : undefined,
  });
  if (!decided.ok) return { ok: false, code: 'GATE_DECISION_FAILED', reason: decided.reason };

  return { ok: true, blueprint: approved.blueprint, gateResult: decided.gateResult };
}

// Derives + persists a StoryStructure for an APPROVED Blueprint, authors it
// into a real Storyboard, and returns the exact context object
// production-orchestrator-service.js's startProduction() already accepts
// via options.narrativeRoles/visualObjectives/edges (see beat-graph-
// derivation-service.js's own extended context shape, Phase 1 Part 6/7).
function buildStoryStructureAndStoryboard(projectId, blueprint, { beatCount, treatments = {}, treatmentByRole = {}, durations = {}, durationByRole = {}, sceneTitle } = {}) {
  const derived = storyStructureService.deriveStoryStructure(blueprint, { beatCount });
  if (!derived.ok) return { ok: false, code: derived.code, reason: derived.reason };

  const saved = storyStructureStore.addStoryStructure(projectId, derived.storyStructure);
  if (!saved.ok) return { ok: false, code: 'PERSIST_FAILED', reason: saved.reason };

  const authored = storyStructureService.authorStoryboardFromStoryStructure(projectId, saved.storyStructure, { treatments, treatmentByRole, durations, durationByRole, sceneTitle });
  if (!authored.ok) return { ok: false, code: 'AUTHOR_STORYBOARD_FAILED', reason: authored.reason };

  const beatGraphContext = storyStructureService.buildBeatGraphContext(saved.storyStructure, authored.beatKeyToShotId);

  return { ok: true, storyStructure: saved.storyStructure, storyboard: authored.storyboard, beatKeyToShotId: authored.beatKeyToShotId, beatGraphContext };
}

module.exports = { buildApprovedBlueprint, buildStoryStructureAndStoryboard };
