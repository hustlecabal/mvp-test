// observation-rules.js
//
// INT-1C, Part 15 — THE rule registry. Every rule is a pure function:
// (measurements: a real schemas/reference-video-measurement-schema.js
// ReferenceVideoMeasurements record) -> null | { statement, evidence,
// confidence, limitations }. Returning null means "not applicable — the
// required evidence is missing, invalid, or insufficient" (Part 20: never
// invent an observation when evidence is missing). No rule here calls an
// LLM, a vision model, or performs semantic interpretation of any kind
// (Part 17) — every rule is arithmetic/string comparison over already-
// computed INT-1B measurements.
//
// Each rule declares its own `requiredMeasurementPaths` (documentation +
// used directly by this stage's tests to assert "removing this exact
// field makes the rule return null" — Part 21's required negative test).
//
// THRESHOLDS ARE NEVER ARBITRARY WITHOUT A STATED REASON (Part 4). Every
// fixed threshold below has a one-line justification next to its constant.
// Where a universal threshold would be misleading, the rule instead
// reports a RELATIVE/DISTRIBUTIONAL comparison (Part 4/12) — first quarter
// vs last quarter, mean vs median, IQR vs mean — and states the numbers
// themselves rather than only a verdict.
//
// CONFIDENCE METHODOLOGY (Part 13): every rule either (a) copies the
// confidence of the single underlying Measurement it reads verbatim — the
// observation is exactly as reliable as its one source — or (b) when it
// combines multiple measurements, takes the WEAKEST of their confidences
// (a chain is only as strong as its weakest link) — never invents a
// confidence unrelated to its inputs.

const CONFIDENCE_ORDER = { HIGH: 3, MEDIUM: 2, LOW: 1 };
function weakest(...levels) {
  const present = levels.filter(Boolean);
  if (present.length === 0) return null;
  return present.reduce((worst, level) => (CONFIDENCE_ORDER[level] < CONFIDENCE_ORDER[worst] ? level : worst));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

// Documented, reused constant: exactly the same 0.5s pause threshold
// services/reference-video/measurement-math.js's own DEFAULT_PAUSE_
// THRESHOLD_SECONDS already established and justified at the measurement
// layer — never a second, uncoordinated threshold invented here.
const SHORT_SHOT_THRESHOLD_SECONDS = 3; // a common short-form-editing reference point (many platforms' own recommended/typical cut cadence); stated explicitly as a chosen convention, not a universal truth about any specific video
const SKEW_RATIO_TOLERANCE = 0.15; // mean within +/-15% of median is treated as "roughly symmetric" — a conventional coarse skewness heuristic, not a statistically derived cutoff
const DISPERSION_RATIO_THRESHOLD = 0.5; // (p75-p25)/mean — a standard coefficient-of-variation-style relative-dispersion split; the OBSERVATION states the actual numbers regardless, so this threshold only selects which of two neutral descriptive phrases ("relatively consistent" / "relatively variable") is used, never a quality claim
const SENTENCE_VARIATION_THRESHOLD_RATIO = 1; // (max-min) exceeding the median itself is used as the "substantial variation" descriptive cutoff — a relative-to-scale threshold, not an absolute word count

const rules = [
  // --- TIMING ---------------------------------------------------------
  {
    id: 'VIDEO_DURATION_MEASURED',
    category: 'TIMING',
    description: 'Reports the video\'s own measured duration.',
    requiredMeasurementPaths: ['video.technical.duration'],
    limitations: 'A direct ffprobe read; carries no information about content or structure.',
    evaluate(m) {
      const duration = m.video && m.video.technical && m.video.technical.duration;
      if (!isNum(duration)) return null;
      return {
        statement: `The reference video is ${round(duration, 2)} seconds long.`,
        evidence: [{ metricPath: 'video.technical.duration', value: duration, unit: 'seconds' }],
        confidence: 'HIGH',
      };
    },
  },

  // --- STRUCTURE --------------------------------------------------------
  {
    id: 'SHOT_COUNT_OBSERVED',
    category: 'STRUCTURE',
    description: 'Reports the number of mechanically detected shots (cut-to-cut spans).',
    requiredMeasurementPaths: ['shots', 'shotRhythm.shotCount'],
    limitations: 'A shot is a mechanical cut boundary only, never a narrative scene (see SCENE_OBSERVATION_UNAVAILABLE). A single-shot result (zero detected cuts) is weaker evidence than a positive multi-cut detection.',
    evaluate(m) {
      if (!Array.isArray(m.shots) || m.shots.length === 0) return null;
      const n = m.shots.length;
      return {
        statement: `The reference video contains ${n} detected shot${n === 1 ? '' : 's'} (cut-to-cut span${n === 1 ? '' : 's'}).`,
        evidence: [{ metricPath: 'shotRhythm.shotCount', value: n, unit: 'count' }],
        confidence: n > 1 ? 'MEDIUM' : 'LOW',
      };
    },
  },
  {
    id: 'SCENE_OBSERVATION_UNAVAILABLE',
    category: 'STRUCTURE',
    description: 'States plainly that scene-level (narrative) grouping is not available at this layer, whenever scene detection capability is absent.',
    requiredMeasurementPaths: ['sceneDetectionCapability.available'],
    limitations: 'This is a capability statement, not an observation about the video itself.',
    isDiagnostic: true,
    diagnosticCode: 'SCENE_OBSERVATION_UNAVAILABLE',
    evaluate(m) {
      if (!m.sceneDetectionCapability || m.sceneDetectionCapability.available !== false) return null;
      return { message: m.sceneDetectionCapability.reason || 'scene-level observations are not available at this layer' };
    },
  },

  // --- SHOT_RHYTHM ------------------------------------------------------
  {
    id: 'SHOT_DURATION_BELOW_THRESHOLD',
    category: 'SHOT_RHYTHM',
    description: `Reports what fraction of detected shots are shorter than ${SHORT_SHOT_THRESHOLD_SECONDS}s.`,
    requiredMeasurementPaths: ['shots'],
    limitations: `Requires at least 3 detected shots for a percentage to be meaningful. The ${SHORT_SHOT_THRESHOLD_SECONDS}s threshold is a stated editorial convention, not a property of this specific video.`,
    evaluate(m) {
      if (!Array.isArray(m.shots) || m.shots.length < 3) return null;
      const below = m.shots.filter((s) => isNum(s.duration) && s.duration < SHORT_SHOT_THRESHOLD_SECONDS);
      const pct = round((below.length / m.shots.length) * 100, 1);
      const median = m.shotRhythm && m.shotRhythm.durationDistribution ? m.shotRhythm.durationDistribution.median : null;
      return {
        statement: `${pct}% of detected shots (${below.length} of ${m.shots.length}) are shorter than ${SHORT_SHOT_THRESHOLD_SECONDS} seconds${isNum(median) ? ` (median shot duration: ${round(median, 2)}s)` : ''}.`,
        evidence: [
          { metricPath: 'shots', value: m.shots.map((s) => s.duration), unit: 'seconds[]' },
          { metricPath: 'shotRhythm.durationDistribution.median', value: median, unit: 'seconds' },
        ],
        confidence: weakest('MEDIUM', ...m.shots.map((s) => s.confidence)),
      };
    },
  },

  // --- PACING -------------------------------------------------------------
  {
    id: 'SHOT_DURATION_SKEW',
    category: 'PACING',
    description: 'Compares mean vs. median shot duration to describe distribution shape.',
    requiredMeasurementPaths: ['shotRhythm.durationDistribution'],
    limitations: `Requires at least 3 shots. Uses a conventional +/-${Math.round(SKEW_RATIO_TOLERANCE * 100)}% mean-vs-median tolerance to select "right-skewed"/"left-skewed"/"roughly symmetric" wording — a coarse descriptive heuristic, not a formal skewness statistic.`,
    evaluate(m) {
      const d = m.shotRhythm && m.shotRhythm.durationDistribution;
      if (!d || d.count < 3 || !isNum(d.mean) || !isNum(d.median) || d.median === 0) return null;
      const ratio = d.mean / d.median;
      let shape;
      if (ratio > 1 + SKEW_RATIO_TOLERANCE) shape = 'right-skewed (a few notably longer shots alongside many shorter ones)';
      else if (ratio < 1 - SKEW_RATIO_TOLERANCE) shape = 'left-skewed (a few notably shorter shots alongside mostly longer ones)';
      else shape = 'roughly symmetric';
      return {
        statement: `The shot-duration distribution is ${shape}: mean ${round(d.mean, 2)}s vs. median ${round(d.median, 2)}s across ${d.count} shots.`,
        evidence: [{ metricPath: 'shotRhythm.durationDistribution', value: { mean: d.mean, median: d.median, count: d.count }, unit: 'seconds' }],
        confidence: 'MEDIUM',
      };
    },
  },
  {
    id: 'SHOT_COUNT_QUARTER_COMPARISON',
    category: 'PACING',
    description: 'Compares the number of detected shots in the first vs. last quarter of the video (Part 12 relative comparison).',
    requiredMeasurementPaths: ['shotRhythm.quarterShotCounts'],
    limitations: 'Requires at least 2 detected shots overall (a single-shot video has nothing to compare). Shot COUNT per quarter is reported; this is not a claim about viewer experience.',
    evaluate(m) {
      const q = m.shotRhythm && m.shotRhythm.quarterShotCounts;
      if (!Array.isArray(q) || q.length !== 4 || !Array.isArray(m.shots) || m.shots.length < 2) return null;
      const first = q[0].shotCount;
      const last = q[3].shotCount;
      const cmp = first === last ? 'the same number of' : first > last ? 'more' : 'fewer';
      return {
        statement: `The first quarter of the video contains ${first} detected shot(s); the last quarter contains ${last} — the first quarter has ${cmp} detected shots than the last.`,
        evidence: [{ metricPath: 'shotRhythm.quarterShotCounts', value: { firstQuarter: first, lastQuarter: last }, unit: 'count' }],
        confidence: 'MEDIUM',
      };
    },
  },

  // --- SPEECH_DENSITY -----------------------------------------------------
  {
    id: 'SPEECH_DENSITY_OVER_VIDEO',
    category: 'SPEECH_DENSITY',
    description: "Reports what fraction of the video's duration contains measured speech, from the transcript's own timing.",
    requiredMeasurementPaths: ['transcript.speechPercentageOfVideo'],
    limitations: 'Coarser (cue-level) when the transcript has no word-level timestamps — confidence reflects that.',
    evaluate(m) {
      const pct = m.transcript && m.transcript.speechPercentageOfVideo;
      if (!pct || !isNum(pct.value)) return null;
      return {
        statement: `Speech occupies approximately ${round(pct.value, 1)}% of the video's measured duration.`,
        evidence: [{ metricPath: 'transcript.speechPercentageOfVideo.value', value: pct.value, unit: 'percent' }],
        confidence: pct.confidence || 'LOW',
      };
    },
  },

  // --- NARRATION ------------------------------------------------------
  {
    id: 'WORDS_PER_MINUTE_OBSERVED',
    category: 'NARRATION',
    description: 'Reports the transcript-derived narration rate across the whole video.',
    requiredMeasurementPaths: ['transcript.wordsPerMinute'],
    limitations: 'An average over the whole video; says nothing about rate variation within it (see WORDS_PER_MINUTE is not compared across windows by this rule).',
    evaluate(m) {
      const wpm = m.transcript && m.transcript.wordsPerMinute;
      if (!wpm || !isNum(wpm.value)) return null;
      return {
        statement: `Narration rate is approximately ${round(wpm.value, 1)} words per minute across the whole video.`,
        evidence: [{ metricPath: 'transcript.wordsPerMinute.value', value: wpm.value, unit: 'words_per_minute' }],
        confidence: wpm.confidence || 'LOW',
      };
    },
  },
  {
    id: 'PAUSE_CONCENTRATION',
    category: 'NARRATION',
    description: 'Reports the count and duration distribution of detected inter-word pauses.',
    requiredMeasurementPaths: ['transcript.pauseCount', 'transcript.pauseDurationDistribution'],
    limitations: 'Only available when word-level timestamps exist. Pause boundary is a fixed gap threshold set at the measurement layer, not adaptive to speaking rate.',
    evaluate(m) {
      const count = m.transcript && m.transcript.pauseCount;
      const dist = m.transcript && m.transcript.pauseDurationDistribution;
      if (!count || !isNum(count.value) || count.value === 0 || !dist) return null;
      return {
        statement: `The transcript contains ${count.value} detected pause(s), averaging ${round(dist.mean, 2)}s (longest: ${round(dist.max, 2)}s).`,
        evidence: [
          { metricPath: 'transcript.pauseCount.value', value: count.value, unit: 'count' },
          { metricPath: 'transcript.pauseDurationDistribution', value: { mean: dist.mean, max: dist.max }, unit: 'seconds' },
        ],
        confidence: count.confidence || 'LOW',
      };
    },
  },
  {
    id: 'SENTENCE_LENGTH_VARIATION',
    category: 'NARRATION',
    description: 'Reports the range of detected sentence lengths (in words).',
    requiredMeasurementPaths: ['transcript.sentenceLengthDistribution'],
    limitations: 'Only available when word-level sentence timing exists (at least 2 detected sentences). Sentence boundaries are detected from terminal punctuation on word tokens, an imperfect heuristic.',
    evaluate(m) {
      const d = m.transcript && m.transcript.sentenceLengthDistribution;
      if (!d || d.count < 2 || !isNum(d.min) || !isNum(d.max) || !isNum(d.median)) return null;
      const range = d.max - d.min;
      const substantial = d.median > 0 && range > d.median * SENTENCE_VARIATION_THRESHOLD_RATIO;
      return {
        statement: `Detected sentence length ranges from ${d.min} to ${d.max} words across ${d.count} sentences (median ${d.median})${substantial ? ', with substantial variation in sentence length' : ''}.`,
        evidence: [{ metricPath: 'transcript.sentenceLengthDistribution', value: { min: d.min, max: d.max, median: d.median, count: d.count }, unit: 'words' }],
        confidence: 'MEDIUM',
      };
    },
  },

  // --- OPENING ----------------------------------------------------------
  {
    id: 'NARRATION_ONSET',
    category: 'OPENING',
    description: 'Reports when the first transcribed word begins, from real word-level timestamps.',
    requiredMeasurementPaths: ['wordTiming'],
    limitations: 'Only available when word-level transcript timing exists.',
    evaluate(m) {
      if (!Array.isArray(m.wordTiming) || m.wordTiming.length === 0) return null;
      const first = m.wordTiming[0];
      if (!isNum(first.startTime)) return null;
      return {
        statement: `Narration begins at approximately ${round(first.startTime, 2)} seconds into the video.`,
        evidence: [{ metricPath: 'wordTiming.0.startTime', value: first.startTime, unit: 'seconds' }],
        confidence: 'MEDIUM',
      };
    },
  },
  {
    id: 'FIRST_SHOT_BOUNDARY',
    category: 'OPENING',
    description: 'Reports the timestamp of the first detected cut.',
    requiredMeasurementPaths: ['shots'],
    limitations: 'Only applicable when at least 2 shots were detected (a single-shot video has no first cut to report).',
    evaluate(m) {
      if (!Array.isArray(m.shots) || m.shots.length < 2) return null;
      const cutTime = m.shots[1].startTime;
      return {
        statement: `The first detected shot change occurs at ${round(cutTime, 2)} seconds.`,
        evidence: [{ metricPath: 'shots.1.startTime', value: cutTime, unit: 'seconds' }],
        confidence: m.shots[1].confidence || 'LOW',
      };
    },
  },
  {
    id: 'OPENING_CUT_DENSITY',
    category: 'OPENING',
    description: 'Reports how many detected shot boundaries fall within the first 10 seconds.',
    requiredMeasurementPaths: ['hook.openingCutCounts'],
    limitations: 'Reports the first-10-seconds window only, by convention; other windows (5/15/30s) are available in the same measurement but not restated here.',
    evaluate(m) {
      const counts = m.hook && m.hook.openingCutCounts;
      if (!counts || !isNum(counts.first10s)) return null;
      return {
        statement: `${counts.first10s} shot boundary change(s) occur within the first 10 seconds of the video.`,
        evidence: [{ metricPath: 'hook.openingCutCounts.first10s', value: counts.first10s, unit: 'count' }],
        confidence: 'MEDIUM',
      };
    },
  },
  {
    id: 'OPENING_QUESTION_DETECTED',
    category: 'OPENING',
    description: "Reports the timestamp of the transcript's first literal question mark, when a word token carries it.",
    requiredMeasurementPaths: ['hook.firstQuestionMarkTime', 'hook.firstQuestionMarkText'],
    limitations: 'This detects linguistic question-mark structure, not a psychological curiosity gap. Only reports a timestamp when a single transcript word token itself carries the "?" character.',
    evaluate(m) {
      const hook = m.hook;
      if (!hook || !isNum(hook.firstQuestionMarkTime)) return null;
      return {
        statement: `The first detected question occurs at ${round(hook.firstQuestionMarkTime, 2)} seconds ("${hook.firstQuestionMarkText}").`,
        evidence: [
          { metricPath: 'hook.firstQuestionMarkTime', value: hook.firstQuestionMarkTime, unit: 'seconds' },
          { metricPath: 'hook.firstQuestionMarkText', value: hook.firstQuestionMarkText, unit: 'text' },
        ],
        confidence: 'MEDIUM',
      };
    },
  },

  // --- SILENCE ------------------------------------------------------------
  {
    id: 'FIRST_SILENCE_OBSERVED',
    category: 'SILENCE',
    description: 'Reports the timing of the first detected audio silence interval.',
    requiredMeasurementPaths: ['audio.silenceIntervals'],
    limitations: 'Silence is detected against a fixed noise-floor/duration threshold set at the measurement layer; a very quiet but non-silent passage will not be reported.',
    evaluate(m) {
      const intervals = m.audio && m.audio.silenceIntervals;
      if (!Array.isArray(intervals) || intervals.length === 0) return null;
      const first = intervals[0];
      return {
        statement: `The first detected audio silence interval begins at ${round(first.startTime, 2)} seconds and lasts ${round(first.duration, 2)} seconds.`,
        evidence: [{ metricPath: 'audio.silenceIntervals.0', value: first, unit: 'seconds' }],
        confidence: (m.audio.totalSilenceDuration && m.audio.totalSilenceDuration.confidence) || 'LOW',
      };
    },
  },
  {
    id: 'SILENCE_PROPORTION',
    category: 'SILENCE',
    description: "Reports what fraction of the audio track's own measured duration is silence, from FFmpeg silencedetect.",
    requiredMeasurementPaths: ['audio.totalSilenceDuration', 'audio.speechPercentage'],
    limitations: 'Uses a fixed noise-floor (-30dB) and minimum-duration (0.3s) threshold — a different, audio-track-level measurement from the transcript-derived SPEECH_DENSITY_OVER_VIDEO observation above.',
    evaluate(m) {
      const speechPct = m.audio && m.audio.speechPercentage;
      const totalSilence = m.audio && m.audio.totalSilenceDuration;
      if (!speechPct || !isNum(speechPct.value) || !totalSilence || !isNum(totalSilence.value)) return null;
      const silencePct = round(100 - speechPct.value, 1);
      return {
        statement: `Approximately ${silencePct}% of the audio track (${round(totalSilence.value, 2)}s) is measured as silence, using a -30dB/0.3s detection threshold.`,
        evidence: [
          { metricPath: 'audio.totalSilenceDuration.value', value: totalSilence.value, unit: 'seconds' },
          { metricPath: 'audio.speechPercentage.value', value: speechPct.value, unit: 'percent' },
        ],
        confidence: weakest(totalSilence.confidence, speechPct.confidence),
      };
    },
  },

  // --- VISUAL_CHANGE --------------------------------------------------
  {
    id: 'VISUAL_CHANGE_QUARTER_COMPARISON',
    category: 'VISUAL_CHANGE',
    description: 'Compares mean frame-to-frame difference in the first vs. last quarter of the video, from representative visual samples.',
    requiredMeasurementPaths: ['visual.samples', 'video.technical.duration'],
    limitations: 'Computed from a bounded, evenly-spaced SAMPLE of frames (not every frame), so this is a coarser signal than shot detection. Requires at least 4 samples in each of the compared quarters.',
    evaluate(m) {
      const samples = m.visual && m.visual.samples;
      const duration = m.video && m.video.technical && m.video.technical.duration;
      if (!Array.isArray(samples) || samples.length === 0 || !isNum(duration) || duration <= 0) return null;
      const q = duration / 4;
      const firstQ = samples.filter((s) => s.time < q && isNum(s.frameDifference));
      const lastQ = samples.filter((s) => s.time >= q * 3 && isNum(s.frameDifference));
      if (firstQ.length < 2 || lastQ.length < 2) return null;
      const mean = (arr) => arr.reduce((sum, s) => sum + s.frameDifference, 0) / arr.length;
      const firstMean = mean(firstQ);
      const lastMean = mean(lastQ);
      const cmp = firstMean === lastMean ? 'the same as' : firstMean > lastMean ? 'higher than' : 'lower than';
      return {
        statement: `Mean sampled frame-to-frame difference in the first quarter (${round(firstMean, 2)}) is ${cmp} the last quarter (${round(lastMean, 2)}).`,
        evidence: [{ metricPath: 'visual.samples', value: { firstQuarterMean: round(firstMean, 4), lastQuarterMean: round(lastMean, 4), firstQuarterSampleCount: firstQ.length, lastQuarterSampleCount: lastQ.length }, unit: 'signalstats_YDIF' }],
        confidence: 'LOW',
      };
    },
  },
  {
    id: 'VISUAL_CHANGE_CONSISTENCY',
    category: 'VISUAL_CHANGE',
    description: 'Describes whether frame-to-frame visual change is relatively consistent or relatively variable, from the frame-difference distribution.',
    requiredMeasurementPaths: ['visual.frameDifferenceDistribution'],
    limitations: `Uses a stated relative-dispersion threshold (interquartile range / mean = ${DISPERSION_RATIO_THRESHOLD}) to choose between two neutral descriptive phrases; this is a coarse distributional signal, not a claim about visual content.`,
    evaluate(m) {
      const d = m.visual && m.visual.frameDifferenceDistribution;
      if (!d || d.count < 4 || !isNum(d.mean) || d.mean === 0 || !isNum(d.p75) || !isNum(d.p25)) return null;
      const ratio = (d.p75 - d.p25) / d.mean;
      const label = ratio < DISPERSION_RATIO_THRESHOLD ? 'relatively consistent' : 'relatively variable';
      return {
        statement: `Frame-to-frame visual change is ${label} throughout the video (interquartile range ${round(d.p75 - d.p25, 2)} around a mean of ${round(d.mean, 2)}, n=${d.count} sampled frames).`,
        evidence: [{ metricPath: 'visual.frameDifferenceDistribution', value: { mean: d.mean, p25: d.p25, p75: d.p75, count: d.count }, unit: 'signalstats_YDIF' }],
        confidence: 'LOW',
      };
    },
  },

  // --- TEXT_PRESENCE ------------------------------------------------------
  {
    id: 'SPOKEN_QUESTION_COUNT',
    category: 'TEXT_PRESENCE',
    description: 'Counts detected question sentences in the SPOKEN transcript (never a claim about on-screen text).',
    requiredMeasurementPaths: ['transcript.sentences'],
    limitations: 'This is about spoken narration only. It says nothing about text that may appear visually on screen (see TEXT_PRESENCE_OCR_UNAVAILABLE).',
    evaluate(m) {
      const sentences = m.transcript && m.transcript.sentences;
      if (!Array.isArray(sentences) || sentences.length === 0) return null;
      const questions = sentences.filter((s) => /\?\s*$/.test(String(s.text || '').trim()));
      if (questions.length === 0) return null;
      return {
        statement: `Spoken narration contains ${questions.length} question sentence${questions.length === 1 ? '' : 's'}.`,
        evidence: [{ metricPath: 'transcript.sentences', value: questions.map((q) => q.text), unit: 'text[]' }],
        confidence: 'MEDIUM',
      };
    },
  },
  {
    id: 'TEXT_PRESENCE_OCR_UNAVAILABLE',
    category: 'TEXT_PRESENCE',
    description: 'States plainly that on-screen text presence cannot be observed, whenever OCR capability is absent.',
    requiredMeasurementPaths: ['ocrCapability.available'],
    limitations: 'This is a capability statement, not an observation about the video itself.',
    isDiagnostic: true,
    diagnosticCode: 'OCR_UNAVAILABLE',
    evaluate(m) {
      if (!m.ocrCapability || m.ocrCapability.available !== false) return null;
      return { message: 'On-screen text presence cannot be observed — OCR is unavailable in this environment. Any text-related observations above describe SPOKEN narration only.' };
    },
  },
];

function getRule(ruleId) {
  return rules.find((r) => r.id === ruleId) || null;
}

module.exports = { rules, getRule, CONFIDENCE_ORDER, weakest };
