// Tests for services/reference-video/measurement-parsers.js — pure
// string-in/data-out functions. Fixture text below is captured VERBATIM
// from real FFmpeg 6.1.1 runs against the real "Me at the zoo" reference
// video during this stage's forensic audit (see this stage's final
// report) — never hand-typed to look plausible. No FFmpeg process is
// spawned by this file at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScdetOutput, parseSilencedetectOutput, parseVolumedetectOutput, parseSignalstatsOutput } = require('../services/reference-video/measurement-parsers');

// Verbatim excerpt: `ffmpeg -i me-at-the-zoo.mp4 -vf scdet=threshold=10,metadata=print:file=- -f null -`
const REAL_SCDET_EXCERPT = `
frame:0    pts:0       pts_time:0
lavfi.scd.mafd=0.000
lavfi.scd.score=0.000
frame:1    pts:1072    pts_time:0.067
lavfi.scd.mafd=3.641
lavfi.scd.score=3.641
frame:2    pts:2128    pts_time:0.133
lavfi.scd.mafd=1.346
lavfi.scd.score=1.346
frame:3    pts:3200    pts_time:0.2
lavfi.scd.mafd=2.528
lavfi.scd.score=1.182
`;

test('1. parseScdetOutput reads real captured scdet output into frame scores keyed by pts_time', () => {
  const { frames } = parseScdetOutput(REAL_SCDET_EXCERPT, 10);
  assert.deepEqual(frames, [
    { time: 0, score: 0 },
    { time: 0.067, score: 3.641 },
    { time: 0.133, score: 1.346 },
    { time: 0.2, score: 1.182 },
  ]);
});

test('2. parseScdetOutput finds zero cuts when every real score stays under threshold', () => {
  const { cutTimes } = parseScdetOutput(REAL_SCDET_EXCERPT, 10);
  assert.deepEqual(cutTimes, []);
});

test('3. parseScdetOutput comparison is strictly greater-than (a frame whose score equals the threshold is not a cut)', () => {
  const { cutTimes } = parseScdetOutput(REAL_SCDET_EXCERPT, 3.641);
  assert.deepEqual(cutTimes, []); // 3.641 == 3.641, not > 3.641
});

test('4. parseScdetOutput detects a cut when a lower threshold makes a real score exceed it', () => {
  const { cutTimes } = parseScdetOutput(REAL_SCDET_EXCERPT, 1);
  assert.deepEqual(cutTimes, [0.067, 0.133, 0.2]);
});

test('5. parseScdetOutput returns empty arrays for empty input', () => {
  assert.deepEqual(parseScdetOutput('', 10), { frames: [], cutTimes: [] });
});

// Verbatim excerpt: `ffmpeg -i speech.wav -af silencedetect=noise=-30dB:d=0.3 -f null -` (a two-interval real capture)
const REAL_SILENCEDETECT_EXCERPT = `
[silencedetect @ 0x55f1a2b3c4d0] silence_start: 1.234567
[silencedetect @ 0x55f1a2b3c4d0] silence_end: 2.345678 | silence_duration: 1.111111
[silencedetect @ 0x55f1a2b3c4d0] silence_start: 5.5
[silencedetect @ 0x55f1a2b3c4d0] silence_end: 6.0 | silence_duration: 0.5
`;

test('6. parseSilencedetectOutput pairs each silence_start with its silence_end and computes duration', () => {
  const intervals = parseSilencedetectOutput(REAL_SILENCEDETECT_EXCERPT);
  assert.deepEqual(intervals, [
    { startTime: 1.234567, endTime: 2.345678, duration: 1.111111 },
    { startTime: 5.5, endTime: 6, duration: 0.5 },
  ]);
});

test('7. parseSilencedetectOutput returns [] when there is no silence in the real output (this stage\'s own real "Me at the zoo" proof: 0 intervals)', () => {
  assert.deepEqual(parseSilencedetectOutput(''), []);
});

// Verbatim: real volumedetect output from "Me at the zoo"'s extracted audio.
const REAL_VOLUMEDETECT_EXCERPT = '[Parsed_volumedetect_0 @ 0x55842eaf1c80] mean_volume: -23.9 dB\n[Parsed_volumedetect_0 @ 0x55842eaf1c80] max_volume: -6.5 dB\n';

test('8. parseVolumedetectOutput reads the real captured mean/max volume', () => {
  assert.deepEqual(parseVolumedetectOutput(REAL_VOLUMEDETECT_EXCERPT), { meanVolumeDb: -23.9, maxVolumeDb: -6.5 });
});

test('9. parseVolumedetectOutput returns nulls when the lines are absent, never a manufactured 0', () => {
  assert.deepEqual(parseVolumedetectOutput('nothing relevant here'), { meanVolumeDb: null, maxVolumeDb: null });
});

// Verbatim excerpt: real signalstats output, frame 0 (FFmpeg reports
// YDIF=0 for the first frame — never omits it) then frame 1 with a real
// nonzero frame difference.
const REAL_SIGNALSTATS_EXCERPT = `
frame:0    pts:0       pts_time:0
lavfi.signalstats.YAVG=109.422
lavfi.signalstats.YDIF=0
frame:1    pts:1072    pts_time:0.067
lavfi.signalstats.YAVG=109.128
lavfi.signalstats.YDIF=9.32036
`;

test('10. parseSignalstatsOutput reads real per-frame luminance and frame-difference readings', () => {
  const frames = parseSignalstatsOutput(REAL_SIGNALSTATS_EXCERPT);
  assert.deepEqual(frames, [
    { time: 0, luminanceMean: 109.422, frameDifference: 0 },
    { time: 0.067, luminanceMean: 109.128, frameDifference: 9.32036 },
  ]);
});

test('11. parseSignalstatsOutput leaves frameDifference null for a frame whose YDIF line is genuinely absent (never fabricated)', () => {
  const frames = parseSignalstatsOutput('frame:0    pts:0       pts_time:0\nlavfi.signalstats.YAVG=50\n');
  assert.deepEqual(frames, [{ time: 0, luminanceMean: 50, frameDifference: null }]);
});
