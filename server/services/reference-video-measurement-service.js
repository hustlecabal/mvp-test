// reference-video-measurement-service.js
//
// INT-1B — the orchestrator proving Layer 2 of the INT-1 specification:
//
//   ReferenceVideo (INT-1A's Raw Evidence) -> ReferenceVideoMeasurements
//
// Reads an already-ingested schemas/reference-video-schema.js
// ReferenceVideo (never fetches anything over the network — Layer 2 works
// exclusively from Layer 1's already-stored evidence: the video/audio
// Assets and the transcript INT-1A already retrieved). Produces a
// schemas/reference-video-measurement-schema.js ReferenceVideoMeasurements
// record: numbers, timestamps, and mechanically-detected classifications —
// never a judgment (see that schema file's own header for the full rule).
//
// TOOLS USED, ALL ALREADY PROVEN ELSEWHERE IN THIS CODEBASE OR VERIFIED
// PRESENT DURING THIS STAGE'S OWN FORENSIC AUDIT — no new dependency:
//   ffprobe          — technical facts (duration/width/height/fps/codec),
//                       frame count (nb_frames stream tag, when present)
//   ffmpeg scdet      — shot (cut) boundary detection
//   ffmpeg signalstats — per-frame luminance + frame-to-frame difference
//   ffmpeg silencedetect/volumedetect — audio silence intervals + loudness
//   ffmpeg -ss/-vframes — deterministic representative-frame extraction
//
// PURE MATH LIVES ELSEWHERE (Part 21's testability requirement): every
// actual computation is services/reference-video/measurement-math.js and
// services/reference-video/measurement-parsers.js — pure functions,
// independently unit-testable against fixed/fixture input with no FFmpeg
// process required. This file's only job is: locate the real files, run
// the real subprocesses, hand their raw output to those pure functions,
// and assemble the schema record.
//
// NO SECOND ASSET SYSTEM (matching reference-video-ingestion-service.js's
// own discipline): extracted representative frames become ordinary
// schemas/production-schema.js Assets (type: 'reference_frame', added
// additively), stored through the EXISTING services/asset-storage.js.
//
// DETERMINISM (Part 19): every tool this file invokes is a pure function of
// its input bytes (no randomness, no network, no model sampling) — see
// this stage's final report for the repeated-run proof.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const projectStore = require('./project-store');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const referenceVideoStore = require('./reference-video-store');
const measurementStore = require('./reference-video-measurement-store');
const parsers = require('./reference-video/measurement-parsers');
const math = require('./reference-video/measurement-math');
const {
  createReferenceVideoMeasurements,
  createMeasurement,
  createEvidenceRef,
  createDetectionMethod,
  createMeasurementDiagnostic,
} = require('../schemas/reference-video-measurement-schema');

// Part 4 — scdet's own documented default threshold. Explicit here (never
// implicit) so it always appears in the recorded detectionMethod.parameters.
const DEFAULT_SHOT_DETECTION_THRESHOLD = 10;
// Part 7 — silencedetect parameters: -30dB noise floor, 0.3s minimum
// duration to count as a silence interval (short breaths/plosives below
// this are not "silence" for pacing purposes). Documented, tunable.
const DEFAULT_SILENCE_NOISE_DB = -30;
const DEFAULT_SILENCE_MIN_DURATION = 0.3;
// Part 6 — frame-sampling bounds, so a long reference video never produces
// an unbounded number of extracted frame files.
const FIXED_INTERVAL_SECONDS = 5;
const MAX_FIXED_INTERVAL_SAMPLES = 24;
const MAX_SHOT_MIDPOINT_SAMPLES = 20;
// Part 12 — visual-change samples[] is a representative subset of the full
// per-frame signalstats read (the DISTRIBUTION is computed from every
// frame; only the stored samples[] array is capped, for record size).
const MAX_VISUAL_SAMPLES = 60;

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function locateOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
function resolveFfmpeg(options) {
  return options.ffmpegPath || process.env.REFERENCE_VIDEO_FFMPEG_PATH || locateOnPath('ffmpeg') || 'ffmpeg';
}
function resolveFfprobe(options) {
  return options.ffprobePath || process.env.REFERENCE_VIDEO_FFPROBE_PATH || locateOnPath('ffprobe') || 'ffprobe';
}

function diag(code, message) {
  return createMeasurementDiagnostic({ code, message });
}

// spawnSync, not execFileSync: several of these filters (silencedetect,
// volumedetect) print their result to STDERR as log lines regardless of
// exit status, while others (scdet/signalstats with `metadata=print:
// file=-`) print to STDOUT. execFileSync only exposes stdout on success —
// spawnSync always exposes both, on every exit status, which is what every
// parser in measurement-parsers.js actually needs.
function runFfmpeg(ffmpegPath, args, timeoutMs = 60000) {
  const result = spawnSync(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status, error: result.error };
}

// Part 3 — frame count "if reliably available" (ffprobe's own nb_frames
// stream tag — a container-level claim, not a verified decode count, hence
// MEDIUM confidence, never HIGH).
function probeFrameCount(ffprobePath, videoPath) {
  try {
    const raw = execFileSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'json', videoPath], { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    const parsed = JSON.parse(raw);
    const stream = (parsed.streams || [])[0];
    const n = stream && stream.nb_frames ? Number(stream.nb_frames) : null;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Part 4 — shot detection via FFmpeg's scdet filter (verified present in
// this environment's FFmpeg 6.1.1 build during this stage's forensic
// audit). `metadata=print:file=-` makes scdet write its per-frame
// mafd/score onto stdout; this file compares each frame's score against
// `threshold` itself (see measurement-parsers.js's own header for why it
// never depends on FFmpeg's own undocumented lavfi.scd.time line).
function detectShots(ffmpegPath, videoPath, videoDuration, threshold = DEFAULT_SHOT_DETECTION_THRESHOLD) {
  const result = runFfmpeg(ffmpegPath, ['-hide_banner', '-i', videoPath, '-vf', `scdet=threshold=${threshold},metadata=print:file=-`, '-f', 'null', '-']);
  if (result.error || !result.stdout) {
    return { ok: false, message: result.error ? result.error.message : 'scdet produced no output' };
  }
  const { cutTimes } = parsers.parseScdetOutput(result.stdout, threshold);
  const shots = math.buildShotsFromCutTimes(cutTimes, videoDuration);
  return { ok: true, shots, threshold };
}

// Part 12 — frame-to-frame difference + luminance via signalstats.
function measureVisualChange(ffmpegPath, videoPath) {
  const result = runFfmpeg(ffmpegPath, ['-hide_banner', '-i', videoPath, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
  if (result.error || !result.stdout) {
    return { ok: false, message: result.error ? result.error.message : 'signalstats produced no output' };
  }
  const frames = parsers.parseSignalstatsOutput(result.stdout);
  // FFmpeg's own signalstats filter reports YDIF=0 for frame 0 (diffed
  // against a blank reference, not omitted) — passed through as-is here,
  // never re-interpreted or excluded; this file trusts FFmpeg's own real
  // reading rather than second-guessing it.
  const frameDifferences = frames.filter((f) => f.frameDifference !== null).map((f) => f.frameDifference);
  const distribution = math.computeDistribution(frameDifferences);
  // downsample to a bounded, evenly-spaced representative subset for the
  // stored samples[] — the distribution above already reflects every frame.
  const step = Math.max(1, Math.ceil(frames.length / MAX_VISUAL_SAMPLES));
  const samples = frames.filter((_, i) => i % step === 0).map((f) => ({ time: f.time, frameDifference: f.frameDifference, luminanceMean: f.luminanceMean }));
  return { ok: true, distribution, samples };
}

// Part 7 — silence intervals + loudness via silencedetect/volumedetect.
function measureAudio(ffmpegPath, audioPath, audioDuration) {
  const silenceResult = runFfmpeg(ffmpegPath, ['-hide_banner', '-i', audioPath, '-af', `silencedetect=noise=${DEFAULT_SILENCE_NOISE_DB}dB:d=${DEFAULT_SILENCE_MIN_DURATION}`, '-f', 'null', '-']);
  const volumeResult = runFfmpeg(ffmpegPath, ['-hide_banner', '-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-']);
  if (silenceResult.error || volumeResult.error) {
    return { ok: false, message: (silenceResult.error || volumeResult.error).message };
  }
  const silenceIntervals = parsers.parseSilencedetectOutput(silenceResult.stderr);
  const { meanVolumeDb, maxVolumeDb } = parsers.parseVolumedetectOutput(volumeResult.stderr);
  const totalSilenceDuration = silenceIntervals.reduce((sum, i) => sum + i.duration, 0);
  const speechDuration = typeof audioDuration === 'number' ? Math.max(0, audioDuration - totalSilenceDuration) : null;
  const speechPercentage = typeof audioDuration === 'number' && audioDuration > 0 ? (speechDuration / audioDuration) * 100 : null;
  return { ok: true, silenceIntervals, totalSilenceDuration, speechDuration, speechPercentage, meanVolumeDb, maxVolumeDb };
}

// Part 6 — deterministic sample-point selection: OPENING (t=0), CLOSING
// (near the end), one SHOT_MIDPOINT per detected shot (capped), and a
// FIXED_INTERVAL grid every FIXED_INTERVAL_SECONDS (capped). Duplicate/
// near-duplicate timestamps (within 0.15s) collapse to one sample so a
// single-shot short video doesn't produce redundant identical frames.
function planFrameSamples(shots, videoDuration) {
  const candidates = [];
  candidates.push({ time: 0, role: 'OPENING', shotIndex: shots.length > 0 ? shots[0].index : null });
  if (typeof videoDuration === 'number' && videoDuration > 0.2) {
    const closingTime = Number((videoDuration - 0.1).toFixed(3));
    const closingShot = shots.find((s) => closingTime >= s.startTime && closingTime < s.endTime);
    candidates.push({ time: closingTime, role: 'CLOSING', shotIndex: closingShot ? closingShot.index : null });
  }
  for (const shot of shots.slice(0, MAX_SHOT_MIDPOINT_SAMPLES)) {
    candidates.push({ time: Number(((shot.startTime + shot.endTime) / 2).toFixed(3)), role: 'SHOT_MIDPOINT', shotIndex: shot.index });
  }
  if (typeof videoDuration === 'number') {
    let t = FIXED_INTERVAL_SECONDS;
    let count = 0;
    while (t < videoDuration && count < MAX_FIXED_INTERVAL_SAMPLES) {
      const shotAtT = shots.find((s) => t >= s.startTime && t < s.endTime);
      candidates.push({ time: t, role: 'FIXED_INTERVAL', shotIndex: shotAtT ? shotAtT.index : null });
      t += FIXED_INTERVAL_SECONDS;
      count += 1;
    }
  }
  const deduped = [];
  for (const c of candidates.sort((a, b) => a.time - b.time)) {
    if (deduped.length === 0 || c.time - deduped[deduped.length - 1].time > 0.15) deduped.push(c);
  }
  return deduped;
}

// Extracts one JPEG frame at `time` via a fast (`-ss` before `-i`) seek —
// approximate to the nearest keyframe/decode boundary, which is exactly
// why these are called "representative" samples, never frame-exact
// evidence (documented on schemas/reference-video-measurement-schema.js's
// own FrameSample).
function extractFrame(ffmpegPath, videoPath, time, outPath) {
  const result = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, time)), '-i', videoPath, '-vframes', '1', '-q:v', '2', outPath], { timeout: 20000 });
  return result.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

function checkOcrCapability() {
  const checkedFor = ['tesseract binary on PATH'];
  const tesseractPath = locateOnPath('tesseract');
  if (tesseractPath) {
    return { available: true, checkedFor, blocker: null };
  }
  return {
    available: false,
    checkedFor,
    blocker: 'no OCR engine (tesseract) is installed in this environment — text-in-frame measurement is not implemented; do not install one automatically (Part 11)',
  };
}

// Public entry point.
//   projectId, referenceVideoId — an existing ingested ReferenceVideo
//   options — { ffmpegPath?, ffprobePath?, workDir? } — override only for tests
function measureReferenceVideo(projectId, referenceVideoId, options = {}) {
  if (!projectStore.getProject(projectId)) {
    return createReferenceVideoMeasurements({ projectId, referenceVideoId, status: 'FAILED', diagnostics: [diag('INVALID_REFERENCE_VIDEO', `no project found with id "${projectId}"`)] });
  }
  const referenceVideo = referenceVideoStore.getReferenceVideo(projectId, referenceVideoId);
  if (!referenceVideo) {
    return createReferenceVideoMeasurements({ projectId, referenceVideoId, status: 'FAILED', diagnostics: [diag('INVALID_REFERENCE_VIDEO', `no ReferenceVideo found with id "${referenceVideoId}" in project "${projectId}"`)] });
  }
  const videoAsset = referenceVideo.videoAssetId ? timelineStore.getAsset(projectId, referenceVideo.videoAssetId) : null;
  if (!videoAsset || !videoAsset.storage || videoAsset.storage.status !== 'STORED') {
    return createReferenceVideoMeasurements({ projectId, referenceVideoId, status: 'FAILED', diagnostics: [diag('INVALID_REFERENCE_VIDEO', 'the ReferenceVideo has no stored video Asset to measure')] });
  }

  const ffmpegPath = resolveFfmpeg(options);
  const ffprobePath = resolveFfprobe(options);
  const videoPath = assetStorage.resolveStoredPath(videoAsset.storage.path);
  const videoDuration = referenceVideo.videoTechnical ? referenceVideo.videoTechnical.duration : null;

  const diagnostics = [];
  const videoEvidence = createEvidenceRef({ sourceType: 'REFERENCE_VIDEO_ASSET', sourceId: referenceVideo.videoAssetId });

  // --- Part 3 — video technical measurements ---
  const frameCountValue = probeFrameCount(ffprobePath, videoPath);
  if (frameCountValue === null) diagnostics.push(diag('VIDEO_METADATA_UNAVAILABLE', 'ffprobe did not report a frame count for this container/codec'));
  const width = referenceVideo.videoTechnical && referenceVideo.videoTechnical.width;
  const height = referenceVideo.videoTechnical && referenceVideo.videoTechnical.height;
  const aspectRatioValue = typeof width === 'number' && typeof height === 'number' && height > 0 ? Number((width / height).toFixed(6)) : null;

  const video = {
    technical: referenceVideo.videoTechnical,
    technicalEvidence: videoEvidence,
    frameCount: createMeasurement({ metric: 'frame_count', value: frameCountValue, unit: 'count', source: 'ffprobe', evidence: videoEvidence, detectionMethod: createDetectionMethod({ name: 'ffprobe_nb_frames', tool: 'ffprobe' }), confidence: frameCountValue !== null ? 'MEDIUM' : null }),
    aspectRatio: createMeasurement({ metric: 'aspect_ratio', value: aspectRatioValue, unit: 'ratio', source: 'computed', evidence: videoEvidence, confidence: aspectRatioValue !== null ? 'HIGH' : null }),
    audioPresent: referenceVideo.audioAssetId !== null,
  };

  // --- Part 4 — shot detection ---
  let shots = [];
  let shotRhythm = null;
  const shotDetection = detectShots(ffmpegPath, videoPath, videoDuration);
  if (!shotDetection.ok) {
    diagnostics.push(diag('SHOT_DETECTION_FAILED', shotDetection.message));
  } else {
    const shotDetectionMethod = createDetectionMethod({ name: 'ffmpeg_scdet', tool: 'ffmpeg', parameters: { threshold: shotDetection.threshold } });
    shots = shotDetection.shots.map((s) =>
      Object.assign(s, {
        detectionMethod: shotDetectionMethod,
        // a threshold-based cut detector is never HIGH confidence — LOW
        // when zero cuts were found (absence of evidence is weaker than a
        // positive detection), MEDIUM when at least one cut was found.
        confidence: shotDetection.shots.length > 1 ? 'MEDIUM' : 'LOW',
        evidence: createEvidenceRef({ sourceType: 'REFERENCE_VIDEO_ASSET', sourceId: referenceVideo.videoAssetId, startTime: s.startTime, endTime: s.endTime }),
      })
    );
    // Part 5
    const rhythm = math.computeShotRhythm(shots, videoDuration);
    const shotListEvidence = createEvidenceRef({ sourceType: 'SHOT_LIST', sourceId: referenceVideo.id });
    shotRhythm = {
      shotCount: rhythm.shotCount,
      durationDistribution: rhythm.durationDistribution,
      shotsPerMinute: createMeasurement({ metric: 'shots_per_minute', value: rhythm.shotsPerMinute, unit: 'shots_per_minute', source: 'computed', evidence: shotListEvidence, confidence: 'MEDIUM' }),
      first30sShotCount: createMeasurement({ metric: 'shots_in_first_30s', value: rhythm.first30sShotCount, unit: 'count', source: 'computed', evidence: shotListEvidence, confidence: 'MEDIUM' }),
      first60sShotCount: createMeasurement({ metric: 'shots_in_first_60s', value: rhythm.first60sShotCount, unit: 'count', source: 'computed', evidence: shotListEvidence, confidence: 'MEDIUM' }),
      quarterShotCounts: rhythm.quarterShotCounts,
    };
  }

  // --- Part 6 — frame sampling: extract real JPEG frames as Assets ---
  const frameSamples = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reference-video-measurement-'));
  try {
    const plan = planFrameSamples(shots, videoDuration);
    let anyExtracted = false;
    for (const sample of plan) {
      const outPath = path.join(workDir, `frame-${sample.time}.jpg`);
      const extracted = extractFrame(ffmpegPath, videoPath, sample.time, outPath);
      let frameAssetId = null;
      if (extracted) {
        anyExtracted = true;
        frameAssetId = crypto.randomUUID();
        const buffer = fs.readFileSync(outPath);
        const stored = assetStorage.storeUploadedImage(buffer, frameAssetId);
        timelineStore.addAsset(projectId, { assetId: frameAssetId, type: 'reference_frame', provider: 'local' });
        timelineStore.updateAssetStorage(projectId, frameAssetId, {
          provider: 'local',
          path: stored.relativePath,
          status: 'STORED',
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          archivedAt: new Date().toISOString(),
          error: null,
        });
      }
      frameSamples.push({
        time: sample.time,
        role: sample.role,
        shotIndex: sample.shotIndex,
        frameAssetId,
        evidence: createEvidenceRef({ sourceType: 'REFERENCE_VIDEO_ASSET', sourceId: referenceVideo.videoAssetId, startTime: sample.time, note: `ffmpeg -ss ${sample.time} -vframes 1 (fast/approximate seek)` }),
      });
    }
    if (plan.length > 0 && !anyExtracted) diagnostics.push(diag('FRAME_SAMPLING_FAILED', 'no representative frame could be extracted from the video'));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // --- Part 7 — audio measurements ---
  let audio = null;
  if (referenceVideo.audioAssetId) {
    const audioAsset = timelineStore.getAsset(projectId, referenceVideo.audioAssetId);
    if (audioAsset && audioAsset.storage && audioAsset.storage.status === 'STORED') {
      const audioPath = assetStorage.resolveStoredPath(audioAsset.storage.path);
      const audioDuration = referenceVideo.audioTechnical ? referenceVideo.audioTechnical.duration : videoDuration;
      const audioEvidence = createEvidenceRef({ sourceType: 'REFERENCE_AUDIO_ASSET', sourceId: referenceVideo.audioAssetId });
      const audioResult = measureAudio(ffmpegPath, audioPath, audioDuration);
      if (!audioResult.ok) {
        diagnostics.push(diag('AUDIO_MEASUREMENT_FAILED', audioResult.message));
      } else {
        const silenceMethod = createDetectionMethod({ name: 'ffmpeg_silencedetect', tool: 'ffmpeg', parameters: { noiseDb: DEFAULT_SILENCE_NOISE_DB, minDuration: DEFAULT_SILENCE_MIN_DURATION } });
        audio = {
          technical: referenceVideo.audioTechnical,
          technicalEvidence: audioEvidence,
          silenceIntervals: audioResult.silenceIntervals,
          totalSilenceDuration: createMeasurement({ metric: 'total_silence_duration', value: audioResult.totalSilenceDuration, unit: 'seconds', source: 'ffmpeg_silencedetect', evidence: audioEvidence, detectionMethod: silenceMethod, confidence: 'MEDIUM' }),
          speechDuration: createMeasurement({ metric: 'speech_duration', value: audioResult.speechDuration, unit: 'seconds', source: 'computed', evidence: audioEvidence, confidence: 'MEDIUM' }),
          speechPercentage: createMeasurement({ metric: 'speech_percentage', value: audioResult.speechPercentage, unit: 'percent', source: 'computed', evidence: audioEvidence, confidence: 'MEDIUM' }),
          meanVolumeDb: createMeasurement({ metric: 'mean_volume', value: audioResult.meanVolumeDb, unit: 'dB', source: 'ffmpeg_volumedetect', evidence: audioEvidence, confidence: 'HIGH' }),
          maxVolumeDb: createMeasurement({ metric: 'max_volume', value: audioResult.maxVolumeDb, unit: 'dB', source: 'ffmpeg_volumedetect', evidence: audioEvidence, confidence: 'HIGH' }),
          silenceDetectionMethod: silenceMethod,
        };
      }
    } else {
      diagnostics.push(diag('AUDIO_MEASUREMENT_FAILED', 'the ReferenceVideo audio Asset is not stored'));
    }
  } else {
    diagnostics.push(diag('INSUFFICIENT_EVIDENCE', 'no audio Asset available — audio measurements skipped'));
  }

  // --- Part 8/9 — transcript + word-timing measurements ---
  let transcript = null;
  let wordTiming = [];
  let hook = null;
  if (referenceVideo.transcript && referenceVideo.transcript.text) {
    const transcriptEvidence = createEvidenceRef({ sourceType: 'TRANSCRIPT', sourceId: referenceVideo.id });
    const words = referenceVideo.transcript.words || [];
    const segments = referenceVideo.transcript.segments || [];
    const totalWordsValue = String(referenceVideo.transcript.text).trim().split(/\s+/).filter(Boolean).length;
    const wpm = typeof videoDuration === 'number' && videoDuration > 0 ? (totalWordsValue / videoDuration) * 60 : null;
    const wps = typeof videoDuration === 'number' && videoDuration > 0 ? totalWordsValue / videoDuration : null;

    const hasWordTiming = words.length > 0;
    const computedWordTiming = hasWordTiming ? math.computeWordTimingMeasurements(words) : [];
    wordTiming = computedWordTiming;

    const sentencesFromText = math.countSentencesFromText(referenceVideo.transcript.text);
    const sentencesWithTiming = hasWordTiming ? math.computeSentencesFromWords(words) : [];
    const sentenceLengths = sentencesWithTiming.length > 0 ? sentencesWithTiming.map((s) => s.wordCount) : [];

    const pauseResult = hasWordTiming ? math.computePauses(computedWordTiming) : { pauses: [], durations: [] };
    if (hasWordTiming) {
      const invalidWords = words.filter((w) => (w.startTime !== null && typeof w.startTime !== 'number') || (w.endTime !== null && typeof w.endTime !== 'number') || (typeof w.startTime === 'number' && typeof w.endTime === 'number' && w.endTime < w.startTime));
      if (invalidWords.length > 0) diagnostics.push(diag('INVALID_WORD_TIMESTAMP', `${invalidWords.length} word(s) have malformed timestamps`));
    }

    // Part 8's last bullet — speech/silence duration from the TRANSCRIPT's
    // OWN timestamps (distinct from the audio-track-level silencedetect
    // measurement above): word-level spans when available, else the
    // coarser cue-level segments.
    let transcriptSpeechDuration = null;
    if (hasWordTiming) {
      transcriptSpeechDuration = computedWordTiming.reduce((sum, w) => sum + (typeof w.duration === 'number' ? w.duration : 0), 0);
    } else if (segments.length > 0) {
      transcriptSpeechDuration = segments.reduce((sum, s) => sum + (typeof s.startTime === 'number' && typeof s.endTime === 'number' ? s.endTime - s.startTime : 0), 0);
    }
    const transcriptSilenceDuration = typeof videoDuration === 'number' && transcriptSpeechDuration !== null ? Math.max(0, videoDuration - transcriptSpeechDuration) : null;
    const transcriptSpeechPercentage = typeof videoDuration === 'number' && videoDuration > 0 && transcriptSpeechDuration !== null ? (transcriptSpeechDuration / videoDuration) * 100 : null;

    transcript = {
      totalWords: createMeasurement({ metric: 'total_words', value: totalWordsValue, unit: 'count', source: 'transcript_text', evidence: transcriptEvidence, confidence: 'HIGH' }),
      wordsPerMinute: createMeasurement({ metric: 'words_per_minute', value: wpm, unit: 'words_per_minute', source: 'computed', evidence: transcriptEvidence, confidence: 'MEDIUM' }),
      wordsPerSecond: createMeasurement({ metric: 'words_per_second', value: wps, unit: 'words_per_second', source: 'computed', evidence: transcriptEvidence, confidence: 'MEDIUM' }),
      sentenceCount: createMeasurement({ metric: 'sentence_count', value: sentencesFromText, unit: 'count', source: 'transcript_text', evidence: transcriptEvidence, detectionMethod: createDetectionMethod({ name: 'terminal_punctuation_split', tool: 'regex' }), confidence: 'MEDIUM' }),
      sentenceLengthDistribution: math.computeDistribution(sentenceLengths),
      sentences: sentencesWithTiming,
      pauseCount: createMeasurement({ metric: 'pause_count', value: hasWordTiming ? pauseResult.pauses.length : null, unit: 'count', source: 'word_timestamps', evidence: transcriptEvidence, confidence: hasWordTiming ? 'MEDIUM' : null }),
      pauseDurationDistribution: math.computeDistribution(pauseResult.durations),
      speechDuration: createMeasurement({ metric: 'transcript_speech_duration', value: transcriptSpeechDuration, unit: 'seconds', source: hasWordTiming ? 'word_timestamps' : 'segment_timestamps', evidence: transcriptEvidence, confidence: hasWordTiming ? 'MEDIUM' : 'LOW' }),
      silenceDuration: createMeasurement({ metric: 'transcript_silence_duration', value: transcriptSilenceDuration, unit: 'seconds', source: 'computed', evidence: transcriptEvidence, confidence: hasWordTiming ? 'MEDIUM' : 'LOW' }),
      speechPercentageOfVideo: createMeasurement({ metric: 'transcript_speech_percentage', value: transcriptSpeechPercentage, unit: 'percent', source: 'computed', evidence: transcriptEvidence, confidence: hasWordTiming ? 'MEDIUM' : 'LOW' }),
    };

    // --- Part 10 — hook measurements ---
    const openingWords = words.length > 0 ? words : [];
    const firstWordsText = String(referenceVideo.transcript.text).trim().split(/\s+/).filter(Boolean).slice(0, 15).join(' ');
    const openingWordCounts = math.computeOpeningWordCounts(words, segments);
    const openingCutCounts = math.computeOpeningCutCounts(shots);
    const qMark = math.findFirstQuestionMark(referenceVideo.transcript.text, words);
    hook = {
      firstWords: firstWordsText || null,
      firstSentenceDuration: createMeasurement({ metric: 'first_sentence_duration', value: sentencesWithTiming.length > 0 ? sentencesWithTiming[0].duration : null, unit: 'seconds', source: 'word_timestamps', evidence: transcriptEvidence, confidence: sentencesWithTiming.length > 0 ? 'MEDIUM' : null }),
      openingWordCounts,
      openingCutCounts,
      firstQuestionMarkTime: qMark.time,
      firstQuestionMarkText: qMark.text,
    };
    void openingWords;
  } else {
    diagnostics.push(diag('TRANSCRIPT_MEASUREMENT_FAILED', 'no transcript available for this ReferenceVideo — transcript/word-timing/hook measurements skipped'));
  }

  // --- Part 12 — visual change measurements ---
  let visual = null;
  const visualResult = measureVisualChange(ffmpegPath, videoPath);
  if (!visualResult.ok) {
    diagnostics.push(diag('VISUAL_MEASUREMENT_FAILED', visualResult.message));
  } else {
    visual = {
      frameDifferenceDistribution: visualResult.distribution,
      samples: visualResult.samples,
      detectionMethod: createDetectionMethod({ name: 'ffmpeg_signalstats', tool: 'ffmpeg' }),
    };
  }

  // --- Part 11/13 — capability reports ---
  const ocrCapability = checkOcrCapability();
  if (!ocrCapability.available) diagnostics.push(diag('OCR_UNAVAILABLE', ocrCapability.blocker));
  diagnostics.push(diag('SCENE_DETECTION_UNAVAILABLE', 'only shot (cut) detection is implemented — see sceneDetectionCapability'));

  // --- Part 14 — temporal windows ---
  const temporalWindows = math.computeTemporalWindows(videoDuration, shots, referenceVideo.transcript ? referenceVideo.transcript.words : null, referenceVideo.transcript ? referenceVideo.transcript.segments : null);

  const status = shots.length === 0 && !audio && !transcript && !visual ? 'FAILED' : diagnostics.length === 0 ? 'COMPLETE' : 'PARTIAL';

  const measurements = createReferenceVideoMeasurements({
    projectId,
    referenceVideoId,
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
    sceneDetectionCapability: undefined, // schema default already states the honest reason
    temporalWindows,
    status,
    diagnostics,
  });

  const saved = measurementStore.addMeasurement(projectId, measurements);
  return saved.ok ? saved.measurements : measurements;
}

module.exports = { measureReferenceVideo, detectShots, measureAudio, measureVisualChange, planFrameSamples, probeFrameCount, checkOcrCapability };
