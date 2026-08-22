// Tests for services/pre-production-gate-service.js (INT-2.5).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgservice-projects-'));
process.env.CREATIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgservice-creative-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgservice-blueprints-'));
process.env.RECOMMENDATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgservice-recs-'));
process.env.PRE_PRODUCTION_GATE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ppgservice-gates-'));

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const recommendationStore = require('../services/recommendation-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const gateStore = require('../services/pre-production-gate-store');
const creativeBlueprintService = require('../services/creative-blueprint-service');
const gateService = require('../services/pre-production-gate-service');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function setupRecommendationSet(projectId, referenceSetId, recOverridesList) {
  const recs = recOverridesList.map((overrides) =>
    createRecommendation({
      projectId,
      referenceSetId,
      recommendationType: 'RECURRING_PATTERN_APPLICATION',
      derivationType: 'SINGLE_PATTERN',
      category: 'OPENING',
      statement: 'stmt',
      rationale: 'rationale',
      action: 'Consider doing X.',
      sourcePatternIds: ['pattern-1'],
      confidence: 'MEDIUM',
      evidenceSufficiency: 'SUFFICIENT',
      meetsMinimumEvidenceThreshold: true,
      ...overrides,
    })
  );
  const set = createRecommendationSet({ projectId, referenceSetId, patternSetId: 'pattern-set-1', recommendations: recs, status: 'COMPLETE' });
  const saved = recommendationStore.addRecommendationSet(projectId, set);
  return saved.recommendationSet;
}

function buildAndApproveBlueprint(project, recSet, draftInput = {}) {
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: recSet.referenceSetId,
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    hookStrategy: 'open with a question',
    ...draftInput,
  });
  if (draft.diagnostics.filter((d) => require('../schemas/creative-blueprint-schema').BLOCKING_DIAGNOSTIC_CODES.includes(d.code)).length === 0) {
    creativeBlueprintService.reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human1' });
    return creativeBlueprintStore.getCreativeBlueprint(project.id, draft.id);
  }
  return draft;
}

// --- 1. schema/integration sanity ---
test('1. evaluatePreProductionGate persists a real PreProductionGateResult with the expected top-level shape', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(result.ok, true);
  assert.match(result.gateResult.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.gateResult.blueprintId, blueprint.id);
  assert.equal(result.gateResult.blueprintRevision, blueprint.id);
  assert.ok(gateService.GATE_ASSESSMENT_VALUES.includes(result.gateResult.machineAssessment));
});

// --- 2. all three assessment states ---
test('2a. PROCEED — a clean APPROVED Blueprint with no blockers', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(result.gateResult.machineAssessment, 'PROCEED');
  assert.equal(result.gateResult.blockers.length, 0);
});

test('2b. REVISE — a non-APPROVED Blueprint with a fixable defect (INVALID_RECOMMENDATION_PROVENANCE) but no structural impossibility', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  // Simulate a real INVALID_RECOMMENDATION_PROVENANCE the way INT-2 itself records one (bad recommendationId), then read the diagnostic back off the persisted draft.
  const draftWithBadProvenance = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: '11111111-1111-4111-8111-111111111111', decision: 'ACCEPT' }],
  });
  void draft;
  const result = gateService.evaluatePreProductionGate(project.id, draftWithBadProvenance.id);
  assert.equal(result.gateResult.machineAssessment, 'REVISE');
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'INVALID_RECOMMENDATION_PROVENANCE'));
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'BLUEPRINT_NOT_APPROVED'));
  assert.ok(!result.gateResult.blockers.some((b) => gateService.REJECT_TIER_BLOCKER_CODES.has(b.code)));
});

test('2c. REJECT — a genuinely structurally contradictory Blueprint', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  void recSet;
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    structuralDirection: { plannedSectionCount: 8, minimumSectionDurationSeconds: 20 },
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.gateResult.machineAssessment, 'REJECT');
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'CONTRADICTORY_STRUCTURE'));
});

// --- 3. completeness ---
test('3a. missing concept is a BLOCKER', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', corePromise: 'p', targetDuration: 60 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'MISSING_CONCEPT'));
});

test('3b. missing corePromise is a BLOCKER', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', targetDuration: 60 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'MISSING_CORE_PROMISE'));
});

test('3c. invalid (non-positive) targetDuration is a BLOCKER', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: -1 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'INVALID_TARGET_DURATION'));
});

// --- 4. APPROVED vs non-APPROVED ---
test('4. a non-APPROVED Blueprint always carries BLUEPRINT_NOT_APPROVED as a blocker', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'BLUEPRINT_NOT_APPROVED'));
});

// --- 5. evidence alignment / recommendation provenance ---
test('5. INVALID_RECOMMENDATION_PROVENANCE is a BLOCKER at the gate even though it is non-blocking at the Blueprint layer (Part 2A, locked)', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: '11111111-1111-4111-8111-111111111111', decision: 'ACCEPT' }],
  });
  // Confirm the Blueprint layer itself did NOT block this (INT-2's own policy, unmodified).
  assert.ok(!require('../schemas/creative-blueprint-schema').BLOCKING_DIAGNOSTIC_CODES.includes('INVALID_RECOMMENDATION_PROVENANCE'));
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'INVALID_RECOMMENDATION_PROVENANCE'));
});

// --- 6. recommendation alignment (strategic alignment) ---
test('6. an accepted recommendation whose category maps to an empty Blueprint strategy field produces RECOMMENDATION_ALIGNMENT_UNVERIFIED (WARNING, never claims implementation)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ category: 'NARRATION' }]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    // narrationStrategy deliberately left empty
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'RECOMMENDATION_ALIGNMENT_UNVERIFIED'));
  assert.ok(!result.gateResult.blockers.some((b) => b.code === 'RECOMMENDATION_ALIGNMENT_UNVERIFIED'));
});

test('6b. an accepted recommendation whose relevant strategy field IS populated produces no alignment warning (never claims positive proof, just stays silent)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ category: 'OPENING' }]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    hookStrategy: 'open cold on the core claim',
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.gateResult.warnings.filter((w) => w.code === 'RECOMMENDATION_ALIGNMENT_UNVERIFIED').length, 0);
});

// --- 7. recommendation conflicts ---
test('7a. two accepted RECURRING_PATTERN_APPLICATION recommendations sharing the same category produce a RECOMMENDATION_CONFLICT warning', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ category: 'OPENING' }, { category: 'OPENING' }]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    hookStrategy: 'x',
    recommendationDecisions: [
      { recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' },
      { recommendationId: recSet.recommendations[1].id, decision: 'ACCEPT' },
    ],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'RECOMMENDATION_CONFLICT'));
});

test('7b. accepted recommendations from an opposing category pair (PACING vs SILENCE) produce a RECOMMENDATION_CONFLICT warning', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ category: 'PACING' }, { category: 'SILENCE' }]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    pacingStrategy: 'x',
    narrationStrategy: 'y',
    recommendationDecisions: [
      { recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' },
      { recommendationId: recSet.recommendations[1].id, decision: 'ACCEPT' },
    ],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'RECOMMENDATION_CONFLICT'));
});

// --- 8. continuity ---
test('8a. INVALID_ENTITY_REFERENCE (already dropped by INT-2) is surfaced as a WARNING at the gate, never silently disappearing', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'nonexistent', requirement: 'x' }],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'INVALID_ENTITY_REFERENCE'));
  assert.ok(!result.gateResult.blockers.some((b) => b.code === 'INVALID_ENTITY_REFERENCE'));
});

test('8b. a VALID continuity reference against a real character produces no INVALID_ENTITY_REFERENCE finding', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Kade' }] }, { updatedBy: 'test' });
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'x' }],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.gateResult.warnings.filter((w) => w.code === 'INVALID_ENTITY_REFERENCE').length, 0);
});

// --- 9. narration feasibility ---
test('9a. narrationDirection with voiceRole set but no voiceProfile produces NARRATION_DIRECTION_INCOMPLETE', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    narrationDirection: { voiceRole: 'narrator' },
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'NARRATION_DIRECTION_INCOMPLETE'));
});

test('9b. a valid VoiceProfile produces no INVALID_VOICE_PROFILE finding', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    narrationDirection: { voiceRole: 'narrator', voiceProfile: { pace: 'fast' } },
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.gateResult.warnings.filter((w) => w.code === 'INVALID_VOICE_PROFILE').length, 0);
  assert.equal(result.gateResult.warnings.filter((w) => w.code === 'NARRATION_DIRECTION_INCOMPLETE').length, 0);
});

test('9c. a structurally malformed voiceProfile produces INVALID_VOICE_PROFILE', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  // Directly construct a separate corrupted record to simulate a malformed
  // voiceProfile shape reaching the gate (never happens via the real
  // construction path — defensive check). A NEW id is required — reusing
  // draft.id would collide with the already-persisted original record.
  const corrupted = JSON.parse(JSON.stringify(draft));
  corrupted.id = '22222222-2222-4222-8222-222222222222';
  corrupted.narrationDirection.voiceProfile = { pace: 123 };
  creativeBlueprintStore.addCreativeBlueprint(project.id, corrupted);
  const result = gateService.evaluatePreProductionGate(project.id, corrupted.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'INVALID_VOICE_PROFILE'));
});

// --- 10. visual/production capability (text-derived, WARNING only) ---
test('10a. free text mentioning a SUPPORTED treatment (e.g. whiteboard) produces no capability warning', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60, visualStrategy: 'a whiteboard sketch reveal' });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.gateResult.warnings.filter((w) => w.category === 'VISUAL_FEASIBILITY').length, 0);
});

test('10b. free text mentioning a PARTIALLY_SUPPORTED treatment (hybrid) produces PARTIALLY_SUPPORTED_CAPABILITY, never a blocker', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60, visualStrategy: 'a hybrid composite of live and animated elements' });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'PARTIALLY_SUPPORTED_CAPABILITY'));
  assert.equal(result.gateResult.blockers.filter((b) => b.category === 'VISUAL_FEASIBILITY' || b.category === 'PRODUCTION_CAPABILITY').length, 0);
});

test('10c. free text mentioning a known-UNSUPPORTED requirement (lip-sync) produces UNKNOWN_CAPABILITY as a WARNING only, never a blocker (Part 2C, locked)', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60, visualStrategy: 'animated dialogue with full lip-sync between two characters' });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'UNKNOWN_CAPABILITY'));
  assert.equal(result.gateResult.blockers.filter((b) => b.code === 'UNSUPPORTED_CAPABILITY_NO_FALLBACK').length, 0);
});

test('10d. unrecognized free text produces no capability finding at all (never invents a signal from nothing)', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60, visualStrategy: 'a warm, inviting look' });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.gateResult.warnings.filter((w) => w.category === 'VISUAL_FEASIBILITY').length, 0);
});

// --- 11. BeatGraph optional / present ---
test('11a. no BeatGraph supplied — BEATGRAPH_UNAVAILABLE information, cost status UNKNOWN, no UNSUPPORTED_CAPABILITY_NO_FALLBACK blocker can ever fire', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.information.some((i) => i.code === 'BEATGRAPH_UNAVAILABLE'));
  assert.equal(result.gateResult.blockers.filter((b) => b.code === 'UNSUPPORTED_CAPABILITY_NO_FALLBACK').length, 0);
});

test('11b. BeatGraph present with an unresolvable beat produces a structured UNSUPPORTED_CAPABILITY_NO_FALLBACK BLOCKER (never from free text)', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  // HYBRID with no fallbackStrategy has no PROJECT_ASSET_REUSE path (empty asset-type
  // mapping), is not a DETERMINISTIC_TEMPLATE treatment, is not BROLL_CLIP-eligible,
  // and GENERATED_NEW only ever attempts STILL_IMAGE/AI_VIDEO — so it has zero
  // survivors under every real MATERIAL_SOURCES path, a genuinely UNRESOLVED beat.
  const beat = createVisualBeat({ projectId: project.id, sceneId: 'scene-1', sequence: 1, visualTreatment: 'HYBRID' });
  const beatGraph = createBeatGraph({ projectId: project.id, beats: [beat] });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id, { beatGraph });
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'UNSUPPORTED_CAPABILITY_NO_FALLBACK'));
  assert.equal(result.gateResult.machineAssessment, 'REJECT');
});

test('11c. BeatGraph present provides GENERATION_CANDIDATE_INFO and ESTIMATED cost status information', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  const beat = createVisualBeat({ projectId: project.id, sceneId: 'scene-1', sequence: 1, visualTreatment: 'MOTION_GRAPHIC' }); // DETERMINISTIC_TEMPLATE-resolvable, zero-cost
  const beatGraph = createBeatGraph({ projectId: project.id, beats: [beat] });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id, { beatGraph });
  assert.ok(result.gateResult.information.some((i) => i.code === 'GENERATION_CANDIDATE_INFO'));
  assert.ok(result.gateResult.information.some((i) => i.code === 'COST_STATUS' && /ESTIMATED/.test(i.message)));
});

test('11d. cost is NEVER reported as a monetary figure or as free/zero — COST_STATUS message contains no currency symbol', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  const costInfo = result.gateResult.information.find((i) => i.code === 'COST_STATUS');
  assert.ok(costInfo);
  assert.ok(!/\$|£|€/.test(costInfo.message));
  assert.match(costInfo.message, /UNKNOWN/);
});

// --- 12. production complexity ---
test('12. high production complexity (many continuity requirements) is surfaced as HIGH_PRODUCTION_COMPLEXITY warnings, never a numeric score', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'c1' }, { characterId: 'c2' }] }, { updatedBy: 'test' });
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    continuityRequirements: [
      { entityType: 'CHARACTER', entityId: 'c1', requirement: 'x' },
      { entityType: 'CHARACTER', entityId: 'c2', requirement: 'y' },
    ],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'HIGH_PRODUCTION_COMPLEXITY'));
  assert.ok(!Object.keys(result.gateResult).some((k) => /score/i.test(k)));
});

// --- 13. rework risk: DEFER + open questions ---
test('13a. a DEFER decision produces DEFERRED_RECOMMENDATION_DECISION warning', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'DEFER' }],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'DEFERRED_RECOMMENDATION_DECISION'));
});

test('13b. non-empty openQuestions[] produces OPEN_QUESTION_UNRESOLVED warning', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    openQuestions: ['should we use a cold open?'],
  });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.ok(result.gateResult.warnings.some((w) => w.code === 'OPEN_QUESTION_UNRESOLVED'));
});

// --- 14. determinism ---
test('14. evaluatePreProductionGate is deterministic — identical input produces identical findings across repeated calls (modulo id/createdAt)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const first = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const second = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(first.gateResult.machineAssessment, second.gateResult.machineAssessment);
  assert.deepEqual(first.gateResult.blockers, second.gateResult.blockers);
  assert.deepEqual(first.gateResult.warnings.map((w) => w.code), second.gateResult.warnings.map((w) => w.code));
});

// --- 15. upstream immutability ---
test('15. evaluatePreProductionGate never mutates the Blueprint, RecommendationSet, or VisualBible it reads', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ statement: 'original statement' }]);
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1' }] }, { updatedBy: 'test' });
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'original concept',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  gateService.evaluatePreProductionGate(project.id, draft.id);
  const blueprintAfter = creativeBlueprintStore.getCreativeBlueprint(project.id, draft.id);
  const recSetAfter = recommendationStore.getRecommendationSet(project.id, recSet.id);
  const bibleAfter = creativeStore.getVisualBible(project.id);
  assert.equal(blueprintAfter.concept, 'original concept');
  assert.equal(recSetAfter.recommendations[0].statement, 'original statement');
  assert.equal(bibleAfter.characters.length, 1);
});

// --- 16. human decisions ---
test('16a. ACCEPT records the human decision without touching machineAssessment/blockers', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const evalResult = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const decided = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'ACCEPT', decidedBy: 'human1' });
  assert.equal(decided.ok, true);
  assert.equal(decided.gateResult.humanDecision, 'ACCEPT');
  assert.equal(decided.gateResult.machineAssessment, 'PROCEED');
});

test('16b. OVERRIDE without a rationale fails', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const evalResult = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const decided = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'human1' });
  assert.equal(decided.ok, false);
  assert.match(decided.reason, /rationale/i);
});

test('16c. OVERRIDE with a rationale succeeds, preserving the machine\'s original REJECT assessment and blockers unchanged', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    structuralDirection: { plannedSectionCount: 8, minimumSectionDurationSeconds: 20 },
  });
  const evalResult = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(evalResult.gateResult.machineAssessment, 'REJECT');
  const decided = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'human1', rationale: 'accepting the contradiction, will fix in Storyboard' });
  assert.equal(decided.ok, true);
  assert.equal(decided.gateResult.humanDecision, 'OVERRIDE');
  assert.equal(decided.gateResult.humanRationale, 'accepting the contradiction, will fix in Storyboard');
  assert.equal(decided.gateResult.machineAssessment, 'REJECT'); // never erased
  assert.ok(decided.gateResult.blockers.some((b) => b.code === 'CONTRADICTORY_STRUCTURE')); // never deleted
});

test('16d. REQUEST_REVISION delegates to the existing Blueprint review machinery — a new DRAFT v2 is created, v1 is SUPERSEDED', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const evalResult = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const decided = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'REQUEST_REVISION', decidedBy: 'human1', rationale: 'needs work' });
  assert.equal(decided.ok, true);
  const v1After = creativeBlueprintStore.getCreativeBlueprint(project.id, blueprint.id);
  assert.equal(v1After.status, 'SUPERSEDED');
  const chain = creativeBlueprintStore.getRevisionChain(project.id, v1After.reviews[v1After.reviews.length - 1].resultingBlueprintId);
  assert.equal(chain.length, 2);
  assert.equal(chain[1].status, 'DRAFT');
});

test('16e. REJECT delegates to the existing Blueprint review machinery — Blueprint moves to REJECTED (from DRAFT/PENDING_REVIEW, matching INT-2\'s own reviewCreativeBlueprint contract)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  const evalResult = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(evalResult.gateResult.machineAssessment, 'REVISE'); // BLUEPRINT_NOT_APPROVED, but locally fixable
  const decided = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'REJECT', decidedBy: 'human1', rationale: 'not viable' });
  assert.equal(decided.ok, true);
  assert.equal(creativeBlueprintStore.getCreativeBlueprint(project.id, draft.id).status, 'REJECTED');
});

test('16f. an unrecognized human decision value is rejected', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const evalResult = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const decided = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'MAYBE', decidedBy: 'human1' });
  assert.equal(decided.ok, false);
});

// --- 17. security boundary ---
test('17. no generation/provider/network/credential-adjacent import anywhere in pre-production-gate-service.js', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'pre-production-gate-service.js'), 'utf8');
  const requireCalls = source.match(/require\(['"][^'"]+['"]\)/g) || [];
  const forbidden = /keyframe-generation-service|video-generation-service|generated-new-executor|provider|apify|anthropic|openai/i;
  assert.ok(!requireCalls.some((r) => forbidden.test(r)), `found a forbidden import: ${requireCalls.filter((r) => forbidden.test(r))}`);
  assert.ok(!/require\(['"]https?['"]\)/.test(source));
  assert.ok(!/\bfetch\(/.test(source));
  assert.ok(!/child_process/.test(source));
});

// --- 18. capability-map drift regression ---
test('18. VISUAL_TREATMENT_CAPABILITY covers every real VISUAL_TREATMENTS value exactly once (drift detection)', () => {
  const { VISUAL_TREATMENTS } = require('../schemas/visual-beat-schema');
  const keys = Object.keys(gateService.VISUAL_TREATMENT_CAPABILITY).sort();
  assert.deepEqual(keys, VISUAL_TREATMENTS.slice().sort());
  for (const v of Object.values(gateService.VISUAL_TREATMENT_CAPABILITY)) {
    assert.ok(require('../schemas/pre-production-gate-schema').CAPABILITY_STATUS_VALUES.includes(v));
  }
});

test('19. provenance remains inspectable — a full trace from Blueprint decision to source Recommendation is reconstructable from the gate result alone plus the RecommendationSet', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const stored = gateStore.getGateResult(project.id, result.gateResult.id);
  assert.equal(stored.blueprintId, blueprint.id);
  const blueprintFromStore = creativeBlueprintStore.getCreativeBlueprint(project.id, stored.blueprintId);
  assert.equal(blueprintFromStore.recommendationDecisions[0].recommendationId, recSet.recommendations[0].id);
});

test('20. evaluatePreProductionGate fails gracefully (ok:false) for a non-existent project or blueprint, never inventing a result', () => {
  const project = newProject();
  assert.equal(gateService.evaluatePreProductionGate('00000000-0000-4000-8000-000000000000', 'x').ok, false);
  assert.equal(gateService.evaluatePreProductionGate(project.id, '11111111-1111-4111-8111-111111111111').ok, false);
});

// ---------------------------------------------------------------------------
// P0 Hardening — dedicated regression tests for fixes C, D, E, I.
// ---------------------------------------------------------------------------

// Fix C — a human's ACCEPT/EDIT of an INSUFFICIENT_EVIDENCE recommendation
// is dropped by INT-2's own buildCreativeBlueprintDraft() (the decision
// never survives into recommendationDecisions), but its diagnostic is
// recorded. Previously the gate only ever copied this diagnostic through
// as a non-blocking WARNING-equivalent (never even reaching machineAssessment);
// now it is a hard BLOCKER, matching the same "gate is the stricter layer"
// precedent already established for INVALID_RECOMMENDATION_PROVENANCE.
test('21. fix C — a human ACCEPT of an INSUFFICIENT_EVIDENCE recommendation surfaces as an INSUFFICIENT_EVIDENCE_RECOMMENDATION BLOCKER at the gate, forcing REVISE even though INT-2 itself silently dropped the decision', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ evidenceSufficiency: 'INSUFFICIENT_EVIDENCE', meetsMinimumEvidenceThreshold: false }]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  // INT-2 itself dropped the decision (never blocking) — the diagnostic is the only surviving record.
  assert.equal(draft.recommendationDecisions.length, 0);
  assert.ok(draft.diagnostics.some((d) => d.code === 'INSUFFICIENT_EVIDENCE_RECOMMENDATION'));
  creativeBlueprintService.reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human1' });
  const approved = creativeBlueprintStore.getCreativeBlueprint(project.id, draft.id);

  const result = gateService.evaluatePreProductionGate(project.id, approved.id);
  assert.equal(result.ok, true);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'INSUFFICIENT_EVIDENCE_RECOMMENDATION'), 'must be a BLOCKER, not silently absorbed');
  assert.equal(result.gateResult.machineAssessment, 'REVISE'); // locally fixable — not one of the REJECT-tier codes
});

// Fix D — humanDecisions[] is an append-only history. A later ACCEPT (which
// legitimately has no rationale) must never erase an earlier OVERRIDE's
// rationale — previously the four scalar fields were simply overwritten.
test('22. fix D — humanDecisions[] records every decision in order, and a later ACCEPT (no rationale) never erases an earlier OVERRIDE\'s rationale', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    structuralDirection: { plannedSectionCount: 8, minimumSectionDurationSeconds: 20 }, // forces CONTRADICTORY_STRUCTURE -> REJECT
  });
  const evalResult = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(evalResult.gateResult.machineAssessment, 'REJECT');

  const overridden = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'human1', rationale: 'accepting the contradiction, will fix in Storyboard' });
  assert.equal(overridden.ok, true);
  const accepted = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'ACCEPT', decidedBy: 'human2' });
  assert.equal(accepted.ok, true);

  assert.equal(accepted.gateResult.humanDecisions.length, 2);
  assert.equal(accepted.gateResult.humanDecisions[0].decision, 'OVERRIDE');
  assert.equal(accepted.gateResult.humanDecisions[0].rationale, 'accepting the contradiction, will fix in Storyboard'); // survives intact
  assert.equal(accepted.gateResult.humanDecisions[1].decision, 'ACCEPT');
  assert.equal(accepted.gateResult.humanDecisions[1].rationale, null);
  // the scalar mirror reflects only the newest entry — never a regression for existing readers
  assert.equal(accepted.gateResult.humanDecision, 'ACCEPT');
  assert.equal(accepted.gateResult.humanRationale, null);
});

// Fix E — a gate result must not outlive the exact Blueprint state it was
// computed against (Rule 4). blueprintUpdatedAt is captured at evaluation
// time; ACCEPT/OVERRIDE on a result whose Blueprint has since moved on
// (superseded via a REQUEST_REVISION against a LATER gate evaluation) must
// be blocked, never silently actioned against a Blueprint that no longer
// reflects what was evaluated.
test('23. fix E — an ACCEPT on a gate result whose Blueprint has since been superseded is blocked as stale, and isGateResultStale() reports it explicitly', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });

  const firstEval = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(firstEval.gateResult.blueprintUpdatedAt, blueprint.updatedAt);
  assert.equal(gateService.isGateResultStale(project.id, firstEval.gateResult).stale, false);

  // A second, independent gate evaluation against the SAME (still-unchanged) Blueprint,
  // whose REQUEST_REVISION supersedes v1 -> a new DRAFT v2 (Blueprint.updatedAt changes).
  const secondEval = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const revised = gateService.decideGateResult(project.id, secondEval.gateResult.id, { decision: 'REQUEST_REVISION', decidedBy: 'human1', rationale: 'needs a rework' });
  assert.equal(revised.ok, true);
  assert.equal(creativeBlueprintStore.getCreativeBlueprint(project.id, blueprint.id).status, 'SUPERSEDED');

  // The FIRST gate result's own snapshot is now stale — an ACCEPT against it must be blocked.
  const staleness = gateService.isGateResultStale(project.id, firstEval.gateResult);
  assert.equal(staleness.stale, true);
  assert.match(staleness.reason, /since changed|no longer exists/);

  const staleAccept = gateService.decideGateResult(project.id, firstEval.gateResult.id, { decision: 'ACCEPT', decidedBy: 'human2' });
  assert.equal(staleAccept.ok, false);
  assert.match(staleAccept.reason, /stale/i);

  const staleOverride = gateService.decideGateResult(project.id, firstEval.gateResult.id, { decision: 'OVERRIDE', decidedBy: 'human2', rationale: 'proceeding anyway' });
  assert.equal(staleOverride.ok, false);
  assert.match(staleOverride.reason, /stale/i);
});

// Fix I — the gate's own computed costStatus (KNOWN/ESTIMATED/UNKNOWN) was
// previously computed inside checkBeatGraphDerivedCapability() and then
// discarded before ever reaching the persisted PreProductionGateResult.
test('24. fix I — costStatus is persisted as UNKNOWN when no BeatGraph is supplied, and ESTIMATED when one is', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });

  const withoutBeatGraph = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(withoutBeatGraph.gateResult.costStatus, 'UNKNOWN');

  const beatGraph = createBeatGraph({
    projectId: project.id,
    beats: [createVisualBeat({ id: 'beat-1', sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'STILL_IMAGE' })],
  });
  const withBeatGraph = gateService.evaluatePreProductionGate(project.id, blueprint.id, { beatGraph });
  assert.equal(withBeatGraph.gateResult.costStatus, 'ESTIMATED');
});

// ============================================================
// PRODUCTION UNBLOCK — CREATOR-LED MODE (no RecommendationSet)
// ============================================================

function buildAndApproveCreatorLedBlueprint(project, draftInput = {}) {
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    hookStrategy: 'open with a question',
    ...draftInput,
  });
  const { BLOCKING_DIAGNOSTIC_CODES } = require('../schemas/creative-blueprint-schema');
  if (draft.diagnostics.filter((d) => BLOCKING_DIAGNOSTIC_CODES.includes(d.code)).length === 0) {
    creativeBlueprintService.reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human1' });
    return creativeBlueprintStore.getCreativeBlueprint(project.id, draft.id);
  }
  return draft;
}

test('PB-1. evaluatePreProductionGate succeeds for a creator-led (no RecommendationSet) APPROVED Blueprint — reference acquisition failure/absence does not prevent Blueprint or gate evaluation', () => {
  const project = newProject();
  const blueprint = buildAndApproveCreatorLedBlueprint(project);
  assert.equal(blueprint.status, 'APPROVED');
  assert.equal(blueprint.recommendationSetId, null);
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.gateResult.blueprintId, blueprint.id);
});

test('PB-2. a creator-led gate evaluation records an honest NO_RECOMMENDATION_SET information entry — never a fabricated pass, never silently skipped without a trace', () => {
  const project = newProject();
  const blueprint = buildAndApproveCreatorLedBlueprint(project);
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.ok(result.gateResult.information.some((i) => i.code === 'NO_RECOMMENDATION_SET'));
});

test('PB-3. evidence-led gate evaluation is completely unaffected — no NO_RECOMMENDATION_SET entry when a real RecommendationSet is linked', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const blueprint = buildAndApproveBlueprint(project, recSet, { recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }] });
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  assert.ok(!result.gateResult.information.some((i) => i.code === 'NO_RECOMMENDATION_SET'));
});

test('PB-4. evidence-provenance/alignment/conflict blockers and warnings never fire for a creator-led Blueprint — genuinely not applicable, not a fabricated clean pass', () => {
  const project = newProject();
  const blueprint = buildAndApproveCreatorLedBlueprint(project);
  const result = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const codes = [...result.gateResult.blockers, ...result.gateResult.warnings].map((f) => f.code);
  assert.ok(!codes.includes('INVALID_RECOMMENDATION_PROVENANCE'));
  assert.ok(!codes.includes('RECOMMENDATION_ALIGNMENT_UNVERIFIED'));
  assert.ok(!codes.includes('RECOMMENDATION_CONFLICT'));
});

test('PB-5. FAILURE INJECTION — a creator-led Blueprint still fails BLUEPRINT_NOT_APPROVED when not approved, exactly as an evidence-led one would', () => {
  const project = newProject();
  const draft = creativeBlueprintService.buildCreativeBlueprintDraft(project.id, { concept: 'c', corePromise: 'p', targetDuration: 60 });
  const result = gateService.evaluatePreProductionGate(project.id, draft.id);
  assert.equal(result.ok, true);
  assert.ok(result.gateResult.blockers.some((b) => b.code === 'BLUEPRINT_NOT_APPROVED'));
});

test('PB-6. FAILURE INJECTION — a Blueprint whose recommendationSetId points to a since-deleted/malformed RecommendationSet fails cleanly with a clear reason, never silently treated as creator-led', () => {
  const project = newProject();
  // Bypass the service layer to construct a Blueprint that references a
  // RecommendationSet id that was never actually persisted — simulating
  // data corruption or a since-deleted RecommendationSet. The gate must
  // still fail explicitly here: a non-null recommendationSetId is a real
  // evidence-led claim, and the creator-led tolerance must never paper
  // over an unresolvable one.
  const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');
  const corrupted = createCreativeBlueprint({
    projectId: project.id,
    recommendationSetId: 'deleted-or-never-existed',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    status: 'APPROVED',
  });
  const saved = creativeBlueprintStore.addCreativeBlueprint(project.id, corrupted);
  const result = gateService.evaluatePreProductionGate(project.id, saved.blueprint.id);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no RecommendationSet found/);
});

test('PB-7. decideGateResult (OVERRIDE/ACCEPT) works identically on a creator-led gate result — approval gate machinery is completely untouched by the RecommendationSet relaxation', () => {
  const project = newProject();
  const blueprint = buildAndApproveCreatorLedBlueprint(project);
  const evalResult = gateService.evaluatePreProductionGate(project.id, blueprint.id);
  const decision = gateService.decideGateResult(project.id, evalResult.gateResult.id, { decision: 'ACCEPT', decidedBy: 'human1' });
  assert.equal(decision.ok, true);
  assert.equal(decision.gateResult.humanDecision, 'ACCEPT');
});
