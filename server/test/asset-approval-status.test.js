// Tests for Stage 9B's candidate-vs-approved asset addition
// (timelineStore.setAssetApprovalStatus) — see docs/architecture/
// generation-history.md. No network, no provider, no generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-approval-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');

test('a fresh asset defaults to approvalStatus NONE (a candidate, not yet reviewed)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { type: 'video' });
  assert.equal(asset.approvalStatus, 'NONE');
});

test('setAssetApprovalStatus marks one asset APPROVED without touching sibling candidates', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId });

  const bad = timelineStore.addAsset(project.id, { type: 'video', shotId: shot.shotId });
  const better = timelineStore.addAsset(project.id, { type: 'video', shotId: shot.shotId });

  const updated = timelineStore.setAssetApprovalStatus(project.id, better.assetId, 'APPROVED');
  assert.equal(updated.approvalStatus, 'APPROVED');

  // The other candidate for the same shot is untouched -- neither deleted
  // nor silently marked as anything else.
  const stillThere = timelineStore.getAsset(project.id, bad.assetId);
  assert.ok(stillThere, 'a rejected/candidate asset must never be deleted');
  assert.equal(stillThere.approvalStatus, 'NONE');

  const assets = timelineStore.listAssets(project.id, { shotId: shot.shotId });
  assert.equal(assets.length, 2, 'approving one asset must not overwrite or remove the other');
});

test('setAssetApprovalStatus rejects an unrecognized status rather than silently accepting it', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { type: 'video' });

  assert.throws(() => timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'MAYBE'), /not a valid asset approval status/);
});

test('setAssetApprovalStatus returns null for an unknown project or asset', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  assert.equal(timelineStore.setAssetApprovalStatus('00000000-0000-0000-0000-000000000000', 'anything', 'APPROVED'), null);
  assert.equal(timelineStore.setAssetApprovalStatus(project.id, 'nonexistent-asset', 'APPROVED'), null);
});
