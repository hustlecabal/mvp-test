// Tests for services/creative-store.js's Stage 19 canonical-reference
// functions and services/reference-library-service.js's derived views.
// No provider, no network, no generation job is ever created here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reflib-creative-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const referenceLibrary = require('../services/reference-library-service');

function newProject() {
  return projectStore.createProject({ title: 'reference library test', topic: 'x' });
}

function seedCharacter(projectId, overrides = {}) {
  creativeStore.updateVisualBible(projectId, {
    characters: [{ characterId: 'char-1', name: 'Mira', identityConstraints: 'always has a scar', wardrobe: 'grey cloak', accessories: ['compass'], referenceAssets: [], ...overrides }],
  });
  return creativeStore.getVisualBible(projectId).characters[0];
}

function approvedAsset(projectId, { approvalStatus = 'APPROVED' } = {}) {
  const asset = timelineStore.addAsset(projectId, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, approvalStatus);
  return asset;
}

// --- addEntityReferenceAsset ------------------------------------------------------

test('addEntityReferenceAsset appends an asset id to the entity referenceAssets array', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);

  const entity = creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  assert.deepEqual(entity.referenceAssets, [asset.assetId]);
});

test('addEntityReferenceAsset is idempotent — adding the same asset twice does not duplicate it', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);

  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  const entity = creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  assert.deepEqual(entity.referenceAssets, [asset.assetId]);
});

test('addEntityReferenceAsset returns null for an unknown entity', () => {
  const project = newProject();
  seedCharacter(project.id);
  const result = creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'no-such-character', 'asset-x');
  assert.equal(result, null);
});

// --- selectCanonicalReferenceAsset -------------------------------------------------

test('selectCanonicalReferenceAsset selects an approved, associated asset as canonical', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);

  const result = creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId, { selectedBy: 'director' });
  assert.equal(result.ok, true);
  assert.equal(result.entity.canonicalReferenceAssetId, asset.assetId);
  assert.equal(result.entity.canonicalReferenceSelectedBy, 'director');
});

test('selectCanonicalReferenceAsset refuses an asset not associated with the entity (never fabricates the association)', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id); // never added via addEntityReferenceAsset

  const result = creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of this character's associated reference assets/);
});

test('selectCanonicalReferenceAsset refuses a REJECTED asset', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id, { approvalStatus: 'REJECTED' });
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);

  const result = creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /REJECTED/);
});

test('selectCanonicalReferenceAsset refuses an asset id that does not exist at all', () => {
  const project = newProject();
  seedCharacter(project.id);
  const result = creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', '00000000-0000-0000-0000-000000000000');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No asset found/);
});

test('selectCanonicalReferenceAsset refuses an unknown entity type', () => {
  const project = newProject();
  assert.throws(() => creativeStore.selectCanonicalReferenceAsset(project.id, 'VEHICLE', 'x', 'y'), /not a valid reference entity type/);
});

// --- canonical replacement + history (never overwritten, never deleted) -----------

test('selecting a new canonical archives the previous selection into canonicalReferenceHistory, never deletes it', () => {
  const project = newProject();
  seedCharacter(project.id);
  const assetA = approvedAsset(project.id);
  const assetB = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', assetA.assetId);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', assetB.assetId);

  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', assetA.assetId, { selectedBy: 'alice', changeNote: 'first pick' });
  const second = creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', assetB.assetId, { selectedBy: 'bob', changeNote: 'better one' });

  assert.equal(second.ok, true);
  assert.equal(second.entity.canonicalReferenceAssetId, assetB.assetId);
  assert.equal(second.entity.canonicalReferenceHistory.length, 1);
  assert.equal(second.entity.canonicalReferenceHistory[0].assetId, assetA.assetId);
  assert.equal(second.entity.canonicalReferenceHistory[0].selectedBy, 'alice');
  assert.ok(second.entity.canonicalReferenceHistory[0].supersededAt);
});

test('re-selecting the SAME asset again still records a history entry (never silently a no-op)', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);

  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId, { selectedBy: 'alice' });
  const again = creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId, { selectedBy: 'alice', changeNote: 're-confirm' });

  assert.equal(again.entity.canonicalReferenceHistory.length, 1);
  assert.equal(again.entity.canonicalReferenceHistory[0].assetId, asset.assetId);
});

test('never deletes a rejected reference asset id from referenceAssets — it stays visible', () => {
  const project = newProject();
  seedCharacter(project.id);
  const rejected = approvedAsset(project.id, { approvalStatus: 'REJECTED' });
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', rejected.assetId);

  const bible = creativeStore.getVisualBible(project.id);
  assert.deepEqual(bible.characters[0].referenceAssets, [rejected.assetId]);
});

// --- getCanonicalReferenceAsset ----------------------------------------------------

test('getCanonicalReferenceAsset returns canonicalAssetId: null and asset: null before any selection, never an error', () => {
  const project = newProject();
  seedCharacter(project.id);
  const result = creativeStore.getCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1');
  assert.equal(result.canonicalAssetId, null);
  assert.equal(result.asset, null);
});

test('getCanonicalReferenceAsset returns the resolved asset once one is selected', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);

  const result = creativeStore.getCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1');
  assert.equal(result.canonicalAssetId, asset.assetId);
  assert.equal(result.asset.assetId, asset.assetId);
});

// --- persistence / restart behaviour ------------------------------------------------

test('canonical selection persists across a fresh require of the store module (restart simulation)', () => {
  const project = newProject();
  seedCharacter(project.id);
  const asset = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId);
  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', asset.assetId, { selectedBy: 'alice' });

  delete require.cache[require.resolve('../services/creative-store')];
  const reloadedStore = require('../services/creative-store');
  const bible = reloadedStore.getVisualBible(project.id);
  assert.equal(bible.characters[0].canonicalReferenceAssetId, asset.assetId);
});

// --- Reference Library derived view -------------------------------------------------

test('listReferenceLibrary lists every character/location/prop, even with zero references (missing is visible, not omitted)', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, {
    characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [] }],
    locations: [{ locationId: 'loc-1', name: 'Pier', referenceAssets: [] }],
    props: [{ propId: 'prop-1', name: 'Compass', referenceAssets: [] }],
  });

  const library = referenceLibrary.listReferenceLibrary(project.id);
  assert.equal(library.entities.length, 3);
  const types = library.entities.map((e) => e.entityType).sort();
  assert.deepEqual(types, ['CHARACTER', 'LOCATION', 'PROP']);
  assert.deepEqual(library.entities.find((e) => e.entityType === 'CHARACTER').referenceAssets, []);
});

test('listReferenceLibrary returns null for a nonexistent project', () => {
  assert.equal(referenceLibrary.listReferenceLibrary('00000000-0000-0000-0000-000000000000'), null);
});

test('listReferenceLibrary marks the canonical asset within referenceAssets and counts approved/rejected/pending correctly', () => {
  const project = newProject();
  seedCharacter(project.id);
  const canonical = approvedAsset(project.id);
  const otherApproved = approvedAsset(project.id);
  const rejected = approvedAsset(project.id, { approvalStatus: 'REJECTED' });
  const pending = timelineStore.addAsset(project.id, { type: 'character_reference' }); // approvalStatus NONE

  for (const a of [canonical, otherApproved, rejected, pending]) {
    creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', a.assetId);
  }
  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-1', canonical.assetId);

  const library = referenceLibrary.listReferenceLibrary(project.id);
  const entry = library.entities.find((e) => e.entityId === 'char-1');
  assert.equal(entry.canonicalAssetId, canonical.assetId);
  assert.equal(entry.approvedCount, 2);
  assert.equal(entry.rejectedCount, 1);
  assert.equal(entry.pendingCount, 1);
  const canonicalEntry = entry.referenceAssets.find((a) => a.assetId === canonical.assetId);
  assert.equal(canonicalEntry.canonical, true);
  const otherEntry = entry.referenceAssets.find((a) => a.assetId === otherApproved.assetId);
  assert.equal(otherEntry.canonical, false);
});

test('listReferenceLibrary reports every generated asset that reused a reference (Part 6/7 reuse lineage)', () => {
  const project = newProject();
  seedCharacter(project.id);
  const reference = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', reference.assetId);

  const generated = timelineStore.addAsset(project.id, { type: 'keyframe', references: [reference.assetId], keyframeId: 'kf-1' });

  const library = referenceLibrary.listReferenceLibrary(project.id);
  const entry = library.entities.find((e) => e.entityId === 'char-1');
  const refEntry = entry.referenceAssets.find((a) => a.assetId === reference.assetId);
  assert.equal(refEntry.usedByAssets.length, 1);
  assert.equal(refEntry.usedByAssets[0].assetId, generated.assetId);
  assert.equal(refEntry.usedByAssets[0].keyframeId, 'kf-1');
});

test('listReferenceLibrary reports an empty usedByAssets for a reference nothing has used yet', () => {
  const project = newProject();
  seedCharacter(project.id);
  const reference = approvedAsset(project.id);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', reference.assetId);

  const library = referenceLibrary.listReferenceLibrary(project.id);
  const entry = library.entities.find((e) => e.entityId === 'char-1');
  assert.deepEqual(entry.referenceAssets.find((a) => a.assetId === reference.assetId).usedByAssets, []);
});

// --- Identity Lock derived view ------------------------------------------------------

test('getIdentityLock resolves character constraints and leaves environmentConstraints null', () => {
  const project = newProject();
  seedCharacter(project.id);
  const lock = referenceLibrary.getIdentityLock(project.id, 'CHARACTER', 'char-1');
  assert.equal(lock.entityName, 'Mira');
  assert.equal(lock.identityConstraints, 'always has a scar');
  assert.deepEqual(lock.wardrobeConstraints, { wardrobe: 'grey cloak', accessories: ['compass'] });
  assert.equal(lock.environmentConstraints, null);
});

test('getIdentityLock resolves location constraints and leaves identity/wardrobe null', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, {
    locations: [{ locationId: 'loc-1', name: 'Pier', architecture: 'wooden', lighting: 'foggy', referenceAssets: [] }],
  });
  const lock = referenceLibrary.getIdentityLock(project.id, 'LOCATION', 'loc-1');
  assert.equal(lock.identityConstraints, null);
  assert.equal(lock.wardrobeConstraints, null);
  assert.equal(lock.environmentConstraints.architecture, 'wooden');
  assert.equal(lock.environmentConstraints.lighting, 'foggy');
});

test('getIdentityLock only lists APPROVED assets in approvedReferenceAssetIds, excluding rejected/pending', () => {
  const project = newProject();
  seedCharacter(project.id);
  const approved = approvedAsset(project.id);
  const rejected = approvedAsset(project.id, { approvalStatus: 'REJECTED' });
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', approved.assetId);
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-1', rejected.assetId);

  const lock = referenceLibrary.getIdentityLock(project.id, 'CHARACTER', 'char-1');
  assert.deepEqual(lock.approvedReferenceAssetIds, [approved.assetId]);
});

test('getIdentityLock returns null for an unknown entity', () => {
  const project = newProject();
  seedCharacter(project.id);
  assert.equal(referenceLibrary.getIdentityLock(project.id, 'CHARACTER', 'no-such-id'), null);
});

// --- real smoke-test project isolation ------------------------------------------------

test('this test file uses only isolated temp directories, never the real server/data paths', () => {
  assert.notEqual(process.env.PROJECT_DATA_DIR, undefined);
  assert.ok(process.env.PROJECT_DATA_DIR.includes(require('os').tmpdir()));
  assert.doesNotMatch(process.env.PROJECT_DATA_DIR, /server[/\\]data[/\\]projects$/);
});

test('an entity built via the real creativeSchema.createCharacter() factory gets safe canonical defaults (never undefined)', () => {
  const creativeSchema = require('../schemas/creative-schema');
  const character = creativeSchema.createCharacter({ characterId: 'char-2', name: 'Test' });
  assert.equal(character.canonicalReferenceAssetId, null);
  assert.deepEqual(character.canonicalReferenceHistory, []);
});
