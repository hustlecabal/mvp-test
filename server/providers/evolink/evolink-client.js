// evolink-client.js
//
// All raw HTTP communication with EvoLink lives here: building the
// request, attaching authentication, and turning EvoLink's error shape
// into a JS error. This file knows the EvoLink base URL and endpoint
// paths, but nothing about our application's own data shapes — that
// translation belongs to evolink-mapper.js.
//
// fetchImpl defaults to the global fetch (Node 22 has this built in), and
// can be overridden per-call so tests never make a real network request.

// Documented in docs/integrations/evolink-api.md: api.evolink.ai is the
// base URL for image/video/audio (multimodal) tasks.
const DEFAULT_BASE_URL = 'https://api.evolink.ai';

// Stage 17 — a SEPARATE base URL for EvoLink's file-upload API family
// (verified via evolink.ai/docs/en/api-manual/file-series/upload-base64).
// Same Bearer-token auth as DEFAULT_BASE_URL (one account, one key), but a
// genuinely different host — evolinkRequest()'s existing `baseUrl` override
// parameter handles this with no change to that function itself.
const FILES_API_BASE_URL = 'https://files-api.evolink.ai';

class EvolinkApiError extends Error {
  constructor(message, { httpStatus, code, type } = {}) {
    super(message);
    this.name = 'EvolinkApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.type = type;
  }
}

// Reads the API key fresh on every call (never cached at module load) so
// tests can set/unset it per test. Throws a beginner-friendly error
// instead of ever falling back to a fake or shared key.
function getApiKey() {
  const key = process.env.EVOLINK_API_KEY;
  if (!key) {
    throw new Error(
      'EVOLINK_API_KEY is not set. Add it to server/.env (copy server/.env.example first) ' +
        'before using the EvoLink provider. This system will never fall back to a fake or shared key.'
    );
  }
  return key;
}

function hasApiKey() {
  return Boolean(process.env.EVOLINK_API_KEY);
}

async function evolinkRequest({ method, path, body, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  const apiKey = getApiKey();

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let json;
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch {
    // Deliberately does not include rawText in the error — it could echo
    // back request content, and this keeps error messages predictable.
    throw new EvolinkApiError(`EvoLink returned a response that was not valid JSON (HTTP ${response.status})`, {
      httpStatus: response.status,
    });
  }

  if (!response.ok) {
    const errorBody = json.error || {};
    throw new EvolinkApiError(errorBody.message || `EvoLink request failed (HTTP ${response.status})`, {
      httpStatus: response.status,
      code: errorBody.code,
      type: errorBody.type,
    });
  }

  return json;
}

// POST /v1/videos/generations — the one generation endpoint independently
// verified so far (see docs/integrations/evolink-api.md).
function createVideoGenerationTask(body, options = {}) {
  return evolinkRequest({ method: 'POST', path: '/v1/videos/generations', body, ...options });
}

// POST /v1/images/generations — Stage 16. Verified in Stage 15's
// investigation (docs/integrations/image-provider-investigation.md Part
// 4/11) to be a distinct endpoint from video generation, but reusing this
// exact same evolinkRequest() helper (same auth, same error handling) —
// no second HTTP stack. See providers/evolink/evolink-image-mapper.js for
// the request body this is called with.
function createImageGenerationTask(body, options = {}) {
  return evolinkRequest({ method: 'POST', path: '/v1/images/generations', body, ...options });
}

// POST /api/v1/files/upload/base64 (files-api.evolink.ai) — Stage 17.
// Verified from EvoLink's own file-series docs: accepts a Data URL
// (`data:image/png;base64,...`) or pure base64 in `base64_data`, returns
// `data.file_url` — an EvoLink-hosted, publicly reachable URL, valid 72
// hours. This is the ONLY EvoLink-documented way to turn a privately-held
// local image into a URL usable in an image-generation request's
// `image_urls` field (see docs/integrations/evolink-api.md and Stage 17's
// investigation) — EvoLink does not accept inline/base64 image data
// directly in the generation request itself.
function uploadBase64File(base64Data, { fileName, uploadPath, ...options } = {}) {
  const body = { base64_data: base64Data };
  if (fileName) body.file_name = fileName;
  if (uploadPath) body.upload_path = uploadPath;
  return evolinkRequest({ method: 'POST', path: '/api/v1/files/upload/base64', body, baseUrl: FILES_API_BASE_URL, ...options });
}

// GET /v1/tasks/{task_id} — used for both status checks and result
// retrieval; EvoLink returns both from the same endpoint.
function getTask(taskId, options = {}) {
  return evolinkRequest({ method: 'GET', path: `/v1/tasks/${encodeURIComponent(taskId)}`, ...options });
}

// GET /v1/credits — a safe, read-only, non-generation endpoint. Useful
// later for confirming a newly-added API key actually works before ever
// calling a generation endpoint. Not called anywhere yet (no key exists).
function getCredits(options = {}) {
  return evolinkRequest({ method: 'GET', path: '/v1/credits', ...options });
}

module.exports = {
  DEFAULT_BASE_URL,
  FILES_API_BASE_URL,
  EvolinkApiError,
  hasApiKey,
  createVideoGenerationTask,
  createImageGenerationTask,
  uploadBase64File,
  getTask,
  getCredits,
};
