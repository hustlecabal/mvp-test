// creative-evaluation-service.js
//
// CREATIVE BRAIN, Part 25/26 — evaluates ONE Creative Angle candidate (or
// a fully-synthesized direction) against 8 INDEPENDENT dimensions, each
// producing its own PASS/FAIL/WARN result. NEVER collapsed into a single
// combined score (explicit, locked decision from this stage's sign-off:
// "PASS/FAIL/WARN is far more defensible than 'Creativity: 87/100' —
// keep that decision locked").
//
// Every FAIL maps 1:1 onto one of the 10 anti-slop diagnostic codes added
// to schemas/creative-blueprint-schema.js's CREATIVE_BLUEPRINT_DIAGNOSTIC_
// CODES/BLOCKING_DIAGNOSTIC_CODES — this file does not decide approval
// gating itself; it only produces the findings services/creative-brain-
// service.js attaches to the Blueprint, where the EXISTING blueprint
// review gate (already blocking MISSING_CONCEPT etc.) does the actual
// enforcement. This file never talks to approval-gate.js, never mutates
// anything, never calls a provider.
//
// REUSES EXISTING CHECKS RATHER THAN DUPLICATING (Hard Rule, every stage
// this session): the coherence dimension calls creative-blueprint-
// service.js's own detectStructuralContradiction() verbatim.
//
// PART 15's SIGN-OFF, restated here so it is not forgotten during
// implementation: visualSpecification completeness is a SPECIFICATION-
// COMPLETENESS mechanism, not a taste engine. Filling every field proves
// the dimension was considered — it does not prove the result is
// aesthetically good. Do not expand this dimension to imply otherwise.

const { detectStructuralContradiction } = require('../creative-blueprint-service');
const { scanGenericHook, scanCorporateFiller, scanUnsupportedClaim } = require('../content-safety/creative-banned-language');

const MIN_SPECIFICITY_ANCHORS = 2;
const MIN_HOOK_ANCHORS = 1;
const PHRASING_OVERLAP_NGRAM = 5;
const PHRASING_OVERLAP_THRESHOLD = 0.4; // Part 23 — >40% of 5-grams shared with a single evidence source
const DOMINANT_EVIDENCE_RATIO_THRESHOLD = 0.75; // Part 23 — >75% of evidence traceable to one reference is a red flag
const TOPIC_OVERLAP_THRESHOLD = 0.6; // Part 25 narrative-clarity — corePromise too close to a bare topic restatement

const CONTRAST_MARKERS = ['but', 'yet', 'despite', 'instead of', 'not just', 'rather than', 'even though'];
const EMOTION_TERMS = ['curiosity', 'unease', 'clarity', 'tension', 'relief', 'dread', 'hope', 'frustration', 'satisfaction', 'surprise', 'calm', 'urgency', 'anxiety', 'excitement', 'regret', 'pride', 'shame'];

function result(dimension, code, res, detail) {
  return { dimension, code, result: res, detail };
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(words, n) {
  const grams = [];
  for (let i = 0; i + n <= words.length; i += 1) grams.push(words.slice(i, i + n).join(' '));
  return grams;
}

// Part 9 — concrete-anchor count: numbers/currency/percentages, contrast
// markers, and quoted/specific phrases. A deterministic proxy for
// "specific detail that carries meaning," never a semantic judgment.
function countAnchors(text) {
  if (!text) return 0;
  let count = 0;
  const numberMatches = text.match(/\b\d+([.,]\d+)?%?\b/g);
  if (numberMatches) count += numberMatches.length;
  const lower = text.toLowerCase();
  for (const marker of CONTRAST_MARKERS) {
    if (lower.includes(marker)) count += 1;
  }
  const quoted = text.match(/"[^"]{3,}"/g);
  if (quoted) count += quoted.length;
  return count;
}

// --- Dimension 1: Specificity -----------------------------------------
function evaluateSpecificity(candidate) {
  const combined = `${candidate.concept} ${candidate.corePromise}`;
  const anchors = countAnchors(combined);
  const hookAnchors = countAnchors(candidate.hookStrategy);
  const genericHookMatch = scanGenericHook(candidate.hookStrategy);
  const results = [];
  results.push(result('specificity', 'WEAK_SPECIFICITY', anchors >= MIN_SPECIFICITY_ANCHORS ? 'PASS' : 'FAIL', `${anchors} concrete anchor(s) found in concept/corePromise (minimum ${MIN_SPECIFICITY_ANCHORS})`));
  if (genericHookMatch) {
    results.push(result('specificity', 'GENERIC_HOOK', 'FAIL', genericHookMatch));
  } else {
    results.push(result('specificity', 'GENERIC_HOOK', hookAnchors >= MIN_HOOK_ANCHORS ? 'PASS' : 'FAIL', `hookStrategy has ${hookAnchors} concrete anchor(s) (minimum ${MIN_HOOK_ANCHORS})`));
  }
  return results;
}

// --- Dimension 2: Coherence — reuses the EXISTING contradiction check --
function evaluateCoherence(structuralDirection, targetDuration) {
  if (!structuralDirection || structuralDirection.plannedSectionCount == null || structuralDirection.minimumSectionDurationSeconds == null) {
    return [result('coherence', 'CONTRADICTORY_STRUCTURE', 'WARN', 'no structuralDirection supplied — coherence not evaluable at this stage')];
  }
  const diagnostic = detectStructuralContradiction(targetDuration, structuralDirection);
  return [result('coherence', 'CONTRADICTORY_STRUCTURE', diagnostic ? 'FAIL' : 'PASS', diagnostic ? diagnostic.message : 'planned section count/duration fits within targetDuration')];
}

// --- Dimension 3: Emotional logic --------------------------------------
function evaluateEmotionalLogic(emotionalArc) {
  if (!emotionalArc) return [result('emotionalLogic', 'NO_MEANINGFUL_TENSION', 'FAIL', 'emotionalArc is empty')];
  const lower = emotionalArc.toLowerCase();
  const distinctStages = EMOTION_TERMS.filter((term) => lower.includes(term));
  return [result('emotionalLogic', 'NO_MEANINGFUL_TENSION', distinctStages.length >= 2 ? 'PASS' : 'FAIL', `${distinctStages.length} distinct emotional stage term(s) found (minimum 2): ${distinctStages.join(', ') || 'none'}`)];
}

// --- Dimension 4: Narrative clarity — corePromise vs bare topic overlap
function evaluateNarrativeClarity(candidate, topic) {
  const topicWords = new Set(tokenize(topic));
  const promiseWords = tokenize(candidate.corePromise);
  if (topicWords.size === 0 || promiseWords.length === 0) {
    return [result('narrativeClarity', 'GENERIC_ANGLE', 'WARN', 'topic or corePromise missing — not evaluable')];
  }
  const overlapping = promiseWords.filter((w) => topicWords.has(w)).length;
  const ratio = overlapping / promiseWords.length;
  return [result('narrativeClarity', 'GENERIC_ANGLE', ratio <= TOPIC_OVERLAP_THRESHOLD ? 'PASS' : 'FAIL', `${Math.round(ratio * 100)}% of corePromise words overlap the bare topic (threshold ${Math.round(TOPIC_OVERLAP_THRESHOLD * 100)}%)`)];
}

// --- Dimension 5/6: Originality + reference-overfitting (Part 23) ------
function phrasingOverlapRatio(candidateText, sourceTexts) {
  const candidateGrams = new Set(ngrams(tokenize(candidateText), PHRASING_OVERLAP_NGRAM));
  if (candidateGrams.size === 0) return 0;
  let maxOverlap = 0;
  for (const source of sourceTexts) {
    const sourceGrams = new Set(ngrams(tokenize(source), PHRASING_OVERLAP_NGRAM));
    if (sourceGrams.size === 0) continue;
    let shared = 0;
    for (const gram of candidateGrams) if (sourceGrams.has(gram)) shared += 1;
    const ratio = shared / candidateGrams.size;
    if (ratio > maxOverlap) maxOverlap = ratio;
  }
  return maxOverlap;
}

function evaluateOriginality(candidate, { recommendations = [], voicePatterns = [], dominantEvidenceRatio = null, structuralSimilarityScore = null } = {}) {
  const results = [];
  const sourceTexts = [...recommendations.map((r) => `${r.statement} ${r.rationale}`), ...voicePatterns.map((v) => v.pattern)];
  const candidateText = `${candidate.concept} ${candidate.corePromise} ${candidate.hookStrategy}`;
  const overlap = sourceTexts.length > 0 ? phrasingOverlapRatio(candidateText, sourceTexts) : 0;
  results.push(result('originality', 'REFERENCE_TEMPLATE_IMITATION', overlap <= PHRASING_OVERLAP_THRESHOLD ? 'PASS' : 'FAIL', `${Math.round(overlap * 100)}% of candidate ${PHRASING_OVERLAP_NGRAM}-grams overlap a single evidence source (threshold ${Math.round(PHRASING_OVERLAP_THRESHOLD * 100)}%)`));

  if (structuralSimilarityScore == null) {
    results.push(result('originality', 'REFERENCE_TEMPLATE_IMITATION', 'WARN', 'structural similarity not supplied by the caller — not evaluated'));
  } else {
    results.push(result('originality', 'REFERENCE_TEMPLATE_IMITATION', structuralSimilarityScore <= PHRASING_OVERLAP_THRESHOLD ? 'PASS' : 'FAIL', `structural similarity to a single reference video: ${Math.round(structuralSimilarityScore * 100)}%`));
  }

  if (dominantEvidenceRatio == null) {
    results.push(result('referenceOverfitting', 'REFERENCE_TEMPLATE_IMITATION', 'WARN', 'dominant-evidence ratio not supplied by the caller — not evaluated'));
  } else {
    results.push(result('referenceOverfitting', 'REFERENCE_TEMPLATE_IMITATION', dominantEvidenceRatio <= DOMINANT_EVIDENCE_RATIO_THRESHOLD ? 'PASS' : 'FAIL', `${Math.round(dominantEvidenceRatio * 100)}% of accepted evidence traces to one reference video (threshold ${Math.round(DOMINANT_EVIDENCE_RATIO_THRESHOLD * 100)}%)`));
  }
  return results;
}

// --- Dimension 7: Visual taste (completeness only, per Part 15's sign-off)
const VISUAL_SPEC_DIMENSIONS = ['composition', 'palette', 'lighting', 'texture', 'depth', 'cameraLanguage', 'subjectTreatment', 'environmentalTreatment', 'visualDensity', 'motionLanguage', 'typography', 'negativeConstraints'];
function evaluateVisualTaste(visualSpecification) {
  if (!visualSpecification) return [result('visualTaste', 'VISUAL_DIRECTION_TOO_GENERIC', 'FAIL', 'no visualSpecification supplied')];
  const missing = VISUAL_SPEC_DIMENSIONS.filter((d) => !visualSpecification[d] || String(visualSpecification[d]).trim().length === 0);
  return [result('visualTaste', 'VISUAL_DIRECTION_TOO_GENERIC', missing.length === 0 ? 'PASS' : 'FAIL', missing.length === 0 ? 'all 12 visualSpecification dimensions populated (completeness only — not an aesthetic judgment)' : `missing dimension(s): ${missing.join(', ')}`)];
}

// --- Dimension 8: Treatment fit — not applicable in this stage ---------
// Creative Brain does not select per-beat visual treatments (that is
// Storyboard's job, explicitly out of scope per the forensic finding
// that Blueprint -> Storyboard generation is unbuilt future work). This
// dimension is reported honestly as not-yet-applicable rather than
// fabricating a check with no real input to evaluate.
function evaluateTreatmentFit() {
  return [result('treatmentFit', null, 'WARN', 'not applicable at this stage — Creative Brain does not select per-beat visual treatments; that occurs later, in Storyboard generation')];
}

// --- Unsupported-claim / cliche-density scan (defense in depth) --------
function evaluateBannedLanguage(candidate, direction) {
  const fields = [candidate.concept, candidate.corePromise, candidate.hookStrategy, direction && direction.narrationText, direction && direction.narrativeStrategy];
  let clicheHits = 0;
  let unsupportedHit = null;
  for (const field of fields) {
    if (!field) continue;
    if (scanCorporateFiller(field)) clicheHits += 1;
    const claim = scanUnsupportedClaim(field);
    if (claim && !unsupportedHit) unsupportedHit = claim;
  }
  const results = [];
  results.push(result('bannedLanguage', 'EXCESSIVE_CLICHE_DENSITY', clicheHits === 0 ? 'PASS' : 'FAIL', clicheHits === 0 ? 'no cliche/filler patterns matched' : `${clicheHits} cliche/filler pattern match(es) found`));
  results.push(result('bannedLanguage', 'UNSUPPORTED_CLAIM', unsupportedHit ? 'FAIL' : 'PASS', unsupportedHit || 'no unsupported causal/certainty claim patterns matched'));
  return results;
}

// Evaluates ONE candidate angle in isolation (Part 24 — used to select
// among the 3 generated candidates before direction synthesis). `context`
// carries topic/recommendations/voicePatterns/dominantEvidenceRatio/
// structuralSimilarityScore — everything the orchestrator already has.
function evaluateCandidate(candidate, context = {}) {
  return [
    ...evaluateSpecificity(candidate),
    ...evaluateNarrativeClarity(candidate, context.topic),
    ...evaluateOriginality(candidate, context),
    ...evaluateBannedLanguage(candidate, null),
  ];
}

// Evaluates the FULL synthesized direction (candidate + narrative/visual/
// emotional synthesis) — the complete 8-dimension pass run before a
// Blueprint is finalized.
function evaluateDirection(candidate, direction, context = {}) {
  return [
    ...evaluateSpecificity(candidate),
    ...evaluateCoherence(context.structuralDirection, context.targetDuration),
    ...evaluateEmotionalLogic(direction && direction.emotionalArc),
    ...evaluateNarrativeClarity(candidate, context.topic),
    ...evaluateOriginality(candidate, context),
    ...evaluateVisualTaste(direction && direction.visualSpecification),
    ...evaluateTreatmentFit(),
    ...evaluateBannedLanguage(candidate, direction),
  ];
}

function hasFailure(results) {
  return results.some((r) => r.result === 'FAIL');
}

module.exports = {
  MIN_SPECIFICITY_ANCHORS,
  PHRASING_OVERLAP_THRESHOLD,
  DOMINANT_EVIDENCE_RATIO_THRESHOLD,
  TOPIC_OVERLAP_THRESHOLD,
  countAnchors,
  phrasingOverlapRatio,
  evaluateCandidate,
  evaluateDirection,
  hasFailure,
};
