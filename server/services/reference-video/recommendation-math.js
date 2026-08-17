// recommendation-math.js
//
// INT-1F — PURE arithmetic for pattern-to-recommendation confidence
// combination. No I/O, no store access, no LLM — mirrors services/
// reference-video/pattern-math.js's own "math lives separately from
// orchestration" convention exactly.
//
// Part 6 — "Recommendation confidence must never exceed the strongest
// justified confidence of its underlying evidence... Use a documented
// conservative combination rule. Do not invent an arbitrary AI score."
//
// The rule here is the simplest defensible one: a recommendation is only
// as strong as its WEAKEST supporting pattern. MEDIUM only if EVERY
// source confidence is MEDIUM; LOW if any source is LOW (or unrecognized/
// missing). Never an average, never upgraded, never HIGH (matching
// PATTERN_CONFIDENCE_LEVELS/INTERPRETATION_CONFIDENCE_LEVELS, which don't
// have a HIGH value to average toward in the first place).

const CONFIDENCE_RANK = { LOW: 0, MEDIUM: 1 };

function combineConfidence(confidenceLevels) {
  const levels = Array.isArray(confidenceLevels) ? confidenceLevels : [];
  if (levels.length === 0) {
    return { combinedConfidence: 'LOW', rule: 'conservative-minimum', formula: 'no source confidence provided — defaults to LOW', sourceConfidences: [] };
  }
  const allMedium = levels.every((c) => c === 'MEDIUM');
  const combinedConfidence = allMedium ? 'MEDIUM' : 'LOW';
  return {
    combinedConfidence,
    rule: 'conservative-minimum',
    formula: 'combinedConfidence = MEDIUM only if every source pattern confidence is MEDIUM, else LOW — never an average, never upgraded, never HIGH',
    sourceConfidences: [...levels],
  };
}

module.exports = { CONFIDENCE_RANK, combineConfidence };
