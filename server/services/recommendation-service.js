// recommendation-service.js
//
// INT-1F — the orchestrator proving the FIRST action-proposing layer:
//
//   PatternSet (INT-1E) -> RecommendationSet
//
// THE EPISTEMIC RULE (this stage's own core principle, restated as code):
// a Recommendation is NOT evidence, NOT a fact, NOT a pattern. Every
// Recommendation this file produces carries sourcePatternIds/
// supportingReferenceVideoIds pointing at REAL, already-persisted Pattern
// records (which themselves already point at real Observations/
// Measurements/ReferenceVideos — see cross-video-pattern-service.js's own
// header) — the chain Recommendation -> Pattern -> Observation ->
// Measurement -> Reference Video -> Raw Evidence is never a claim without
// a pointer, and this file never invents evidence, never re-derives a
// Pattern's own prevalence/confidence/threshold, and never fabricates a
// Pattern id it didn't read from a real, persisted PatternSet.
//
// THE PATTERN LAYER IS THE GATE (Part 4): every Recommendation here
// originates from validateSourcePattern()'d PatternSet.patterns entries
// only — never from raw video, transcript, arbitrary measurements, LLM
// intuition, or hard-coded creator folklore. This file never imports
// reference-video-measurement-store.js or reference-video-observation-
// store.js directly for exactly that reason.
//
// FULLY DETERMINISTIC, NO LLM (Part 9): every statement/rationale/action
// below is built from a fixed template plus real Pattern data — never
// generated text from a model. This file never imports an interpretation
// or generation provider. If an LLM phrasing layer is ever added, its
// role is restricted to Part 9's own three bullets (phrase, explain,
// suggest wording variants) and its output would still have to pass
// containsUnsupportedLanguage() and the schema's own structural shape —
// that boundary is enforced here, not left to be built later.
//
// CORRELATION, NEVER CAUSATION (Part 7) + LANGUAGE SAFEGUARDS (Part 8):
// containsUnsupportedLanguage() below mirrors reference-video-
// interpretation-service.js's own containsBannedLanguage() convention —
// applied to every generated statement/rationale/action as a defense-in-
// depth net (the templates below are written to never trip it in normal
// operation, but a violation is never silently repaired — it drops the
// candidate and records BANNED_LANGUAGE_REJECTED).

const projectStore = require('./project-store');
const patternStore = require('./cross-video-pattern-store');
const recommendationStore = require('./recommendation-store');
const recommendationMath = require('./reference-video/recommendation-math');
const {
  RECOMMENDATION_REVIEW_DECISIONS,
  BANNED_OUTCOME_CATEGORIES,
  createRecommendationDiagnostic,
  createRecommendation,
  createRecommendationSet,
  createRecommendationReview,
} = require('../schemas/recommendation-schema');

// Part 7/8 — mirrors reference-video-interpretation-service.js's own
// INTENT_CLAIM_PATTERN/QUALITY_JUDGMENT_PATTERN/RECOMMENDATION_PATTERN
// convention exactly (one targeted regex per named prohibition, never a
// general-purpose NLP classifier this codebase has no way to build).
const CAUSAL_LANGUAGE_PATTERN = /\b(causes?|leads? to|results? in|because of this|increases? (retention|engagement|views)|drives? (retention|engagement|views)|keeps? viewers? (engaged|watching)|makes? (videos?|viewers?) (perform|stay|watch)|is why (these|this|the))\b/i;
const CERTAINTY_LANGUAGE_PATTERN = /\b(always|never|guaranteed?|proven to work|the secret is|this will make|this causes|this guarantees|definitely works?|will (guarantee|ensure)|proven to increase)\b/i;
const OUTCOME_JUDGMENT_PATTERN = /\b(viral|virality|engagement score|quality score|retention score|best practice|the key to success)\b/i;

// cross-video-pattern-service.js's own CO_OCCURRENCE statements DISCLAIM
// causation using the word "causes" negated ("...not evidence that either
// influences or causes the other") — exactly Part 7's required behavior.
// `rationale` reuses that sentence verbatim (see buildRecommendationContent
// below), so the disclaimer clause itself must be stripped before scanning
// for an AFFIRMATIVE causal claim, or this guard would reject the very
// sentence that correctly refuses to claim causation (the identical false-
// positive already found and fixed in test/cross-video-pattern-service.
// test.js's own causal-language battery test during INT-1E).
const CO_OCCURRENCE_DISCLAIMER_CLAUSE = /not evidence that (either )?influences? or causes? the other\.?/i;

function containsUnsupportedLanguage(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const sanitized = text.replace(CO_OCCURRENCE_DISCLAIMER_CLAUSE, '');
  if (CAUSAL_LANGUAGE_PATTERN.test(sanitized)) return 'an unsupported causal claim';
  if (CERTAINTY_LANGUAGE_PATTERN.test(sanitized)) return 'an unsupported certainty claim';
  if (OUTCOME_JUDGMENT_PATTERN.test(sanitized)) return 'an unsupported outcome/quality judgment';
  return null;
}

function diag(code, message) {
  return createRecommendationDiagnostic({ code, message });
}

// Part 16 — a documented, qualitative-only, category-keyed mapping (never
// a cost estimator — that stays out of scope per this stage's own DO NOT
// BUILD list). `null` entries are deliberate: not every category implies
// a clear production consideration, and inventing one would violate the
// same "never invent evidence" discipline this whole file follows.
const PRODUCTION_CONSIDERATION_BY_CATEGORY = {
  SHOT_RHYTHM: 'May require additional editing complexity (more cut points to produce and align).',
  STRUCTURE: 'May require additional editing complexity (more cut points to produce and align).',
  PACING: 'May require additional editing complexity (more cut points to produce and align).',
  NARRATION: 'May require additional narration/scripting work.',
  SPEECH_DENSITY: 'May require additional narration/scripting work.',
  OPENING: 'May require an additional narration/scripting pass for the opening.',
  OPENING_STRUCTURE: 'May require an additional narration/scripting pass for the opening.',
  VISUAL_CHANGE: 'May require additional visual assets or animation to sustain the observed rate of change.',
  TEXT_PRESENCE: 'May require additional on-screen text/graphics production.',
  SILENCE: null,
  TIMING: null,
};

function deriveProductionConsiderations(pattern) {
  const categories = pattern.type === 'CO_OCCURRENCE' && pattern.coOccurrence ? [pattern.coOccurrence.categoryA, pattern.coOccurrence.categoryB] : [pattern.category];
  const notes = new Set();
  for (const c of categories) {
    const note = PRODUCTION_CONSIDERATION_BY_CATEGORY[c];
    if (note) notes.add(note);
  }
  return [...notes].map((note) => ({ note }));
}

// Part 4 — "validate the Pattern... validate its support... validate its
// evidence chain" before any translation is attempted. Every field
// checked here is one this file's own templates below actually read;
// nothing is invented if a check fails — the pattern is simply skipped
// and a structured diagnostic recorded (never repaired, never guessed).
function validateSourcePattern(pattern) {
  if (!pattern || typeof pattern.id !== 'string' || pattern.id.length === 0) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', 'a candidate pattern has no valid id') };
  }
  if (!['RECURRING_OBSERVATION', 'NUMERIC_DISTRIBUTION', 'CO_OCCURRENCE', 'OUTLIER'].includes(pattern.type)) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" has an unrecognized type "${pattern.type}"`) };
  }
  if (!pattern.prevalence || typeof pattern.prevalence.supportingCount !== 'number' || typeof pattern.prevalence.totalCount !== 'number') {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" has no valid prevalence`) };
  }
  if (!Array.isArray(pattern.support)) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" has no valid support[]`) };
  }
  if (!['MEDIUM', 'LOW'].includes(pattern.confidence)) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" has an unrecognized confidence "${pattern.confidence}" — never HIGH, never anything else`) };
  }
  if (typeof pattern.category === 'string' && BANNED_OUTCOME_CATEGORIES.includes(pattern.category.toUpperCase())) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" has a banned outcome-vocabulary category "${pattern.category}" — Part 3`) };
  }
  if (pattern.type === 'RECURRING_OBSERVATION' && typeof pattern.ruleId !== 'string') {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" is RECURRING_OBSERVATION but has no ruleId`) };
  }
  if (pattern.type === 'NUMERIC_DISTRIBUTION' && (typeof pattern.metric !== 'string' || !pattern.distribution)) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" is NUMERIC_DISTRIBUTION but has no metric/distribution`) };
  }
  if (pattern.type === 'CO_OCCURRENCE' && (!pattern.coOccurrence || !pattern.coOccurrence.ruleIdA || !pattern.coOccurrence.ruleIdB)) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" is CO_OCCURRENCE but has no coOccurrence.ruleIdA/ruleIdB`) };
  }
  if (pattern.type === 'OUTLIER' && (!pattern.outlier || typeof pattern.outlier.metric !== 'string')) {
    return { ok: false, diagnostic: diag('INVALID_SOURCE_PATTERN', `pattern "${pattern.id}" is OUTLIER but has no outlier.metric`) };
  }
  return { ok: true };
}

// Part 17 — every field below is read from the real, already-validated
// Pattern; nothing here is hard-coded.
function buildEvidenceSummary(pattern) {
  const { supportingCount, totalCount, percentage } = pattern.prevalence;
  return `${supportingCount} of ${totalCount} reference video(s) support this pattern (${percentage}%), confidence: ${pattern.confidence}.`;
}

// Part 2 — the ONE place statement/rationale/action are actually written.
// `rationale` REUSES the source Pattern's own real `statement` field
// verbatim in every branch below — never re-derived, never paraphrased in
// a way that could drift from what INT-1E actually established.
function buildRecommendationContent(pattern) {
  if (pattern.type === 'OUTLIER') {
    // Part 12 — ALTERNATIVE_STRATEGY: an outlier is honestly, explicitly
    // labeled as a non-majority finding from the start, so (unlike
    // CAUTION below) it is allowed to be reviewed/accepted normally —
    // accepting it is accepting "try the minority approach", never a
    // silent promotion of a weak claim as if it were a strong one.
    return {
      recommendationType: 'ALTERNATIVE_STRATEGY',
      derivationType: 'SINGLE_PATTERN',
      evidenceSufficiency: 'SUFFICIENT',
      statement: `Reference video ${pattern.outlier.referenceVideoId} departs notably from the rest of the set on "${pattern.outlier.metric}".`,
      rationale: pattern.statement,
      action: `Consider this outlier's approach to "${pattern.outlier.metric}" as an alternative strategy if it better fits the intended format, rather than assuming the majority pattern in this reference set is the only valid option.`,
    };
  }

  if (!pattern.meetsMinimumEvidenceThreshold) {
    // Part 5 — CAUTION: below INT-1E's own minimum evidence threshold.
    // Never actionable (action stays null), never eligible for ACCEPT
    // (enforced in reviewRecommendation, not just by convention here).
    let sourceLabel;
    let derivationType = 'SINGLE_PATTERN';
    if (pattern.type === 'RECURRING_OBSERVATION') sourceLabel = `"${pattern.ruleId}"`;
    else if (pattern.type === 'NUMERIC_DISTRIBUTION') sourceLabel = `the metric "${pattern.metric}"`;
    else {
      sourceLabel = `"${pattern.coOccurrence.ruleIdA}" and "${pattern.coOccurrence.ruleIdB}" co-occurring`;
      derivationType = 'CO_OCCURRENCE_PATTERN';
    }
    return {
      recommendationType: 'CAUTION',
      derivationType,
      evidenceSufficiency: 'INSUFFICIENT_EVIDENCE',
      statement: `${sourceLabel} appears in only ${pattern.prevalence.supportingCount} of ${pattern.prevalence.totalCount} reference video(s) (${pattern.prevalence.percentage}%) — below this system's minimum evidence threshold for a recommendation.`,
      rationale: pattern.statement,
      action: null,
    };
  }

  if (pattern.type === 'RECURRING_OBSERVATION') {
    return {
      recommendationType: 'RECURRING_PATTERN_APPLICATION',
      derivationType: 'SINGLE_PATTERN',
      evidenceSufficiency: 'SUFFICIENT',
      statement: `"${pattern.ruleId}" recurs across this reference set.`,
      rationale: pattern.statement,
      action: `Consider incorporating "${pattern.ruleId}" where it naturally fits the new video's subject matter.`,
    };
  }
  if (pattern.type === 'NUMERIC_DISTRIBUTION') {
    const { median, min, max } = pattern.distribution;
    return {
      recommendationType: 'TESTING_OPPORTUNITY',
      derivationType: 'SINGLE_PATTERN',
      evidenceSufficiency: 'SUFFICIENT',
      statement: `The metric "${pattern.metric}" shows a typical value across this reference set.`,
      rationale: pattern.statement,
      action: `Consider testing a "${pattern.metric}" near ${median.toFixed(3)} as a starting point, while allowing for the natural range observed in this reference set (${min.toFixed(3)}-${max.toFixed(3)}).`,
    };
  }
  // CO_OCCURRENCE, threshold met
  return {
    recommendationType: 'CO_OCCURRENCE_APPLICATION',
    derivationType: 'CO_OCCURRENCE_PATTERN',
    evidenceSufficiency: 'SUFFICIENT',
    statement: `"${pattern.coOccurrence.ruleIdA}" and "${pattern.coOccurrence.ruleIdB}" tend to co-occur in this reference set.`,
    rationale: pattern.statement,
    action: `Consider pairing "${pattern.coOccurrence.ruleIdA}" with "${pattern.coOccurrence.ruleIdB}" where it fits the new video, recognizing this reflects joint frequency, not a proven causal relationship.`,
  };
}

function buildRecommendationFromPattern(projectId, referenceSetId, patternSetId, pattern, homogeneityWarnings) {
  const validation = validateSourcePattern(pattern);
  if (!validation.ok) return { recommendation: null, diagnostic: validation.diagnostic };

  const content = buildRecommendationContent(pattern);
  for (const field of [content.statement, content.rationale, content.action]) {
    const reason = containsUnsupportedLanguage(field);
    if (reason) return { recommendation: null, diagnostic: diag('BANNED_LANGUAGE_REJECTED', `pattern "${pattern.id}" produced ${reason} ("${field}") — dropped, never repaired`) };
  }

  const supportingReferenceVideoIds = [...new Set(pattern.support.map((s) => s.referenceVideoId).filter(Boolean))];
  const confidenceResult = recommendationMath.combineConfidence([pattern.confidence]);
  const limitations = [...pattern.limitations, ...homogeneityWarnings.map((w) => w.message)];

  const recommendation = createRecommendation({
    projectId,
    referenceSetId,
    patternSetId,
    recommendationType: content.recommendationType,
    derivationType: content.derivationType,
    category: pattern.category,
    statement: content.statement,
    rationale: content.rationale,
    action: content.action,
    sourcePatternIds: [pattern.id],
    supportingReferenceVideoIds,
    evidenceSummary: buildEvidenceSummary(pattern),
    prevalence: pattern.prevalence,
    confidence: confidenceResult.combinedConfidence,
    confidenceMethodology: { sourceConfidences: confidenceResult.sourceConfidences, rule: confidenceResult.rule, combinedConfidence: confidenceResult.combinedConfidence, formula: confidenceResult.formula },
    evidenceSufficiency: content.evidenceSufficiency,
    meetsMinimumEvidenceThreshold: pattern.meetsMinimumEvidenceThreshold,
    limitations,
    productionConsiderations: deriveProductionConsiderations(pattern),
  });
  return { recommendation, diagnostic: null };
}

// Public entry point. Resolves the LATEST PatternSet for the given
// referenceSetId (mirroring cross-video-pattern-service.js's own "always
// operate on latest evidence" convention) — never re-derives patterns
// itself, never touches Measurements/Observations/ReferenceVideos.
function generateRecommendations(projectId, referenceSetId) {
  if (!projectStore.getProject(projectId)) {
    return createRecommendationSet({ projectId, referenceSetId, status: 'FAILED', diagnostics: [diag('INVALID_PATTERN_SET', `no project found with id "${projectId}"`)] });
  }
  const patternSet = patternStore.getLatestPatternSetForReferenceSet(projectId, referenceSetId);
  if (!patternSet) {
    return createRecommendationSet({ projectId, referenceSetId, status: 'FAILED', diagnostics: [diag('INVALID_PATTERN_SET', `no PatternSet found for reference set "${referenceSetId}"`)] });
  }
  if (!Array.isArray(patternSet.patterns) || patternSet.patterns.length === 0) {
    return createRecommendationSet({ projectId, referenceSetId, patternSetId: patternSet.id, status: 'FAILED', diagnostics: [diag('INSUFFICIENT_PATTERNS', `PatternSet "${patternSet.id}" has no patterns to translate`)] });
  }

  const homogeneityWarnings = (patternSet.homogeneityReport && patternSet.homogeneityReport.warnings) || [];
  const recommendations = [];
  const diagnostics = [];
  for (const pattern of patternSet.patterns) {
    const result = buildRecommendationFromPattern(projectId, referenceSetId, patternSet.id, pattern, homogeneityWarnings);
    if (result.recommendation) recommendations.push(result.recommendation);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }

  const status = recommendations.length === 0 ? 'FAILED' : diagnostics.length === 0 ? 'COMPLETE' : 'PARTIAL';
  const recommendationSet = createRecommendationSet({ projectId, referenceSetId, patternSetId: patternSet.id, recommendations, status, diagnostics });
  const saved = recommendationStore.addRecommendationSet(projectId, recommendationSet);
  return saved.ok ? saved.recommendationSet : recommendationSet;
}

// Part 10 — human review. ACCEPT/REJECT/FLAG/REQUEST_ALTERNATIVE only
// ever touch status/reviews[] (via recommendationStore.
// updateRecommendationReviewState — the exact same narrow contract as
// cross-video-pattern-store.js's updatePatternReviewState). EDIT creates
// a brand-new Recommendation and marks the original SUPERSEDED — the
// original's own statement/rationale/action are NEVER overwritten in
// place (mirrors reference-video-interpretation-service.js's
// reviewInterpretation() exactly).
function reviewRecommendation(projectId, recommendationSetId, recommendationId, { decision, reviewedBy, note, editedStatement, editedRationale, editedAction } = {}) {
  if (!RECOMMENDATION_REVIEW_DECISIONS.includes(decision)) return { ok: false, reason: `"${decision}" is not a recognized review decision` };
  const recommendationSet = recommendationStore.getRecommendationSet(projectId, recommendationSetId);
  if (!recommendationSet) return { ok: false, reason: `no RecommendationSet found with id "${recommendationSetId}"` };
  const original = (recommendationSet.recommendations || []).find((r) => r.id === recommendationId);
  if (!original) return { ok: false, reason: `no Recommendation found with id "${recommendationId}"` };

  if (decision === 'ACCEPT') {
    // Part 5 — structurally blocked, never just a convention: an
    // INSUFFICIENT_EVIDENCE recommendation must not appear as approved.
    if (original.evidenceSufficiency === 'INSUFFICIENT_EVIDENCE') {
      return { ok: false, reason: 'this recommendation is below the minimum evidence threshold (evidenceSufficiency: INSUFFICIENT_EVIDENCE) and cannot be ACCEPTED' };
    }
    recommendationStore.updateRecommendationReviewState(projectId, recommendationSetId, recommendationId, { status: 'ACCEPTED', review: createRecommendationReview({ decision, reviewedBy, note }) });
    return { ok: true, recommendation: recommendationStore.getRecommendationSet(projectId, recommendationSetId).recommendations.find((r) => r.id === recommendationId) };
  }
  if (decision === 'REJECT') {
    recommendationStore.updateRecommendationReviewState(projectId, recommendationSetId, recommendationId, { status: 'REJECTED', review: createRecommendationReview({ decision, reviewedBy, note }) });
    return { ok: true, recommendation: recommendationStore.getRecommendationSet(projectId, recommendationSetId).recommendations.find((r) => r.id === recommendationId) };
  }
  if (decision === 'FLAG') {
    recommendationStore.updateRecommendationReviewState(projectId, recommendationSetId, recommendationId, { status: 'FLAGGED', review: createRecommendationReview({ decision, reviewedBy, note }) });
    return { ok: true, recommendation: recommendationStore.getRecommendationSet(projectId, recommendationSetId).recommendations.find((r) => r.id === recommendationId) };
  }
  if (decision === 'REQUEST_ALTERNATIVE') {
    recommendationStore.updateRecommendationReviewState(projectId, recommendationSetId, recommendationId, { status: 'NEEDS_ALTERNATIVE', review: createRecommendationReview({ decision, reviewedBy, note }) });
    return { ok: true, recommendation: recommendationStore.getRecommendationSet(projectId, recommendationSetId).recommendations.find((r) => r.id === recommendationId) };
  }
  if (decision === 'EDIT') {
    // Part 10 — same "must not become an approved recommendation" rule
    // applies to editing as to a direct ACCEPT: editing is not a backdoor
    // around Part 5's evidence-sufficiency block.
    if (original.evidenceSufficiency === 'INSUFFICIENT_EVIDENCE') {
      return { ok: false, reason: 'this recommendation is below the minimum evidence threshold (evidenceSufficiency: INSUFFICIENT_EVIDENCE) and cannot be EDITed into an accepted recommendation' };
    }
    if (editedStatement === undefined && editedRationale === undefined && editedAction === undefined) {
      return { ok: false, reason: 'an EDIT review must change at least one of editedStatement/editedRationale/editedAction' };
    }
    for (const field of [editedStatement, editedRationale, editedAction]) {
      const reason = containsUnsupportedLanguage(field);
      if (reason) return { ok: false, reason: `edited text contains ${reason} — the same constraints apply to human edits` };
    }
    const edited = createRecommendation({
      ...original,
      id: undefined,
      statement: editedStatement !== undefined ? editedStatement : original.statement,
      rationale: editedRationale !== undefined ? editedRationale : original.rationale,
      action: editedAction !== undefined ? editedAction : original.action,
      status: 'ACCEPTED',
      supersedesRecommendationId: original.id,
      reviews: [],
      createdAt: undefined,
    });
    const saved = recommendationStore.addRecommendation(projectId, recommendationSetId, edited);
    if (!saved.ok) return { ok: false, reason: saved.reason };
    recommendationStore.updateRecommendationReviewState(projectId, recommendationSetId, recommendationId, {
      status: 'SUPERSEDED',
      review: createRecommendationReview({ decision, reviewedBy, note, resultingRecommendationId: saved.recommendation.id }),
    });
    return { ok: true, recommendation: saved.recommendation, original: recommendationStore.getRecommendationSet(projectId, recommendationSetId).recommendations.find((r) => r.id === recommendationId) };
  }
  return { ok: false, reason: `"${decision}" is not a recognized review decision` };
}

module.exports = {
  generateRecommendations,
  reviewRecommendation,
  validateSourcePattern,
  containsUnsupportedLanguage,
  buildEvidenceSummary,
  deriveProductionConsiderations,
  PRODUCTION_CONSIDERATION_BY_CATEGORY,
};
