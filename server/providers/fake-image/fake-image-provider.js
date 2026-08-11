// fake-image-provider.js
//
// Stage 13B, Part 3 — implements ../image-provider-interface.js entirely
// in memory. Exists ONLY to prove the complete approval -> generation ->
// archive -> human-review lifecycle end-to-end in automated tests and
// manual verification, without ever touching the network or spending a
// real credit.
//
// - accepts a generation request, returns a fake (random UUID) task id
// - "simulates processing": the first status check after submission
//   reports PROCESSING; every check after that reports COMPLETED — a
//   small, deterministic, in-memory state machine, not a real timer
// - the completed result is always the same bundled fixture file
//   (./fixtures/sample-keyframe.png), never a real download
// - NEVER calls fetch/http/any network API — see fakeFetchImpl below,
//   which asset-archive-service.js is given instead of the real `fetch`
//   global when archiving a fake-image asset, so even the "download the
//   result" step never leaves this machine

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGenerationStatus } = require('../image-provider-interface');

const PROVIDER_NAME = 'fake-image';
const MODEL_NAME = 'fake-image-v1';

// A plausible, small, fixed number — deliberately never configurable by a
// caller, so tests can rely on it being the same every time. This is NOT
// a claim about what a real provider would charge; see docs/architecture/
// keyframe-generation.md's "Known limitations" for why no real pricing is
// invented anywhere in this stage.
const FAKE_RESERVED_COST = 1.5;

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-keyframe.png');
// A syntactically valid https URL (so it passes the exact same
// asset-storage.js validation a real provider's URL would) that is never
// actually requested over the network — fakeFetchImpl below intercepts it.
const FIXTURE_URL = 'https://fake-image-provider.local/fixtures/sample-keyframe.png';

// In-memory only — never persisted, never shared across processes. Maps a
// fake task id to how many times its status has been checked, which is
// all the state needed to deterministically simulate "processing, then
// done" without a real timer.
const tasks = new Map();

async function createImageGeneration(request) {
  const taskId = crypto.randomUUID();
  tasks.set(taskId, { checks: 0 });

  return createGenerationStatus({
    generationId: taskId,
    provider: PROVIDER_NAME,
    model: MODEL_NAME,
    status: 'SUBMITTED',
    progress: 0,
    reservedCost: FAKE_RESERVED_COST,
    results: [],
    error: null,
  });
}

async function getGenerationStatus(taskId) {
  const state = tasks.get(taskId);
  if (!state) {
    throw new Error(`Unknown fake image generation task "${taskId}" — createImageGeneration was never called for it.`);
  }
  state.checks += 1;

  if (state.checks < 2) {
    return createGenerationStatus({
      generationId: taskId,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      status: 'PROCESSING',
      progress: 50,
      reservedCost: FAKE_RESERVED_COST,
      results: [],
      error: null,
    });
  }

  return createGenerationStatus({
    generationId: taskId,
    provider: PROVIDER_NAME,
    model: MODEL_NAME,
    status: 'COMPLETED',
    progress: 100,
    reservedCost: FAKE_RESERVED_COST,
    results: [FIXTURE_URL],
    error: null,
  });
}

// Given to services/asset-storage.js's downloadAsset() IN PLACE OF the
// real `fetch` global when archiving a fake-image result — reads the
// bundled fixture straight off disk and hands back a real (Node built-in)
// Response object, so every existing streaming/size-limit/content-type
// check in asset-storage.js still runs exactly as it does for a real
// provider, but nothing ever leaves this machine.
async function fakeFetchImpl(url) {
  if (url !== FIXTURE_URL) {
    throw new Error(`FakeImageProvider's fetchImpl only recognizes its own fixture URL, got: "${url}"`);
  }
  const buffer = fs.readFileSync(FIXTURE_PATH);
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(buffer.length) },
  });
}

// Test-only: clears all in-memory task state between test files/cases so
// task ids and "checks" counters never leak across unrelated tests.
function resetFakeImageProvider() {
  tasks.clear();
}

module.exports = {
  PROVIDER_NAME,
  MODEL_NAME,
  FAKE_RESERVED_COST,
  FIXTURE_URL,
  createImageGeneration,
  getGenerationStatus,
  fakeFetchImpl,
  resetFakeImageProvider,
};
