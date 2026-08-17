// Tests for services/creative-blueprint-service.js (INT-2 Part 22 — 30-item list).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cbservice-projects-'));
process.env.CREATIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cbservice-creative-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cbservice-blueprints-'));
process.env.RECOMMENDATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cbservice-recs-'));

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const recommendationStore = require('../services/recommendation-store');
const blueprintStore = require('../services/creative-blueprint-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const {
  buildCreativeBlueprintDraft,
  submitCreativeBlueprintForReview,
  reviewCreativeBlueprint,
  resolveRecommendationDecision,
  resolveEntityReference,
  detectStructuralContradiction,
  deriveBlueprintProductionConsiderations,
} = require('../services/creative-blueprint-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

// Builds a real, persisted RecommendationSet with `n` CANDIDATE recommendations
// (default SUFFICIENT evidence), returning { project, recommendationSet, recs }.
function setupRecommendationSet(projectId, referenceSetId, recOverridesList) {
  const recs = recOverridesList.map((overrides) =>
    createRecommendation({
      projectId,
      referenceSetId,
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
      ...overrides,
    })
  );
  const set = createRecommendationSet({ projectId, referenceSetId, patternSetId: 'pattern-set-1', recommendations: recs, status: 'COMPLETE' });
  const saved = recommendationStore.addRecommendationSet(projectId, set);
  return saved.recommendationSet;
}

test('1. buildCreativeBlueprintDraft creates a valid DRAFT with no diagnostics when all required fields and a valid ACCEPT decision are supplied', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    title: 't',
    concept: 'a concept',
    corePromise: 'a promise',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  assert.equal(draft.status, 'DRAFT');
  assert.deepEqual(draft.diagnostics, []);
  assert.equal(draft.recommendationDecisions.length, 1);
});

test('2. missing concept produces MISSING_CONCEPT diagnostic', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', corePromise: 'p', targetDuration: 60 });
  assert.ok(draft.diagnostics.some((d) => d.code === 'MISSING_CONCEPT'));
});

test('3. missing corePromise produces MISSING_CORE_PROMISE diagnostic', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', targetDuration: 60 });
  assert.ok(draft.diagnostics.some((d) => d.code === 'MISSING_CORE_PROMISE'));
});

test('4. missing targetDuration produces MISSING_TARGET_DURATION diagnostic', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p' });
  assert.ok(draft.diagnostics.some((d) => d.code === 'MISSING_TARGET_DURATION'));
});

test('5. invalid (non-positive) targetDuration produces INVALID_TARGET_DURATION diagnostic', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: -5 });
  assert.ok(draft.diagnostics.some((d) => d.code === 'INVALID_TARGET_DURATION'));
});

test('6. non-existent RecommendationSet returns an unpersisted FAILED blueprint with INVALID_RECOMMENDATION_SET', () => {
  const project = newProject();
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'no-such-rs', concept: 'c', corePromise: 'p', targetDuration: 60 });
  assert.equal(draft.status, 'FAILED');
  assert.ok(draft.diagnostics.some((d) => d.code === 'INVALID_RECOMMENDATION_SET'));
  assert.equal(blueprintStore.listCreativeBlueprints(project.id).length, 0);
});

test('7. non-existent project returns an unpersisted FAILED blueprint', () => {
  const draft = buildCreativeBlueprintDraft('00000000-0000-4000-8000-000000000000', { concept: 'c', corePromise: 'p', targetDuration: 60 });
  assert.equal(draft.status, 'FAILED');
});

test('8. a recommendationDecision naming a non-existent recommendationId is dropped with INVALID_RECOMMENDATION_PROVENANCE, never invented', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: '11111111-1111-4111-8111-111111111111', decision: 'ACCEPT' }],
  });
  assert.ok(draft.diagnostics.some((d) => d.code === 'INVALID_RECOMMENDATION_PROVENANCE'));
  assert.equal(draft.recommendationDecisions.length, 0);
});

test('9. resolveRecommendationDecision rejects an unrecognized decision value as INVALID_RECOMMENDATION_PROVENANCE', () => {
  const recSet = createRecommendationSet({ recommendations: [createRecommendation({ id: 'r1' })] });
  const result = resolveRecommendationDecision(recSet, { recommendationId: recSet.recommendations[0].id, decision: 'MAYBE' });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'INVALID_RECOMMENDATION_PROVENANCE');
});

test('10. ACCEPT on an INSUFFICIENT_EVIDENCE recommendation is blocked with INSUFFICIENT_EVIDENCE_RECOMMENDATION and dropped', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ evidenceSufficiency: 'INSUFFICIENT_EVIDENCE' }]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  assert.ok(draft.diagnostics.some((d) => d.code === 'INSUFFICIENT_EVIDENCE_RECOMMENDATION'));
  assert.equal(draft.recommendationDecisions.length, 0);
});

test('11. REJECT on an INSUFFICIENT_EVIDENCE recommendation is allowed (only ACCEPT/EDIT are blocked)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ evidenceSufficiency: 'INSUFFICIENT_EVIDENCE' }]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'REJECT' }],
  });
  assert.equal(draft.diagnostics.filter((d) => d.code === 'INSUFFICIENT_EVIDENCE_RECOMMENDATION').length, 0);
  assert.equal(draft.recommendationDecisions.length, 1);
  assert.equal(draft.recommendationDecisions[0].decision, 'REJECT');
});

test('12. ACCEPT/EDIT/REJECT/DEFER decisions are each preserved distinctly', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}, {}, {}, {}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [
      { recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' },
      { recommendationId: recSet.recommendations[1].id, decision: 'EDIT', finalCreativeDecision: 'edited text' },
      { recommendationId: recSet.recommendations[2].id, decision: 'REJECT' },
      { recommendationId: recSet.recommendations[3].id, decision: 'DEFER' },
    ],
  });
  const decisions = draft.recommendationDecisions;
  assert.deepEqual(decisions.map((d) => d.decision).sort(), ['ACCEPT', 'DEFER', 'EDIT', 'REJECT']);
  const edited = decisions.find((d) => d.decision === 'EDIT');
  assert.equal(edited.finalCreativeDecision, 'edited text');
});

test('13. EDIT with no finalCreativeDecision falls back to the recommendation\'s own action text, never left blank', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ action: 'Consider doing the original thing.' }]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'EDIT' }],
  });
  assert.equal(draft.recommendationDecisions[0].finalCreativeDecision, 'Consider doing the original thing.');
});

test('14. REJECT/DEFER decisions never populate finalCreativeDecision (stays null)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}, {}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [
      { recommendationId: recSet.recommendations[0].id, decision: 'REJECT' },
      { recommendationId: recSet.recommendations[1].id, decision: 'DEFER' },
    ],
  });
  assert.equal(draft.recommendationDecisions[0].finalCreativeDecision, null);
  assert.equal(draft.recommendationDecisions[1].finalCreativeDecision, null);
});

test('15. sourceRecommendationIds/sourcePatternIds/sourceReferenceSetIds are derived only from valid, resolved decisions', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [
    { sourcePatternIds: ['pattern-a'] },
    { sourcePatternIds: ['pattern-b'] },
  ]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [
      { recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' },
      { recommendationId: recSet.recommendations[1].id, decision: 'REJECT' },
      { recommendationId: '11111111-1111-4111-8111-111111111111', decision: 'ACCEPT' },
    ],
  });
  assert.deepEqual(draft.sourceRecommendationIds.sort(), [recSet.recommendations[0].id, recSet.recommendations[1].id].sort());
  // Only the ACCEPTed recommendation's pattern id is a "source" for the blueprint's own creative content.
  assert.deepEqual(draft.sourcePatternIds, ['pattern-a']);
  assert.deepEqual(draft.sourceReferenceSetIds, ['rs1']);
});

test('16. resolveEntityReference validates a continuityRequirement\'s entityId against the real, persisted VisualBible', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Kade' }] }, { updatedBy: 'test' });
  const updated = creativeStore.getVisualBible(project.id);
  assert.equal(resolveEntityReference(updated, 'CHARACTER', 'char-1'), true);
  assert.equal(resolveEntityReference(updated, 'CHARACTER', 'char-does-not-exist'), false);
});

test('17. an invalid continuityRequirement entity reference is dropped with INVALID_ENTITY_REFERENCE, never invented', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'nonexistent', requirement: 'stay consistent' }],
  });
  assert.ok(draft.diagnostics.some((d) => d.code === 'INVALID_ENTITY_REFERENCE'));
  assert.equal(draft.continuityRequirements.length, 0);
});

test('18. a valid continuityRequirement entity reference against a real character is preserved', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Kade' }] }, { updatedBy: 'test' });
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'stay consistent' }],
  });
  assert.equal(draft.diagnostics.filter((d) => d.code === 'INVALID_ENTITY_REFERENCE').length, 0);
  assert.equal(draft.continuityRequirements.length, 1);
});

test('19. narrationDirection.voiceProfile, when supplied, is validated/normalized through the real audio-schema.js createVoiceProfile factory', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    narrationDirection: { voiceRole: 'narrator', voiceProfile: { genderPresentation: 'male', pace: 'fast' } },
  });
  assert.equal(draft.narrationDirection.voiceProfile.genderPresentation, 'male');
  assert.equal(draft.narrationDirection.voiceProfile.pace, 'fast');
  // Fields the caller never supplied still get the real factory's own defaults, never left undefined.
  assert.equal(draft.narrationDirection.voiceProfile.accent, '');
});

test('20. narrationDirection.voiceProfile defaults to null when never supplied — never fabricated', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  assert.equal(draft.narrationDirection.voiceProfile, null);
});

test('21. detectStructuralContradiction flags Part 18\'s own worked example (8 sections x 20s minimum > 60s target)', () => {
  const contradiction = detectStructuralContradiction(60, { plannedSectionCount: 8, minimumSectionDurationSeconds: 20 });
  assert.equal(contradiction.code, 'CONTRADICTORY_STRUCTURE');
  assert.match(contradiction.message, /160/);
});

test('22. detectStructuralContradiction returns null when planned minimum fits within the target duration', () => {
  assert.equal(detectStructuralContradiction(60, { plannedSectionCount: 3, minimumSectionDurationSeconds: 10 }), null);
});

test('23. CONTRADICTORY_STRUCTURE is a blocking diagnostic that prevents draft creation from being clean', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    structuralDirection: { plannedSectionCount: 8, minimumSectionDurationSeconds: 20 },
  });
  assert.ok(draft.diagnostics.some((d) => d.code === 'CONTRADICTORY_STRUCTURE'));
});

test('24. submitCreativeBlueprintForReview moves DRAFT -> PENDING_REVIEW even with missing fields (never blocked)', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1' }); // missing concept/corePromise/targetDuration
  const result = submitCreativeBlueprintForReview(project.id, draft.id, { submittedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.status, 'PENDING_REVIEW');
});

test('25. reviewCreativeBlueprint APPROVE is blocked when a blocking diagnostic (e.g. MISSING_CONCEPT) is present — human authority cannot override a real structural blocker', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', corePromise: 'p', targetDuration: 60 });
  const result = reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /blocking/);
  assert.equal(blueprintStore.getCreativeBlueprint(project.id, draft.id).status, 'DRAFT');
});

test('26. reviewCreativeBlueprint APPROVE succeeds for a clean draft and requires an explicit human decision (never auto-approved by buildCreativeBlueprintDraft itself)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  assert.equal(draft.status, 'DRAFT'); // never auto-approved
  const result = reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.status, 'APPROVED');
  assert.equal(result.blueprint.reviews.length, 1);
  assert.equal(result.blueprint.reviews[0].reviewedBy, 'human1');
});

test('27. an APPROVED blueprint\'s own content fields are immutable — reviewCreativeBlueprint APPROVE cannot be called again to change status/content, and content is unchanged by the review call itself. REJECT IS reachable from APPROVED (P0 Hardening finding A) — this is the pre-production gate\'s own only path to a human REJECT decision, since the gate\'s documented precondition is an already-APPROVED Blueprint.', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'original concept',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human1' });
  const approved = blueprintStore.getCreativeBlueprint(project.id, draft.id);
  assert.equal(approved.concept, 'original concept');
  const secondApprove = reviewCreativeBlueprint(project.id, draft.id, { decision: 'APPROVE', reviewedBy: 'human2' });
  assert.equal(secondApprove.ok, false);
  const rejectAfterApprove = reviewCreativeBlueprint(project.id, draft.id, { decision: 'REJECT', reviewedBy: 'human2' });
  assert.equal(rejectAfterApprove.ok, true);
  assert.equal(rejectAfterApprove.blueprint.status, 'REJECTED');
  assert.equal(rejectAfterApprove.blueprint.concept, 'original concept'); // content still untouched by the status transition itself
});

test('28. reviewCreativeBlueprint REJECT transitions DRAFT/PENDING_REVIEW -> REJECTED', () => {
  const project = newProject();
  setupRecommendationSet(project.id, 'rs1', [{}]);
  const draft = buildCreativeBlueprintDraft(project.id, { referenceSetId: 'rs1', concept: 'c', corePromise: 'p', targetDuration: 60 });
  const result = reviewCreativeBlueprint(project.id, draft.id, { decision: 'REJECT', reviewedBy: 'human1', note: 'not the right direction' });
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.status, 'REJECTED');
});

test('29. reviewCreativeBlueprint REQUEST_REVISION on an APPROVED blueprint creates a new DRAFT v2 (via supersedesBlueprintId) and marks v1 SUPERSEDED — v1\'s own content stays intact and historically inspectable', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const v1 = buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'v1 concept',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
  reviewCreativeBlueprint(project.id, v1.id, { decision: 'APPROVE', reviewedBy: 'human1' });
  const revisionResult = reviewCreativeBlueprint(project.id, v1.id, { decision: 'REQUEST_REVISION', reviewedBy: 'human1', note: 'needs a stronger hook' });
  assert.equal(revisionResult.ok, true);
  const v2 = revisionResult.blueprint;
  assert.equal(v2.status, 'DRAFT');
  assert.equal(v2.supersedesBlueprintId, v1.id);
  assert.equal(v2.concept, 'v1 concept'); // carried forward content, not blanked

  const v1AfterRevision = blueprintStore.getCreativeBlueprint(project.id, v1.id);
  assert.equal(v1AfterRevision.status, 'SUPERSEDED');
  assert.equal(v1AfterRevision.concept, 'v1 concept'); // v1's own content untouched
  assert.equal(v1AfterRevision.reviews[v1AfterRevision.reviews.length - 1].resultingBlueprintId, v2.id);

  // v2 can now itself be approved, and the full chain is inspectable oldest-first.
  const v2Approved = reviewCreativeBlueprint(project.id, v2.id, { decision: 'APPROVE', reviewedBy: 'human1' });
  assert.equal(v2Approved.ok, true);
  const chain = blueprintStore.getRevisionChain(project.id, v2.id);
  assert.deepEqual(chain.map((b) => b.id), [v1.id, v2.id]);
});

test('30. buildCreativeBlueprintDraft is deterministic — identical input against the same stored data produces identical diagnostics/content across repeated calls (no randomness, no LLM)', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{}]);
  const input = {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  };
  const first = buildCreativeBlueprintDraft(project.id, input);
  const second = buildCreativeBlueprintDraft(project.id, input);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.concept, second.concept);
  assert.deepEqual(first.sourcePatternIds, second.sourcePatternIds);
  assert.deepEqual(first.recommendationDecisions.map((d) => d.decision), second.recommendationDecisions.map((d) => d.decision));
});

test('31. buildCreativeBlueprintDraft never mutates the source RecommendationSet or its Recommendations', () => {
  const project = newProject();
  const recSet = setupRecommendationSet(project.id, 'rs1', [{ statement: 'original statement' }]);
  buildCreativeBlueprintDraft(project.id, {
    referenceSetId: 'rs1',
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'EDIT', finalCreativeDecision: 'a different text entirely' }],
  });
  const recSetAfter = recommendationStore.getRecommendationSet(project.id, recSet.id);
  assert.equal(recSetAfter.recommendations[0].statement, 'original statement');
  assert.equal(recSetAfter.recommendations[0].status, 'CANDIDATE'); // never flipped by the Blueprint layer
});

test('32. deriveBlueprintProductionConsiderations flags >=2 distinct continuity entities, long duration (>=600s), and >=6 planned sections, each independently', () => {
  const manyEntities = deriveBlueprintProductionConsiderations({
    continuityRequirements: [
      { entityType: 'CHARACTER', entityId: 'a' },
      { entityType: 'CHARACTER', entityId: 'b' },
    ],
    targetDuration: 60,
    structuralDirection: null,
  });
  assert.equal(manyEntities.length, 1);

  const longDuration = deriveBlueprintProductionConsiderations({ continuityRequirements: [], targetDuration: 700, structuralDirection: null });
  assert.equal(longDuration.length, 1);

  const manySections = deriveBlueprintProductionConsiderations({ continuityRequirements: [], targetDuration: 60, structuralDirection: { plannedSectionCount: 6 } });
  assert.equal(manySections.length, 1);

  const none = deriveBlueprintProductionConsiderations({ continuityRequirements: [], targetDuration: 60, structuralDirection: null });
  assert.equal(none.length, 0);
});

test('33. no network dependency — creative-blueprint-service.js contains no fetch/http/https/axios calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'creative-blueprint-service.js'), 'utf8');
  assert.ok(!/require\(['"]https?['"]\)/.test(source));
  assert.ok(!/\bfetch\(/.test(source));
  assert.ok(!/axios/.test(source));
});

test('34. no LLM/interpretation-provider dependency — creative-blueprint-service.js never requires a provider/LLM module (the word "provider" may still appear in explanatory comments)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'creative-blueprint-service.js'), 'utf8');
  const requireCalls = source.match(/require\(['"][^'"]+['"]\)/g) || [];
  assert.ok(!requireCalls.some((r) => /provider/i.test(r)));
  assert.ok(!/openai|anthropic|claude/i.test(source));
});
