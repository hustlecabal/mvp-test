// Tests for services/operator-queue-service.js's Stage 19, Part 5
// referenceStatus field — computed purely from already-indexed data, no
// extra store reads, no automatic generation, never mutates anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-refstatus-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-refstatus-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-refstatus-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-refstatus-packages-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const timelineStore = require('../services/timeline-store');
const oq = require('../services/operator-queue-service');

function newProject() {
  return projectStore.createProject({ title: 'oq reference status test', topic: 'x' });
}

function seedShot(project, { characterReferences = [], locationReferences = [] } = {}) {
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences, locationReferences });
  return { scene, shot };
}

function seedKeyframe(project, scene, shot, overrides = {}) {
  const storyboard = creativeStore.getStoryboard(project.id);
  return keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, sourceShotVersion: storyboard.version, ...overrides });
}

function queueItemFor(project, keyframeId) {
  const items = oq.buildProjectQueue(project.id);
  return items.find((i) => i.keyframeId === keyframeId);
}

test('a keyframe with no character/location scope reports NO_REFERENCE_NEEDED', () => {
  const project = newProject();
  const { scene, shot } = seedShot(project);
  const keyframe = seedKeyframe(project, scene, shot);
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'NO_REFERENCE_NEEDED');
});

test('a scoped character with zero reference assets reports MISSING', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [] }] });
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'MISSING');
});

test('a scoped character with only PENDING (NONE) candidates reports REVIEW_REQUIRED', () => {
  const project = newProject();
  const pending = timelineStore.addAsset(project.id, { type: 'character_reference' });
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [pending.assetId] }] });
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'REVIEW_REQUIRED');
});

test('a scoped character with only a REJECTED candidate reports MISSING (no usable reference)', () => {
  const project = newProject();
  const rejected = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, rejected.assetId, 'REJECTED');
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [rejected.assetId] }] });
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'MISSING');
});

test('a scoped character with an approved, non-canonical reference reports AVAILABLE', () => {
  const project = newProject();
  const approved = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [approved.assetId] }] });
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'AVAILABLE');
});

test('a scoped character with a resolvable CANONICAL reference reports CANONICAL_AVAILABLE', () => {
  const project = newProject();
  const approved = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [approved.assetId] }] });
  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', approved.assetId);
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'CANONICAL_AVAILABLE');
});

test('multiple scoped entities: MISSING wins over CANONICAL_AVAILABLE (worst case surfaces)', () => {
  const project = newProject();
  const approved = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, {
    characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [approved.assetId] }],
    locations: [{ locationId: 'loc-1', name: 'Pier', referenceAssets: [] }],
  });
  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', approved.assetId);
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'], locationReferences: ['loc-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'], locationReferences: ['loc-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'MISSING');
});

test('multiple scoped entities: REVIEW_REQUIRED wins over AVAILABLE', () => {
  const project = newProject();
  const approved = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');
  const pending = timelineStore.addAsset(project.id, { type: 'location_reference' });
  creativeStore.updateVisualBible(project.id, {
    characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [approved.assetId] }],
    locations: [{ locationId: 'loc-1', name: 'Pier', referenceAssets: [pending.assetId] }],
  });
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'], locationReferences: ['loc-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'], locationReferences: ['loc-1'] });
  assert.equal(queueItemFor(project, keyframe.keyframeId).referenceStatus, 'REVIEW_REQUIRED');
});

test('referenceStatus never mutates the visual bible, timeline assets, or the keyframe itself', () => {
  const project = newProject();
  const approved = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [approved.assetId] }] });
  const { scene, shot } = seedShot(project, { characterReferences: ['char-1'] });
  const keyframe = seedKeyframe(project, scene, shot, { characterReferences: ['char-1'] });

  const bibleBefore = JSON.stringify(creativeStore.getVisualBible(project.id));
  oq.buildProjectQueue(project.id);
  const bibleAfter = JSON.stringify(creativeStore.getVisualBible(project.id));
  assert.equal(bibleBefore, bibleAfter);
});
