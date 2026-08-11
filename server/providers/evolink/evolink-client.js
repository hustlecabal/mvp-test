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
  EvolinkApiError,
  hasApiKey,
  createVideoGenerationTask,
  getTask,
  getCredits,
};
