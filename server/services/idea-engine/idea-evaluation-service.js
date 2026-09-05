// idea-evaluation-service.js
//
// PHASE 1 EDITORIAL SPINE, Part 2 — evaluates ONE Idea candidate against 9
// INDEPENDENT dimensions, each producing its own PASS/FAIL/WARN result.
// NEVER collapsed into a single combined score — the same locked decision
// services/creative-brain/creative-evaluation-service.js's header
// documents ("PASS/FAIL/WARN is far more defensible than a fabricated
// combined score"), applied one layer up.
//
// REUSES EXISTING CHECKS RATHER THAN DUPLICATING (this codebase's Hard
// Rule): countAnchors()/phrasingOverlapRatio() are imported verbatim from
// creative-evaluation-service.js rather than reimplemented; scanGenericHook
// /scanCorporateFiller/scanUnsupportedClaim are imported verbatim from
// content-safety/creative-banned-language.js.
//
// NEVER a performance/CTR/retention claim (phase brief, Part 2) — every
// dimension here scores a TEXTUAL/STRUCTURAL property of the candidate
// (concrete anchors present, distinct from its siblings, references the
// strategy's own stated need, avoids a listed avoid-term), never predicted
// audience behavior.

const { countAnchors, phrasingOverlapRatio } = require('../creative-brain/creative-evaluation-service');
const { scanGenericHook, scanCorporateFiller, scanUnsupportedClaim } = require('../content-safety/creative-banned-language');

const MIN_ANCHORS = 1;
const DISTINCTIVENESS_OVERLAP_THRESHOLD = 0.5; // >50% shared 5-grams with a sibling candidate is not a genuinely distinct idea
const STAKES_TERMS = ['wrong', 'fails', 'failing', 'breaks', 'cost', 'risk', 'actually', 'never', 'why', 'mistake', 'trap'];
const CONTRAST_MARKERS = ['but', 'yet', 'despite', 'instead of', 'not just', 'rather than', 'even though'];

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

// --- specificity: reuses countAnchors() verbatim ------------------------
function evaluateSpecificity(candidate) {
  const anchors = countAnchors(`${candidate.topic} ${candidate.premise}`);
  return [result('specificity', 'WEAK_SPECIFICITY', anchors >= MIN_ANCHORS ? 'PASS' : 'WARN', `${anchors} concrete anchor(s) found (minimum ${MIN_ANCHORS})`)];
}

// --- curiosity: a contrast marker signals an implied gap; a generic hook
// phrase (reused scan) fails outright -------------------------------------
function evaluateCuriosity(candidate) {
  const generic = scanGenericHook(candidate.premise);
  if (generic) return [result('curiosity', 'GENERIC_PREMISE', 'FAIL', generic)];
  const lower = candidate.premise.toLowerCase();
  const hasContrast = CONTRAST_MARKERS.some((m) => lower.includes(m));
  return [result('curiosity', 'NO_CURIOSITY_SIGNAL', hasContrast ? 'PASS' : 'WARN', hasContrast ? 'premise contains a contrast/gap marker' : 'premise contains no contrast/gap marker — curiosity may be weak')];
}

// --- stakes/tension: keyword presence, same "documented, non-exhaustive
// marker list" discipline creative-evaluation-service.js's EMOTION_TERMS
// already uses ---------------------------------------------------------
function evaluateStakes(candidate) {
  const lower = `${candidate.topic} ${candidate.premise}`.toLowerCase();
  const hits = STAKES_TERMS.filter((t) => lower.includes(t));
  return [result('stakes', 'NO_STAKES_SIGNAL', hits.length > 0 ? 'PASS' : 'WARN', hits.length > 0 ? `stakes term(s) found: ${hits.join(', ')}` : 'no stakes/tension term found')];
}

// --- audienceRelevance: does the idea's own text actually reference the
// strategy's stated need/audience, rather than drifting off it? ----------
function evaluateAudienceRelevance(candidate, strategy) {
  const needWords = new Set(tokenize(strategy.audienceNeed));
  const candidateWords = new Set(tokenize(`${candidate.topic} ${candidate.premise}`));
  if (needWords.size === 0) return [result('audienceRelevance', 'NO_AUDIENCE_NEED_TO_CHECK', 'WARN', 'strategy.audienceNeed is empty — not evaluable')];
  const overlap = [...needWords].filter((w) => candidateWords.has(w)).length;
  return [result('audienceRelevance', 'DRIFTS_FROM_AUDIENCE_NEED', overlap > 0 ? 'PASS' : 'FAIL', overlap > 0 ? `${overlap} shared term(s) with strategy.audienceNeed` : 'candidate shares no terms with strategy.audienceNeed')];
}

// --- usefulness: same anchor count, scored as its own dimension since
// "concrete enough to be useful" and "specific enough to be interesting"
// are related but not identical questions ---------------------------------
function evaluateUsefulness(candidate) {
  const anchors = countAnchors(candidate.premise);
  return [result('usefulness', 'NOT_ACTIONABLE', anchors >= MIN_ANCHORS ? 'PASS' : 'WARN', anchors >= MIN_ANCHORS ? 'premise has at least one concrete anchor a viewer could act on' : 'premise has no concrete anchor')];
}

// --- strategicFit: does the candidate cross a strategy.avoid[] line? ----
function evaluateStrategicFit(candidate, strategy) {
  const lower = `${candidate.topic} ${candidate.premise}`.toLowerCase();
  const avoided = (Array.isArray(strategy.avoid) ? strategy.avoid : []).filter((term) => typeof term === 'string' && term.trim() && lower.includes(term.toLowerCase()));
  const results = [result('strategicFit', 'CROSSES_AVOID_LIST', avoided.length === 0 ? 'PASS' : 'FAIL', avoided.length === 0 ? 'candidate touches none of strategy.avoid[]' : `candidate touches avoided term(s): ${avoided.join(', ')}`)];
  const cliche = scanCorporateFiller(candidate.premise);
  results.push(result('strategicFit', 'CORPORATE_FILLER', cliche ? 'FAIL' : 'PASS', cliche || 'no corporate/filler language matched'));
  const unsupported = scanUnsupportedClaim(candidate.premise);
  results.push(result('strategicFit', 'UNSUPPORTED_CLAIM', unsupported ? 'FAIL' : 'PASS', unsupported || 'no unsupported causal/certainty claim matched'));
  return results;
}

// --- novelty/distinctiveness: pairwise phrasing overlap against every
// OTHER candidate in the same batch (reuses phrasingOverlapRatio verbatim)
function evaluateNoveltyAndDistinctiveness(candidate, allCandidates) {
  const siblings = allCandidates.filter((c) => c !== candidate).map((c) => `${c.topic} ${c.premise}`);
  const overlap = siblings.length > 0 ? phrasingOverlapRatio(`${candidate.topic} ${candidate.premise}`, siblings) : 0;
  const passed = overlap <= DISTINCTIVENESS_OVERLAP_THRESHOLD;
  return [
    result('novelty', 'TOO_SIMILAR_TO_SIBLING', passed ? 'PASS' : 'FAIL', `${Math.round(overlap * 100)}% phrasing overlap with the most similar sibling candidate (threshold ${Math.round(DISTINCTIVENESS_OVERLAP_THRESHOLD * 100)}%)`),
    result('distinctiveness', 'TOO_SIMILAR_TO_SIBLING', passed ? 'PASS' : 'FAIL', `${Math.round(overlap * 100)}% phrasing overlap with the most similar sibling candidate (threshold ${Math.round(DISTINCTIVENESS_OVERLAP_THRESHOLD * 100)}%)`),
  ];
}

// Evaluates ONE candidate against the strategy it was generated for AND
// the sibling candidates generated alongside it (needed for novelty/
// distinctiveness). `allCandidates` must include `candidate` itself.
function evaluateIdeaCandidate(candidate, strategy, allCandidates) {
  return [
    ...evaluateSpecificity(candidate),
    ...evaluateCuriosity(candidate),
    ...evaluateStakes(candidate),
    ...evaluateAudienceRelevance(candidate, strategy),
    ...evaluateUsefulness(candidate),
    ...evaluateStrategicFit(candidate, strategy),
    ...evaluateNoveltyAndDistinctiveness(candidate, allCandidates),
  ];
}

module.exports = {
  MIN_ANCHORS,
  DISTINCTIVENESS_OVERLAP_THRESHOLD,
  STAKES_TERMS,
  CONTRAST_MARKERS,
  evaluateIdeaCandidate,
};
