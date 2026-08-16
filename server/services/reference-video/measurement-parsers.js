// measurement-parsers.js
//
// INT-1B — PURE parsing functions: turn raw FFmpeg/ffprobe stdout/stderr
// text into plain JS data. Nothing in this file spawns a process, touches
// the filesystem, or does I/O of any kind — every function here is a pure
// string-in/data-out transform, testable with fixed, real, captured FFmpeg
// output (Part 21's "deterministic fixture tests") without needing FFmpeg
// installed in the test environment at all.
//
// The orchestrator (services/reference-video-measurement-service.js) is the
// only file that actually spawns ffmpeg/ffprobe; it hands this file the raw
// text those processes printed.

// FFmpeg's scdet filter (with `,metadata=print:file=-`) prints one block
// per frame:
//   frame:12   pts:12800   pts_time:0.8
//   lavfi.scd.mafd=5.272
//   lavfi.scd.score=1.613
// A cut is any frame whose score exceeds `threshold` — this function does
// the comparison itself (never trusting FFmpeg's own optional
// `lavfi.scd.time` line, which behaves identically but isn't documented
// as stable across FFmpeg versions).
function parseScdetOutput(rawText, threshold) {
  const lines = String(rawText || '').split('\n');
  const frames = [];
  let currentTime = null;
  for (const line of lines) {
    const timeMatch = line.match(/pts_time:([\d.]+)/);
    if (timeMatch) {
      currentTime = Number(timeMatch[1]);
      continue;
    }
    const scoreMatch = line.match(/lavfi\.scd\.score=([\d.]+)/);
    if (scoreMatch && currentTime !== null) {
      frames.push({ time: currentTime, score: Number(scoreMatch[1]) });
    }
  }
  const cutTimes = frames.filter((f) => f.score > threshold).map((f) => f.time);
  return { frames, cutTimes };
}

// FFmpeg's silencedetect filter prints, per detected interval:
//   [silencedetect @ 0x...] silence_start: 1.23456
//   [silencedetect @ 0x...] silence_end: 2.34567 | silence_duration: 1.11111
function parseSilencedetectOutput(rawText) {
  const text = String(rawText || '');
  const starts = [...text.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const intervals = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i += 1) {
    intervals.push({ startTime: starts[i], endTime: ends[i], duration: Number((ends[i] - starts[i]).toFixed(6)) });
  }
  return intervals;
}

// FFmpeg's volumedetect filter prints:
//   [Parsed_volumedetect_0 @ 0x...] mean_volume: -23.9 dB
//   [Parsed_volumedetect_0 @ 0x...] max_volume: -6.5 dB
function parseVolumedetectOutput(rawText) {
  const text = String(rawText || '');
  const mean = text.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const max = text.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return {
    meanVolumeDb: mean ? Number(mean[1]) : null,
    maxVolumeDb: max ? Number(max[1]) : null,
  };
}

// FFmpeg's signalstats filter (with `,metadata=print:file=-`) prints, per frame:
//   frame:5    pts:5328    pts_time:0.333
//   lavfi.signalstats.YAVG=112.4
//   lavfi.signalstats.YDIF=3.2   (absent on frame 0 — no previous frame to diff against)
function parseSignalstatsOutput(rawText) {
  const lines = String(rawText || '').split('\n');
  const frames = [];
  let current = null;
  for (const line of lines) {
    const timeMatch = line.match(/pts_time:([\d.]+)/);
    if (timeMatch) {
      if (current) frames.push(current);
      current = { time: Number(timeMatch[1]), luminanceMean: null, frameDifference: null };
      continue;
    }
    if (!current) continue;
    const yavgMatch = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (yavgMatch) current.luminanceMean = Number(yavgMatch[1]);
    const ydifMatch = line.match(/lavfi\.signalstats\.YDIF=([\d.]+)/);
    if (ydifMatch) current.frameDifference = Number(ydifMatch[1]);
  }
  if (current) frames.push(current);
  return frames;
}

module.exports = {
  parseScdetOutput,
  parseSilencedetectOutput,
  parseVolumedetectOutput,
  parseSignalstatsOutput,
};
