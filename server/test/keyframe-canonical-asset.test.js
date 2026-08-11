// Tests for Stage 13E, Part 1 — the canonical keyframe asset:
// services/keyframe-store.js's selectCanonicalKeyframeAsset/
// getCanonicalKeyframeAsset, the two MCP tools, and the two REST routes.
// Selection is always explicit — nothing here ever picks a canonical
// asset automatically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-keyframes-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const timelineStore = require('../services/timeline-store');

function buildFixture() {
  const project = projectStore.createProject({ title: 'canonical-asset test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'DETAIL_FRAME',
    sourceShotVersion: storyboard.version,
  });
  return { project, scene, shot, keyframe };
}

function addAsset(projectId, keyframeId, overrides = {}) {
  return timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'keyframe', keyframeId, ...overrides });
}

// --- 1. select canonical --------------------------------------------------------------

test('1. selectCanonicalKeyframeAsset marks an asset canonical', () => {
  const { project, keyframe } = buildFixture();
  const asset = addAsset(project.id, keyframe.keyframeId);

  const result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.keyframe.canonicalAssetId, asset.assetId);
  assert.equal(result.keyframe.canonicalAssetSelectedBy, 'tester');
  assert.ok(result.keyframe.canonicalAssetSelectedAt);
});

// --- 2. get canonical ------------------------------------------------------------------

test('2. getCanonicalKeyframeAsset reads the current selection, including the full asset record', () => {
  const { project, keyframe } = buildFixture();
  const asset = addAsset(project.id, keyframe.keyframeId);
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });

  const got = keyframeStore.getCanonicalKeyframeAsset(project.id, keyframe.keyframeId);
  assert.equal(got.canonicalAssetId, asset.assetId);
  assert.equal(got.asset.assetId, asset.assetId);
  assert.equal(got.canonicalAssetSelectedBy, 'tester');
});

test('getCanonicalKeyframeAsset returns canonicalAssetId: null (not an error) before any selection', () => {
  const { project, keyframe } = buildFixture();
  const got = keyframeStore.getCanonicalKeyframeAsset(project.id, keyframe.keyframeId);
  assert.equal(got.canonicalAssetId, null);
  assert.equal(got.asset, null);
});

// --- 3. only one canonical asset --------------------------------------------------------

test('3. selecting a new canonical asset replaces the old one — never two at once', () => {
  const { project, keyframe } = buildFixture();
  const first = addAsset(project.id, keyframe.keyframeId);
  const second = addAsset(project.id, keyframe.keyframeId);

  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, first.assetId, { selectedBy: 'a' });
  const result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, second.assetId, { selectedBy: 'b' });

  assert.equal(result.keyframe.canonicalAssetId, second.assetId);
  const got = keyframeStore.getCanonicalKeyframeAsset(project.id, keyframe.keyframeId);
  assert.equal(got.canonicalAssetId, second.assetId, 'only the second asset is canonical now');
});

// --- 4. cross-project asset rejected ----------------------------------------------------

test('4. an asset from a DIFFERENT project cannot become canonical', () => {
  const { project: projectA, keyframe } = buildFixture();
  const { project: projectB } = buildFixture();
  const assetInB = addAsset(projectB.id, keyframe.keyframeId); // same keyframeId by coincidence, wrong project

  const result = keyframeStore.selectCanonicalKeyframeAsset(projectA.id, keyframe.keyframeId, assetInB.assetId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /No asset found/);
});

test('4b. an asset that belongs to a DIFFERENT keyframe in the same project is rejected', () => {
  const { project, keyframe } = buildFixture();
  const otherAsset = addAsset(project.id, 'some-other-keyframe-id');

  const result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, otherAsset.assetId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not belong to keyframe/);
});

// --- 5. rejected asset cannot become canonical -------------------------------------------

test('5. a REJECTED asset can never become canonical', () => {
  const { project, keyframe } = buildFixture();
  const asset = addAsset(project.id, keyframe.keyframeId);
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');

  const result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /REJECTED/);

  const got = keyframeStore.getCanonicalKeyframeAsset(project.id, keyframe.keyframeId);
  assert.equal(got.canonicalAssetId, null);
});

test('5b. an APPROVED or unreviewed (NONE) asset can become canonical; selecting never changes approvalStatus', () => {
  const { project, keyframe } = buildFixture();
  const approved = addAsset(project.id, keyframe.keyframeId);
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');
  const unreviewed = addAsset(project.id, keyframe.keyframeId);

  let result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, approved.assetId);
  assert.equal(result.ok, true);
  assert.equal(timelineStore.getAsset(project.id, approved.assetId).approvalStatus, 'APPROVED');

  result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, unreviewed.assetId);
  assert.equal(result.ok, true);
  assert.equal(timelineStore.getAsset(project.id, unreviewed.assetId).approvalStatus, 'NONE', 'selection never auto-approves');
});

test('5c. a canonical asset that is LATER rejected is not auto-cleared — selection must be explicitly changed', () => {
  const { project, keyframe } = buildFixture();
  const asset = addAsset(project.id, keyframe.keyframeId);
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });

  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');

  const got = keyframeStore.getCanonicalKeyframeAsset(project.id, keyframe.keyframeId);
  assert.equal(got.canonicalAssetId, asset.assetId, 'still canonical — nothing clears it automatically');

  // A human must explicitly pick a different one; re-affirming the now-
  // rejected asset itself is refused (same rule as test 5).
  const reselect = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId);
  assert.equal(reselect.ok, false);
});

// --- 6. historical assets preserved -------------------------------------------------------

test('6. every previous canonical selection is preserved in canonicalAssetHistory, never discarded', () => {
  const { project, keyframe } = buildFixture();
  const first = addAsset(project.id, keyframe.keyframeId);
  const second = addAsset(project.id, keyframe.keyframeId);
  const third = addAsset(project.id, keyframe.keyframeId);

  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, first.assetId, { selectedBy: 'a', changeNote: 'first pick' });
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, second.assetId, { selectedBy: 'b', changeNote: 'second pick' });
  const result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, third.assetId, { selectedBy: 'c' });

  assert.equal(result.keyframe.canonicalAssetHistory.length, 2);
  assert.equal(result.keyframe.canonicalAssetHistory[0].assetId, first.assetId);
  assert.equal(result.keyframe.canonicalAssetHistory[0].changeNote, 'first pick');
  assert.equal(result.keyframe.canonicalAssetHistory[1].assetId, second.assetId);
  assert.equal(result.keyframe.canonicalAssetHistory[1].changeNote, 'second pick');

  // No asset is ever deleted anywhere — every candidate remains a real,
  // fetchable asset regardless of canonical status.
  assert.ok(timelineStore.getAsset(project.id, first.assetId));
  assert.ok(timelineStore.getAsset(project.id, second.assetId));
  assert.ok(timelineStore.getAsset(project.id, third.assetId));
});

// --- missing project/keyframe --------------------------------------------------------------

test('selectCanonicalKeyframeAsset fails clearly for an unknown project or keyframe', () => {
  const { project } = buildFixture();
  let result = keyframeStore.selectCanonicalKeyframeAsset('00000000-0000-0000-0000-000000000000', 'kf-1', 'asset-1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No project found/);

  result = keyframeStore.selectCanonicalKeyframeAsset(project.id, 'nope', 'asset-1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No keyframe found/);
});

test('selectCanonicalKeyframeAsset fails clearly for a missing assetId', () => {
  const { project, keyframe } = buildFixture();
  const result = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, '00000000-0000-0000-0000-000000000000');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No asset found/);
});
