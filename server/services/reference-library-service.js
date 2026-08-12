// reference-library-service.js
//
// Stage 19, Part 1/3 — the REFERENCE LIBRARY and IDENTITY LOCK derived
// views. Neither is a new store: everything here is computed on read from
// the existing Visual Bible (services/creative-store.js) and Timeline IR
// asset records (services/timeline-store.js) — the same compute-on-read
// discipline Stage 14's Operator Queue already established. Nothing in
// this file writes anything; canonical selection itself is
// creative-store.js's job (selectCanonicalReferenceAsset), reused here,
// not reimplemented.
//
// THIS FILE NEVER MUTATES ANYTHING and never calls a provider, EvoLink,
// or the network — it cannot spend a credit even in principle.

const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const timelineStore = require('./timeline-store');
const { REFERENCE_ENTITY_TYPES } = require('../schemas/creative-schema');

// Builds a reverse index: reference assetId -> every OTHER asset in the
// project whose own `references` array names it (Part 6/7 — "see where a
// reference is being reused" / "inspect generated assets associated with
// a reference"). Built from a single timelineStore.listAssets() call,
// never one call per reference asset — same "exactly one store read"
// discipline as Operator Queue's buildProjectQueue.
function buildReusedByIndex(allAssets) {
  const index = new Map();
  for (const asset of allAssets) {
    for (const refId of asset.references || []) {
      const list = index.get(refId) || [];
      list.push(asset);
      index.set(refId, list);
    }
  }
  return index;
}

function summarizeReusingAsset(asset) {
  return {
    assetId: asset.assetId,
    keyframeId: asset.keyframeId,
    approvalStatus: asset.approvalStatus,
    generationId: asset.generationId,
    createdAt: asset.createdAt,
  };
}

// Resolves ONE asset id to a small, display-ready summary, or null if the
// asset no longer exists (defensive — referenceAssets should never point
// at a deleted asset since nothing in this codebase deletes assets, but
// this never crashes if it somehow did).
function summarizeAsset(projectId, assetId, canonicalAssetId, reusedByIndex) {
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) return null;
  return {
    assetId: asset.assetId,
    type: asset.type,
    approvalStatus: asset.approvalStatus,
    canonical: assetId === canonicalAssetId,
    provider: asset.provider,
    model: asset.model,
    generationId: asset.generationId,
    generationType: asset.generationType,
    promptPackageId: asset.promptPackageId,
    promptPackageVersion: asset.promptPackageVersion,
    storageStatus: asset.storage ? asset.storage.status : 'NOT_ARCHIVED',
    createdAt: asset.createdAt,
    // Part 6/7 — every generated asset that used THIS asset as a
    // reference (via its own `references` lineage field). Never
    // computed by re-scanning per reference — see buildReusedByIndex.
    usedByAssets: (reusedByIndex.get(assetId) || []).map(summarizeReusingAsset),
  };
}

// One Reference Library entry for a single entity (character/location/
// prop). `referenceAssets` preserves the entity's own referenceAssets
// ORDER — nothing is ever reordered, filtered, or deleted here, per Part
// 1's "never delete rejected or previous references."
function buildEntityLibraryEntry(projectId, entityType, entity, reusedByIndex) {
  const idField = creativeStore.ENTITY_TYPE_CONFIG[entityType].idField;
  const referenceAssets = (entity.referenceAssets || [])
    .map((assetId) => summarizeAsset(projectId, assetId, entity.canonicalReferenceAssetId, reusedByIndex))
    .filter(Boolean);

  return {
    entityType,
    entityId: entity[idField],
    entityName: entity.name || null,
    canonicalAssetId: entity.canonicalReferenceAssetId || null,
    canonicalAssetSelectedAt: entity.canonicalReferenceSelectedAt || null,
    canonicalAssetSelectedBy: entity.canonicalReferenceSelectedBy || null,
    referenceAssets,
    approvedCount: referenceAssets.filter((a) => a.approvalStatus === 'APPROVED').length,
    rejectedCount: referenceAssets.filter((a) => a.approvalStatus === 'REJECTED').length,
    pendingCount: referenceAssets.filter((a) => a.approvalStatus === 'NONE').length,
  };
}

// The full Reference Library for a project: one entry per character,
// location, and prop in the Visual Bible, regardless of whether it has
// any reference assets yet (an entity with zero references is still
// listed, with an empty referenceAssets array — "missing" is a real,
// visible state, never silently omitted). Returns null if the project
// doesn't exist.
function listReferenceLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  const safeBible = creativeStore.getVisualBible(projectId) || { characters: [], locations: [], props: [] };
  const reusedByIndex = buildReusedByIndex(timelineStore.listAssets(projectId) || []);

  const entities = [
    ...(safeBible.characters || []).map((c) => buildEntityLibraryEntry(projectId, 'CHARACTER', c, reusedByIndex)),
    ...(safeBible.locations || []).map((l) => buildEntityLibraryEntry(projectId, 'LOCATION', l, reusedByIndex)),
    ...(safeBible.props || []).map((p) => buildEntityLibraryEntry(projectId, 'PROP', p, reusedByIndex)),
  ];

  return { projectId, entities };
}

// The IDENTITY LOCK derived view for one entity (Part 3). Every field is
// selected straight from the existing Visual Bible entity — nothing new
// is stored, nothing is invented. `wardrobeConstraints`/
// `environmentConstraints` are null when not applicable to this entity
// type (a location has no wardrobe; a character has no environment).
function getIdentityLock(projectId, entityType, entityId) {
  const found = creativeStore.findReferenceEntity(projectId, entityType, entityId);
  if (!found) return null;
  const { entity } = found;
  const idField = creativeStore.ENTITY_TYPE_CONFIG[entityType].idField;

  return {
    entityId: entity[idField],
    entityType,
    entityName: entity.name || null,
    canonicalAssetId: entity.canonicalReferenceAssetId || null,
    approvedReferenceAssetIds: (entity.referenceAssets || []).filter((assetId) => {
      const asset = timelineStore.getAsset(projectId, assetId);
      return asset && asset.approvalStatus === 'APPROVED';
    }),
    identityConstraints: entityType === 'CHARACTER' ? entity.identityConstraints || null : null,
    wardrobeConstraints:
      entityType === 'CHARACTER' && (entity.wardrobe || (entity.accessories || []).length > 0)
        ? { wardrobe: entity.wardrobe || null, accessories: entity.accessories || [] }
        : null,
    environmentConstraints:
      entityType === 'LOCATION'
        ? {
            architecture: entity.architecture || null,
            geography: entity.geography || null,
            materials: entity.materials || null,
            colourPalette: entity.colourPalette || null,
            lighting: entity.lighting || null,
            atmosphere: entity.atmosphere || null,
            recurringElements: entity.recurringElements || [],
            continuityConstraints: entity.continuityConstraints || null,
          }
        : null,
    continuityNotes: entity.continuityNotes || null,
  };
}

module.exports = {
  REFERENCE_ENTITY_TYPES,
  listReferenceLibrary,
  getIdentityLock,
};
