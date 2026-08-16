// cross-video-pattern-service.js
//
// INT-1E — the orchestrator proving the FIRST cross-video layer:
//
//   ReferenceSet (INT-1E membership) -> PatternSet
//
// ONE VIDEO IS NOT A PATTERN (this stage's own core principle): extraction
// refuses to even attempt anything with fewer than pattern-math.js's
// MIN_ABSOLUTE_SUPPORT_COUNT (3) usable members, and every individual
// Pattern this file produces carries its own real prevalence (supportingCount
// / totalCount) so a reader can never mistake "this one video does X" for
// "this reference set recurringly does X."
//
// FULLY DETERMINISTIC, NO LLM (Part 18): every statement below is built
// from a fixed template plus real numbers — never generated text from a
// model. This file never imports an interpretation provider, never calls
// `.interpret()`, and a dedicated test in this stage's suite scans every
// generated statement for banned causal language, proving Part 13's rule
// ("X occurs frequently" — never "X causes...") holds for real generated
// output, not just by convention.
//
// EVIDENCE CHAIN (Part 19): every Pattern's support[] entries point at
// real, already-persisted ReferenceVideo/Measurements/Observation ids —
// this file resolves the LATEST Measurements and ObservationSet for each
// member itself (services/reference-video-measurement-store.js's own
// getLatestMeasurementForReferenceVideo, services/reference-video-
// observation-store.js's own getLatestObservationSetForMeasurements),
// never inventing or duplicating that data.

const projectStore = require('./project-store');
const referenceVideoStore = require('./reference-video-store');
const referenceSetStore = require('./reference-set-store');
const measurementStore = require('./reference-video-measurement-store');
const observationStore = require('./reference-video-observation-store');
const patternStore = require('./cross-video-pattern-store');
const patternMath = require('./reference-video/pattern-math');
const { createPatternSet, createPattern, createPatternDiagnostic, createPatternSupport, createHomogeneityReport, createPatternReview, PATTERN_REVIEW_DECISIONS } = require('../schemas/cross-video-pattern-schema');

// Part 4 — a documented coefficient-of-variation cutoff: CoV (stdDev/mean)
// above 0.5 is a commonly cited rule-of-thumb threshold for "substantial"
// relative dispersion in a dataset — a stated convention, not a claim
// about any specific reference set's own real-world validity.
const DURATION_HETEROGENEITY_COV_THRESHOLD = 0.5;
// Part 16 — a documented relative-difference threshold for flagging that a
// numeric pattern may not generalize across subgroups: subgroup medians
// differing by more than 50% of the overall median.
const SUBGROUP_DIVERGENCE_RATIO_THRESHOLD = 0.5;

function diag(code, message) {
  return createPatternDiagnostic({ code, message });
}

// INT-1E-PATCH — Part 4: proves, rather than assumes, that a candidate
// CO_OCCURRENCE support entry's two observations are real and actually
// responsible for the co-occurrence being reported, before that entry is
// ever persisted. Never repairs or invents a replacement id — a failing
// entry is simply dropped and reported via a structured diagnostic
// (Part 4's own "do not silently repair" rule).
//
// obsA/obsB are expected to be the exact observation objects already
// resolved from this member's own real, already-persisted ObservationSet
// (services/reference-video-observation-service.js's deriveObservations()
// guarantees at most one observation per rule id per ObservationSet, and
// every observation in one ObservationSet shares that ObservationSet's own
// single measurementsId — so a truthful CO_OCCURRENCE support entry needs
// exactly one measurementsId, never a plural measurementsIds).
function validateCoOccurrenceProvenance({ obsA, obsB, referenceVideoId, ruleIdA, ruleIdB }) {
  if (!obsA || !obsB) {
    return { ok: false, diagnostic: diag('INVALID_CO_OCCURRENCE_PROVENANCE', `reference video "${referenceVideoId}" is missing one or both observations for rule ids "${ruleIdA}"/"${ruleIdB}"`) };
  }
  if (obsA.referenceVideoId !== referenceVideoId || obsB.referenceVideoId !== referenceVideoId) {
    return { ok: false, diagnostic: diag('INVALID_CO_OCCURRENCE_PROVENANCE', `an observation supporting reference video "${referenceVideoId}" does not itself belong to that video`) };
  }
  if (obsA.methodology.ruleId !== ruleIdA || obsB.methodology.ruleId !== ruleIdB) {
    return { ok: false, diagnostic: diag('INVALID_CO_OCCURRENCE_PROVENANCE', `reference video "${referenceVideoId}"'s resolved observations do not match rule ids "${ruleIdA}"/"${ruleIdB}"`) };
  }
  if (obsA.measurementsId !== obsB.measurementsId) {
    return { ok: false, diagnostic: diag('INVALID_CO_OCCURRENCE_PROVENANCE', `reference video "${referenceVideoId}"'s two co-occurring observations resolve to different Measurements records`) };
  }
  return { ok: true, measurementsId: obsA.measurementsId };
}

// Part 11 — the fixed set of comparable, normalized (where mathematically
// justified) metrics this stage aggregates, extracted from an already-
// computed INT-1B ReferenceVideoMeasurements record. Every metric here is
// EITHER inherently rate/percentage-based (never duration-dependent) OR
// explicitly documented as raw (see METRIC_DEFINITIONS' own `normalized`
// flag) — never silently treated as comparable when it isn't.
function extractComparableMetrics(measurements) {
  const durationSeconds = measurements.video && measurements.video.technical ? measurements.video.technical.duration : null;
  const metrics = {
    durationSeconds,
    shotsPerMinute: measurements.shotRhythm && measurements.shotRhythm.shotsPerMinute ? measurements.shotRhythm.shotsPerMinute.value : null,
    medianShotDurationSeconds: measurements.shotRhythm && measurements.shotRhythm.durationDistribution ? measurements.shotRhythm.durationDistribution.median : null,
    speechPercentage: measurements.transcript && measurements.transcript.speechPercentageOfVideo ? measurements.transcript.speechPercentageOfVideo.value : null,
    wordsPerMinute: measurements.transcript && measurements.transcript.wordsPerMinute ? measurements.transcript.wordsPerMinute.value : null,
    audioSilencePercentage: measurements.audio && measurements.audio.speechPercentage && typeof measurements.audio.speechPercentage.value === 'number' ? 100 - measurements.audio.speechPercentage.value : null,
    frameDifferenceMean: measurements.visual && measurements.visual.frameDifferenceDistribution ? measurements.visual.frameDifferenceDistribution.mean : null,
    firstShotBoundaryFraction: null,
    questionsPerMinute: null,
  };
  if (Array.isArray(measurements.shots) && measurements.shots.length >= 2 && typeof durationSeconds === 'number' && durationSeconds > 0) {
    metrics.firstShotBoundaryFraction = measurements.shots[1].startTime / durationSeconds;
  }
  if (measurements.transcript && Array.isArray(measurements.transcript.sentences) && typeof durationSeconds === 'number' && durationSeconds > 0) {
    const questionCount = measurements.transcript.sentences.filter((s) => /\?\s*$/.test(String(s.text || '').trim())).length;
    metrics.questionsPerMinute = questionCount / (durationSeconds / 60);
  }
  return metrics;
}

const METRIC_DEFINITIONS = {
  durationSeconds: { category: 'TIMING', unit: 'seconds', normalized: false },
  shotsPerMinute: { category: 'SHOT_RHYTHM', unit: 'shots_per_minute', normalized: true },
  medianShotDurationSeconds: { category: 'SHOT_RHYTHM', unit: 'seconds', normalized: true }, // an average length, not a total — already comparable regardless of overall video duration
  speechPercentage: { category: 'SPEECH_DENSITY', unit: 'percent', normalized: true },
  wordsPerMinute: { category: 'NARRATION', unit: 'words_per_minute', normalized: true },
  audioSilencePercentage: { category: 'SILENCE', unit: 'percent', normalized: true },
  frameDifferenceMean: { category: 'VISUAL_CHANGE', unit: 'signalstats_YDIF', normalized: true },
  firstShotBoundaryFraction: { category: 'OPENING_STRUCTURE', unit: 'fraction_of_duration', normalized: true },
  questionsPerMinute: { category: 'OPENING_STRUCTURE', unit: 'questions_per_minute', normalized: true },
};

// Part 4 — built ONLY from metadata this codebase genuinely has: platform
// and channel (schemas/reference-video-schema.js's own Source fields) and
// duration/aspect ratio (INT-1B's own ffprobe-measured technical facts).
// Never invents a "topic" or "content type" dimension.
function computeHomogeneityReport(membersData) {
  const totalCount = membersData.length;
  const platforms = membersData.map((m) => m.referenceVideo.source && m.referenceVideo.source.platform).filter(Boolean);
  const channels = membersData.map((m) => m.referenceVideo.source && m.referenceVideo.source.channelId).filter(Boolean);
  const durations = membersData.map((m) => m.measurements.video && m.measurements.video.technical && m.measurements.video.technical.duration).filter((n) => typeof n === 'number');
  const aspectRatios = membersData
    .map((m) => {
      const tech = m.measurements.video && m.measurements.video.technical;
      return tech && tech.width && tech.height ? Number((tech.width / tech.height).toFixed(3)) : null;
    })
    .filter((v) => v !== null);

  const metadataAvailable = [];
  const warnings = [];
  let platformConsistent = null;
  let channelConsistent = null;
  let aspectRatioConsistent = null;
  let durationCoefficientOfVariation = null;

  if (platforms.length === totalCount && totalCount > 0) {
    metadataAvailable.push('platform');
    platformConsistent = new Set(platforms).size === 1;
    if (!platformConsistent) warnings.push(diag('HETEROGENEOUS_REFERENCE_SET', 'reference set members span more than one platform'));
  }
  if (channels.length === totalCount && totalCount > 0) {
    metadataAvailable.push('channelId');
    channelConsistent = new Set(channels).size === 1;
  }
  if (durations.length === totalCount && totalCount >= 2) {
    metadataAvailable.push('durationSeconds');
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const variance = durations.reduce((s, v) => s + (v - mean) ** 2, 0) / durations.length;
    durationCoefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : null;
    if (durationCoefficientOfVariation !== null && durationCoefficientOfVariation > DURATION_HETEROGENEITY_COV_THRESHOLD) {
      warnings.push(diag('HETEROGENEOUS_REFERENCE_SET', `duration coefficient of variation (${durationCoefficientOfVariation.toFixed(2)}) exceeds ${DURATION_HETEROGENEITY_COV_THRESHOLD} — video lengths vary substantially; raw (non-normalized) metrics may not be safely comparable across this set`));
    }
  }
  if (aspectRatios.length === totalCount && totalCount > 0) {
    metadataAvailable.push('aspectRatio');
    aspectRatioConsistent = new Set(aspectRatios).size === 1;
  }
  if (metadataAvailable.length === 0) {
    warnings.push(diag('MISSING_METADATA', 'no homogeneity dimension could be evaluated — no consistent metadata is available across every member'));
  }

  return createHomogeneityReport({ metadataAvailable, platformConsistent, channelConsistent, durationCoefficientOfVariation, aspectRatioConsistent, warnings });
}

// Part 10 — deterministic aggregation of INT-1C rule ids across the set.
function buildRecurringObservationPatterns(projectId, referenceSetId, membersData) {
  const withObservations = membersData.filter((m) => m.observationSet);
  const totalCount = withObservations.length;
  if (totalCount === 0) return [];

  const ruleIdToSupport = new Map();
  for (const m of withObservations) {
    for (const obs of m.observationSet.observations) {
      const ruleId = obs.methodology.ruleId;
      if (!ruleIdToSupport.has(ruleId)) ruleIdToSupport.set(ruleId, []);
      ruleIdToSupport.get(ruleId).push({ referenceVideoId: m.referenceVideo.id, observationId: obs.id, measurementsId: m.measurements.id, category: obs.category });
    }
  }

  const patterns = [];
  for (const [ruleId, supportList] of ruleIdToSupport) {
    const supportingCount = supportList.length;
    const percentage = Number(((supportingCount / totalCount) * 100).toFixed(1));
    const meetsThreshold = patternMath.meetsMinimumEvidenceThreshold(supportingCount, totalCount);
    const confidenceResult = patternMath.computePatternConfidence({ supportingCount, totalCount, distribution: null });
    patterns.push(
      createPattern({
        projectId,
        referenceSetId,
        type: 'RECURRING_OBSERVATION',
        category: supportList[0].category,
        ruleId,
        statement: `"${ruleId}" was detected in ${supportingCount} of ${totalCount} reference video(s) in this set (${percentage}%).`,
        prevalence: { supportingCount, totalCount, percentage },
        support: supportList.map((s) => createPatternSupport({ referenceVideoId: s.referenceVideoId, observationId: s.observationId, measurementsId: s.measurementsId })),
        confidence: confidenceResult.confidence,
        confidenceMethodology: confidenceResult,
        meetsMinimumEvidenceThreshold: meetsThreshold,
        limitations: meetsThreshold
          ? []
          : [`Supported by only ${supportingCount} of ${totalCount} video(s) (${percentage}%) — below this stage's minimum evidence threshold (>= ${patternMath.MIN_ABSOLUTE_SUPPORT_COUNT} videos AND >= ${patternMath.MIN_SUPPORT_PERCENTAGE}%). Reported for transparency, not confirmed as recurring.`],
      })
    );
  }
  return patterns;
}

// Part 11/12/15/16 — deterministic aggregation of numeric, normalized
// metrics, with outlier detection and channel-based subgroup awareness.
function buildNumericDistributionPatterns(projectId, referenceSetId, membersData) {
  const patterns = [];
  const totalCount = membersData.length;

  for (const [metricName, def] of Object.entries(METRIC_DEFINITIONS)) {
    const items = membersData
      .map((m) => ({ referenceVideoId: m.referenceVideo.id, measurementsId: m.measurements.id, value: extractComparableMetrics(m.measurements)[metricName], groupValue: m.referenceVideo.source ? m.referenceVideo.source.channelId : null }))
      .filter((i) => typeof i.value === 'number' && Number.isFinite(i.value));
    if (items.length < 2) continue; // need at least 2 real values for a distribution to mean anything

    const distribution = patternMath.computeDistributionWithStdDev(items.map((i) => i.value));
    const supportingCount = items.length;
    const percentage = Number(((supportingCount / totalCount) * 100).toFixed(1));
    const meetsThreshold = patternMath.meetsMinimumEvidenceThreshold(supportingCount, totalCount);
    const confidenceResult = patternMath.computePatternConfidence({ supportingCount, totalCount, distribution });

    const limitations = [];
    if (!meetsThreshold) limitations.push(`Only ${supportingCount} of ${totalCount} video(s) (${percentage}%) have a measured value for this metric — below the minimum evidence threshold.`);
    if (!def.normalized) limitations.push('This metric is a raw value and may not be directly comparable across videos of substantially different duration.');

    // Part 16 — channel-based subgroup check
    const subgroups = patternMath.groupByField(items);
    if (subgroups && subgroups.length >= 2) {
      const subgroupMedians = subgroups.map((g) => ({ groupValue: g.groupValue, median: patternMath.computeDistributionWithStdDev(g.values).median }));
      const overallMedian = distribution.median;
      const divergent = overallMedian ? subgroupMedians.filter((g) => Math.abs(g.median - overallMedian) / Math.abs(overallMedian) > SUBGROUP_DIVERGENCE_RATIO_THRESHOLD) : [];
      if (divergent.length > 0) {
        limitations.push(`Subgroup medians by channel diverge from the overall median by more than ${SUBGROUP_DIVERGENCE_RATIO_THRESHOLD * 100}%: ${subgroupMedians.map((g) => `${g.groupValue}=${g.median.toFixed(3)}`).join(', ')} (overall=${overallMedian.toFixed(3)}) — this pattern may not generalize across every channel represented in this set (Part 16).`);
      }
    }

    patterns.push(
      createPattern({
        projectId,
        referenceSetId,
        type: 'NUMERIC_DISTRIBUTION',
        category: def.category,
        metric: metricName,
        statement: `Across ${supportingCount} of ${totalCount} reference video(s) with a measured value, "${metricName}" has median ${distribution.median.toFixed(3)} ${def.unit} (mean ${distribution.mean.toFixed(3)}, range ${distribution.min.toFixed(3)}-${distribution.max.toFixed(3)}).`,
        prevalence: { supportingCount, totalCount, percentage },
        distribution,
        support: items.map((i) => createPatternSupport({ referenceVideoId: i.referenceVideoId, measurementsId: i.measurementsId, value: i.value })),
        confidence: confidenceResult.confidence,
        confidenceMethodology: confidenceResult,
        meetsMinimumEvidenceThreshold: meetsThreshold,
        limitations,
      })
    );

    // Part 15 — outliers, recorded, never silently dropped
    for (const o of patternMath.detectOutliers(items)) {
      patterns.push(
        createPattern({
          projectId,
          referenceSetId,
          type: 'OUTLIER',
          category: def.category,
          metric: metricName,
          statement: `Reference video ${o.referenceVideoId} has "${metricName}" = ${o.value.toFixed(3)} ${def.unit}, a statistical outlier relative to this set's median (${o.medianValue.toFixed(3)}), per the standard Tukey 1.5*IQR fence.`,
          prevalence: { supportingCount: 1, totalCount, percentage: Number(((1 / totalCount) * 100).toFixed(1)) },
          outlier: { referenceVideoId: o.referenceVideoId, metric: metricName, value: o.value, medianValue: o.medianValue, deviation: o.deviation },
          support: [createPatternSupport({ referenceVideoId: o.referenceVideoId, value: o.value })],
          confidence: 'LOW',
          confidenceMethodology: patternMath.computePatternConfidence({ supportingCount: 1, totalCount, distribution: null }),
          meetsMinimumEvidenceThreshold: false,
          limitations: ['A single-video outlier is inherently below the minimum evidence threshold for a recurring pattern — recorded for visibility, not as a recurring behavior. An outlier may represent a distinct, independently valid strategy rather than an error.'],
        })
      );
    }
  }
  return patterns;
}

// Part 14 — joint frequency of pairs of INT-1C rule ids. Only pairs that
// co-occur at least twice are recorded, to avoid a flood of one-off,
// uninformative combinations.
//
// INT-1E-PATCH (Parts 2-4) — each contributing video's support entry now
// carries the exact two observation ids (and their shared measurementsId)
// responsible for that video's contribution, instead of only a bare
// referenceVideoId. The lookup uses the SAME `withObservations` data this
// function already had in memory — no new store call, no redesign of the
// underlying co-occurrence math (patternMath.computeCoOccurrence itself is
// unchanged and still drives prevalence/count). Returns
// { patterns, diagnostics } — diagnostics is non-empty only if a
// provenance check ever fails (see validateCoOccurrenceProvenance);
// callers must merge it into the PatternSet's own diagnostics rather than
// silently dropping it.
function buildCoOccurrencePatterns(projectId, referenceSetId, membersData) {
  const withObservations = membersData.filter((m) => m.observationSet);
  const totalCount = withObservations.length;
  if (totalCount === 0) return { patterns: [], diagnostics: [] };

  const memberRuleIdSets = withObservations.map((m) => new Set(m.observationSet.observations.map((o) => o.methodology.ruleId)));
  const memberObservationByRuleId = withObservations.map((m) => {
    const byRuleId = new Map();
    for (const o of m.observationSet.observations) byRuleId.set(o.methodology.ruleId, o);
    return byRuleId;
  });
  const categoryByRuleId = new Map();
  for (const m of withObservations) for (const o of m.observationSet.observations) categoryByRuleId.set(o.methodology.ruleId, o.category);
  const allRuleIds = [...categoryByRuleId.keys()].sort();

  const patterns = [];
  const diagnostics = [];
  for (let i = 0; i < allRuleIds.length; i += 1) {
    for (let j = i + 1; j < allRuleIds.length; j += 1) {
      const ruleIdA = allRuleIds[i];
      const ruleIdB = allRuleIds[j];
      const result = patternMath.computeCoOccurrence(memberRuleIdSets, ruleIdA, ruleIdB);
      if (result.count < 2) continue;
      const meetsThreshold = patternMath.meetsMinimumEvidenceThreshold(result.count, totalCount);
      const confidenceResult = patternMath.computePatternConfidence({ supportingCount: result.count, totalCount, distribution: null });

      const support = [];
      withObservations.forEach((m, idx) => {
        if (!memberRuleIdSets[idx].has(ruleIdA) || !memberRuleIdSets[idx].has(ruleIdB)) return;
        const obsA = memberObservationByRuleId[idx].get(ruleIdA);
        const obsB = memberObservationByRuleId[idx].get(ruleIdB);
        const validation = validateCoOccurrenceProvenance({ obsA, obsB, referenceVideoId: m.referenceVideo.id, ruleIdA, ruleIdB });
        if (!validation.ok) {
          diagnostics.push(validation.diagnostic);
          return; // Part 4 — never invent a replacement id; this video's contribution is simply omitted from support
        }
        support.push(createPatternSupport({ referenceVideoId: m.referenceVideo.id, measurementsId: validation.measurementsId, observationIds: [obsA.id, obsB.id] }));
      });

      patterns.push(
        createPattern({
          projectId,
          referenceSetId,
          type: 'CO_OCCURRENCE',
          category: 'CO_OCCURRENCE',
          statement: `"${ruleIdA}" and "${ruleIdB}" co-occur in ${result.count} of ${totalCount} reference video(s) (${result.percentage}%). This is a joint-frequency count, not evidence that either influences or causes the other.`,
          prevalence: { supportingCount: result.count, totalCount, percentage: result.percentage },
          coOccurrence: { ruleIdA, ruleIdB, categoryA: categoryByRuleId.get(ruleIdA), categoryB: categoryByRuleId.get(ruleIdB) },
          support,
          confidence: confidenceResult.confidence,
          confidenceMethodology: confidenceResult,
          meetsMinimumEvidenceThreshold: meetsThreshold,
          limitations: [...(meetsThreshold ? [] : ['Below the minimum evidence threshold for a recurring co-occurrence.']), 'Co-occurrence describes joint frequency only; it is not evidence of a causal or influential relationship (Part 13).'],
        })
      );
    }
  }
  return { patterns, diagnostics };
}

// Public entry point.
function extractPatterns(projectId, referenceSetId) {
  if (!projectStore.getProject(projectId)) {
    return createPatternSet({ projectId, referenceSetId, status: 'FAILED', diagnostics: [diag('INSUFFICIENT_REFERENCE_SET', `no project found with id "${projectId}"`)] });
  }
  const referenceSet = referenceSetStore.getReferenceSet(projectId, referenceSetId);
  if (!referenceSet) {
    return createPatternSet({ projectId, referenceSetId, status: 'FAILED', diagnostics: [diag('INSUFFICIENT_REFERENCE_SET', `no ReferenceSet found with id "${referenceSetId}"`)] });
  }

  // Part 17 — REJECTED members are never aggregated; PENDING/APPROVED both are (curation is opt-out, not opt-in, so a freshly-added member contributes until a human explicitly rejects it).
  const activeMembers = referenceSet.members.filter((m) => m.curationStatus !== 'REJECTED');
  if (activeMembers.length < patternMath.MIN_ABSOLUTE_SUPPORT_COUNT) {
    return createPatternSet({
      projectId,
      referenceSetId,
      status: 'FAILED',
      diagnostics: [diag('INSUFFICIENT_REFERENCE_SET', `only ${activeMembers.length} non-rejected member(s) — ONE VIDEO IS NOT A PATTERN; at least ${patternMath.MIN_ABSOLUTE_SUPPORT_COUNT} are required to attempt cross-video pattern extraction`)],
    });
  }

  const diagnostics = [];
  const membersData = [];
  for (const member of activeMembers) {
    const referenceVideo = referenceVideoStore.getReferenceVideo(projectId, member.referenceVideoId);
    if (!referenceVideo) {
      diagnostics.push(diag('INCOMPLETE_MEASUREMENTS', `member "${member.referenceVideoId}" has no ReferenceVideo record`));
      continue;
    }
    const measurements = measurementStore.getLatestMeasurementForReferenceVideo(projectId, referenceVideo.id);
    if (!measurements || measurements.status === 'FAILED') {
      diagnostics.push(diag('INCOMPLETE_MEASUREMENTS', `member "${referenceVideo.id}" has no usable Measurements`));
      continue;
    }
    const observationSet = observationStore.getLatestObservationSetForMeasurements(projectId, measurements.id);
    if (!observationSet || observationSet.status === 'FAILED') {
      diagnostics.push(diag('INCOMPLETE_OBSERVATIONS', `member "${referenceVideo.id}" has no usable ObservationSet`));
    }
    membersData.push({ referenceVideo, measurements, observationSet: observationSet && observationSet.status !== 'FAILED' ? observationSet : null });
  }

  if (membersData.length < patternMath.MIN_ABSOLUTE_SUPPORT_COUNT) {
    return createPatternSet({
      projectId,
      referenceSetId,
      status: 'FAILED',
      diagnostics: [...diagnostics, diag('INSUFFICIENT_REFERENCE_SET', `only ${membersData.length} member(s) have usable Measurements — at least ${patternMath.MIN_ABSOLUTE_SUPPORT_COUNT} are required`)],
    });
  }

  const homogeneityReport = computeHomogeneityReport(membersData);
  diagnostics.push(...homogeneityReport.warnings);

  const coOccurrenceResult = buildCoOccurrencePatterns(projectId, referenceSetId, membersData);
  diagnostics.push(...coOccurrenceResult.diagnostics);
  const patterns = [...buildRecurringObservationPatterns(projectId, referenceSetId, membersData), ...buildNumericDistributionPatterns(projectId, referenceSetId, membersData), ...coOccurrenceResult.patterns];

  const status = patterns.length === 0 ? 'FAILED' : diagnostics.length === 0 ? 'COMPLETE' : 'PARTIAL';
  const patternSet = createPatternSet({ projectId, referenceSetId, patterns, homogeneityReport, status, diagnostics });
  const saved = patternStore.addPatternSet(projectId, patternSet);
  return saved.ok ? saved.patternSet : patternSet;
}

// Part 17 — human curation of a pattern candidate. Mirrors services/
// reference-video-interpretation-service.js's reviewInterpretation()
// ACCEPT/REJECT handling exactly — only ever touches status/reviews[],
// never the machine-derived statement/prevalence/distribution/support.
function reviewPattern(projectId, patternSetId, patternId, { decision, reviewedBy, note } = {}) {
  if (!PATTERN_REVIEW_DECISIONS.includes(decision)) return { ok: false, reason: `"${decision}" is not a recognized review decision` };
  const statusByDecision = { ACCEPT: 'ACCEPTED', REJECT: 'REJECTED', FLAG: 'FLAGGED', REQUEST_REVIEW: 'NEEDS_REVIEW' };
  const updated = patternStore.updatePatternReviewState(projectId, patternSetId, patternId, {
    status: statusByDecision[decision],
    review: createPatternReview({ decision, reviewedBy, note }),
  });
  if (!updated) return { ok: false, reason: 'pattern not found' };
  return { ok: true, pattern: updated };
}

module.exports = {
  extractPatterns,
  reviewPattern,
  extractComparableMetrics,
  computeHomogeneityReport,
  METRIC_DEFINITIONS,
  DURATION_HETEROGENEITY_COV_THRESHOLD,
  SUBGROUP_DIVERGENCE_RATIO_THRESHOLD,
  validateCoOccurrenceProvenance, // INT-1E-PATCH — exported for direct, isolated provenance-validation tests (Part 7)
};
