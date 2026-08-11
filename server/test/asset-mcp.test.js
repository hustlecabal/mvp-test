// Tests for the Stage 9A asset MCP tools (archive_asset, get_asset_download,
// and list_assets' new storage status), using a REAL spawned MCP server
// process over stdio — same pattern as generation-mcp.test.js.
//
// archive_asset in this test suite always operates on a fixture asset whose
// url points at a local, offline test HTTP server (started in test.before)
// -- never at a real EvoLink URL -- so nothing here makes a real network
// call to EvoLink or spends any credit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-mcp-projects-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-mcp-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;
let fixtureServer;
let fixtureUrl;

test.before(async () => {
  // A local, offline HTTP fixture standing in for "a provider's result URL"
  // -- this is what proves archive_asset never needs, and never calls, the
  // real EvoLink API.
  fixtureServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end('fixture video bytes');
  });
  await new Promise((resolve) => fixtureServer.listen(0, resolve));
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fake.mp4`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: projectTempDir, ASSET_STORAGE_DIR: assetsTempDir },
  });
  client = new Client({ name: 'evolink-asset-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fixtureServer.close();
  fs.rmSync(projectTempDir, { recursive: true, force: true });
  fs.rmSync(assetsTempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function createFixtureAsset() {
  const project = projectStore.createProject({ title: 'MCP asset test', topic: 'x' });
  const asset = timelineStore.addAsset(project.id, { type: 'video', url: fixtureUrl });
  return { project, asset };
}

// --- 18. MCP archive_asset works --------------------------------------------

test('18. archive_asset downloads the fixture URL and marks the asset STORED', async () => {
  const { asset } = createFixtureAsset();

  const result = textOf(await call('archive_asset', { assetId: asset.assetId }));

  assert.equal(result.ok, true);
  assert.equal(result.asset.storage.status, 'STORED');
  assert.equal(result.asset.storage.provider, 'local');
  assert.ok(fs.existsSync(path.join(assetsTempDir, `${asset.assetId}.mp4`)));
});

test('archive_asset is idempotent through MCP too', async () => {
  const { asset } = createFixtureAsset();

  const first = textOf(await call('archive_asset', { assetId: asset.assetId }));
  const second = textOf(await call('archive_asset', { assetId: asset.assetId }));

  assert.equal(first.alreadyArchived, false);
  assert.equal(second.alreadyArchived, true);
});

test('archive_asset never generates anything -- unknown asset id fails cleanly', async () => {
  const result = textOf(await call('archive_asset', { assetId: '00000000-0000-0000-0000-000000000000' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /No asset found/);
});

// --- 19. MCP get_asset_download works ---------------------------------------

test('19. get_asset_download returns endpoint paths and storage status, never a filesystem path', async () => {
  const { asset } = createFixtureAsset();
  await call('archive_asset', { assetId: asset.assetId });

  const result = textOf(await call('get_asset_download', { assetId: asset.assetId }));

  assert.equal(result.assetId, asset.assetId);
  assert.equal(result.storageStatus, 'STORED');
  assert.equal(result.downloadUrl, `/assets/${asset.assetId}/download`);
  assert.equal(result.previewUrl, `/assets/${asset.assetId}/preview`);
  assert.equal(result.providerUrlAvailable, true);
  assert.equal(JSON.stringify(result).includes(assetsTempDir), false, 'internal filesystem path must never be exposed');
});

test('get_asset_download reports NOT_ARCHIVED before archiving', async () => {
  const { asset } = createFixtureAsset();
  const result = textOf(await call('get_asset_download', { assetId: asset.assetId }));
  assert.equal(result.storageStatus, 'NOT_ARCHIVED');
});

// --- 20. list_assets returns storage status ---------------------------------

test('20. list_assets includes storageStatus for each asset', async () => {
  const { project, asset } = createFixtureAsset();
  await call('archive_asset', { assetId: asset.assetId });

  const list = textOf(await call('list_assets', { projectId: project.id }));

  assert.equal(list.length, 1);
  assert.equal(list[0].assetId, asset.assetId);
  assert.equal(list[0].storageStatus, 'STORED');
  assert.ok('projectId' in list[0] && 'sceneId' in list[0] && 'shotId' in list[0]);
  assert.ok('generationId' in list[0] && 'provider' in list[0] && 'model' in list[0] && 'type' in list[0]);
  assert.ok('createdAt' in list[0]);
});
