// Tests for the /assets/:assetId/download and /assets/:assetId/preview
// HTTP endpoints in index.js (Stage 9A). Uses the real Express app on a
// random local port, same pattern as api.test.js/approval-api.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-endpoints-projects-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-endpoints-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
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

test.after(() => {
  server.close();
});

function createArchivedAsset(fileContent = 'fake mp4 bytes') {
  const project = projectStore.createProject({ title: 'Endpoint test', topic: 'x' });
  const asset = timelineStore.addAsset(project.id, { type: 'video', url: 'https://files.evolink.ai/x.mp4' });

  fs.writeFileSync(path.join(assetsTempDir, `${asset.assetId}.mp4`), fileContent);
  const updated = timelineStore.updateAssetStorage(project.id, asset.assetId, {
    provider: 'local',
    path: `${asset.assetId}.mp4`,
    status: 'STORED',
    contentType: 'video/mp4',
    sizeBytes: fileContent.length,
    archivedAt: new Date().toISOString(),
  });

  return { project, asset: updated };
}

// --- 14. Download endpoint works --------------------------------------------

test('14. GET /assets/:assetId/download streams the file with an attachment disposition', async () => {
  const { asset } = createArchivedAsset('download me');

  const res = await fetch(`${baseUrl}/assets/${asset.assetId}/download`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.match(res.headers.get('content-disposition'), new RegExp(asset.assetId));

  const body = await res.text();
  assert.equal(body, 'download me');
});

// --- 15. Preview endpoint works, including a basic range request -----------

test('15. GET /assets/:assetId/preview streams the file inline (no attachment disposition)', async () => {
  const { asset } = createArchivedAsset('preview me');

  const res = await fetch(`${baseUrl}/assets/${asset.assetId}/preview`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-disposition'), null);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');

  const body = await res.text();
  assert.equal(body, 'preview me');
});

test('15b. preview supports a basic byte-range request', async () => {
  const { asset } = createArchivedAsset('0123456789');

  const res = await fetch(`${baseUrl}/assets/${asset.assetId}/preview`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
  const body = await res.text();
  assert.equal(body, '2345');
});

// --- 16. Unknown asset returns 404 ------------------------------------------

test('16. an unknown asset id returns 404 for both download and preview', async () => {
  const missingId = '00000000-0000-0000-0000-000000000000';

  const downloadRes = await fetch(`${baseUrl}/assets/${missingId}/download`);
  assert.equal(downloadRes.status, 404);

  const previewRes = await fetch(`${baseUrl}/assets/${missingId}/preview`);
  assert.equal(previewRes.status, 404);
});

// --- 17. Unarchived asset returns a clear error, not a crash ----------------

test('17. an asset that has not been archived returns a clear (non-500) error', async () => {
  const project = projectStore.createProject({ title: 'Unarchived test', topic: 'x' });
  const asset = timelineStore.addAsset(project.id, { type: 'video', url: 'https://files.evolink.ai/x.mp4' });

  const res = await fetch(`${baseUrl}/assets/${asset.assetId}/download`);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /archive/i);
});

test('the client never receives an internal filesystem path', async () => {
  const { asset } = createArchivedAsset();

  const res = await fetch(`${baseUrl}/assets/${asset.assetId}/download`);
  const disposition = res.headers.get('content-disposition');
  assert.ok(!disposition.includes(assetsTempDir), 'the internal storage directory must never leak to the client');
  await res.arrayBuffer(); // drain

  const budgetRes = await fetch(`${baseUrl}/assets/${asset.assetId}/download`);
  await budgetRes.arrayBuffer();
});
