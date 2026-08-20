// visual-technical-qc-service.js
//
// VISUAL WORLD, Part 20 — TECHNICAL QC, kept structurally separate from
// CREATIVE QC (services/visual-creative-qc-service.js). This file answers
// only "is this a valid, decodable media file" — never "does it look
// right." Mirrors services/renderers/hyperframes-renderer.js's own
// ffprobeValidate() exactly (same tool, same flags, same never-trust-
// exit-code-alone discipline) — extracted here because that check
// currently only runs for the BROLL_CLIP/HyperFrames render path
// (forensic finding: no per-asset technical QC exists anywhere for a
// freshly-generated keyframe/video image before human review).
//
// DELIBERATELY NOT WIRED into keyframe-generation-service.js/video-
// generation-service.js's own hot path (Part 17/39 — do not rewrite an
// already-shipped, financially-critical service for this stage's
// convenience). This is an opt-in, additive check any caller (the Golden
// Visual Production Test, an MCP tool, a future automated step) can run
// explicitly against an already-archived asset.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');

function locateOnPath(binaryName) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ffprobeInspect(filePath) {
  const ffprobePath = process.env.VISUAL_QC_FFPROBE_PATH || locateOnPath('ffprobe') || 'ffprobe';
  const raw = execFileSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filePath],
    { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString('utf8');
  return JSON.parse(raw);
}

// Returns { ok, code, message } — never throws; every failure mode is a
// structured, honest result, same discipline as every executor in this
// codebase.
function runTechnicalQc(projectId, assetId) {
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) return { ok: false, code: 'ASSET_NOT_FOUND', message: `no Asset found with id "${assetId}"` };
  if (!asset.storage || asset.storage.status !== 'STORED' || !asset.storage.path) {
    return { ok: false, code: 'ASSET_NOT_ARCHIVED', message: 'asset.storage.status is not STORED — nothing to inspect yet' };
  }

  let filePath;
  try {
    filePath = assetStorage.resolveStoredPath(asset.storage.path);
  } catch (error) {
    return { ok: false, code: 'INVALID_STORAGE_PATH', message: error.message };
  }
  if (!fs.existsSync(filePath)) return { ok: false, code: 'FILE_NOT_FOUND', message: 'stored asset file does not exist on disk' };
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return { ok: false, code: 'FILE_EMPTY', message: 'stored asset file is zero bytes' };

  let parsed;
  try {
    parsed = ffprobeInspect(filePath);
  } catch (error) {
    return { ok: false, code: 'FFPROBE_FAILED', message: `ffprobe could not inspect this file: ${error.message}` };
  }

  const stream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  if (!stream) return { ok: false, code: 'NO_VISUAL_STREAM', message: 'ffprobe found no video/image stream in this file' };
  if (!stream.width || !stream.height) return { ok: false, code: 'INVALID_DIMENSIONS', message: 'ffprobe reported invalid/missing dimensions' };
  if (!stream.codec_name) return { ok: false, code: 'UNKNOWN_CODEC', message: 'ffprobe reported no codec information' };

  if (asset.type === 'video') {
    const duration = parsed.format && Number(parsed.format.duration);
    if (!duration || duration <= 0) return { ok: false, code: 'INVALID_DURATION', message: `ffprobe reported an invalid duration: ${JSON.stringify(parsed.format)}` };
  }

  return { ok: true, code: 'PASS', message: 'valid, decodable media', width: stream.width, height: stream.height, codec: stream.codec_name };
}

module.exports = { runTechnicalQc };
