// Tests for Stage 19's Reference Library / Identity Lock / Identity
// Consistency Review MCP tools, using a REAL spawned server process over
// stdio, the same way Stage 5's mcp.test.js tests the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-mcp-creative-'));
const reviewTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-mcp-reviews-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.IDENTITY_CONSISTENCY_REVIEW_DATA_DIR = reviewTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: projectTempDir, CREATIVE_DATA_DIR: creativeTempDir, IDENTITY_CONSISTENCY_REVIEW_DATA_DIR: reviewTempDir },
  });
  client = new Client({ name: 'evolink-reflib-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function seedCharacter(projectId) {
  creativeStore.updateVisualBible(projectId, { characters: [{ characterId: 'char-1', name: 'Mira', identityConstraints: 'scar', referenceAssets: [] }] });
}

function approvedAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'APPROVED');
  return asset;
}

test('the 7 reference-library tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of [
    'list_reference_library',
    'get_identity_lock',
    'add_entity_reference_asset',
    'select_canonical_reference_asset',
    'get_canonical_reference_asset',
    'record_identity_consistency_review',
    'list_identity_consistency_reviews',
  ]) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }
});

test('list_reference_library reports a nonexistent project as a clear error', async () => {
  const result = await call('list_reference_library', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('list_reference_library lists a seeded character', async () => {
  const project = projectStore.createProject({ title: 'MCP reflib test', topic: 'x' });
  seedCharacter(project.id);

  const result = textOf(await call('list_reference_library', { projectId: project.id }));
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].entityId, 'char-1');
});

test('add_entity_reference_asset then select_canonical_reference_asset then get_canonical_reference_asset — full flow', async () => {
  const project = projectStore.createProject({ title: 'MCP reflib flow test', topic: 'x' });
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);

  const added = textOf(await call('add_entity_reference_asset', { projectId: project.id, entityType: 'CHARACTER', entityId: 'char-1', assetId: asset.assetId }));
  assert.deepEqual(added.referenceAssets, [asset.assetId]);

  const selected = textOf(
    await call('select_canonical_reference_asset', { projectId: project.id, entityType: 'CHARACTER', entityId: 'char-1', assetId: asset.assetId, selectedBy: 'director' })
  );
  assert.equal(selected.canonicalReferenceAssetId, asset.assetId);

  const canonical = textOf(await call('get_canonical_reference_asset', { projectId: project.id, entityType: 'CHARACTER', entityId: 'char-1' }));
  assert.equal(canonical.canonicalAssetId, asset.assetId);
  assert.equal(canonical.asset.assetId, asset.assetId);
});

test('select_canonical_reference_asset refuses a REJECTED asset via MCP', async () => {
  const project = projectStore.createProject({ title: 'MCP reflib reject test', topic: 'x' });
  seedCharacter(project.id);
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  await call('add_entity_reference_asset', { projectId: project.id, entityType: 'CHARACTER', entityId: 'char-1', assetId: asset.assetId });

  const result = await call('select_canonical_reference_asset', { projectId: project.id, entityType: 'CHARACTER', entityId: 'char-1', assetId: asset.assetId });
  assert.equal(result.isError, true);
});

test('get_identity_lock returns the derived view via MCP', async () => {
  const project = projectStore.createProject({ title: 'MCP identity lock test', topic: 'x' });
  seedCharacter(project.id);

  const lock = textOf(await call('get_identity_lock', { projectId: project.id, entityType: 'CHARACTER', entityId: 'char-1' }));
  assert.equal(lock.identityConstraints, 'scar');
});

test('record_identity_consistency_review then list_identity_consistency_reviews via MCP', async () => {
  const project = projectStore.createProject({ title: 'MCP review test', topic: 'x' });
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe' });

  const review = textOf(
    await call('record_identity_consistency_review', {
      projectId: project.id,
      assetId: asset.assetId,
      scores: { clothing: 4, colourPalette: 5 },
      notes: 'good',
      reviewedBy: 'director',
    })
  );
  assert.equal(review.total, 9);

  const reviews = textOf(await call('list_identity_consistency_reviews', { projectId: project.id, assetId: asset.assetId }));
  assert.equal(reviews.length, 1);

  const reloaded = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(reloaded.approvalStatus, 'NONE');
});
