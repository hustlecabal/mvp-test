// asset-storage.js
//
// Stage 9A — low-level permanent local storage for downloaded generation
// results. This file owns exactly two things: WHERE files live on disk,
// and HOW a remote URL gets safely turned into one of them. It knows
// nothing about projects, assets, or generation jobs — that orchestration
// lives in services/asset-archive-service.js.
//
// See docs/architecture/asset-storage.md for the full explanation and the
// security assumptions documented below in plain language.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

// Where downloaded asset files live. Overridable via an environment
// variable so tests never touch real data — same pattern as
// PROJECT_DATA_DIR/GENERATION_JOBS_DATA_DIR.
const ASSETS_DIR = process.env.ASSET_STORAGE_DIR
  ? path.resolve(process.env.ASSET_STORAGE_DIR)
  : path.join(__dirname, '..', 'data', 'assets');

fs.mkdirSync(ASSETS_DIR, { recursive: true });

// Reasonable default cap for a single downloaded asset (500 MB — generous
// for an MVP's short video clips). Overridable for tests.
const DEFAULT_MAX_BYTES = Number(process.env.ASSET_MAX_BYTES) || 500 * 1024 * 1024;

// Same shape as project-store.js/generation-store.js's own id pattern —
// duplicated rather than imported, matching how this codebase already
// keeps each store's id validation local to itself.
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only file extensions we recognize are ever used to build a filename —
// anything else (or anything we can't parse a URL out of at all) falls
// back to a generic ".bin". This is what stops a malicious/odd URL path
// from injecting characters into a filesystem path: we never use more of
// the URL than this one whitelisted extension.
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

class AssetStorageError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AssetStorageError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function isValidAssetId(id) {
  return typeof id === 'string' && ASSET_ID_PATTERN.test(id);
}

// Assumption (documented, not hidden): "valid to download" means the
// protocol is http/https. We deliberately do NOT try to block private/
// internal IP ranges (SSRF hardening) here — this endpoint is only ever
// called with EvoLink's own documented result URLs (files.evolink.ai),
// never with arbitrary user-supplied URLs. If this function is ever
// exposed to attacker-controlled URLs in the future, that hardening would
// need to be added then.
function isValidRemoteUrl(value) {
  if (typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext) ? ext : '.bin';
  } catch {
    return '.bin';
  }
}

// The ONLY function that turns an assetId into a filename. It is always
// `${assetId}${ext}` — assetId is validated as a UUID first, and ext comes
// only from the whitelist above. Nothing here ever accepts a
// caller-supplied filename or path.
function relativeFilename(assetId, ext) {
  return `${assetId}${ext}`;
}

// Turns a stored RELATIVE path (as saved on an asset's storage.path field)
// back into a real filesystem path, refusing anything that isn't a plain
// filename directly inside ASSETS_DIR. This is the path-traversal guard —
// even though relativeFilename() above never produces anything else, this
// defends the read side too (e.g. if a project file were ever hand-edited).
function resolveStoredPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    throw new AssetStorageError('invalid_path', 'Refusing to resolve a suspicious stored asset path.');
  }
  const base = path.resolve(ASSETS_DIR) + path.sep;
  const full = path.resolve(ASSETS_DIR, relativePath);
  if (!full.startsWith(base)) {
    throw new AssetStorageError('invalid_path', 'Resolved path escapes the asset storage directory.');
  }
  return full;
}

function storedFileExists(relativePath) {
  try {
    return fs.existsSync(resolveStoredPath(relativePath));
  } catch {
    return false;
  }
}

// Downloads `url` into permanent local storage under `assetId`'s filename.
// - Never overwrites an existing file for this assetId — if one is
//   already there, returns it as-is (alreadyExisted: true) instead of
//   re-downloading. Callers that need to force a re-download (Part 11's
//   "missing file" reconciliation) simply never call this for an assetId
//   whose file still exists.
// - Streams to a `.download` temp file first and only renames it into
//   place on full success, so a failed/aborted download never leaves a
//   partial file at the real path.
// - Enforces maxBytes both from the Content-Length header (fails fast,
//   before downloading anything) and while streaming (in case the header
//   is missing or lies).
async function downloadAsset(url, assetId, { fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!isValidAssetId(assetId)) {
    throw new AssetStorageError('invalid_asset_id', `"${assetId}" is not a valid asset id.`);
  }
  if (!isValidRemoteUrl(url)) {
    throw new AssetStorageError('invalid_url', 'Only http:// or https:// URLs can be downloaded.');
  }

  const relativePath = relativeFilename(assetId, extensionFromUrl(url));
  const finalPath = resolveStoredPath(relativePath);

  if (fs.existsSync(finalPath)) {
    return {
      path: finalPath,
      relativePath,
      sizeBytes: fs.statSync(finalPath).size,
      contentType: null,
      alreadyExisted: true,
    };
  }

  let response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new AssetStorageError('network_error', `Network error while downloading the asset: ${err.message}`);
  }

  if (!response.ok) {
    throw new AssetStorageError('http_error', `Remote server returned HTTP ${response.status} while downloading the asset.`, {
      httpStatus: response.status,
    });
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > maxBytes) {
    throw new AssetStorageError(
      'too_large',
      `Remote asset (${contentLengthHeader} bytes) exceeds the ${maxBytes}-byte limit.`
    );
  }

  if (!response.body) {
    throw new AssetStorageError('empty_response', 'Remote response had no body.');
  }

  const tmpPath = `${finalPath}.download`;
  let totalBytes = 0;

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _enc, callback) {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            callback(new AssetStorageError('too_large', `Download exceeded the ${maxBytes}-byte limit.`));
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(tmpPath)
    );
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err instanceof AssetStorageError
      ? err
      : new AssetStorageError('network_error', `Error while streaming the download: ${err.message}`);
  }

  if (totalBytes === 0) {
    fs.rmSync(tmpPath, { force: true });
    throw new AssetStorageError('empty_response', 'Downloaded file was empty.');
  }

  fs.renameSync(tmpPath, finalPath);
  return { path: finalPath, relativePath, sizeBytes: totalBytes, contentType, alreadyExisted: false };
}

// ---------------------------------------------------------------------------
// Stage 13D — storing a HUMAN-UPLOADED image (Part 6). Distinct from
// downloadAsset() above: there is no remote URL here, just bytes already
// in memory (the human downloaded the image from Higgsfield themselves
// and is now handing it back to this application). "The uploaded image
// itself is the only source of truth" (Part 6) — this function never
// trusts a client-supplied filename or Content-Type; it identifies the
// format itself by sniffing the file's own magic bytes.
// ---------------------------------------------------------------------------

// Reasonable default cap for a single human-uploaded image (25 MB — an
// image, never a video, so far smaller than DEFAULT_MAX_BYTES above).
// Overridable for tests.
const DEFAULT_MAX_UPLOAD_BYTES = Number(process.env.ASSET_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;

// Each entry's `check` looks only at the buffer's own leading bytes — the
// actual file signature, not anything the client claims about it.
const IMAGE_SIGNATURES = [
  { ext: '.png', contentType: 'image/png', check: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg', contentType: 'image/jpeg', check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', contentType: 'image/gif', check: (b) => b.length >= 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') },
  {
    ext: '.webp',
    contentType: 'image/webp',
    check: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

// Returns { ext, contentType }, or null if the bytes don't match any
// supported image signature — never guessed from a filename or header.
function sniffImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.check(buffer)) return { ext: sig.ext, contentType: sig.contentType };
  }
  return null;
}

// Writes an already-in-memory, already-validated-by-the-caller image
// buffer to permanent local storage under `assetId`'s filename. `assetId`
// must already be a server-generated UUID (Part 6: "generate the asset ID
// server-side" — this function never accepts one from a client). Refuses
// to overwrite an existing file (a fresh UUID should never collide;
// treating a collision as an error rather than silently overwriting is
// the safe default). Streams via a `.upload` temp file and only renames
// into place on full success, matching downloadAsset()'s crash-safety.
function storeUploadedImage(buffer, assetId, { maxBytes = DEFAULT_MAX_UPLOAD_BYTES } = {}) {
  if (!isValidAssetId(assetId)) {
    throw new AssetStorageError('invalid_asset_id', `"${assetId}" is not a valid asset id.`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AssetStorageError('empty_upload', 'Uploaded file was empty.');
  }
  if (buffer.length > maxBytes) {
    throw new AssetStorageError('too_large', `Uploaded file (${buffer.length} bytes) exceeds the ${maxBytes}-byte limit.`);
  }

  const format = sniffImageFormat(buffer);
  if (!format) {
    throw new AssetStorageError('unsupported_format', 'Uploaded file is not a recognized image format (PNG, JPEG, GIF, or WEBP).');
  }

  const relativePath = relativeFilename(assetId, format.ext);
  const finalPath = resolveStoredPath(relativePath);

  if (fs.existsSync(finalPath)) {
    throw new AssetStorageError('already_exists', `A stored file already exists for asset "${assetId}".`);
  }

  const tmpPath = `${finalPath}.upload`;
  try {
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  return { path: finalPath, relativePath, sizeBytes: buffer.length, contentType: format.contentType };
}

module.exports = {
  ASSETS_DIR,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  AssetStorageError,
  isValidAssetId,
  isValidRemoteUrl,
  extensionFromUrl,
  resolveStoredPath,
  storedFileExists,
  downloadAsset,
  sniffImageFormat,
  storeUploadedImage,
};
