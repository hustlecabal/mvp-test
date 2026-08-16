// Tests for services/reference-video/pattern-math.js — pure functions,
// no I/O. Every test asserts an EXACT expected number against a
// hand-computed value.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../services/reference-video/pattern-math');

test('1. computeDistributionWithStdDev adds a real population standard deviation to INT-1B\'s own distribution shape', () => {
  const d = m.computeDistributionWithStdDev([2, 4, 4, 4, 5, 5, 7, 9]);
  // mean = 5, population variance = 4, stdDev = 2
  assert.equal(d.mean, 5);
  assert.equal(d.stdDev, 2);
  assert.equal(d.count, 8);
});

test('2. computeDistributionWithStdDev returns stdDev: null for an empty input', () => {
  assert.deepEqual(m.computeDistributionWithStdDev([]), { count: 0, mean: null, median: null, min: null, max: null, p25: null, p75: null, p90: null, stdDev: null });
});

test('3. meetsMinimumEvidenceThreshold requires BOTH the absolute count and the percentage', () => {
  assert.equal(m.meetsMinimumEvidenceThreshold(3, 5), true); // 3>=3, 60%>=60%
  assert.equal(m.meetsMinimumEvidenceThreshold(2, 2), false); // 100% but count 2<3
  assert.equal(m.meetsMinimumEvidenceThreshold(3, 10), false); // count ok, 30%<60%
  assert.equal(m.meetsMinimumEvidenceThreshold(0, 0), false);
});

test('4. computePatternConfidence never returns HIGH regardless of how strong the inputs are', () => {
  const perfect = m.computePatternConfidence({ supportingCount: 100, totalCount: 100, distribution: { count: 100, mean: 5, p25: 4.9, p75: 5.1 } });
  assert.equal(perfect.confidence, 'MEDIUM');
  assert.notEqual(perfect.confidence, 'HIGH');
});

test('5. computePatternConfidence combinedScore matches the documented formula exactly for a known input', () => {
  // supportingCount=5, totalCount=10 -> prevalenceScore=0.5; sampleSizeScore=min(1,10/10)=1; no distribution -> consistencyScore=1 (not applicable)
  const result = m.computePatternConfidence({ supportingCount: 5, totalCount: 10, distribution: null });
  assert.equal(result.prevalenceScore, 0.5);
  assert.equal(result.sampleSizeScore, 1);
  assert.equal(result.consistencyScore, 1);
  assert.equal(result.consistencyApplicable, false);
  assert.ok(Math.abs(result.combinedScore - (0.5 + 1 + 1) / 3) < 1e-9);
  assert.equal(result.confidence, result.combinedScore >= 0.7 ? 'MEDIUM' : 'LOW');
});

test('6. computePatternConfidence sampleSizeScore is capped at 1 and scales linearly below the documented threshold of 10', () => {
  const small = m.computePatternConfidence({ supportingCount: 3, totalCount: 3, distribution: null });
  assert.equal(small.sampleSizeScore, 0.3);
  const large = m.computePatternConfidence({ supportingCount: 50, totalCount: 50, distribution: null });
  assert.equal(large.sampleSizeScore, 1);
});

test('7. computePatternConfidence consistencyScore reflects a real IQR/mean computation when a distribution is supplied', () => {
  // mean=10, p25=9, p75=11 -> IQR=2 -> consistencyScore = 1 - min(1, 2/10) = 0.8
  const result = m.computePatternConfidence({ supportingCount: 10, totalCount: 10, distribution: { count: 10, mean: 10, p25: 9, p75: 11 } });
  assert.equal(result.consistencyApplicable, true);
  assert.ok(Math.abs(result.consistencyScore - 0.8) < 1e-9);
});

test('8. detectOutliers finds real Tukey-fence outliers and returns [] below the 4-point minimum', () => {
  const items = [{ referenceVideoId: 'a', value: 2 }, { referenceVideoId: 'b', value: 2.1 }, { referenceVideoId: 'c', value: 1.9 }, { referenceVideoId: 'd', value: 2.0 }, { referenceVideoId: 'e', value: 50 }];
  const outliers = m.detectOutliers(items);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].referenceVideoId, 'e');
  assert.equal(outliers[0].value, 50);
  assert.equal(m.detectOutliers([{ referenceVideoId: 'a', value: 1 }, { referenceVideoId: 'b', value: 2 }, { referenceVideoId: 'c', value: 100 }]).length, 0); // only 3 points, below minimum
});

test('9. detectOutliers never flags a tightly-clustered, non-outlying set', () => {
  const items = [{ referenceVideoId: 'a', value: 5 }, { referenceVideoId: 'b', value: 5.1 }, { referenceVideoId: 'c', value: 4.9 }, { referenceVideoId: 'd', value: 5.05 }, { referenceVideoId: 'e', value: 4.95 }];
  assert.deepEqual(m.detectOutliers(items), []);
});

test('10. computeCoOccurrence counts exact joint occurrences out of the real total', () => {
  const sets = [new Set(['A', 'B']), new Set(['A']), new Set(['A', 'B']), new Set(['B']), new Set([])];
  const result = m.computeCoOccurrence(sets, 'A', 'B');
  assert.deepEqual(result, { count: 2, totalCount: 5, percentage: 40 });
});

test('11. computeCoOccurrence returns count 0 when the two never co-occur', () => {
  const sets = [new Set(['A']), new Set(['B']), new Set(['A'])];
  assert.equal(m.computeCoOccurrence(sets, 'A', 'B').count, 0);
});

test('12. groupByField returns null (not testable) when fewer than 2 groups have the minimum size', () => {
  assert.equal(m.groupByField([{ groupValue: 'ch1', value: 1 }, { groupValue: 'ch1', value: 2 }, { groupValue: 'ch2', value: 3 }]), null); // ch2 only has 1 member
  assert.equal(m.groupByField([]), null);
});

test('13. groupByField returns real per-group value lists when at least 2 groups qualify', () => {
  const groups = m.groupByField([{ groupValue: 'ch1', value: 1 }, { groupValue: 'ch1', value: 2 }, { groupValue: 'ch2', value: 10 }, { groupValue: 'ch2', value: 20 }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((g) => g.groupValue === 'ch1').values, [1, 2]);
  assert.deepEqual(groups.find((g) => g.groupValue === 'ch2').values, [10, 20]);
});

test('14. MIN_ABSOLUTE_SUPPORT_COUNT and MIN_SUPPORT_PERCENTAGE are the documented, stated values', () => {
  assert.equal(m.MIN_ABSOLUTE_SUPPORT_COUNT, 3);
  assert.equal(m.MIN_SUPPORT_PERCENTAGE, 60);
});
