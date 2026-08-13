// Tests for Stage 22B-Part-1 — the Generation Model Registry REST
// endpoints (GET /generation-models, GET /generation-models/:provider/:model,
// POST /generation-models/search, POST /generation-models/validate). Every
// route is a thin wrapper over services/generation-model-registry.js —
// verified by a static check that no registry logic lives in index.js
// itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Defensive only — these routes never touch project data, but index.js
// loads projectStore at require time, so point it at a throwaway temp dir
// like every other REST test file does.
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-genreg-api-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const app = require('../index');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(projectTempDir, { recursive: true, force: true });
});

test('GET /generation-models lists the full registry', async () => {
  const res = await fetch(`${baseUrl}/generation-models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 30);
  assert.ok(body.some((m) => m.provider === 'evolink' && m.model === 'gpt-image-2'));
  assert.ok(body.some((m) => m.provider === 'google'));
});

test('GET /generation-models supports provider/modality/productionReadyOnly query filters', async () => {
  const res = await fetch(`${baseUrl}/generation-models?provider=evolink&modality=image&productionReadyOnly=true`);
  const body = await res.json();
  assert.ok(body.length > 0);
  for (const m of body) {
    assert.equal(m.provider, 'evolink');
    assert.equal(m.modality, 'image');
    assert.equal(m.productionReady, true);
  }
});

test('GET /generation-models/:provider/:model returns the exact record', async () => {
  const res = await fetch(`${baseUrl}/generation-models/evolink/gpt-image-2`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'evolink');
  assert.equal(body.model, 'gpt-image-2');
});

test('GET /generation-models/:provider/:model returns 404 for an unknown model', async () => {
  const res = await fetch(`${baseUrl}/generation-models/evolink/does-not-exist`);
  assert.equal(res.status, 404);
});

test('POST /generation-models/search returns matching models, never selects one', async () => {
  const res = await fetch(`${baseUrl}/generation-models/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirements: { modality: 'video', referenceImages: true } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 1); // multiple models match -- this endpoint never narrows to "the one"
  assert.ok(body.every((m) => m.capabilities.referenceImages === true));
});

test('POST /generation-models/search with sortByPrice orders cheapest-first among known prices', async () => {
  const res = await fetch(`${baseUrl}/generation-models/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirements: { modality: 'image', referenceImages: true }, sortByPrice: true }),
  });
  const body = await res.json();
  assert.equal(body[0].model, 'gpt-image-2');
});

test('POST /generation-models/validate returns structured diagnostics without executing anything', async () => {
  const res = await fetch(`${baseUrl}/generation-models/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'evolink', model: 'gpt-image-2', requirements: { referenceImages: true } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.allowed, true);
  assert.deepEqual(body.reasons, []);
});

test('POST /generation-models/validate requires provider and model', async () => {
  const res = await fetch(`${baseUrl}/generation-models/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirements: {} }),
  });
  assert.equal(res.status, 400);
});

test('safety: no generation-model-registry route in index.js contains capability/pricing logic of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const sectionStart = src.indexOf('Stage 22B-Part-1 — Generation Model Capability Registry');
  const sectionEnd = src.indexOf('If a client sends broken JSON');
  const section = src.slice(sectionStart, sectionEnd);
  // every route must delegate to generationModelRegistry.* and contain no
  // capability-matching conditionals (referenceImages, maxReferenceImages,
  // startingPrice, etc.) of its own
  assert.doesNotMatch(section, /capabilities\.\w+\s*===/);
  assert.doesNotMatch(section, /startingPrice\s*[<>]/);
  assert.match(section, /generationModelRegistry\.listModels/);
  assert.match(section, /generationModelRegistry\.getModel/);
  assert.match(section, /generationModelRegistry\.(findModelsSatisfying|cheapestSatisfying)/);
  assert.match(section, /generationModelRegistry\.validateModelSelection/);
});

test('safety: no generation-model-registry route can create a job, approval, or asset', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const sectionStart = src.indexOf('Stage 22B-Part-1 — Generation Model Capability Registry');
  const sectionEnd = src.indexOf('If a client sends broken JSON');
  const section = src.slice(sectionStart, sectionEnd);
  for (const forbidden of ['generationStore.createGenerationJob', 'timelineStore.addAsset', 'gate.reconcileGenerationCost', 'keyframeGenerationApprovalStore']) {
    assert.doesNotMatch(section, new RegExp(forbidden.replace(/[.]/g, '\\.')));
  }
});
