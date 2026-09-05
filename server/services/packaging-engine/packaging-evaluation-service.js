// packaging-evaluation-service.js
//
// PHASE 1 EDITORIAL SPINE, Part 3 — evaluates ONE Package candidate against
// 9 INDEPENDENT dimensions (the exact list the phase brief names: clarity,
// curiosity, specificity, novelty, emotionalTension, audienceRelevance,
// promiseStrength, titleThumbnailComplementarity, alignmentWithIdea), each
// PASS/FAIL/WARN, never a combined score — same locked convention as
// idea-engine/idea-evaluation-service.js and creative-brain/creative-
// evaluation-service.js.
//
// REUSES EXISTING CHECKS RATHER THAN DUPLICATING: countAnchors()/
// phrasingOverlapRatio() (creative-evaluation-service.js), scanGenericHook/
// scanCorporateFiller (content-safety/creative-banned-language.js), and
// STAKES_TERMS/CONTRAST_MARKERS (idea-engine/idea-evaluation-service.js) are
// all imported verbatim rather than reimplemented.
//
// This is EDITORIAL PACKAGE QUALITY scoring only (phase brief, Part 3) —
// never a CTR/performance prediction.

const { countAnchors, phrasingOverlapRatio } = require('../creative-brain/creative-evaluation-service');
const { scanGenericHook, scanCorporateFiller } = require('../content-safety/creative-banned-language');
const { STAKES_TERMS, CONTRAST_MARKERS } = require('../idea-engine/idea-evaluation-service');

const MIN_ANCHORS = 1;
const NOVELTY_OVERLAP_THRESHOLD = 0.5;
const TITLE_THUMBNAIL_OVERLAP_CEILING = 0.7; // a thumbnail concept that mostly restates the title in words adds nothing complementary

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

function tokenOverlapRatio(a, b) {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  if (wordsA.size === 0) return 0;
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  return shared / wordsA.size;
}

function evaluateClarity(pkg) {
  if (!pkg.title || !pkg.promise) return [result('clarity', 'MISSING_TITLE_OR_PROMISE', 'FAIL', 'a package requires both a title and a promise')];
  const filler = scanCorporateFiller(pkg.promise);
  return [result('clarity', 'CORPORATE_FILLER_PROMISE', filler ? 'FAIL' : 'PASS', filler || 'promise is free of corporate/filler language')];
}

function evaluateCuriosity(pkg) {
  const generic = scanGenericHook(pkg.title);
  if (generic) return [result('curiosity', 'GENERIC_TITLE', 'FAIL', generic)];
  const lower = `${pkg.title} ${pkg.curiosityMechanism}`.toLowerCase();
  const hasSignal = lower.includes('?') || CONTRAST_MARKERS.some((m) => lower.includes(m)) || Boolean(pkg.curiosityMechanism && pkg.curiosityMechanism.trim());
  return [result('curiosity', 'NO_CURIOSITY_MECHANISM', hasSignal ? 'PASS' : 'WARN', hasSignal ? 'a curiosity mechanism is stated' : 'no question/contrast marker and no stated curiosityMechanism')];
}

function evaluateSpecificity(pkg) {
  const anchors = countAnchors(`${pkg.title} ${pkg.specificity}`);
  return [result('specificity', 'WEAK_SPECIFICITY', anchors >= MIN_ANCHORS ? 'PASS' : 'WARN', `${anchors} concrete anchor(s) found (minimum ${MIN_ANCHORS})`)];
}

function evaluateNovelty(pkg, allPackages) {
  const siblings = allPackages.filter((p) => p !== pkg).map((p) => `${p.title} ${p.promise}`);
  const overlap = siblings.length > 0 ? phrasingOverlapRatio(`${pkg.title} ${pkg.promise}`, siblings) : 0;
  const passed = overlap <= NOVELTY_OVERLAP_THRESHOLD;
  return [result('novelty', 'TOO_SIMILAR_TO_SIBLING', passed ? 'PASS' : 'FAIL', `${Math.round(overlap * 100)}% phrasing overlap with the most similar sibling package (threshold ${Math.round(NOVELTY_OVERLAP_THRESHOLD * 100)}%)`)];
}

function evaluateEmotionalTension(pkg) {
  const lower = `${pkg.stakes} ${pkg.curiosityMechanism}`.toLowerCase();
  const hits = STAKES_TERMS.filter((t) => lower.includes(t));
  const hasStakesText = Boolean(pkg.stakes && pkg.stakes.trim());
  const passed = hits.length > 0 || hasStakesText;
  return [result('emotionalTension', 'NO_STAKES_SIGNAL', passed ? 'PASS' : 'WARN', passed ? 'stakes are named' : 'no stakes/tension term found and package.stakes is empty')];
}

function evaluateAudienceRelevance(pkg, strategy) {
  if (!strategy || !strategy.audienceNeed) return [result('audienceRelevance', 'NO_AUDIENCE_NEED_TO_CHECK', 'WARN', 'strategy.audienceNeed is empty — not evaluable')];
  const overlap = tokenOverlapRatio(strategy.audienceNeed, `${pkg.title} ${pkg.promise}`);
  return [result('audienceRelevance', 'DRIFTS_FROM_AUDIENCE_NEED', overlap > 0 ? 'PASS' : 'FAIL', overlap > 0 ? 'package shares terms with strategy.audienceNeed' : 'package shares no terms with strategy.audienceNeed')];
}

function evaluatePromiseStrength(pkg) {
  const anchors = countAnchors(pkg.promise);
  return [result('promiseStrength', 'WEAK_PROMISE', anchors >= MIN_ANCHORS ? 'PASS' : 'WARN', `${anchors} concrete anchor(s) found in promise (minimum ${MIN_ANCHORS})`)];
}

function evaluateTitleThumbnailComplementarity(pkg) {
  if (!pkg.thumbnailConcept || !pkg.thumbnailConcept.trim()) return [result('titleThumbnailComplementarity', 'MISSING_THUMBNAIL_CONCEPT', 'FAIL', 'thumbnailConcept is empty')];
  const overlap = tokenOverlapRatio(pkg.title, pkg.thumbnailConcept);
  const passed = overlap <= TITLE_THUMBNAIL_OVERLAP_CEILING;
  return [result('titleThumbnailComplementarity', 'THUMBNAIL_RESTATES_TITLE', passed ? 'PASS' : 'WARN', `${Math.round(overlap * 100)}% of the title's words reappear in the thumbnail concept (ceiling ${Math.round(TITLE_THUMBNAIL_OVERLAP_CEILING * 100)}%) — a thumbnail that just repeats the title in words adds no complementary information`)];
}

function evaluateAlignmentWithIdea(pkg, idea) {
  if (!idea) return [result('alignmentWithIdea', 'NO_IDEA_TO_CHECK', 'WARN', 'no source Idea supplied — not evaluable')];
  const overlap = tokenOverlapRatio(idea.premise, pkg.promise);
  return [result('alignmentWithIdea', 'DRIFTS_FROM_IDEA', overlap > 0 ? 'PASS' : 'FAIL', overlap > 0 ? 'package promise shares terms with the source idea\'s premise' : 'package promise shares no terms with the source idea\'s premise')];
}

// Evaluates ONE candidate against the strategy/idea it was generated for
// AND the sibling candidates generated alongside it (needed for novelty).
// `allPackages` must include `pkg` itself.
function evaluatePackageCandidate(pkg, { idea, strategy, allPackages } = {}) {
  return [
    ...evaluateClarity(pkg),
    ...evaluateCuriosity(pkg),
    ...evaluateSpecificity(pkg),
    ...evaluateNovelty(pkg, allPackages || [pkg]),
    ...evaluateEmotionalTension(pkg),
    ...evaluateAudienceRelevance(pkg, strategy),
    ...evaluatePromiseStrength(pkg),
    ...evaluateTitleThumbnailComplementarity(pkg),
    ...evaluateAlignmentWithIdea(pkg, idea),
  ];
}

module.exports = {
  MIN_ANCHORS,
  NOVELTY_OVERLAP_THRESHOLD,
  TITLE_THUMBNAIL_OVERLAP_CEILING,
  evaluatePackageCandidate,
};
