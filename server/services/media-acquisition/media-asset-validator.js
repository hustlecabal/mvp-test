// media-asset-validator.js
//
// Validates an ALREADY-DOWNLOADED media file before
// services/media-acquisition-service.js is allowed to register it as an
// Asset. Never invents a value it cannot determine — same discipline
// schemas/broll-schema.js's own header already established ("no media
// metadata extraction (ffprobe/ffmpeg/dimension detection) exists
// anywhere in this repository" was true before this file; this file is
// the first place real dimension/duration extraction is added, and it
// stays honest about what it can and cannot verify per format — see
// validateImage()'s own comment below).
//
// IMAGE validation reads the file's own magic bytes via the EXISTING
// services/asset-storage.js sniffer (never a second, competing format
// detector) plus a real, dependency-free PNG IHDR parse for width/height
// (PNG's dimensions sit at a fixed byte offset — no image library needed).
// JPEG/GIF/WEBP dimensions are NOT re-derived from bytes (no image
// library is a dependency of this project); for those formats, width/
// height come from whatever the acquisition candidate already reported
// (a stock provider's own metadata), exactly like schemas/broll-
// schema.js's own media.duration/width/height fields are allowed to stay
// as already-known, never re-derived, information.
//
// VIDEO validation reuses the EXACT ffprobe + ffmpeg decode-integrity
// pattern services/renderers/hyperframes-renderer.js's own
// ffprobeValidate() already established (same flags, same two-step
// probe-then-decode discipline) — never a second, divergent ffprobe
// invocation shape. When ffprobe/ffmpeg cannot be located on PATH, this
// returns a distinct FFPROBE_UNAVAILABLE outcome — never silently
// treated as PASS or as REJECTED_INVALID; a genuine missing-capability is
// reported, never hidden, matching this codebase's own established
// discipline (see services/reference-video/apify-acquisition-provider.js's
// header for the same "report, don't hide" rule for a missing credential).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { sniffImageFormat } = require('../asset-storage');

function locateOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function computeChecksum(filePath) {
  const buffer = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// PNG stores width/height as two big-endian uint32s starting at byte 16
// (8-byte signature + 4-byte chunk length + 4-byte "IHDR" = 16), per the
// PNG spec — a fixed, documented offset, not a heuristic.
function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// input: filePath, { minWidth, minHeight, candidateWidth, candidateHeight }
//   candidateWidth/candidateHeight — the dimensions the acquisition
//   CANDIDATE reported (from the provider's own search response), used as
//   the known dimensions for formats this validator cannot parse itself
//   (JPEG/GIF/WEBP) — never silently trusted for PNG, where the real bytes
//   are always checked instead.
function validateImage(filePath, { minWidth, minHeight, candidateWidth, candidateHeight } = {}) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, code: 'FILE_NOT_FOUND', message: `no file at "${filePath}"` };
  }
  const sizeBytes = fs.statSync(filePath).size;
  if (sizeBytes === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: 'downloaded file is empty' };
  }
  const buffer = fs.readFileSync(filePath);
  const format = sniffImageFormat(buffer);
  if (!format) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', message: 'file is not a recognized image format (PNG, JPEG, GIF, or WEBP)' };
  }

  let width = null;
  let height = null;
  if (format.ext === '.png') {
    const dims = readPngDimensions(buffer);
    if (!dims) {
      return { ok: false, code: 'UNREADABLE_DIMENSIONS', message: 'PNG file is malformed — could not read IHDR dimensions' };
    }
    width = dims.width;
    height = dims.height;
  } else {
    // Not re-derived from bytes for this format (see file header) — the
    // candidate's own provider-reported dimensions are the known value,
    // or null if the candidate didn't report any.
    width = typeof candidateWidth === 'number' ? candidateWidth : null;
    height = typeof candidateHeight === 'number' ? candidateHeight : null;
  }

  if (typeof minWidth === 'number' || typeof minHeight === 'number') {
    if (width === null || height === null) {
      return { ok: false, code: 'DIMENSIONS_UNKNOWN', message: `a minimum dimension was requested but this format's (${format.ext}) real dimensions cannot be verified from the downloaded bytes` };
    }
    if (typeof minWidth === 'number' && width < minWidth) {
      return { ok: false, code: 'BELOW_MIN_WIDTH', message: `image width ${width} is below the required minimum ${minWidth}` };
    }
    if (typeof minHeight === 'number' && height < minHeight) {
      return { ok: false, code: 'BELOW_MIN_HEIGHT', message: `image height ${height} is below the required minimum ${minHeight}` };
    }
  }

  return { ok: true, format: format.ext.replace('.', ''), contentType: format.contentType, width, height, sizeBytes };
}

// input: filePath, { minDurationSeconds, maxDurationSeconds, minWidth, minHeight, ffprobePath, ffmpegPath }
function validateVideo(filePath, { minDurationSeconds, maxDurationSeconds, minWidth, minHeight, ffprobePath, ffmpegPath } = {}) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, code: 'FILE_NOT_FOUND', message: `no file at "${filePath}"` };
  }
  const sizeBytes = fs.statSync(filePath).size;
  if (sizeBytes === 0) {
    return { ok: false, code: 'EMPTY_FILE', message: 'downloaded file is empty' };
  }

  const resolvedFfprobe = ffprobePath || process.env.MEDIA_ACQUISITION_FFPROBE_PATH || locateOnPath('ffprobe');
  const resolvedFfmpeg = ffmpegPath || process.env.MEDIA_ACQUISITION_FFMPEG_PATH || locateOnPath('ffmpeg');
  if (!resolvedFfprobe || !resolvedFfmpeg) {
    return { ok: false, code: 'FFPROBE_UNAVAILABLE', message: 'ffprobe and/or ffmpeg were not found on PATH in this environment — video validation cannot run' };
  }

  let raw;
  try {
    raw = execFileSync(
      resolvedFfprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filePath],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString('utf8');
  } catch (error) {
    return { ok: false, code: 'FFPROBE_VALIDATION_FAILED', message: `ffprobe failed to run: ${error && error.message ? error.message : String(error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'FFPROBE_VALIDATION_FAILED', message: 'ffprobe returned unparseable output' };
  }
  const duration = parsed.format && Number(parsed.format.duration);
  const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  if (!videoStream) return { ok: false, code: 'FFPROBE_VALIDATION_FAILED', message: 'ffprobe found no video stream in the file' };
  if (!duration || duration <= 0) return { ok: false, code: 'FFPROBE_VALIDATION_FAILED', message: `ffprobe reported an invalid duration: ${JSON.stringify(parsed.format)}` };
  if (!videoStream.width || !videoStream.height) return { ok: false, code: 'FFPROBE_VALIDATION_FAILED', message: 'ffprobe reported invalid/missing dimensions' };
  if (!videoStream.codec_name) return { ok: false, code: 'FFPROBE_VALIDATION_FAILED', message: 'ffprobe reported no codec information' };

  if (typeof minDurationSeconds === 'number' && duration < minDurationSeconds) {
    return { ok: false, code: 'BELOW_MIN_DURATION', message: `video duration ${duration}s is below the required minimum ${minDurationSeconds}s` };
  }
  if (typeof maxDurationSeconds === 'number' && duration > maxDurationSeconds) {
    return { ok: false, code: 'ABOVE_MAX_DURATION', message: `video duration ${duration}s exceeds the required maximum ${maxDurationSeconds}s` };
  }
  if (typeof minWidth === 'number' && videoStream.width < minWidth) {
    return { ok: false, code: 'BELOW_MIN_WIDTH', message: `video width ${videoStream.width} is below the required minimum ${minWidth}` };
  }
  if (typeof minHeight === 'number' && videoStream.height < minHeight) {
    return { ok: false, code: 'BELOW_MIN_HEIGHT', message: `video height ${videoStream.height} is below the required minimum ${minHeight}` };
  }

  // Decode-integrity pass — never trust a non-zero exit code alone (same
  // discipline as hyperframes-renderer.js's own ffprobeValidate).
  try {
    execFileSync(resolvedFfmpeg, ['-v', 'error', '-i', filePath, '-f', 'null', '-'], { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, code: 'DECODE_FAILED', message: `decode validation failed: ${error && error.message ? error.message : String(error)}` };
  }

  return { ok: true, format: videoStream.codec_name, width: videoStream.width, height: videoStream.height, durationSeconds: duration, sizeBytes };
}

module.exports = { locateOnPath, computeChecksum, validateImage, validateVideo };
