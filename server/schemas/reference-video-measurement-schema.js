// reference-video-measurement-schema.js
//
// INT-1B — Layer 2 of the INT-1 specification's five-layer model:
//
//   RAW EVIDENCE (INT-1A's ReferenceVideo) -> MEASUREMENTS (this file) ->
//   Observations -> Interpretation -> Recommendation
//
// This file describes NUMBERS, TIMESTAMPS, and MECHANICALLY-DETECTED
// CLASSIFICATIONS derived from a ReferenceVideo's real evidence — never a
// judgment about whether any of it is good, bad, engaging, fast, slow, or
// effective. There is no field anywhere in this file that could hold the
// string "strong hook" or "good pacing" — every value here is either a
// number, a timestamp, a count, or a small closed vocabulary describing HOW
// something was measured (never what it MEANS). Same rules as every other
// schema file in this codebase: plain object factories only, no file I/O,
// no provider knowledge, every field defaults to null/[]/'' so partial data
// is always valid, nothing here invents information.
//
// ---------------------------------------------------------------------------
// TRACEABILITY (Part 16/17) — the createEvidenceRef/createMeasurement pattern
// ---------------------------------------------------------------------------
// Every DERIVED number (a rate, an average, a count computed from other
// data) is wrapped in createMeasurement({ metric, value, unit, source,
// evidence, confidence }) — the Part 2 shape the task specified, used
// exactly where it earns its keep. A DIRECTLY-READ fact (ffprobe's own
// width/height/duration) is NOT wrapped the same way; it is a plain field
// inside `video.technical`, exactly how schemas/reference-video-schema.js's
// own createVideoTechnicalMetadata already represents it, with one
// `video.technicalEvidence` pointer covering the whole block (they are all
// one ffprobe read of one file at one time — wrapping each field
// individually would multiply boilerplate without adding any real
// traceability beyond what one shared evidence pointer already gives).
// This mirrors the distinction schemas/reference-video-schema.js itself
// already draws between raw ffprobe facts (plain fields) and this stage's
// own derived arithmetic (which needs the fuller wrapper).
//
// ---------------------------------------------------------------------------
// SHOT vs SCENE (Part 4/13) — kept permanently distinct
// ---------------------------------------------------------------------------
// A SHOT is a mechanically-detected CUT boundary (FFmpeg's scdet filter
// comparing consecutive frames) — nothing more. A SCENE is a group of shots
// that share a narrative moment — a SEMANTIC judgment this layer cannot and
// does not make. `scenes` therefore does not exist as a field on this
// schema; `sceneDetectionCapability` instead records, honestly, that only
// shot detection is implemented here (see this stage's final report for the
// full reasoning).
//
// ---------------------------------------------------------------------------
// NO INTERPRETATION LEAKAGE — the discipline this file enforces on itself
// ---------------------------------------------------------------------------
// `hook` measures ONLY mechanically countable things in the opening window
// (word counts, cut counts, a literal "?" character's timestamp) — never a
// "curiosity gap" or "payoff" judgment (Part 10's explicit warning). `visual`
// measures frame-to-frame pixel difference and luminance — never "visual
// excitement" (Part 12's explicit warning). `shotRhythm` reports numbers,
// never "fast"/"slow" labels (Part 5's explicit warning).

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// Part 17 — never manufactured. HIGH: directly measured from a trusted,
// deterministic source (ffprobe, a literal count). MEDIUM: derived from
// multiple reliable measurements (an arithmetic combination of HIGH
// numbers). LOW: a heuristic, threshold-based, or partially-observed
// method (FFmpeg's scdet cut detection has a tunable threshold and can
// mis-detect; frame-sampling at a fixed interval is representative, not
// exhaustive). A measurement with no meaningful confidence concept (e.g. a
// literal count of words) still names its method but may omit confidence.
const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];

const MEASUREMENT_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED'];

// Part 18 — exactly the codes the task specified, plus the minimum natural
// extensions this stage's own scope requires (frame sampling and visual
// measurement each need their own failure code, matching the same
// "does this specific sub-measurement have its own failure code" pattern
// every code in the task's own list already follows).
const MEASUREMENT_DIAGNOSTIC_CODES = [
  'INVALID_REFERENCE_VIDEO',
  'VIDEO_METADATA_UNAVAILABLE',
  'SHOT_DETECTION_FAILED',
  'FRAME_SAMPLING_FAILED',
  'AUDIO_MEASUREMENT_FAILED',
  'TRANSCRIPT_MEASUREMENT_FAILED',
  'INVALID_WORD_TIMESTAMP',
  'INSUFFICIENT_EVIDENCE',
  'OCR_UNAVAILABLE',
  'SCENE_DETECTION_UNAVAILABLE',
  'VISUAL_MEASUREMENT_FAILED',
];

// Part 16 — what kind of evidence a measurement points back to.
const EVIDENCE_SOURCE_TYPES = ['REFERENCE_VIDEO_ASSET', 'REFERENCE_AUDIO_ASSET', 'TRANSCRIPT', 'SHOT_LIST', 'FRAME_SAMPLE'];

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

// A pointer back to the literal evidence a measurement came from — never a
// re-statement of the value itself. sourceType names WHICH piece of Layer-1
// evidence; sourceId is that evidence's own id (an Asset id, or the
// ReferenceVideo id for its transcript); startTime/endTime narrow it to a
// specific window when the measurement is about a slice, not the whole
// thing; note is free text for anything the three fields above can't
// capture (e.g. an FFmpeg filter invocation).
function createEvidenceRef(overrides = {}) {
  const base = {
    sourceType: null, // one of EVIDENCE_SOURCE_TYPES
    sourceId: null,
    startTime: null,
    endTime: null,
    note: null,
  };
  return withDefaults(base, overrides);
}

// Documents HOW a measurement was produced — the method itself, not its
// result. Every shot/silence/visual-change measurement carries one of
// these so a later reader can tell "scdet threshold=10" from "a human
// counted cuts by eye" without guessing.
function createDetectionMethod(overrides = {}) {
  const base = {
    name: null, // e.g. 'ffmpeg_scdet', 'ffmpeg_silencedetect', 'ffmpeg_volumedetect', 'literal_count'
    tool: null, // e.g. 'ffmpeg 6.1.1'
    parameters: {}, // e.g. { threshold: 10 } — whatever the method needed, plain object
  };
  return withDefaults(base, overrides);
}

// Part 2/16/17 — the reusable leaf for every DERIVED number in this file.
function createMeasurement(overrides = {}) {
  const { evidence, detectionMethod, ...rest } = overrides;
  const base = {
    metric: null, // short machine name, e.g. 'shots_per_minute'
    value: null,
    unit: null, // e.g. 'seconds', 'words_per_minute', 'count', 'ratio', 'dB'
    source: null, // short human label for where this came from, e.g. 'ffprobe', 'transcript_word_timestamps'
    evidence: evidence !== undefined ? (evidence === null ? null : createEvidenceRef(evidence)) : null,
    detectionMethod: detectionMethod !== undefined ? (detectionMethod === null ? null : createDetectionMethod(detectionMethod)) : null,
    confidence: null, // one of CONFIDENCE_LEVELS, or null when the concept doesn't apply
  };
  return withDefaults(base, rest);
}

// Part 15 — the shape of a video's behavior, never collapsed to one number.
function createDistribution(overrides = {}) {
  const base = {
    count: 0,
    mean: null,
    median: null,
    min: null,
    max: null,
    p25: null,
    p75: null,
    p90: null,
  };
  return withDefaults(base, overrides);
}

function createMeasurementDiagnostic(overrides = {}) {
  const base = {
    code: null, // one of MEASUREMENT_DIAGNOSTIC_CODES
    message: '',
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 3 — video technical measurements (ffprobe, direct reads)
// ---------------------------------------------------------------------------
function createVideoMeasurements(overrides = {}) {
  const { technical, technicalEvidence, frameCount, aspectRatio, audioPresent, ...rest } = overrides;
  const base = {
    // duration/width/height/fps/videoCodec/pixelFormat/bitrate/containerFormat/fileSizeBytes —
    // copied straight from the already-ffprobe-measured schemas/reference-
    // video-schema.js VideoTechnicalMetadata this ReferenceVideo already
    // carries; never re-guessed here.
    technical: technical || null,
    technicalEvidence: technicalEvidence !== undefined ? (technicalEvidence === null ? null : createEvidenceRef(technicalEvidence)) : null,
    // Part 3 — frame count "if reliably available": ffprobe's own
    // nb_frames stream tag, present for some containers/codecs and absent
    // for others. Never estimated from duration*fps (that would be a
    // computed guess, not a measurement) — stays null when ffprobe didn't
    // report it directly.
    frameCount: frameCount !== undefined ? frameCount : createMeasurement(),
    aspectRatio: aspectRatio !== undefined ? aspectRatio : createMeasurement(), // width/height, computed — MEDIUM confidence
    audioPresent: typeof audioPresent === 'boolean' ? audioPresent : null,
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 4 — a single detected SHOT (cut-to-cut span). Never called a scene.
// ---------------------------------------------------------------------------
function createShot(overrides = {}) {
  const { evidence, detectionMethod, ...rest } = overrides;
  const base = {
    index: null,
    startTime: null,
    endTime: null,
    duration: null,
    detectionMethod: detectionMethod !== undefined ? (detectionMethod === null ? null : createDetectionMethod(detectionMethod)) : null,
    confidence: null, // one of CONFIDENCE_LEVELS — scdet is threshold-based, so LOW/MEDIUM, never HIGH
    evidence: evidence !== undefined ? (evidence === null ? null : createEvidenceRef(evidence)) : null,
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 5 — shot rhythm: numbers only, no "fast"/"slow" label anywhere.
// ---------------------------------------------------------------------------
function createShotRhythm(overrides = {}) {
  const { durationDistribution, shotsPerMinute, first30sShotCount, first60sShotCount, quarterShotCounts, ...rest } = overrides;
  const base = {
    shotCount: 0,
    durationDistribution: durationDistribution || createDistribution(),
    shotsPerMinute: shotsPerMinute !== undefined ? shotsPerMinute : createMeasurement(),
    first30sShotCount: first30sShotCount !== undefined ? first30sShotCount : createMeasurement(),
    first60sShotCount: first60sShotCount !== undefined ? first60sShotCount : createMeasurement(),
    // Part 5 "pacing changes over time" — shot count per quarter of the
    // video's own duration; a distribution's SHAPE across time, not a
    // verdict about whether that shape is good.
    quarterShotCounts: Array.isArray(quarterShotCounts) ? quarterShotCounts : [],
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 6 — a deterministically-sampled representative frame. When frame
// extraction succeeds, the actual JPEG becomes an ordinary Asset (type
// 'reference_frame', added additively to production-schema.js's
// ASSET_TYPES — Part 4/5's own "reuse the existing Asset model" precedent
// applied again) so a FUTURE vision layer has a real file to look at. This
// file never looks at the pixels itself — no semantic interpretation.
function createFrameSample(overrides = {}) {
  const { evidence, ...rest } = overrides;
  const base = {
    time: null,
    role: null, // 'FIXED_INTERVAL' | 'SHOT_MIDPOINT' | 'OPENING' | 'CLOSING' | 'SHOT_BOUNDARY'
    shotIndex: null, // which detected shot this sample belongs to, when applicable
    frameAssetId: null, // an existing Asset (type: 'reference_frame'), null if extraction failed for this one sample
    evidence: evidence !== undefined ? (evidence === null ? null : createEvidenceRef(evidence)) : null,
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 7 — audio measurements
// ---------------------------------------------------------------------------
function createSilenceInterval(overrides = {}) {
  const base = { startTime: null, endTime: null, duration: null };
  return withDefaults(base, overrides);
}

function createAudioMeasurements(overrides = {}) {
  const {
    technical,
    technicalEvidence,
    silenceIntervals,
    totalSilenceDuration,
    speechDuration,
    speechPercentage,
    meanVolumeDb,
    maxVolumeDb,
    silenceDetectionMethod,
    ...rest
  } = overrides;
  const base = {
    // duration/audioCodec/sampleRate/channels/bitrate — from schemas/
    // reference-video-schema.js's own ffprobe-measured AudioTechnicalMetadata.
    technical: technical || null,
    technicalEvidence: technicalEvidence !== undefined ? (technicalEvidence === null ? null : createEvidenceRef(technicalEvidence)) : null,
    silenceIntervals: Array.isArray(silenceIntervals) ? silenceIntervals.map((s) => createSilenceInterval(s)) : [],
    totalSilenceDuration: totalSilenceDuration !== undefined ? totalSilenceDuration : createMeasurement(),
    // "speech/non-speech regions" (Part 7): this layer has no speech
    // detector distinct from silence detection, so speech regions are
    // computed as the complement of the measured silence intervals — an
    // explicit, documented approximation (silence != non-speech in
    // general, e.g. music without silence would read as "all speech"),
    // never presented as a dedicated speech-recognition result.
    speechDuration: speechDuration !== undefined ? speechDuration : createMeasurement(),
    speechPercentage: speechPercentage !== undefined ? speechPercentage : createMeasurement(),
    meanVolumeDb: meanVolumeDb !== undefined ? meanVolumeDb : createMeasurement(),
    maxVolumeDb: maxVolumeDb !== undefined ? maxVolumeDb : createMeasurement(),
    silenceDetectionMethod: silenceDetectionMethod !== undefined ? (silenceDetectionMethod === null ? null : createDetectionMethod(silenceDetectionMethod)) : null,
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 8/9 — transcript + word-timing measurements. Reads schemas/
// reference-video-schema.js's own Transcript (words[]/segments[]) —
// NEVER modifies it (Part 9's explicit instruction: "measurements are
// derived data").
// ---------------------------------------------------------------------------
function createSentenceTiming(overrides = {}) {
  const base = {
    index: null,
    text: '',
    startTime: null,
    endTime: null,
    duration: null,
    wordCount: null,
  };
  return withDefaults(base, overrides);
}

function createWordTimingMeasurement(overrides = {}) {
  const base = {
    index: null,
    word: '',
    startTime: null,
    endTime: null,
    duration: null,
    gapBeforeNextWord: null, // inter-word gap to the NEXT word, null for the last word
  };
  return withDefaults(base, overrides);
}

function createTranscriptMeasurements(overrides = {}) {
  const {
    totalWords,
    wordsPerMinute,
    wordsPerSecond,
    sentenceCount,
    sentenceLengthDistribution,
    pauseCount,
    pauseDurationDistribution,
    speechDuration,
    silenceDuration,
    speechPercentageOfVideo,
    sentences,
    ...rest
  } = overrides;
  const base = {
    totalWords: totalWords !== undefined ? totalWords : createMeasurement(),
    wordsPerMinute: wordsPerMinute !== undefined ? wordsPerMinute : createMeasurement(),
    wordsPerSecond: wordsPerSecond !== undefined ? wordsPerSecond : createMeasurement(),
    // "sentence count where sentence boundaries are reliably available"
    // (Part 8): sentence boundaries are derived from terminal punctuation
    // (./!/?) in the transcript TEXT, only ever computed when word-level
    // timing exists (LOCAL_WHISPER transcripts) — a cue-level-only
    // transcript (PLATFORM_CAPTION/ACQUISITION_PROVIDER) has no reliable
    // per-word boundary to anchor sentence timing to, so this stays at its
    // default/empty rather than guessing.
    sentenceCount: sentenceCount !== undefined ? sentenceCount : createMeasurement(),
    sentenceLengthDistribution: sentenceLengthDistribution || createDistribution(),
    sentences: Array.isArray(sentences) ? sentences.map((s) => createSentenceTiming(s)) : [],
    // pauses — gaps between consecutive words beyond a documented
    // threshold; only meaningful when word-level timestamps exist.
    pauseCount: pauseCount !== undefined ? pauseCount : createMeasurement(),
    pauseDurationDistribution: pauseDurationDistribution || createDistribution(),
    speechDuration: speechDuration !== undefined ? speechDuration : createMeasurement(),
    silenceDuration: silenceDuration !== undefined ? silenceDuration : createMeasurement(),
    speechPercentageOfVideo: speechPercentageOfVideo !== undefined ? speechPercentageOfVideo : createMeasurement(),
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 10 — hook measurements. ONLY mechanically countable facts about the
// opening window. No field here may ever hold a judgment.
// ---------------------------------------------------------------------------
function createHookMeasurements(overrides = {}) {
  const { firstWords, firstSentenceDuration, openingWordCounts, openingCutCounts, firstQuestionMarkTime, firstQuestionMarkText, ...rest } = overrides;
  const base = {
    firstWords: firstWords || null, // the literal first transcript words, verbatim — a quotation, not a judgment
    firstSentenceDuration: firstSentenceDuration !== undefined ? firstSentenceDuration : createMeasurement(),
    // word counts within fixed opening windows — Part 10's own list
    openingWordCounts: openingWordCounts || { first5s: null, first10s: null, first15s: null },
    // cut counts within the same fixed opening windows, derived from the
    // already-detected shot list — Part 10's own list (5/10/15/30s)
    openingCutCounts: openingCutCounts || { first5s: null, first10s: null, first15s: null, first30s: null },
    // "first detected question mark" — Part 10's own explicit example of
    // what IS mechanically measurable (a literal character), as opposed to
    // "curiosity gap" or "payoff", which are NOT (Part 10's own warning) —
    // and are therefore never fields on this schema at all.
    firstQuestionMarkTime: firstQuestionMarkTime !== undefined ? firstQuestionMarkTime : null,
    firstQuestionMarkText: firstQuestionMarkText !== undefined ? firstQuestionMarkText : null,
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 12 — visual change measurements. Frame difference/luminance ONLY —
// never "visual excitement" or any other semantic leap (Part 12's own
// explicit warning, restated in `note` below so the field's limits travel
// with the data itself).
// ---------------------------------------------------------------------------
function createVisualSample(overrides = {}) {
  const base = { time: null, frameDifference: null, luminanceMean: null };
  return withDefaults(base, overrides);
}

function createVisualMeasurements(overrides = {}) {
  const { frameDifferenceDistribution, samples, detectionMethod, ...rest } = overrides;
  const base = {
    frameDifferenceDistribution: frameDifferenceDistribution || createDistribution(),
    samples: Array.isArray(samples) ? samples.map((s) => createVisualSample(s)) : [],
    detectionMethod: detectionMethod !== undefined ? (detectionMethod === null ? null : createDetectionMethod(detectionMethod)) : null,
    note: 'Frame difference and luminance are pixel-level signal measurements only. They do not measure and must never be read as "visual excitement", "dynamism", or any other qualitative judgment.',
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 11 — OCR capability report (never fabricated; installs nothing)
// ---------------------------------------------------------------------------
function createOcrCapabilityReport(overrides = {}) {
  const base = {
    available: false,
    checkedFor: [], // e.g. ['tesseract binary on PATH', 'pytesseract Python module']
    blocker: null, // human-readable reason, set when available === false
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 13 — scene detection capability report (honest, not renamed shots)
// ---------------------------------------------------------------------------
function createSceneDetectionCapabilityReport(overrides = {}) {
  const base = {
    available: false,
    reason: 'Only mechanical cut (shot) boundaries are detected at this layer. Grouping shots into narrative scenes requires semantic understanding of what happens on-screen, which this measurement layer deliberately does not perform (see INT-1 Layer 3, Observations — not built by this stage).',
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 14 — a temporal measurement window (reused across pacing/hook views)
// ---------------------------------------------------------------------------
function createTemporalWindow(overrides = {}) {
  const base = {
    label: null, // e.g. 'FIRST_5S', 'FIRST_30S', 'QUARTER_1', 'ENTIRE_VIDEO'
    startTime: null,
    endTime: null,
    shotCount: null,
    wordCount: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 19 — determinism note. Every method used here IS deterministic given
// identical input bytes (ffprobe/scdet/silencedetect/volumedetect are all
// pure functions of the file — no randomness, no network, no model
// sampling). This field exists so that fact is recorded ON the record
// itself, not just asserted in a test file.
// ---------------------------------------------------------------------------
function createDeterminismNote(overrides = {}) {
  const base = {
    deterministic: true,
    explanation:
      'All measurements in this record are produced by pure, non-random functions (ffprobe stream reads; FFmpeg scdet/silencedetect/volumedetect/signalstats filters; literal counting/arithmetic over the stored transcript) applied to the same stored video/audio bytes and transcript. Re-running measurement against unchanged evidence always produces byte-for-byte identical VALUES. The one explicitly-documented exception (Part 19): frameSamples[].frameAssetId is a freshly-generated identifier for a newly-stored Asset each time frame extraction runs — the extracted image BYTES are themselves deterministic (same ffmpeg seek against the same source), but re-running measurement always mints new Asset ids for them rather than deduplicating, so frameAssetId values are not expected to match across separate measurement runs even though every other field is.',
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// The ReferenceVideoMeasurements record itself.
// ---------------------------------------------------------------------------
function createReferenceVideoMeasurements(overrides = {}) {
  const {
    video,
    shots,
    shotRhythm,
    frameSamples,
    audio,
    transcript,
    wordTiming,
    hook,
    visual,
    ocrCapability,
    sceneDetectionCapability,
    temporalWindows,
    determinism,
    diagnostics,
    ...rest
  } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    referenceVideoId: null, // the schemas/reference-video-schema.js ReferenceVideo this was derived from

    video: video !== undefined ? (video === null ? null : createVideoMeasurements(video)) : createVideoMeasurements(),
    shots: Array.isArray(shots) ? shots.map((s) => createShot(s)) : [],
    shotRhythm: shotRhythm !== undefined ? (shotRhythm === null ? null : createShotRhythm(shotRhythm)) : null,
    frameSamples: Array.isArray(frameSamples) ? frameSamples.map((f) => createFrameSample(f)) : [],

    audio: audio !== undefined ? (audio === null ? null : createAudioMeasurements(audio)) : null,

    transcript: transcript !== undefined ? (transcript === null ? null : createTranscriptMeasurements(transcript)) : null,
    wordTiming: Array.isArray(wordTiming) ? wordTiming.map((w) => createWordTimingMeasurement(w)) : [],

    hook: hook !== undefined ? (hook === null ? null : createHookMeasurements(hook)) : null,
    visual: visual !== undefined ? (visual === null ? null : createVisualMeasurements(visual)) : null,

    ocrCapability: ocrCapability !== undefined ? (ocrCapability === null ? null : createOcrCapabilityReport(ocrCapability)) : createOcrCapabilityReport(),
    sceneDetectionCapability: sceneDetectionCapability !== undefined ? (sceneDetectionCapability === null ? null : createSceneDetectionCapabilityReport(sceneDetectionCapability)) : createSceneDetectionCapabilityReport(),

    temporalWindows: Array.isArray(temporalWindows) ? temporalWindows.map((w) => createTemporalWindow(w)) : [],

    determinism: determinism !== undefined ? (determinism === null ? null : createDeterminismNote(determinism)) : createDeterminismNote(),

    status: null, // one of MEASUREMENT_STATUSES
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createMeasurementDiagnostic(d)) : [],

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  CONFIDENCE_LEVELS,
  MEASUREMENT_STATUSES,
  MEASUREMENT_DIAGNOSTIC_CODES,
  EVIDENCE_SOURCE_TYPES,
  createEvidenceRef,
  createDetectionMethod,
  createMeasurement,
  createDistribution,
  createMeasurementDiagnostic,
  createVideoMeasurements,
  createShot,
  createShotRhythm,
  createFrameSample,
  createSilenceInterval,
  createAudioMeasurements,
  createSentenceTiming,
  createWordTimingMeasurement,
  createTranscriptMeasurements,
  createHookMeasurements,
  createVisualSample,
  createVisualMeasurements,
  createOcrCapabilityReport,
  createSceneDetectionCapabilityReport,
  createTemporalWindow,
  createDeterminismNote,
  createReferenceVideoMeasurements,
};
