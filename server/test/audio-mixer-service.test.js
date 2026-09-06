// Tests for services/audio-mixer-service.js — PHASE 3D.
//
// Two kinds of tests, deliberately kept separate:
//   1. Pure duck-math (mergeNarrationWindows/computeDuckGainAtTime/
//      buildDuckVolumeExpression) — no ffmpeg, no I/O, exact numeric
//      assertions, matching this file's own "deterministic" design goal.
//   2. Real ffmpeg integration — real tone fixtures (mirrors this
//      codebase's own existing convention, e.g. test/video-assembly-
//      pipeline.test.js's own lavfi-generated sources), real measured
//      output via ffmpeg's own astats/volumedetect filters.
//
// NOTE on gain/fade tests (Part E): they measure buildEventSegment()'s
// own output directly, BEFORE the final-loudness stage — Part F's own
// broadband auto-normalization targets a fixed mean level for the WHOLE
// mix, which can otherwise level-match two differently-gained SOLO tracks
// back to the same measured loudness and hide the very difference being
// tested. Ducking/fade RELATIVE-timing tests (within one already-mixed
// file) are unaffected by this since a constant broadband shift preserves
// relative differences between two windows of the SAME file — those are
// tested against the real, full mixAudioEvents() output.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const audioMixerService = require('../services/audio-mixer-service');
const { createAudioEvent } = require('../schemas/audio-schema');

const { mergeNarrationWindows, computeDuckGainAtTime, buildDuckVolumeExpression, mixAudioEvents, buildEventSegment, analyzePeakLevelDb } = audioMixerService;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-audio-mixer-'));
}

function buildTone(outPath, { frequency = 440, durationSeconds = 1, gainDb = 0 } = {}) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${durationSeconds}`, '-af', `volume=${gainDb}dB`, '-ar', '48000', '-ac', '2', outPath]);
}

function buildSilence(outPath, durationSeconds) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(durationSeconds), outPath]);
}

function measureMeanVolumeDb(filePath, { startSeconds, durationSeconds } = {}) {
  const args = ['-hide_banner', '-nostats'];
  if (typeof startSeconds === 'number') args.push('-ss', String(startSeconds));
  args.push('-i', filePath);
  if (typeof durationSeconds === 'number') args.push('-t', String(durationSeconds));
  args.push('-af', 'volumedetect', '-f', 'null', '-');
  const result = spawnSync('ffmpeg', args, { timeout: 30000 });
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return match ? Number(match[1]) : null;
}

function ffprobeAudio(filePath) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', filePath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  const parsed = JSON.parse(raw);
  return (parsed.streams || []).find((s) => s.codec_type === 'audio') || null;
}

// ===========================================================================
// A. mergeNarrationWindows — pure
// ===========================================================================

test('A1. mergeNarrationWindows sorts and merges overlapping/touching windows', () => {
  const merged = mergeNarrationWindows([
    { start: 5, end: 8 },
    { start: 0, end: 2 },
    { start: 1.5, end: 4 }, // overlaps [0,2)
    { start: 8, end: 9 }, // touches [5,8)
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 4 },
    { start: 5, end: 9 },
  ]);
});

test('A2. mergeNarrationWindows drops degenerate/invalid entries', () => {
  assert.deepEqual(mergeNarrationWindows([{ start: 3, end: 3 }, { start: 5, end: 2 }, null, {}]), []);
  assert.deepEqual(mergeNarrationWindows([]), []);
});

// ===========================================================================
// B. computeDuckGainAtTime — pure, exact numeric assertions
// ===========================================================================

test('B1. gain is 1 (no ducking) with no windows, or well outside any window', () => {
  const config = { attackSeconds: 0.5, releaseSeconds: 0.5, duckGainDb: -12 };
  assert.equal(computeDuckGainAtTime(5, [], config), 1);
  assert.equal(computeDuckGainAtTime(-1, [{ start: 2, end: 4 }], config), 1);
  assert.equal(computeDuckGainAtTime(10, [{ start: 2, end: 4 }], config), 1);
});

test('B2. gain reaches the configured duck level, held for the full window', () => {
  const config = { attackSeconds: 0.5, releaseSeconds: 0.5, duckGainDb: -12 };
  const duckLevel = Math.pow(10, -12 / 20);
  const gain = computeDuckGainAtTime(3, [{ start: 2, end: 4 }], config); // mid-window, well past attack
  assert.ok(Math.abs(gain - duckLevel) < 1e-9, `expected ~${duckLevel}, got ${gain}`);
});

test('B3. attack/release are linear ramps between 1 and the duck level', () => {
  const config = { attackSeconds: 1, releaseSeconds: 1, duckGainDb: -12 };
  const duckLevel = Math.pow(10, -12 / 20);
  // halfway through the 1s attack starting at t=2
  const midAttack = computeDuckGainAtTime(2.5, [{ start: 2, end: 4 }], config);
  assert.ok(Math.abs(midAttack - (1 + (duckLevel - 1) * 0.5)) < 1e-9);
  // halfway through the 1s release starting at t=4
  const midRelease = computeDuckGainAtTime(4.5, [{ start: 2, end: 4 }], config);
  assert.ok(Math.abs(midRelease - (duckLevel + (1 - duckLevel) * 0.5)) < 1e-9);
});

test('B4. overlapping windows combine via the LOWEST (most-ducked) gain, never summed/multiplied', () => {
  const config = { attackSeconds: 0.1, releaseSeconds: 0.1, duckGainDb: -12 };
  const duckLevel = Math.pow(10, -12 / 20);
  const gain = computeDuckGainAtTime(3, [{ start: 2, end: 4 }, { start: 2.5, end: 3.5 }], config);
  assert.ok(Math.abs(gain - duckLevel) < 1e-9, 'must not go below a single window\'s own duck level');
});

// ===========================================================================
// C. buildDuckVolumeExpression — structural (the ffmpeg-facing rendering
// of the SAME formula B verifies numerically)
// ===========================================================================

test('C1. buildDuckVolumeExpression is the identity "1" with no windows', () => {
  assert.equal(buildDuckVolumeExpression([]), '1');
});

test('C2. buildDuckVolumeExpression embeds each window\'s real boundaries and uses between()/min() — never a hardcoded/wrong window', () => {
  const expr = buildDuckVolumeExpression([{ start: 2, end: 4 }], { attackSeconds: 0.5, releaseSeconds: 0.5, duckGainDb: -12 });
  assert.match(expr, /between\(t,2,2\.5\)/);
  assert.match(expr, /between\(t,2\.5,4\)/);
  assert.match(expr, /between\(t,4,4\.5\)/);
  const expr2 = buildDuckVolumeExpression([{ start: 2, end: 4 }, { start: 10, end: 12 }], { attackSeconds: 0.5, releaseSeconds: 0.5, duckGainDb: -12 });
  assert.match(expr2, /min\(/);
  assert.match(expr2, /between\(t,10,10\.5\)/);
});

// ===========================================================================
// D. mixAudioEvents — real ffmpeg integration
// ===========================================================================

test('D1. no resolved audio -> ok, no file produced', () => {
  const result = mixAudioEvents({ resolvedAudio: [], expectedDuration: 5, workDir: tmpDir(), ffmpegPath: 'ffmpeg' });
  assert.equal(result.ok, true);
  assert.equal(result.path, null);
});

test('D2. narration only (single event) produces a real, correct-duration audio file — unchanged behavior for Phase 1/2\'s own scenario', () => {
  const dir = tmpDir();
  const narrPath = path.join(dir, 'narr.wav');
  buildTone(narrPath, { durationSeconds: 2 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', startTime: 1, duration: 2 });

  const result = mixAudioEvents({ resolvedAudio: [{ audioEvent: narrationEvent, absolutePath: narrPath }], expectedDuration: 5, workDir: dir, ffmpegPath: 'ffmpeg' });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.path));
  const stream = ffprobeAudio(result.path);
  assert.ok(stream);
  assert.ok(Math.abs(Number(stream.duration) - 5) < 0.2);
});

test('D3. music only (no narration) mixes without ducking and still applies final loudness (a non-NARRATION event is present)', () => {
  const dir = tmpDir();
  const musicPath = path.join(dir, 'music.wav');
  buildTone(musicPath, { durationSeconds: 6, gainDb: -6 });
  const musicEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 6 });

  const result = mixAudioEvents({ resolvedAudio: [{ audioEvent: musicEvent, absolutePath: musicPath }], expectedDuration: 6, workDir: dir, ffmpegPath: 'ffmpeg' });
  assert.equal(result.ok, true);
  const stream = ffprobeAudio(result.path);
  assert.ok(stream);
  assert.ok(Math.abs(Number(stream.duration) - 6) < 0.2);
  const peak = analyzePeakLevelDb('ffmpeg', result.path);
  assert.ok(typeof peak === 'number' && Number.isFinite(peak), 'final loudness must produce a real, measurable, non-clipping level');
  assert.ok(peak < 0, 'the limiter ceiling must keep the final peak below 0 dBFS');
});

test('D4. narration + music together both survive into the final mixed file', () => {
  const dir = tmpDir();
  const narrPath = path.join(dir, 'narr.wav');
  const musicPath = path.join(dir, 'music.wav');
  buildTone(narrPath, { frequency: 300, durationSeconds: 2 });
  buildTone(musicPath, { frequency: 3000, durationSeconds: 6, gainDb: -10 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', startTime: 1, duration: 2 });
  const musicEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 6 });

  const result = mixAudioEvents({
    resolvedAudio: [
      { audioEvent: narrationEvent, absolutePath: narrPath },
      { audioEvent: musicEvent, absolutePath: musicPath },
    ],
    expectedDuration: 6,
    workDir: dir,
    ffmpegPath: 'ffmpeg',
  });
  assert.equal(result.ok, true);
  const stream = ffprobeAudio(result.path);
  assert.ok(stream);
  assert.ok(Math.abs(Number(stream.duration) - 6) < 0.2);
  // there IS real signal energy in the output (not silence)
  const overall = measureMeanVolumeDb(result.path);
  assert.ok(typeof overall === 'number' && overall > -90);
});

test('D5. MUSIC ducks measurably under NARRATION, and recovers after — deterministic, timeline-derived (no sidechain level-dependence)', () => {
  const dir = tmpDir();
  const narrPath = path.join(dir, 'narr-silent.wav');
  const musicPath = path.join(dir, 'music-tone.wav');
  buildSilence(narrPath, 2); // silent "narration" — isolates the MEASURED window to the music's own ducked level
  buildTone(musicPath, { frequency: 1000, durationSeconds: 6, gainDb: -6 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', startTime: 2, duration: 2 }); // window [2,4)
  const musicEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 6 });

  const result = mixAudioEvents({
    resolvedAudio: [
      { audioEvent: narrationEvent, absolutePath: narrPath },
      { audioEvent: musicEvent, absolutePath: musicPath },
    ],
    expectedDuration: 6,
    workDir: dir,
    ffmpegPath: 'ffmpeg',
    duckingConfig: { attackSeconds: 0.3, releaseSeconds: 0.3, duckGainDb: -12 },
  });
  assert.equal(result.ok, true);

  const baseline = measureMeanVolumeDb(result.path, { startSeconds: 0, durationSeconds: 1 }); // before narration
  const ducked = measureMeanVolumeDb(result.path, { startSeconds: 2.5, durationSeconds: 1 }); // solidly inside the held-duck portion
  const recovered = measureMeanVolumeDb(result.path, { startSeconds: 5, durationSeconds: 1 }); // well after release completes

  assert.ok(baseline - ducked > 8, `expected ~12dB of ducking, measured baseline=${baseline} ducked=${ducked}`);
  assert.ok(Math.abs(recovered - baseline) < 3, `expected recovery back near baseline, measured recovered=${recovered} baseline=${baseline}`);
});

test('D6. music plays at full level when no narration is present at all (Part D: "Music plays normally when narration is absent")', () => {
  const dir = tmpDir();
  const musicPath = path.join(dir, 'music.wav');
  buildTone(musicPath, { frequency: 1000, durationSeconds: 4, gainDb: -6 });
  const musicEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 4 });

  const result = mixAudioEvents({ resolvedAudio: [{ audioEvent: musicEvent, absolutePath: musicPath }], expectedDuration: 4, workDir: dir, ffmpegPath: 'ffmpeg' });
  const early = measureMeanVolumeDb(result.path, { startSeconds: 0.5, durationSeconds: 1 });
  const late = measureMeanVolumeDb(result.path, { startSeconds: 2.5, durationSeconds: 1 });
  assert.ok(Math.abs(early - late) < 1, `expected a flat, un-ducked level throughout; got early=${early} late=${late}`);
});

test('D7. UNSUPPORTED_AUDIO_TYPE is a structured failure, never a crash or silent drop (SFX/AMBIENCE not implemented yet — Part C)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'x.wav');
  buildSilence(p, 1);
  const sfxEvent = createAudioEvent({ type: 'SFX', startTime: 0, duration: 1 });
  const result = mixAudioEvents({ resolvedAudio: [{ audioEvent: sfxEvent, absolutePath: p }], expectedDuration: 1, workDir: dir, ffmpegPath: 'ffmpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSUPPORTED_AUDIO_TYPE');
});

test('D8. overlapping same-type events sum rather than crash or silently drop one', () => {
  const dir = tmpDir();
  const p1 = path.join(dir, 'n1.wav');
  const p2 = path.join(dir, 'n2.wav');
  buildTone(p1, { frequency: 400, durationSeconds: 2, gainDb: -10 });
  buildTone(p2, { frequency: 800, durationSeconds: 2, gainDb: -10 });
  const e1 = createAudioEvent({ type: 'NARRATION', startTime: 0, duration: 2 });
  const e2 = createAudioEvent({ type: 'NARRATION', startTime: 1, duration: 2 }); // overlaps [1,2)
  const result = mixAudioEvents({
    resolvedAudio: [
      { audioEvent: e1, absolutePath: p1 },
      { audioEvent: e2, absolutePath: p2 },
    ],
    expectedDuration: 3,
    workDir: dir,
    ffmpegPath: 'ffmpeg',
  });
  assert.equal(result.ok, true);
  const overlapRegion = measureMeanVolumeDb(result.path, { startSeconds: 1.2, durationSeconds: 0.6 });
  const soloRegion = measureMeanVolumeDb(result.path, { startSeconds: 0.2, durationSeconds: 0.6 });
  assert.ok(overlapRegion > soloRegion, `two summed tones must measure louder than one alone; overlap=${overlapRegion} solo=${soloRegion}`);
});

test('D9. silence between events stays silent — no phantom audio injected between placed events', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'n.wav');
  buildTone(p, { durationSeconds: 1, gainDb: -6 });
  const e = createAudioEvent({ type: 'NARRATION', startTime: 0, duration: 1 });
  const result = mixAudioEvents({ resolvedAudio: [{ audioEvent: e, absolutePath: p }], expectedDuration: 5, workDir: dir, ffmpegPath: 'ffmpeg' });
  const gapLevel = measureMeanVolumeDb(result.path, { startSeconds: 2, durationSeconds: 2 });
  assert.ok(gapLevel === null || gapLevel < -60, `the gap between/after events must be silent (or near-digital-silence); measured ${gapLevel}`);
});

// ===========================================================================
// E. buildEventSegment — gain/fade consumption (Part E), measured
// BEFORE the final-loudness stage (see file header for why)
// ===========================================================================

test('E1. volume !== 1 is actually applied to the built segment (measurably quieter, not dead schema)', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src.wav');
  buildTone(src, { durationSeconds: 2 });

  const fullEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 2, volume: 1 });
  const halfEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 2, volume: 0.5 });
  const fullOut = path.join(dir, 'full.wav');
  const halfOut = path.join(dir, 'half.wav');
  assert.equal(buildEventSegment('ffmpeg', src, fullEvent, 2, null, fullOut).ok, true);
  assert.equal(buildEventSegment('ffmpeg', src, halfEvent, 2, null, halfOut).ok, true);

  const fullDb = measureMeanVolumeDb(fullOut);
  const halfDb = measureMeanVolumeDb(halfOut);
  // volume=0.5 is a ~6.02dB reduction (20*log10(0.5))
  assert.ok(Math.abs(fullDb - halfDb - 6.02) < 1, `expected ~6dB difference; full=${fullDb} half=${halfDb}`);
});

test('E2. fadeIn/fadeOut are actually applied — quieter at the very start/end than in the middle', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src.wav');
  buildTone(src, { durationSeconds: 4 });
  const event = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 4, fadeIn: 1, fadeOut: 1 });
  const out = path.join(dir, 'faded.wav');
  assert.equal(buildEventSegment('ffmpeg', src, event, 4, null, out).ok, true);

  const start = measureMeanVolumeDb(out, { startSeconds: 0, durationSeconds: 0.3 });
  const middle = measureMeanVolumeDb(out, { startSeconds: 1.8, durationSeconds: 0.4 });
  const end = measureMeanVolumeDb(out, { startSeconds: 3.7, durationSeconds: 0.3 });
  assert.ok(middle - start > 3, `fade-in must make the very start measurably quieter than the middle; start=${start} middle=${middle}`);
  assert.ok(middle - end > 3, `fade-out must make the very end measurably quieter than the middle; end=${end} middle=${middle}`);
});

test('E3. a NARRATION event never gets an atrim stage — its own real, measured length is trusted verbatim (Part C: "no unnecessary processing that damages speech")', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src.wav');
  buildTone(src, { durationSeconds: 2 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', startTime: 0, duration: 2 });
  const out = path.join(dir, 'narr-seg.wav');
  assert.equal(buildEventSegment('ffmpeg', src, narrationEvent, 2, null, out).ok, true);
  const stream = ffprobeAudio(out);
  assert.ok(Math.abs(Number(stream.duration) - 2) < 0.1);
});

test('E4. a MUSIC event longer than its assigned span is TRIMMED, never looped (Part B: duration is requested, not guaranteed)', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'long-music.wav');
  buildTone(src, { durationSeconds: 5 }); // real source runs longer than the assigned 2s span
  const musicEvent = createAudioEvent({ type: 'MUSIC', startTime: 0, duration: 2 });
  const out = path.join(dir, 'trimmed.wav');
  assert.equal(buildEventSegment('ffmpeg', src, musicEvent, 5, null, out).ok, true); // expectedDuration=5 (whole timeline), but the event's own content must stop at 2s
  const soundAt1 = measureMeanVolumeDb(out, { startSeconds: 0.5, durationSeconds: 0.5 });
  const silenceAt3 = measureMeanVolumeDb(out, { startSeconds: 3, durationSeconds: 1 });
  assert.ok(typeof soundAt1 === 'number' && soundAt1 > -50);
  assert.ok(silenceAt3 === null || silenceAt3 < -60, `content past the assigned 2s span must be silence, not the looped/continued source; measured ${silenceAt3}`);
});
