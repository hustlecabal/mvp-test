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

// P0 Hardening — extracted from what used to be buildCreativeBlueprintDraft's
// own inline body, so a REVISION can recompute diagnostics fresh against
// whatever content it actually holds, instead of the two paths (initial
// build vs. REQUEST_REVISION) diverging — one validating for real, the
// other blindly copying a prior diagnostics[] array forward. `content` is
// any object exposing the same field names buildCreativeBlueprintDraft's
// own `input` always has: concept/corePromise/targetDuration/
// structuralDirection/recommendationDecisions/continuityRequirements/
// creativeBriefId/targetAudience/format — an existing Blueprint record
// already has every one of these under the same names, so it can be passed
// here directly with no reshaping.
function validateBlueprintContent(projectId, recommendationSet, content) {
  const diagnostics = [];
  const validDecisions = [];
  for (const decisionInput of Array.isArray(content.recommendationDecisions) ? content.recommendationDecisions : []) {
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

  // Part 9 — continuity requirement validation against the real VisualBible.
  const visualBible = creativeStore.getVisualBible(projectId);
  const validContinuityRequirements = [];
  for (const cr of Array.isArray(content.continuityRequirements) ? content.continuityRequirements : []) {
    if (resolveEntityReference(visualBible, cr.entityType, cr.entityId)) {
      validContinuityRequirements.push(cr);
    } else {
      diagnostics.push(diag('INVALID_ENTITY_REFERENCE', `continuity requirement references "${cr.entityType}" id "${cr.entityId}", which does not exist in this project's VisualBible`));
    }
  }

  // Part 17/18 — structural readiness diagnostics, checked against real
  // supplied values only.
  if (!content.concept || String(content.concept).trim().length === 0) diagnostics.push(diag('MISSING_CONCEPT', 'concept is required'));
  if (!content.corePromise || String(content.corePromise).trim().length === 0) diagnostics.push(diag('MISSING_CORE_PROMISE', 'corePromise is required'));
  if (content.targetDuration === undefined || content.targetDuration === null) {
    diagnostics.push(diag('MISSING_TARGET_DURATION', 'targetDuration is required'));
  } else if (typeof content.targetDuration !== 'number' || !Number.isFinite(content.targetDuration) || content.targetDuration <= 0) {
    diagnostics.push(diag('INVALID_TARGET_DURATION', `targetDuration "${content.targetDuration}" must be a positive number of seconds`));
  }
  const contradiction = detectStructuralContradiction(content.targetDuration, content.structuralDirection);
  if (contradiction) diagnostics.push(contradiction);

  diagnostics.push(...detectCreativeBriefMismatch(projectId, content.creativeBriefId, { targetAudience: content.targetAudience, format: content.format, targetDuration: content.targetDuration }));

  const productionConsiderations = deriveBlueprintProductionConsiderations({
    continuityRequirements: validContinuityRequirements,
    targetDuration: content.targetDuration,
    structuralDirection: content.structuralDirection,
  });

  return { diagnostics, validDecisions, sourceRecommendationIds, sourcePatternIds, validContinuityRequirements, productionConsiderations };
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

  const validated = validateBlueprintContent(projectId, recommendationSet, input);
  const sourceReferenceSetIds = [...new Set([recommendationSet.referenceSetId])];

  // Part 10 — VoiceProfile reuse: validated via the real factory, never
  // redefined; if the caller supplied nothing, this stays null (never
  // invented).
  const narrationDirection = input.narrationDirection
    ? { ...input.narrationDirection, voiceProfile: input.narrationDirection.voiceProfile ? createVoiceProfile(input.narrationDirection.voiceProfile) : null }
    : undefined;

  const blueprint = createCreativeBlueprint({
    projectId,
    creativeBriefId: creativeBriefId || null,
    referenceSetId: recommendationSet.referenceSetId,
    recommendationSetId: recommendationSet.id,
    strategyId: input.strategyId || null,
    ideaId: input.ideaId || null,
    packageId: input.packageId || null,
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
    recommendationDecisions: validated.validDecisions,
    creativeDecisions: input.creativeDecisions || [],
    constraints: input.constraints || [],
    exclusions: input.exclusions || [],
    openQuestions: input.openQuestions || [],
    visualDirection: input.visualDirection || '',
    narrationDirection,
    structuralDirection: input.structuralDirection,
    continuityRequirements: validated.validContinuityRequirements,
    productionConsiderations: validated.productionConsiderations,
    sourceRecommendationIds: validated.sourceRecommendationIds,
    sourcePatternIds: validated.sourcePatternIds,
    sourceReferenceSetIds,
    status: 'DRAFT',
    // CREATIVE BRAIN — purely additive passthrough for the one automated
    // caller of this SAME builder (services/creative-brain-service.js):
    // never populated by the existing human-authored MCP path, since
    // build_creative_blueprint_draft's own input never sets these.
    // `additionalDiagnostics` are MERGED with this function's own
    // rule-based diagnostics (validated.diagnostics) rather than
    // replacing them — both sets of findings remain visible, and the
    // existing BLOCKING_DIAGNOSTIC_CODES gate (already enforced at
    // reviewCreativeBlueprint(), untouched) applies to the union exactly
    // as it already does to validated.diagnostics alone.
    visualSpecification: input.visualSpecification,
    humanVoiceProfileId: input.humanVoiceProfileId || null,
    humanVoiceInfluences: input.humanVoiceInfluences || [],
    candidates: input.candidates || [],
    evaluationResults: input.evaluationResults || [],
    diagnostics: [...validated.diagnostics, ...(Array.isArray(input.additionalDiagnostics) ? input.additionalDiagnostics : [])],
  });

  const saved = creativeBlueprintStore.addCreativeBlueprint(projectId, blueprint);
  return saved.ok ? saved.blueprint : blueprint;
}

// P0 Hardening (Rule 2) — the one content-edit mechanism this file
// previously lacked. Only ever operates on a DRAFT/PENDING_REVIEW record
// (an APPROVED Blueprint's content stays immutable, unchanged from before).
// Recomputes diagnostics fresh via validateBlueprintContent — never
// invents content, never auto-approves, never auto-submits for review.
const EDITABLE_BLUEPRINT_FIELDS = [
  'title', 'concept', 'corePromise', 'format', 'targetAudience', 'targetDuration',
  'hookStrategy', 'narrativeStrategy', 'pacingStrategy', 'visualStrategy', 'narrationStrategy',
  'tone', 'emotionalArc', 'recommendationDecisions', 'creativeDecisions', 'constraints',
  'exclusions', 'openQuestions', 'visualDirection', 'structuralDirection', 'continuityRequirements',
];

function editCreativeBlueprintDraft(projectId, blueprintId, edits = {}) {
  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId);
  if (!blueprint) return { ok: false, reason: `no CreativeBlueprint found with id "${blueprintId}"` };
  if (!['DRAFT', 'PENDING_REVIEW'].includes(blueprint.status)) {
    return { ok: false, reason: `cannot edit content from status "${blueprint.status}" — only a DRAFT or PENDING_REVIEW Blueprint may be edited` };
  }
  const recommendationSet = recommendationStore.getRecommendationSet(projectId, blueprint.recommendationSetId);
  if (!recommendationSet) return { ok: false, reason: `no RecommendationSet found with id "${blueprint.recommendationSetId}"` };

  const mergedContent = { ...blueprint };
  for (const field of EDITABLE_BLUEPRINT_FIELDS) {
    if (edits[field] !== undefined) mergedContent[field] = edits[field];
  }

  const validated = validateBlueprintContent(projectId, recommendationSet, mergedContent);
  const contentUpdate = {
    title: mergedContent.title,
    concept: mergedContent.concept,
    corePromise: mergedContent.corePromise,
    format: mergedContent.format,
    targetAudience: mergedContent.targetAudience,
    targetDuration: mergedContent.targetDuration,
    hookStrategy: mergedContent.hookStrategy,
    narrativeStrategy: mergedContent.narrativeStrategy,
    pacingStrategy: mergedContent.pacingStrategy,
    visualStrategy: mergedContent.visualStrategy,
    narrationStrategy: mergedContent.narrationStrategy,
    tone: mergedContent.tone,
    emotionalArc: mergedContent.emotionalArc,
    creativeDecisions: mergedContent.creativeDecisions,
    constraints: mergedContent.constraints,
    exclusions: mergedContent.exclusions,
    openQuestions: mergedContent.openQuestions,
    visualDirection: mergedContent.visualDirection,
    structuralDirection: mergedContent.structuralDirection,
    recommendationDecisions: validated.validDecisions,
    continuityRequirements: validated.validContinuityRequirements,
    productionConsiderations: validated.productionConsiderations,
    sourceRecommendationIds: validated.sourceRecommendationIds,
    sourcePatternIds: validated.sourcePatternIds,
    diagnostics: validated.diagnostics,
  };
  const updated = creativeBlueprintStore.updateCreativeBlueprintContent(projectId, blueprintId, contentUpdate);
  if (!updated) return { ok: false, reason: 'failed to persist edit — Blueprint status may have changed concurrently' };
  return { ok: true, blueprint: updated };
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
    // P0 Hardening (finding A) — the pre-production gate's own documented
    // precondition is an APPROVED Blueprint (schemas/pre-production-gate-
    // schema.js), so REJECT must be reachable from APPROVED for the gate's
    // human-decision path to ever actually work, not just from the
    // pre-approval DRAFT/PENDING_REVIEW states this guard originally
    // allowed. Widening this one guard is the full extent of the fix —
    // REJECTED remains exactly as terminal as before (nothing here changes
    // what REJECTED itself permits).
    if (!['DRAFT', 'PENDING_REVIEW', 'APPROVED'].includes(blueprint.status)) return { ok: false, reason: `cannot REJECT from status "${blueprint.status}"` };
    creativeBlueprintStore.updateCreativeBlueprintReviewState(projectId, blueprintId, { status: 'REJECTED', review: createCreativeBlueprintReview({ decision, reviewedBy, note }) });
    return { ok: true, blueprint: creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId) };
  }

  if (decision === 'REQUEST_REVISION') {
    if (blueprint.status === 'SUPERSEDED') return { ok: false, reason: 'this Blueprint is already SUPERSEDED by a later revision' };
    // P0 Hardening (Rule 3) — REJECTED is a terminal state; nothing may
    // silently move it to SUPERSEDED just because REQUEST_REVISION is a
    // generic-sounding function. A rejected Blueprint has no path back —
    // building a brand-new draft (buildCreativeBlueprintDraft) is the only
    // way forward, exactly as it already was for a bad-provenance case
    // that was never approved in the first place.
    if (blueprint.status === 'REJECTED') return { ok: false, reason: 'a REJECTED Blueprint is terminal and cannot be revised — build a new Blueprint draft instead' };
    const recommendationSet = recommendationStore.getRecommendationSet(projectId, blueprint.recommendationSetId);
    if (!recommendationSet) return { ok: false, reason: `no RecommendationSet found with id "${blueprint.recommendationSetId}"` };
    // P0 Hardening (Rule 2/findings B, F) — recomputed fresh via the same
    // validation core buildCreativeBlueprintDraft uses, NEVER a blind copy
    // of the prior revision's diagnostics[]. Against unchanged content this
    // reproduces the same diagnostics (nothing has been fixed yet); once a
    // human calls editCreativeBlueprintDraft() on the resulting DRAFT, the
    // next recomputation can actually clear a diagnostic that content edit
    // genuinely fixed — a real repair path, not a permanently-stuck clone.
    const validated = validateBlueprintContent(projectId, recommendationSet, blueprint);
    const revised = createCreativeBlueprint({
      ...blueprint,
      id: undefined,
      status: 'DRAFT',
      supersedesBlueprintId: blueprint.id,
      recommendationDecisions: validated.validDecisions,
      continuityRequirements: validated.validContinuityRequirements,
      productionConsiderations: validated.productionConsiderations,
      sourceRecommendationIds: validated.sourceRecommendationIds,
      sourcePatternIds: validated.sourcePatternIds,
      diagnostics: validated.diagnostics,
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
  editCreativeBlueprintDraft,
  submitCreativeBlueprintForReview,
  reviewCreativeBlueprint,
  resolveRecommendationDecision,
  resolveEntityReference,
  detectStructuralContradiction,
  deriveBlueprintProductionConsiderations,
  validateBlueprintContent,
};
