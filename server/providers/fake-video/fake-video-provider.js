// fake-video-provider.js
//
// Stage 22B-Part-3, Part 22 — implements ../provider-interface.js entirely
// in memory. Deliberately a SEPARATE provider from ../fake-image/
// fake-image-provider.js (Part 22 explicitly requires this): a different
// generic interface (provider-interface.js, not image-provider-
// interface.js), a different fixture, a different in-memory task map — no
// shared mutable state between the two, and no production code path ever
// resolves to this provider (see video-generation-service.js's
// PROVIDERS registry, where this is registered only under the test-only
// entry, never under 'evolink').
//
// - accepts a generic generation request, returns a fake (random UUID) task id
// - simulates PROCESSING -> COMPLETED (or, if asked, -> FAILED) as a
//   small, deterministic, in-memory state machine — never a real timer
// - the completed result is always the same bundled local fixture file
//   (./fixtures/sample-video.mp4), never a real download
// - NEVER calls fetch/http/any network API — see fakeFetchImpl below

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGenerationStatus } = require('../provider-interface');

const PROVIDER_NAME = 'fake-video';
const MODEL_NAME = 'fake-video-v1';

// A plausible, small, fixed number — deliberately never configurable by a
// caller, same reasoning as fake-image-provider.js's FAKE_RESERVED_COST:
// this is not a claim about what a real provider would charge.
const FAKE_RESERVED_COST = 2.25;

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-video.mp4');
// A syntactically valid https URL, never actually requested over the
// network — fakeFetchImpl below intercepts it, exactly like fake-image-
// provider.js's FIXTURE_URL.
const FIXTURE_URL = 'https://fake-video-provider.local/fixtures/sample-video.mp4';

// In-memory only — never persisted, never shared across processes. Maps a
// fake task id to its simulated lifecycle state.
const tasks = new Map();

// simulateFailure lets a test explicitly request a FAILED outcome instead
// of the default COMPLETED one (Part 22: "optionally simulate FAILED") —
// read once at submission time, from the generic request's own
// `parameters.simulateFailure` field, so no separate provider-specific
// call is needed to configure it.
async function createGeneration(genericRequest) {
  const taskId = crypto.randomUUID();
  const simulateFailure = Boolean(genericRequest && genericRequest.parameters && genericRequest.parameters.simulateFailure);
  tasks.set(taskId, { checks: 0, simulateFailure });

  return createGenerationStatus({
    generationId: taskId,
    provider: PROVIDER_NAME,
    model: (genericRequest && genericRequest.model) || MODEL_NAME,
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
    throw new Error(`Unknown fake video generation task "${taskId}" — createGeneration was never called for it.`);
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

  if (state.simulateFailure) {
    return createGenerationStatus({
      generationId: taskId,
      provider: PROVIDER_NAME,
      model: MODEL_NAME,
      status: 'FAILED',
      progress: 100,
      reservedCost: FAKE_RESERVED_COST,
      results: [],
      error: { code: 'fake_simulated_failure', message: 'FakeVideoProvider was asked to simulate a failure.' },
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

async function getGenerationResult(taskId) {
  return getGenerationStatus(taskId);
}

// Given to services/asset-storage.js's downloadAsset() IN PLACE OF the
// real `fetch` global when archiving a fake-video result — reads the
// bundled fixture straight off disk and hands back a real Response
// object, so archival runs exactly as it does for a real provider, but
// nothing ever leaves this machine.
async function fakeFetchImpl(url) {
  if (url !== FIXTURE_URL) {
    throw new Error(`FakeVideoProvider's fetchImpl only recognizes its own fixture URL, got: "${url}"`);
  }
  const buffer = fs.readFileSync(FIXTURE_PATH);
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(buffer.length) },
  });
}

// Test-only: clears all in-memory task state between test files/cases so
// task ids and "checks" counters never leak across unrelated tests.
function resetFakeVideoProvider() {
  tasks.clear();
}

module.exports = {
  PROVIDER_NAME,
  MODEL_NAME,
  FAKE_RESERVED_COST,
  FIXTURE_URL,
  createGeneration,
  getGenerationStatus,
  getGenerationResult,
  fakeFetchImpl,
  resetFakeVideoProvider,
};
