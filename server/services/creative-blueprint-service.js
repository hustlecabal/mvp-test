// creative-blueprint-service.js
//
// INT-2 — the orchestrator proving the first layer that commits to an
// actual creative contract for ONE proposed video:
//
//   RecommendationSet (INT-1F) -> CreativeBlueprint
//
// THE PATTERN LAYER WAS THE GATE FOR RECOMMENDATIONS (INT-1F); THE
// RECOMMENDATION LAYER IS THE GATE HERE: every recommendationDecision
// this file accepts must resolve to a real, already-persisted
// Recommendation belonging to the resolved RecommendationSet — never a
// raw pattern, raw video, or LLM intuition. buildCreativeBlueprintDraft()
// never imports cross-video-pattern-store.js, reference-video-
// measurement-store.js, or reference-video-observation-store.js directly
// for exactly that reason; sourcePatternIds/sourceReferenceSetIds are
// read straight off the already-resolved Recommendation records, never
// re-derived from a lower layer.
//
// FULLY DETERMINISTIC, NO LLM (Part 20/21): this file never imports an
// interpretation/generation provider. Every diagnostic and every derived
// field below is computed from real, already-supplied structured input —
// never generated text from a model, never a random choice.
//
// HUMAN AUTHORITY, NEVER MACHINE SELF-APPROVAL (Part 7): status starts at
// 'DRAFT' (or 'FAILED' for a hard construction failure) no matter how
// complete the input is — reviewCreativeBlueprint() is the ONLY function
// that can ever move a Blueprint to APPROVED, and it always requires an
// explicit human decision.

const projectStore = require('./project-store');
const recommendationStore = require('./recommendation-store');
const creativeStore = require('./creative-store');
const creativeBlueprintStore = require('./creative-blueprint-store');
const { createVoiceProfile } = require('../schemas/audio-schema');
const {
  CREATIVE_BLUEPRINT_REVIEW_DECISIONS,
  RECOMMENDATION_DECISION_TYPES,
  REFERENCE_ENTITY_TYPES,
  BLOCKING_DIAGNOSTIC_CODES,
  createCreativeBlueprintDiagnostic,
  createCreativeBlueprint,
  createRecommendationDecision,
  createCreativeBlueprintReview,
} = require('../schemas/creative-blueprint-schema');

function diag(code, message) {
  return createCreativeBlueprintDiagnostic({ code, message });
}

// Part 9 — resolves a continuityRequirement's entityId against the
// project's REAL, already-persisted VisualBible (services/creative-
// store.js's own getVisualBible) — never invents a character/location/
// prop, never duplicates the Bible's own content.
const ENTITY_ARRAY_BY_TYPE = { CHARACTER: 'characters', LOCATION: 'locations', PROP: 'props' };
const ENTITY_ID_FIELD_BY_TYPE = { CHARACTER: 'characterId', LOCATION: 'locationId', PROP: 'propId' };

function resolveEntityReference(visualBible, entityType, entityId) {
  if (!visualBible || !REFERENCE_ENTITY_TYPES.includes(entityType)) return false;
  const array = visualBible[ENTITY_ARRAY_BY_TYPE[entityType]];
  const idField = ENTITY_ID_FIELD_BY_TYPE[entityType];
  return Array.isArray(array) && array.some((e) => e[idField] === entityId);
}

// Part 18's own worked example: plannedSectionCount * minimumSectionDurationSeconds
// exceeding targetDuration is a real, checkable structural contradiction
// — never an AI judgment call, just arithmetic over real supplied numbers.
function detectStructuralContradiction(targetDuration, structuralDirection) {
  if (!structuralDirection || typeof targetDuration !== 'number' || targetDuration <= 0) return null;
  const { plannedSectionCount, minimumSectionDurationSeconds } = structuralDirection;
  if (typeof plannedSectionCount !== 'number' || typeof minimumSectionDurationSeconds !== 'number') return null;
  const minimumTotal = plannedSectionCount * minimumSectionDurationSeconds;
  if (minimumTotal > targetDuration) {
    return diag('CONTRADICTORY_STRUCTURE', `${plannedSectionCount} planned section(s) at a minimum of ${minimumSectionDurationSeconds}s each requires at least ${minimumTotal}s, which exceeds the ${targetDuration}s target duration`);
  }
  return null;
}

// Part 16 — deterministic, qualitative-only, derived ONLY from structured
// signals actually present on the draft (never parsed out of free-text
// strategy fields, which would risk an invented interpretation). Mirrors
// recommendation-service.js's own category-keyed PRODUCTION_CONSIDERATION_
// BY_CATEGORY convention: a documented mapping, never a cost estimate.
const DISTINCT_ENTITY_CONSIDERATION_THRESHOLD = 2;
const LONG_DURATION_CONSIDERATION_THRESHOLD_SECONDS = 600; // 10 minutes — a documented, stated convention, not a claim about any specific video's real cost

function deriveBlueprintProductionConsiderations({ continuityRequirements, targetDuration, structuralDirection }) {
  const notes = [];
  const distinctEntityIds = new Set(continuityRequirements.map((c) => `${c.entityType}:${c.entityId}`));
  if (distinctEntityIds.size >= DISTINCT_ENTITY_CONSIDERATION_THRESHOLD) {
    notes.push({ note: `${distinctEntityIds.size} distinct character/location/prop continuity requirements may imply additional identity-consistency production overhead.` });
  }
  if (typeof targetDuration === 'number' && targetDuration >= LONG_DURATION_CONSIDERATION_THRESHOLD_SECONDS) {
    notes.push({ note: `A target duration of ${targetDuration}s (>= ${LONG_DURATION_CONSIDERATION_THRESHOLD_SECONDS}s) may imply a higher number of generated assets than a shorter video.` });
  }
  if (structuralDirection && typeof structuralDirection.plannedSectionCount === 'number' && structuralDirection.plannedSectionCount >= 6) {
    notes.push({ note: `${structuralDirection.plannedSectionCount} planned sections may imply additional editing/continuity complexity.` });
  }
  return notes;
}

// Part 6 — resolves ONE recommendationDecision against the REAL,
// already-persisted RecommendationSet. Never invents a replacement id.
// Returns { ok:true, recommendation } or { ok:false, diagnostic }.
function resolveRecommendationDecision(recommendationSet, decisionInput) {
  const { recommendationId, decision } = decisionInput;
  if (!RECOMMENDATION_DECISION_TYPES.includes(decision)) {
    return { ok: false, diagnostic: diag('INVALID_RECOMMENDATION_PROVENANCE', `"${decision}" is not a recognized recommendation decision type`) };
  }
  const recommendation = (recommendationSet.recommendations || []).find((r) => r.id === recommendationId);
  if (!recommendation) {
    return { ok: false, diagnostic: diag('INVALID_RECOMMENDATION_PROVENANCE', `recommendationId "${recommendationId}" does not resolve to a real recommendation in RecommendationSet "${recommendationSet.id}"`) };
  }
  if ((decision === 'ACCEPT' || decision === 'EDIT') && recommendation.evidenceSufficiency === 'INSUFFICIENT_EVIDENCE') {
    return { ok: false, diagnostic: diag('INSUFFICIENT_EVIDENCE_RECOMMENDATION', `recommendation "${recommendationId}" has evidenceSufficiency INSUFFICIENT_EVIDENCE and cannot be ACCEPTed/EDITed into a Blueprint decision`) };
  }
  return { ok: true, recommendation };
}

// Part 2 — informational only, never blocking: does the draft's own
// targetAudience/format/targetDuration differ from a linked CreativeBrief's?
function detectCreativeBriefMismatch(projectId, creativeBriefId, draft) {
  if (!creativeBriefId) return [];
  const brief = creativeStore.getCreativeBrief(projectId);
  if (!brief || brief.id !== creativeBriefId) return [];
  const mismatches = [];
  if (draft.targetAudience && brief.audience && draft.targetAudience !== brief.audience) mismatches.push(`targetAudience ("${draft.targetAudience}") differs from linked CreativeBrief's audience ("${brief.audience}")`);
  if (draft.format && brief.format && draft.format !== brief.format) mismatches.push(`format ("${draft.format}") differs from linked CreativeBrief's format ("${brief.format}")`);
  if (typeof draft.targetDuration === 'number' && typeof brief.targetDuration === 'number' && draft.targetDuration !== brief.targetDuration) {
    mismatches.push(`targetDuration (${draft.targetDuration}s) differs from linked CreativeBrief's targetDuration (${brief.targetDuration}s)`);
  }
  return mismatches.map((m) => diag('CREATIVE_BRIEF_MISMATCH', m));
}

// Public entry point (Part 3/6/17/18). Builds and persists a DRAFT
// CreativeBlueprint from real, already-supplied human input plus real,
// already-persisted Recommendation records — never inventing evidence,
// strategy, or approval.
function buildCreativeBlueprintDraft(projectId, input = {}) {
  if (!projectStore.getProject(projectId)) {
    return createCreativeBlueprint({ projectId, status: 'FAILED', diagnostics: [diag('INVALID_RECOMMENDATION_SET', `no project found with id "${projectId}"`)] });
  }

  const { referenceSetId, recommendationSetId, creativeBriefId } = input;
  const recommendationSet = recommendationSetId
    ? recommendationStore.getRecommendationSet(projectId, recommendationSetId)
    : referenceSetId
    ? recommendationStore.getLatestRecommendationSetForReferenceSet(projectId, referenceSetId)
    : null;
  if (!recommendationSet || recommendationSet.projectId !== projectId) {
    return createCreativeBlueprint({ projectId, referenceSetId, status: 'FAILED', diagnostics: [diag('INVALID_RECOMMENDATION_SET', `no RecommendationSet found for referenceSetId "${referenceSetId}" / recommendationSetId "${recommendationSetId}"`)] });
  }

  const diagnostics = [];
  const validDecisions = [];
  for (const decisionInput of Array.isArray(input.recommendationDecisions) ? input.recommendationDecisions : []) {
    const resolved = resolveRecommendationDecision(recommendationSet, decisionInput);
    if (!resolved.ok) {
      diagnostics.push(resolved.diagnostic);
      continue; // Part 6 — never silently accept invalid provenance, never invent a replacement
    }
    validDecisions.push(
      createRecommendationDecision({
        recommendationId: resolved.recommendation.id,
        decision: decisionInput.decision,
        decidedBy: decisionInput.decidedBy || null,
        note: decisionInput.note || null,
        finalCreativeDecision: decisionInput.decision === 'ACCEPT' || decisionInput.decision === 'EDIT' ? decisionInput.finalCreativeDecision || resolved.recommendation.action : null,
      })
    );
  }

  // Part 6 — provenance, derived ONLY from valid, resolved decisions.
  const sourceRecommendationIds = [...new Set(validDecisions.map((d) => d.recommendationId))];
  const acceptedOrEdited = validDecisions.filter((d) => d.decision === 'ACCEPT' || d.decision === 'EDIT');
  const sourcePatternIds = [...new Set(acceptedOrEdited.flatMap((d) => (recommendationSet.recommendations.find((r) => r.id === d.recommendationId) || { sourcePatternIds: [] }).sourcePatternIds))];
  const sourceReferenceSetIds = [...new Set([recommendationSet.referenceSetId])];

  // Part 9 — continuity requirement validation against the real VisualBible.
  const visualBible = creativeStore.getVisualBible(projectId);
  const validContinuityRequirements = [];
  for (const cr of Array.isArray(input.continuityRequirements) ? input.continuityRequirements : []) {
    if (resolveEntityReference(visualBible, cr.entityType, cr.entityId)) {
      validContinuityRequirements.push(cr);
    } else {
      diagnostics.push(diag('INVALID_ENTITY_REFERENCE', `continuity requirement references "${cr.entityType}" id "${cr.entityId}", which does not exist in this project's VisualBible`));
    }
  }

  // Part 10 — VoiceProfile reuse: validated via the real factory, never
  // redefined; if the caller supplied nothing, this stays null (never
  // invented).
  const narrationDirection = input.narrationDirection
    ? { ...input.narrationDirection, voiceProfile: input.narrationDirection.voiceProfile ? createVoiceProfile(input.narrationDirection.voiceProfile) : null }
    : undefined;

  // Part 17/18 — structural readiness diagnostics, checked against real
  // supplied values only.
  if (!input.concept || String(input.concept).trim().length === 0) diagnostics.push(diag('MISSING_CONCEPT', 'concept is required'));
  if (!input.corePromise || String(input.corePromise).trim().length === 0) diagnostics.push(diag('MISSING_CORE_PROMISE', 'corePromise is required'));
  if (input.targetDuration === undefined || input.targetDuration === null) {
    diagnostics.push(diag('MISSING_TARGET_DURATION', 'targetDuration is required'));
  } else if (typeof input.targetDuration !== 'number' || !Number.isFinite(input.targetDuration) || input.targetDuration <= 0) {
    diagnostics.push(diag('INVALID_TARGET_DURATION', `targetDuration "${input.targetDuration}" must be a positive number of seconds`));
  }
  const contradiction = detectStructuralContradiction(input.targetDuration, input.structuralDirection);
  if (contradiction) diagnostics.push(contradiction);

  const draftForMismatchCheck = { targetAudience: input.targetAudience, format: input.format, targetDuration: input.targetDuration };
  diagnostics.push(...detectCreativeBriefMismatch(projectId, creativeBriefId, draftForMismatchCheck));

  const blueprint = createCreativeBlueprint({
    projectId,
    creativeBriefId: creativeBriefId || null,
    referenceSetId: recommendationSet.referenceSetId,
    recommendationSetId: recommendationSet.id,
    title: input.title || '',
    concept: input.concept || '',
    corePromise: input.corePromise || '',
    format: input.format || null,
    targetAudience: input.targetAudience || null,
    targetDuration: typeof input.targetDuration === 'number' ? input.targetDuration : null,
    hookStrategy: input.hookStrategy || '',
    narrativeStrategy: input.narrativeStrategy || '',
    pacingStrategy: input.pacingStrategy || '',
    visualStrategy: input.visualStrategy || '',
    narrationStrategy: input.narrationStrategy || '',
    tone: input.tone || '',
    emotionalArc: input.emotionalArc || '',
    recommendationDecisions: validDecisions,
    creativeDecisions: input.creativeDecisions || [],
    constraints: input.constraints || [],
    exclusions: input.exclusions || [],
    openQuestions: input.openQuestions || [],
    visualDirection: input.visualDirection || '',
    narrationDirection,
    structuralDirection: input.structuralDirection,
    continuityRequirements: validContinuityRequirements,
    productionConsiderations: deriveBlueprintProductionConsiderations({ continuityRequirements: validContinuityRequirements, targetDuration: input.targetDuration, structuralDirection: input.structuralDirection }),
    sourceRecommendationIds,
    sourcePatternIds,
    sourceReferenceSetIds,
    status: 'DRAFT',
    diagnostics,
  });

  const saved = creativeBlueprintStore.addCreativeBlueprint(projectId, blueprint);
  return saved.ok ? saved.blueprint : blueprint;
}

// Part 7 — optional soft transition, DRAFT -> PENDING_REVIEW. Never
// blocked by missing fields (only APPROVE is a hard gate).
function submitCreativeBlueprintForReview(projectId, blueprintId, { submittedBy } = {}) {
  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId);
  if (!blueprint) return { ok: false, reason: `no CreativeBlueprint found with id "${blueprintId}"` };
  if (blueprint.status !== 'DRAFT') return { ok: false, reason: `cannot submit for review from status "${blueprint.status}" — only DRAFT may be submitted` };
  creativeBlueprintStore.updateCreativeBlueprintReviewState(projectId, blueprintId, { status: 'PENDING_REVIEW' });
  return { ok: true, blueprint: creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId) };
}

// Part 7/19/24 — human review. APPROVE/REJECT only ever touch
// status/reviews[] (via creativeBlueprintStore.updateCreativeBlueprintReviewState).
// REQUEST_REVISION creates a brand-new DRAFT v(n+1) and marks the current
// version SUPERSEDED — the current version's own content is NEVER
// overwritten in place (mirrors reviewRecommendation()/reviewInterpretation()
// exactly).
function reviewCreativeBlueprint(projectId, blueprintId, { decision, reviewedBy, note } = {}) {
  if (!CREATIVE_BLUEPRINT_REVIEW_DECISIONS.includes(decision)) return { ok: false, reason: `"${decision}" is not a recognized review decision` };
  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId);
  if (!blueprint) return { ok: false, reason: `no CreativeBlueprint found with id "${blueprintId}"` };

  if (decision === 'APPROVE') {
    if (!['DRAFT', 'PENDING_REVIEW'].includes(blueprint.status)) return { ok: false, reason: `cannot APPROVE from status "${blueprint.status}"` };
    // Part 7/13 — human approval is authoritative, but it can never
    // override a real structural blocker (Part 17). Passing validation is
    // necessary, not sufficient — an explicit human decision is still
    // required to reach this point at all.
    const blocking = blueprint.diagnostics.filter((d) => BLOCKING_DIAGNOSTIC_CODES.includes(d.code));
    if (blocking.length > 0) {
      return { ok: false, reason: `cannot APPROVE — ${blocking.length} blocking diagnostic(s) unresolved: ${blocking.map((d) => d.code).join(', ')}` };
    }
    creativeBlueprintStore.updateCreativeBlueprintReviewState(projectId, blueprintId, { status: 'APPROVED', review: createCreativeBlueprintReview({ decision, reviewedBy, note }) });
    return { ok: true, blueprint: creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId) };
  }

  if (decision === 'REJECT') {
    if (!['DRAFT', 'PENDING_REVIEW'].includes(blueprint.status)) return { ok: false, reason: `cannot REJECT from status "${blueprint.status}"` };
    creativeBlueprintStore.updateCreativeBlueprintReviewState(projectId, blueprintId, { status: 'REJECTED', review: createCreativeBlueprintReview({ decision, reviewedBy, note }) });
    return { ok: true, blueprint: creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId) };
  }

  if (decision === 'REQUEST_REVISION') {
    if (blueprint.status === 'SUPERSEDED') return { ok: false, reason: 'this Blueprint is already SUPERSEDED by a later revision' };
    const revised = createCreativeBlueprint({
      ...blueprint,
      id: undefined,
      status: 'DRAFT',
      supersedesBlueprintId: blueprint.id,
      diagnostics: blueprint.diagnostics, // carried forward — still real, still unresolved until the human edits the new draft
      reviews: [],
      createdAt: undefined,
      updatedAt: undefined,
    });
    const saved = creativeBlueprintStore.addCreativeBlueprint(projectId, revised);
    if (!saved.ok) return { ok: false, reason: saved.reason };
    creativeBlueprintStore.updateCreativeBlueprintReviewState(projectId, blueprintId, {
      status: 'SUPERSEDED',
      review: createCreativeBlueprintReview({ decision, reviewedBy, note, resultingBlueprintId: saved.blueprint.id }),
    });
    return { ok: true, blueprint: saved.blueprint, original: creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId) };
  }

  return { ok: false, reason: `"${decision}" is not a recognized review decision` };
}

module.exports = {
  buildCreativeBlueprintDraft,
  submitCreativeBlueprintForReview,
  reviewCreativeBlueprint,
  resolveRecommendationDecision,
  resolveEntityReference,
  detectStructuralContradiction,
  deriveBlueprintProductionConsiderations,
};
