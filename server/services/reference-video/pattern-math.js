// pattern-math.js
//
// INT-1E — PURE arithmetic for cross-video pattern extraction. No I/O, no
// FFmpeg, no LLM, no store access — every function here is a pure
// data-in/data-out transform, testable with fixed synthetic reference
// sets (Part 22/27), mirroring services/reference-video/measurement-
// math.js's own "math lives separately from orchestration" convention
// exactly (and reuses that file's computeDistribution directly rather
// than re-deriving mean/median/percentiles a second time).

const { computeDistribution } = require('./measurement-math');

// Part 6 — extends INT-1B's own distribution shape with a standard
// deviation, useful across a reference set in a way it wasn't
// individually justified for a single video's own shot-duration list.
// Population standard deviation (divides by N, not N-1) — this is a
// distribution OF the reference set's own members, the full population
// being studied, not a sample estimating a larger population.
function computeDistributionWithStdDev(numbers) {
  const dist = computeDistribution(numbers);
  if (dist.count === 0) return { ...dist, stdDev: null };
  const values = (Array.isArray(numbers) ? numbers : []).filter((n) => typeof n === 'number' && Number.isFinite(n));
  const variance = values.reduce((sum, v) => sum + (v - dist.mean) ** 2, 0) / values.length;
  return { ...dist, stdDev: Math.sqrt(variance) };
}

// ---------------------------------------------------------------------------
// Part 8 — MINIMUM EVIDENCE THRESHOLD, documented and justified (never an
// arbitrary number chosen silently):
//   MIN_ABSOLUTE_SUPPORT_COUNT = 3 — the smallest count for which "most of
//     the set" is even a meaningful phrase (2 videos can only ever be
//     "both" or "one", never a distribution); matches this codebase's own
//     established precedent (schemas/reference-video-measurement-schema.js's
//     SHOT_DURATION_BELOW_THRESHOLD rule already requires >=3 shots before
//     reporting a percentage, for the identical reason).
//   MIN_SUPPORT_PERCENTAGE = 60 — a clear-majority cutoff: strictly above
//     50% (a bare majority is not "recurring"), but well short of
//     requiring near-unanimity, which would make the threshold useless for
//     any real, naturally-varied reference set. Both conditions must hold.
// ---------------------------------------------------------------------------
const MIN_ABSOLUTE_SUPPORT_COUNT = 3;
const MIN_SUPPORT_PERCENTAGE = 60;

function meetsMinimumEvidenceThreshold(supportingCount, totalCount) {
  if (!Number.isFinite(totalCount) || totalCount <= 0) return false;
  const percentage = (supportingCount / totalCount) * 100;
  return supportingCount >= MIN_ABSOLUTE_SUPPORT_COUNT && percentage >= MIN_SUPPORT_PERCENTAGE;
}

// ---------------------------------------------------------------------------
// Part 9 — PATTERN STRENGTH, a documented formula over three measurable
// factors, never an opaque AI judgment:
//   prevalenceScore  = supportingCount / totalCount                (0..1)
//   sampleSizeScore  = min(1, totalCount / 10)                     (0..1)
//     — a documented convention: this stage treats a reference set of 10+
//       videos as large enough to no longer be the limiting factor on
//       confidence; below 10, confidence is scaled down proportionally.
//       Chosen for the same reason INT-1C's own thresholds are chosen —
//       a stated, defensible convention, not derived from a formal power
//       calculation this codebase has no data to perform.
//   consistencyScore = 1 - min(1, IQR / |mean|), for NUMERIC_DISTRIBUTION
//       patterns only (a tighter spread relative to the mean means a more
//       consistent pattern); defaults to 1 ("not applicable — treated as
//       fully consistent") for RECURRING_OBSERVATION/CO_OCCURRENCE
//       patterns, which have no numeric spread to measure.
//   combinedScore = average of the three
//   confidence = 'MEDIUM' if combinedScore >= 0.7, else 'LOW' — NEVER
//     'HIGH' (schemas/cross-video-pattern-schema.js's own
//     PATTERN_CONFIDENCE_LEVELS is MEDIUM/LOW only, by construction,
//     extending INT-1D's identical "interpretation is inherently more
//     uncertain, never auto-upgraded to HIGH" discipline to cross-video
//     patterns, which are strictly less certain than any single
//     interpretation they could be built from).
// ---------------------------------------------------------------------------
const SAMPLE_SIZE_FULL_CONFIDENCE_COUNT = 10;
const CONFIDENCE_THRESHOLD = 0.7;

function computePatternConfidence({ supportingCount, totalCount, distribution }) {
  const prevalenceScore = totalCount > 0 ? supportingCount / totalCount : 0;
  const sampleSizeScore = Math.min(1, totalCount / SAMPLE_SIZE_FULL_CONFIDENCE_COUNT);
  let consistencyScore = 1;
  let consistencyApplicable = false;
  if (distribution && distribution.count > 1 && typeof distribution.mean === 'number' && distribution.mean !== 0) {
    const iqr = distribution.p75 - distribution.p25;
    consistencyScore = Math.max(0, 1 - Math.min(1, iqr / Math.abs(distribution.mean)));
    consistencyApplicable = true;
  }
  const combinedScore = (prevalenceScore + sampleSizeScore + consistencyScore) / 3;
  return {
    prevalenceScore,
    sampleSizeScore,
    consistencyScore,
    consistencyApplicable,
    combinedScore,
    confidence: combinedScore >= CONFIDENCE_THRESHOLD ? 'MEDIUM' : 'LOW',
    formula: `combinedScore = (prevalenceScore + sampleSizeScore + consistencyScore) / 3; prevalenceScore = supportingCount/totalCount; sampleSizeScore = min(1, totalCount/${SAMPLE_SIZE_FULL_CONFIDENCE_COUNT}); consistencyScore = 1 - min(1, IQR/|mean|) when a numeric distribution applies, else 1 (not applicable); confidence = 'MEDIUM' if combinedScore >= ${CONFIDENCE_THRESHOLD} else 'LOW' — never 'HIGH'`,
  };
}

// ---------------------------------------------------------------------------
// Part 15 — OUTLIER detection via Tukey's IQR fence (a standard,
// well-established convention: any value below Q1 - 1.5*IQR or above
// Q3 + 1.5*IQR), never silently dropped from the distribution itself —
// this function only IDENTIFIES outliers for separate reporting; callers
// still compute the distribution over every value, outliers included.
// Requires at least 4 data points for quartiles to be meaningful.
// ---------------------------------------------------------------------------
function detectOutliers(items) {
  const numeric = items.filter((i) => typeof i.value === 'number' && Number.isFinite(i.value));
  if (numeric.length < 4) return [];
  const dist = computeDistribution(numeric.map((i) => i.value));
  const iqr = dist.p75 - dist.p25;
  const lowerFence = dist.p25 - 1.5 * iqr;
  const upperFence = dist.p75 + 1.5 * iqr;
  return numeric
    .filter((i) => i.value < lowerFence || i.value > upperFence)
    .map((i) => ({ referenceVideoId: i.referenceVideoId, value: i.value, medianValue: dist.median, deviation: Number((i.value - dist.median).toFixed(6)) }));
}

// ---------------------------------------------------------------------------
// Part 14 — CO-OCCURRENCE: how often two specific INT-1C rule ids fire
// together, out of the videos that have observation data at all. Never a
// causal claim (Part 13) — purely a joint-frequency count.
// ---------------------------------------------------------------------------
function computeCoOccurrence(memberRuleIdSets, ruleIdA, ruleIdB) {
  let both = 0;
  const totalCount = memberRuleIdSets.length;
  for (const ruleIds of memberRuleIdSets) {
    if (ruleIds.has(ruleIdA) && ruleIds.has(ruleIdB)) both += 1;
  }
  return { count: both, totalCount, percentage: totalCount > 0 ? Number(((both / totalCount) * 100).toFixed(2)) : 0 };
}

// Part 16 — groups members by a metadata field (e.g. channelId) and
// reports whether there is enough diversity to meaningfully test
// heterogeneity at all (Part 16: "do not collapse meaningful subgroups
// into one average" — but also never fabricate subgroup structure that
// isn't really there). Returns null when fewer than 2 groups have at
// least `minGroupSize` members each — an honest "not testable" signal.
function groupByField(items, minGroupSize = 2) {
  const groups = new Map();
  for (const item of items) {
    if (item.groupValue == null) continue;
    if (!groups.has(item.groupValue)) groups.set(item.groupValue, []);
    groups.get(item.groupValue).push(item);
  }
  const eligible = [...groups.entries()].filter(([, members]) => members.length >= minGroupSize);
  if (eligible.length < 2) return null;
  return eligible.map(([groupValue, members]) => ({ groupValue, count: members.length, values: members.map((m) => m.value) }));
}

module.exports = {
  MIN_ABSOLUTE_SUPPORT_COUNT,
  MIN_SUPPORT_PERCENTAGE,
  SAMPLE_SIZE_FULL_CONFIDENCE_COUNT,
  CONFIDENCE_THRESHOLD,
  computeDistributionWithStdDev,
  meetsMinimumEvidenceThreshold,
  computePatternConfidence,
  detectOutliers,
  computeCoOccurrence,
  groupByField,
};
