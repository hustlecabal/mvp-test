// timeline-store.js
//
// Scene, shot, and asset operations. Scenes, shots, and assets all live as
// plain arrays inside a project's own JSON file (see
// schemas/production-schema.js for their shape), so this file reuses
// project-store.js's read/save functions rather than touching files
// itself — project-store.js stays the only file that talks to disk.

const projectStore = require('./project-store');
const productionSchema = require('../schemas/production-schema');

// Returns the created scene, or null if the project doesn't exist.
function addScene(projectId, overrides = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;

  const scene = productionSchema.createScene(overrides);
  project.scenes.push(scene);
  projectStore.touch(project);
  return scene;
}

// Returns the project's scenes, or null if the project doesn't exist.
function listScenes(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  return project.scenes;
}

// Returns the created shot, or null if the project doesn't exist. Throws
// if sceneId is given but doesn't belong to this project — a shot should
// never silently point at a scene that isn't really there.
function addShot(projectId, overrides = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;

  if (overrides.sceneId && !project.scenes.some((scene) => scene.sceneId === overrides.sceneId)) {
    throw new Error(`Scene "${overrides.sceneId}" does not belong to project "${projectId}"`);
  }

  const shot = productionSchema.createShot(overrides);
  project.shots.push(shot);
  projectStore.touch(project);
  return shot;
}

// Returns the shot, or null if the project or shot doesn't exist.
function getShot(projectId, shotId) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  return project.shots.find((shot) => shot.shotId === shotId) || null;
}

// Returns the project's shots (optionally filtered to one scene), or null
// if the project doesn't exist.
function listShots(projectId, { sceneId } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  if (sceneId) {
    return project.shots.filter((shot) => shot.sceneId === sceneId);
  }
  return project.shots;
}

// Returns the project's assets (optionally filtered to one shot), or null
// if the project doesn't exist. Nothing generates real assets yet, so this
// is typically an empty list at this stage.
function listAssets(projectId, { shotId } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  if (shotId) {
    return project.assets.filter((asset) => asset.shotId === shotId);
  }
  return project.assets;
}

// Returns the asset, or null if the project or asset doesn't exist.
function getAsset(projectId, assetId) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  return project.assets.find((asset) => asset.assetId === assetId) || null;
}

// Returns the created asset, or null if the project doesn't exist. Used by
// generation-service.js when a generation job completes — never called to
// edit an existing asset (see createNextAssetVersion in
// schemas/production-schema.js for how changes to an asset are handled).
function addAsset(projectId, overrides = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;

  const asset = productionSchema.createAsset({ ...overrides, projectId });
  project.assets.push(asset);
  projectStore.touch(project);
  return asset;
}

// Stage 9A — finds an asset by id WITHOUT already knowing its project
// (needed by the archive_asset/get_asset_download MCP tools and the
// download/preview HTTP endpoints, which only take an assetId). Scans
// every project's assets array; fine at this project's scale, and avoids
// introducing any kind of separate assets index/database.
function findAssetById(assetId) {
  for (const project of projectStore.listProjects()) {
    const asset = (project.assets || []).find((a) => a.assetId === assetId);
    if (asset) return { project, asset };
  }
  return null;
}

// Merges storageUpdates into an existing asset's `storage` sub-object
// in place (never touches any other asset field, so lineage — projectId,
// sceneId, shotId, generationId, provider, model, prompt, references — is
// always left exactly as it was). Backfills any storage field an older
// asset might be missing before applying updates. Returns the updated
// asset, or null if the project/asset doesn't exist.
function updateAssetStorage(projectId, assetId, storageUpdates = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;

  const asset = project.assets.find((a) => a.assetId === assetId);
  if (!asset) return null;

  asset.storage = { ...productionSchema.defaultAssetStorage(), ...(asset.storage || {}), ...storageUpdates };
  projectStore.touch(project);
  return asset;
}

module.exports = {
  addScene,
  listScenes,
  addShot,
  getShot,
  listShots,
  listAssets,
  getAsset,
  addAsset,
  findAssetById,
  updateAssetStorage,
};
