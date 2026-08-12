// Tests for Stage 19's Reference Library / Identity Lock / Identity
// Consistency Review REST endpoints. Every route is a thin wrapper over
// services/reference-library-service.js, services/creative-store.js, and
// services/identity-consistency-review-store.js — verified by a static
// check that no business logic lives in index.js itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-api-creative-'));
const reviewTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-api-reviews-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.IDENTITY_CONSISTENCY_REVIEW_DATA_DIR = reviewTempDir;

const app = require('../index');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');

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

test.after(() => server.close());

async function createProject(title = 'reference library API test') {
  const res = await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, topic: 'x' }) });
  return res.json();
}

function seedCharacter(projectId) {
  creativeStore.updateVisualBible(projectId, { characters: [{ characterId: 'char-1', name: 'Mira', identityConstraints: 'scar', referenceAssets: [] }] });
}

function approvedAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'APPROVED');
  return asset;
}

// --- GET /projects/:id/reference-library --------------------------------------------

test('GET /projects/:id/reference-library returns entries for every character/location/prop', async () => {
  const project = await createProject();
  seedCharacter(project.id);

  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entities.length, 1);
  assert.equal(body.entities[0].entityType, 'CHARACTER');
});

test('GET /projects/:id/reference-library 404s for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/reference-library`);
  assert.equal(res.status, 404);
});

// --- identity-lock --------------------------------------------------------------------

test('GET .../identity-lock returns the derived identity lock', async () => {
  const project = await createProject();
  seedCharacter(project.id);

  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/identity-lock`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.identityConstraints, 'scar');
});

test('GET .../identity-lock 400s for an invalid entity type', async () => {
  const project = await createProject();
  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/VEHICLE/char-1/identity-lock`);
  assert.equal(res.status, 400);
});

test('GET .../identity-lock 404s for an unknown entity', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/no-such-id/identity-lock`);
  assert.equal(res.status, 404);
});

// --- add reference asset ---------------------------------------------------------------

test('POST .../reference-assets associates a candidate asset with the entity', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);

  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/reference-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.assetId }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.referenceAssets, [asset.assetId]);
});

test('POST .../reference-assets requires assetId', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/reference-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// --- canonical selection ----------------------------------------------------------------

test('PUT .../canonical selects the canonical reference asset', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);
  await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/reference-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.assetId }),
  });

  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/canonical`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.assetId, selectedBy: 'director' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.canonicalReferenceAssetId, asset.assetId);
});

test('PUT .../canonical 409s when the asset is not associated with the entity', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id); // never added via reference-assets

  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/canonical`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.assetId }),
  });
  assert.equal(res.status, 409);
});

test('PUT .../canonical 409s for a REJECTED asset', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/reference-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.assetId }),
  });

  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/canonical`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: asset.assetId }),
  });
  assert.equal(res.status, 409);
});

test('GET .../canonical returns canonicalAssetId: null before any selection', async () => {
  const project = await createProject();
  seedCharacter(project.id);
  const res = await fetch(`${baseUrl}/projects/${project.id}/reference-library/CHARACTER/char-1/canonical`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.canonicalAssetId, null);
});

// --- identity consistency review --------------------------------------------------------

test('POST .../identity-review records a score without changing approvalStatus', async () => {
  const project = await createProject();
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe' });

  const res = await fetch(`${baseUrl}/projects/${project.id}/assets/${asset.assetId}/identity-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scores: { clothing: 4, colourPalette: 5 }, notes: 'good match', reviewedBy: 'director' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.total, 9);

  const reloaded = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(reloaded.approvalStatus, 'NONE');
});

test('POST .../identity-review 400s for an invalid score', async () => {
  const project = await createProject();
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe' });
  const res = await fetch(`${baseUrl}/projects/${project.id}/assets/${asset.assetId}/identity-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scores: { clothing: 99 } }),
  });
  assert.equal(res.status, 400);
});

test('GET .../identity-reviews lists every recorded review, never deleted', async () => {
  const project = await createProject();
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe' });
  await fetch(`${baseUrl}/projects/${project.id}/assets/${asset.assetId}/identity-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scores: { clothing: 2 }, reviewedBy: 'alice' }),
  });
  await fetch(`${baseUrl}/projects/${project.id}/assets/${asset.assetId}/identity-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scores: { clothing: 4 }, reviewedBy: 'bob' }),
  });

  const res = await fetch(`${baseUrl}/projects/${project.id}/assets/${asset.assetId}/identity-reviews`);
  const body = await res.json();
  assert.equal(body.length, 2);
});

// --- no business logic lives in index.js -------------------------------------------

test("index.js's reference-library routes are thin wrappers — no canonical/resolution logic lives there", () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const text = fs2.readFileSync(path2.join(__dirname, '..', 'index.js'), 'utf8');
  const sectionStart = text.indexOf('Stage 19 — Reference Library');
  assert.ok(sectionStart > -1);
  const section = text.slice(sectionStart, sectionStart + 4000);

  assert.match(section, /referenceLibraryService\.listReferenceLibrary/);
  assert.match(section, /referenceLibraryService\.getIdentityLock/);
  assert.match(section, /creativeStore\.selectCanonicalReferenceAsset/);
  assert.match(section, /identityConsistencyReviewStore\.recordReview/);
  // no dimension name or resolution-status literal should appear in the
  // route handlers themselves — those decisions live only in the services.
  for (const literal of ['CANONICAL_AVAILABLE', 'REJECTED_ONLY', 'headFaceGeometry']) {
    assert.doesNotMatch(section, new RegExp(literal));
  }
});
