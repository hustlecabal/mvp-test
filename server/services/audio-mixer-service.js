// audio-mixer-service.js
//
// PHASE 3D — the AUDIO MIXER. Consumes already-compiled AudioEvents (real
// startTime/duration, exactly as services/timeline-compiler-service.js's
// own TimelineCompilationResult.audio[] produces them — see that file's
// header) and renders ONE final mixed audio stream: gain, fades, ducking,
// and final loudness control all happen here, and ONLY here.
//
// NOT A SECOND TIMELINE (Part C's own explicit rule): this file never
// decides WHERE an event plays — every startTime/duration it reads is
// already final, compiler-decided fact. It only decides HOW LOUD and HOW
// SMOOTH each event sounds once placed.
//
// LAYERING: services/video-assembly-service.js resolves+validates every
// AudioEvent's source Asset (unchanged — that validation is type-neutral
// already) and calls this file's mixAudioEvents() to get back ONE mixed
// audio file, then mux()es that file against the rendered video exactly
// as it always has. Assembly never builds a filter graph itself; this
// file never touches video or the final container.
//
// ---------------------------------------------------------------------------
// EXTENSIBILITY WITHOUT REDESIGN (Part C): SFX and AMBIENCE do not exist
// as providers yet, and this stage does not build them. What this stage
// DOES do is make sure adding them later never requires touching the
// pipeline shape: SEGMENT_BUILDERS below is a per-type registry (today:
// NARRATION, MUSIC); a real SFX/AMBIENCE provider arriving later adds one
// more entry, never a rewrite of buildEventSegment/sumSegments/
// applyFinalLoudness. An AudioEvent of a type this file does not yet
// support is a structured UNSUPPORTED_AUDIO_TYPE failure, never a silent
// drop — the same "report and exclude/fail, never fake" discipline every
// other stage in this pipeline already follows.
//
// PRECEDENCE (Part D): NARRATION > SFX > MUSIC > AMBIENCE. Only NARRATION
// and MUSIC exist this phase, so the only precedence relationship actually
// implemented is "MUSIC ducks under NARRATION" — never the reverse, and
// narration itself is never ducked or otherwise processed beyond its own
// AudioEvent-level gain/fade fields (see "NARRATION SAFETY" below). A
// future SFX bed would duck under NARRATION and would itself duck MUSIC,
// reusing the exact same mergeNarrationWindows/computeDuckGainAtTime
// primitives this file already exports — not a new mechanism.
//
// DETERMINISTIC DUCKING (Part D's own explicit word): the duck amount and
// timing are a pure function of the COMPILED TIMELINE (narration
// start/end windows) plus fixed, named constants (attack/release/duck
// level) — never of the narration audio's own real loudness. This is a
// deliberate choice over ffmpeg's own level-triggered `sidechaincompress`
// filter, which would make the duck amount depend on how loud a given
// narration take happens to be — not reproducible from timeline data
// alone, and not what "deterministic" can mean here. computeDuckGainAtTime
// below is a plain, side-effect-free function of (t, windows, config) —
// directly unit-testable with no ffmpeg process involved — and
// buildDuckVolumeExpression renders the IDENTICAL formula as an ffmpeg
// `volume` filter expression (both are kept in the same file, generated
// from the same window/config inputs, specifically so they cannot drift
// apart silently).
//
// NARRATION SAFETY (Part C: "no unnecessary processing that damages
// speech"): a NARRATION segment's filter chain never gains an `atrim`
// stage (its source file's own real, measured length already IS its
// `duration` — trimming it is pure risk, never a benefit) and is never a
// ducking TARGET. Its own volume/fadeIn/fadeOut fields ARE honored if a
// caller ever sets them (Part E: "the mixer must actually consume the
// existing fields"), but every real narration AudioEvent in this codebase
// today leaves them at their schema defaults (1/0/0), which reduce to
// exactly zero added filter stages — so today's real narration-only
// pipeline (Phase 1/2's own frozen, tested behavior) produces the
// byte-identical ffmpeg invocation it always has.
//
// FINAL LOUDNESS SCOPE (Part F): applied once, after every track is
// summed — never per-source. Deliberately SKIPPED when the resolved audio
// is 100% NARRATION (Phase 1/2's own existing scenario, frozen, already
// covered by an exact-duration regression tolerance): there is no
// multi-source BALANCE to control yet in that case, and this stage must
// never risk altering that already-proven output. The stage runs whenever
// at least one non-NARRATION event (MUSIC today) is present.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { createAssemblyDiagnostic } = require('../schemas/assembly-result-schema');

// Configurable, named constants (Part D's own explicit instruction: "The
// exact values should be configurable rather than scattered as magic
// numbers") — never inlined at each call site.
const DEFAULT_DUCKING_CONFIG = {
  attackSeconds: 0.4, // how long the ramp DOWN takes once narration starts
  releaseSeconds: 0.8, // how long the ramp UP takes once narration ends
  duckGainDb: -12, // how far music drops while narration is active
};

const TARGET_MEAN_VOLUME_DB = -20; // final-mix loudness target (Part F)
const MAX_GAIN_ADJUST_DB = 12; // never swing the final gain further than this either direction
const LIMITER_CEILING = 0.97; // ~-0.27 dBFS true-peak headroom (Part F: "prevent clipping")
const CLIPPING_PEAK_THRESHOLD_DB = -0.1; // Part H — a measured peak at/above this is flagged as a clipping-risk diagnostic

const SEGMENT_BUILDERS = new Set(['NARRATION', 'MUSIC']); // Part C — the extensibility registry; add 'SFX'/'AMBIENCE' here, and nowhere else, once a real provider exists for either.

function diag(code, message, extra = {}) {
  return createAssemblyDiagnostic({ code, message, ...extra });
}

function run(ffmpegPath, args, code, message) {
  try {
    execFileSync(ffmpegPath, args, { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').slice(-2000) : '';
    return { ok: false, error: diag(code, `${message}: ${error && error.message ? error.message : String(error)}${stderr ? ` | stderr: ${stderr}` : ''}`) };
  }
}

// ---------------------------------------------------------------------------
// Deterministic ducking math — pure functions, no ffmpeg, no I/O.
// ---------------------------------------------------------------------------

// Sorts and merges overlapping/touching [start,end) windows so a music
// event ducking under several close/overlapping narration events never
// double-ramps between them.
function mergeNarrationWindows(windows) {
  const sorted = (Array.isArray(windows) ? windows : [])
    .filter((w) => w && typeof w.start === 'number' && typeof w.end === 'number' && w.end > w.start)
    .map((w) => ({ start: w.start, end: w.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// The gain multiplier (0-1) at time `t`, given a set of already-merged
// narration windows: 1 outside any window's attack/hold/release span,
// ramping linearly down to duckGainDb's linear equivalent over
// attackSeconds once a window starts, held for the window's duration,
// ramping linearly back up to 1 over releaseSeconds after it ends.
// Multiple windows combine via min() — the LOWEST (most-ducked) gain any
// window demands always wins, never summed/multiplied across windows.
function computeDuckGainAtTime(t, mergedWindows, config = DEFAULT_DUCKING_CONFIG) {
  const duckLevel = Math.pow(10, config.duckGainDb / 20);
  const attack = Math.max(config.attackSeconds, 1e-6);
  const release = Math.max(config.releaseSeconds, 1e-6);
  let gain = 1;
  for (const w of Array.isArray(mergedWindows) ? mergedWindows : []) {
    let g;
    if (t < w.start) {
      g = 1;
    } else if (t < w.start + attack) {
      g = 1 + (duckLevel - 1) * ((t - w.start) / attack);
    } else if (t <= w.end) {
      g = duckLevel;
    } else if (t < w.end + release) {
      g = duckLevel + (1 - duckLevel) * ((t - w.end) / release);
    } else {
      g = 1;
    }
    gain = Math.min(gain, g);
  }
  return gain;
}

// The ffmpeg `volume` filter expression rendering the IDENTICAL formula
// computeDuckGainAtTime() implements above (same windows, same config) —
// kept in the same file, generated from the same inputs, so the two can
// never silently diverge. `eval=frame` makes ffmpeg re-evaluate this
// expression's `t` (the frame's own presentation time) every frame.
function buildDuckVolumeExpression(mergedWindows, config = DEFAULT_DUCKING_CONFIG) {
  const windows = Array.isArray(mergedWindows) ? mergedWindows : [];
  if (windows.length === 0) return '1';
  const duckLevel = Math.pow(10, config.duckGainDb / 20);
  const attack = Math.max(config.attackSeconds, 1e-6);
  const release = Math.max(config.releaseSeconds, 1e-6);
  const perWindow = windows.map((w) => {
    const s = w.start;
    const e = w.end;
    const attackEnd = s + attack;
    const releaseEnd = e + release;
    return (
      `if(between(t,${s},${attackEnd}),1+(${duckLevel}-1)*(t-${s})/${attack},` +
      `if(between(t,${attackEnd},${e}),${duckLevel},` +
      `if(between(t,${e},${releaseEnd}),${duckLevel}+(1-${duckLevel})*(t-${e})/${release},1)))`
    );
  });
  return perWindow.reduceRight((acc, expr) => `min(${expr},${acc})`, '1');
}

// ---------------------------------------------------------------------------
// ffmpeg rendering.
// ---------------------------------------------------------------------------

// Builds ONE AudioEvent's own segment: full-timeline-length (expectedDuration),
// silent outside [startTime, startTime+duration], with the event's own
// gain/fade/duck applied. See the NARRATION SAFETY comment above for why a
// NARRATION event's real filter chain is unchanged from Phase 1/2's own.
function buildEventSegment(ffmpegPath, sourcePath, audioEvent, expectedDuration, duckExpression, outPath) {
  const delayMs = Math.max(0, Math.round(audioEvent.startTime * 1000));
  const duration = audioEvent.duration;
  const stages = [];

  if (audioEvent.type !== 'NARRATION') {
    // Part B: the provider's returned length is REQUESTED, never
    // guaranteed (see services/music/elevenlabs-music-provider.js's own
    // header) — trim to the assigned span rather than pretend/loop.
    stages.push(`atrim=0:${duration}`);
  }
  if (typeof audioEvent.fadeIn === 'number' && audioEvent.fadeIn > 0) {
    stages.push(`afade=t=in:st=0:d=${audioEvent.fadeIn}`);
  }
  if (typeof audioEvent.fadeOut === 'number' && audioEvent.fadeOut > 0) {
    stages.push(`afade=t=out:st=${Math.max(0, duration - audioEvent.fadeOut)}:d=${audioEvent.fadeOut}`);
  }
  if (typeof audioEvent.volume === 'number' && audioEvent.volume !== 1) {
    stages.push(`volume=${audioEvent.volume}`);
  }
  stages.push(`adelay=${delayMs}|${delayMs}`);
  stages.push('apad');
  if (duckExpression) {
    stages.push(`volume=volume='${duckExpression}':eval=frame`);
  }

  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-af', stages.join(','), '-t', String(expectedDuration), '-ar', '48000', '-ac', '2', outPath],
    'FFMPEG_FAILED',
    `failed to build ${audioEvent.type} segment from "${sourcePath}" at startTime ${audioEvent.startTime}`
  );
}

// Sums N already-full-length segments into one track. Identical
// implementation to Phase 1/2's own narration-only mixNarrationSegments()
// — generalized to any segment, never behaviorally changed for the
// narration-only case (every segment is already `duration=first`-safe
// because every input is already exactly expectedDuration long).
function sumSegments(ffmpegPath, segmentPaths, outPath) {
  if (segmentPaths.length === 1) {
    return run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', segmentPaths[0], '-c:a', 'pcm_s16le', outPath], 'FFMPEG_FAILED', 'failed to normalize the single audio track');
  }
  const inputArgs = segmentPaths.flatMap((p) => ['-i', p]);
  const filter = `amix=inputs=${segmentPaths.length}:duration=first:dropout_transition=0[aout]`;
  return run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs, '-filter_complex', filter, '-map', '[aout]', outPath], 'FFMPEG_FAILED', 'failed to mix audio tracks');
}

// Reads the real, measured mean_volume (dB) ffmpeg's own `volumedetect`
// filter reports for a file — spawnSync (not execFileSync) because
// `-f null -` always exits 0 and the value we need is on stderr, not
// something execFileSync's return value carries on success.
function analyzeMeanVolumeDb(ffmpegPath, filePath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30000 });
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return match ? Number(match[1]) : null;
}

// Part H — audio QA primitive: the real, ffmpeg-measured peak level (dB)
// of a file's audio stream, via ffmpeg's own `astats` filter — the
// "detectable through FFmpeg analysis" clipping signal Part H asks for.
// Non-fatal by construction (this function only measures; the caller
// decides what a high peak means) — real, ordinary narration audio can
// legitimately peak close to 0 dBFS without being broken, so this is
// exposed as a DIAGNOSTIC-producing detector (see video-assembly-
// service.js's own use of it), never a hidden hard gate here.
function analyzePeakLevelDb(ffmpegPath, filePath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-i', filePath, '-af', 'astats=metadata=0:reset=1', '-f', 'null', '-'], { timeout: 30000 });
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  const matches = [...stderr.matchAll(/Peak level dB:\s*(-?\d+(?:\.\d+)?|-?inf)/gi)];
  if (matches.length === 0) return null;
  const values = matches.map((m) => (m[1].toLowerCase() === '-inf' ? -Infinity : m[1].toLowerCase() === 'inf' ? Infinity : Number(m[1])));
  return Math.max(...values);
}

// Part F — ONE final pass on the already-summed mix: a single broadband
// gain adjustment toward TARGET_MEAN_VOLUME_DB (measured, not guessed —
// analyzeMeanVolumeDb reads the real file), clamped to
// +/-MAX_GAIN_ADJUST_DB so an unusual input never swings wildly, then a
// true-peak limiter as a hard, deterministic, duration-preserving ceiling
// against clipping. Never applied per-source (Part F: "avoid repeatedly
// normalising individual tracks") — this is the only place either filter
// appears anywhere in this pipeline.
function applyFinalLoudness(ffmpegPath, inputPath, outputPath) {
  const meanDb = analyzeMeanVolumeDb(ffmpegPath, inputPath);
  let gainDb = 0;
  if (typeof meanDb === 'number' && Number.isFinite(meanDb)) {
    gainDb = Math.max(-MAX_GAIN_ADJUST_DB, Math.min(MAX_GAIN_ADJUST_DB, TARGET_MEAN_VOLUME_DB - meanDb));
  }
  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-af', `volume=${gainDb}dB,alimiter=limit=${LIMITER_CEILING}:attack=5:release=50`, '-ar', '48000', '-ac', '2', outputPath],
    'FFMPEG_FAILED',
    'failed to apply final loudness control to the mixed audio'
  );
}

// ---------------------------------------------------------------------------
// Public entry point.
//   resolvedAudio — [{ audioEvent, absolutePath }], exactly what services/
//     video-assembly-service.js's own validateAudioEvent() loop already
//     produces (type-neutral; unchanged by this stage).
//   expectedDuration — the timeline's own total length (Part 12's existing
//     concept), reused verbatim — this file invents no second duration.
//   workDir — a caller-owned scratch directory (assembly's own workDir);
//     this file writes intermediate segments there and never cleans it up
//     itself (assembly's own `finally` block already does).
//   ffmpegPath — resolved by the caller (assembly's own resolveFfmpeg());
//     never re-resolved here, avoiding a second PATH-lookup implementation.
// ---------------------------------------------------------------------------
function mixAudioEvents({ resolvedAudio, expectedDuration, workDir, ffmpegPath, duckingConfig = DEFAULT_DUCKING_CONFIG } = {}) {
  const entries = Array.isArray(resolvedAudio) ? resolvedAudio : [];
  if (entries.length === 0) {
    return { ok: true, path: null };
  }

  const narrationWindows = entries
    .filter(({ audioEvent }) => audioEvent.type === 'NARRATION')
    .map(({ audioEvent }) => ({ audioEventId: audioEvent.audioEventId, start: audioEvent.startTime, end: audioEvent.startTime + audioEvent.duration }));
  const mergedNarrationWindows = mergeNarrationWindows(narrationWindows);

  const segmentPaths = [];
  let hasNonNarration = false;
  let index = 0;
  for (const { audioEvent, absolutePath } of entries) {
    if (!SEGMENT_BUILDERS.has(audioEvent.type)) {
      return { ok: false, error: diag('UNSUPPORTED_AUDIO_TYPE', `AudioEvent "${audioEvent.audioEventId}" has type "${audioEvent.type}", which the mixer does not yet render (only NARRATION/MUSIC are implemented)`) };
    }

    let duckExpression = null;
    if (audioEvent.type === 'MUSIC') {
      hasNonNarration = true;
      // duckingTarget (schemas/audio-schema.js's own, pre-existing field)
      // narrows ducking to one specific narration event when a caller
      // sets it; the default (null, every real narration event today)
      // ducks under ALL narration windows in this same mix.
      const relevantWindows = audioEvent.duckingTarget
        ? mergeNarrationWindows(narrationWindows.filter((w) => w.audioEventId === audioEvent.duckingTarget))
        : mergedNarrationWindows;
      if (relevantWindows.length > 0) {
        duckExpression = buildDuckVolumeExpression(relevantWindows, duckingConfig);
      }
    } else if (audioEvent.type !== 'NARRATION') {
      hasNonNarration = true;
    }

    const segPath = path.join(workDir, `audio-${index}-${audioEvent.type.toLowerCase()}.wav`);
    const built = buildEventSegment(ffmpegPath, absolutePath, audioEvent, expectedDuration, duckExpression, segPath);
    if (!built.ok) return built;
    segmentPaths.push(segPath);
    index += 1;
  }

  const rawMixPath = path.join(workDir, 'audio-mix-raw.wav');
  const summed = sumSegments(ffmpegPath, segmentPaths, rawMixPath);
  if (!summed.ok) return summed;

  if (!hasNonNarration) {
    // Pure-NARRATION mix — Phase 1/2's own existing, frozen scenario.
    // Never touched by final loudness; see file header.
    return { ok: true, path: rawMixPath };
  }

  const finalPath = path.join(workDir, 'audio-mix-final.wav');
  const loud = applyFinalLoudness(ffmpegPath, rawMixPath, finalPath);
  if (!loud.ok) return loud;
  return { ok: true, path: finalPath };
}

module.exports = {
  mixAudioEvents,
  buildEventSegment, // exported for direct testing (Part E: gain/fade must be verifiably consumed, not left as dead schema) — a global final-loudness pass can otherwise mask a solo track's own gain difference; see test/audio-mixer-service.test.js's own comment.
  mergeNarrationWindows,
  computeDuckGainAtTime,
  buildDuckVolumeExpression,
  analyzePeakLevelDb,
  analyzeMeanVolumeDb,
  DEFAULT_DUCKING_CONFIG,
  TARGET_MEAN_VOLUME_DB,
  MAX_GAIN_ADJUST_DB,
  LIMITER_CEILING,
  CLIPPING_PEAK_THRESHOLD_DB,
};
