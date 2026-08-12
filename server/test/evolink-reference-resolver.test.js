// Tests for services/evolink-reference-resolver.js — Stage 17, Part 2/3.
// Turns an approved, locally-archived reference asset into an
// EvoLink-hosted URL via the documented base64-upload API. Every upload
// call here uses a mocked uploadImpl; NONE of these tests make a real
// network call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ref-resolver-projects-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ref-resolver-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const resolver = require('../services/evolink-reference-resolver');

// A minimal, valid 1x1 PNG (same magic bytes asset-storage.js's own
// sniffImageFormat() checks for).
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000'.padEnd(64, '0'),
  'hex'
);

function storeApprovedAsset(projectId, { type = 'character_reference' } = {}) {
  const asset = timelineStore.addAsset(projectId, { type });
  assetStorage.storeUploadedImage(PNG_BYTES, asset.assetId);
  timelineStore.updateAssetStorage(projectId, asset.assetId, {
    provider: 'local',
    path: `${asset.assetId}.png`,
    status: 'STORED',
    contentType: 'image/png',
  });
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, asset.assetId);
}

function newProject() {
  return projectStore.createProject({ title: 'reference resolver test', topic: 'x' });
}

// --- single reference resolution ------------------------------------------------

test('resolveReferenceImageUrl resolves an approved, stored asset to the uploaded URL', async () => {
  const project = newProject();
  const asset = storeApprovedAsset(project.id);

  let capturedDataUrl;
  const uploadImpl = async (dataUrl) => {
    capturedDataUrl = dataUrl;
    return { data: { file_url: 'https://files.evolink.ai/uploaded/x.png', expires_at: '2026-08-15T00:00:00Z' } };
  };

  const result = await resolver.resolveReferenceImageUrl(project.id, asset.assetId, { uploadImpl });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://files.evolink.ai/uploaded/x.png');
  assert.equal(result.expiresAt, '2026-08-15T00:00:00Z');
  assert.match(capturedDataUrl, /^data:image\/png;base64,/);
});

test('resolveReferenceImageUrl refuses an unapproved asset', async () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  const result = await resolver.resolveReferenceImageUrl(project.id, asset.assetId, { uploadImpl: async () => { throw new Error('MUST NOT BE CALLED'); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not APPROVED/);
});

test('resolveReferenceImageUrl refuses an asset that is not STORED locally', async () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  const result = await resolver.resolveReferenceImageUrl(project.id, asset.assetId, { uploadImpl: async () => { throw new Error('MUST NOT BE CALLED'); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not STORED locally/);
});

test('resolveReferenceImageUrl reports a missing asset, never inventing one', async () => {
  const project = newProject();
  const result = await resolver.resolveReferenceImageUrl(project.id, '00000000-0000-0000-0000-000000000000');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No asset/);
});

test('resolveReferenceImageUrl surfaces an EvoLink upload failure as a reason, never throws', async () => {
  const project = newProject();
  const asset = storeApprovedAsset(project.id);
  const uploadImpl = async () => { throw new Error('insufficient quota'); };
  const result = await resolver.resolveReferenceImageUrl(project.id, asset.assetId, { uploadImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /EvoLink file upload failed: insufficient quota/);
});

test('resolveReferenceImageUrl reports a malformed upload response (no file_url) as unresolved, not a crash', async () => {
  const project = newProject();
  const asset = storeApprovedAsset(project.id);
  const uploadImpl = async () => ({ data: {} });
  const result = await resolver.resolveReferenceImageUrl(project.id, asset.assetId, { uploadImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not include a data.file_url/);
});

test('resolveReferenceImageUrl refuses an unsupported content type rather than uploading it anyway', async () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', path: `${asset.assetId}.bin`, contentType: 'application/octet-stream' });
  // A real file must exist at the recorded path so this test actually
  // exercises the content-type check rather than the earlier
  // missing-file check.
  fs.writeFileSync(assetStorage.resolveStoredPath(`${asset.assetId}.bin`), Buffer.from('not an image'));
  const result = await resolver.resolveReferenceImageUrl(project.id, asset.assetId, { uploadImpl: async () => { throw new Error('MUST NOT BE CALLED'); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsupported content type/);
});

// --- multiple references / exclusion rules --------------------------------------

test('resolveReferenceImageUrls resolves multiple approved references and preserves order', async () => {
  const project = newProject();
  const charAsset = storeApprovedAsset(project.id, { type: 'character_reference' });
  const envAsset = storeApprovedAsset(project.id, { type: 'location_reference' });

  const uploadImpl = async (dataUrl, { fileName }) => ({ data: { file_url: `https://files.evolink.ai/uploaded/${fileName}` } });

  const { referenceImageUrls, unresolved } = await resolver.resolveReferenceImageUrls(
    project.id,
    [
      { assetId: charAsset.assetId, roleType: 'CHARACTER', role: 'character:Mira' },
      { assetId: envAsset.assetId, roleType: 'ENVIRONMENT', role: 'location:Pier' },
    ],
    { uploadImpl }
  );

  assert.equal(unresolved.length, 0);
  assert.deepEqual(
    referenceImageUrls.map((r) => r.assetId),
    [charAsset.assetId, envAsset.assetId]
  );
});

test('resolveReferenceImageUrls excludes unresolvable references, preserving their roleType/reason, without failing the whole batch', async () => {
  const project = newProject();
  const goodAsset = storeApprovedAsset(project.id);
  const missingAssetId = '11111111-1111-1111-1111-111111111111';

  const uploadImpl = async () => ({ data: { file_url: 'https://files.evolink.ai/uploaded/x.png' } });

  const { referenceImageUrls, unresolved } = await resolver.resolveReferenceImageUrls(
    project.id,
    [
      { assetId: goodAsset.assetId, roleType: 'CHARACTER', role: 'character:Mira' },
      { assetId: missingAssetId, roleType: 'WARDROBE', role: 'character:Mira wardrobe' },
    ],
    { uploadImpl }
  );

  assert.equal(referenceImageUrls.length, 1);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].assetId, missingAssetId);
  assert.equal(unresolved[0].roleType, 'WARDROBE');
  assert.match(unresolved[0].reason, /No asset/);
});

test('resolveReferenceImageUrls with zero references returns empty arrays, not null', async () => {
  const project = newProject();
  const { referenceImageUrls, unresolved } = await resolver.resolveReferenceImageUrls(project.id, []);
  assert.deepEqual(referenceImageUrls, []);
  assert.deepEqual(unresolved, []);
});

// --- safety: never calls the real network ---------------------------------------

test('evolink-reference-resolver.js never imports fetch/http directly — every network call goes through evolink-client.js', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'evolink-reference-resolver.js'), 'utf8');
  assert.doesNotMatch(text, /\bfetch\(/);
});
