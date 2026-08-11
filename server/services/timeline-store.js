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

// Returns the project's assets, optionally filtered by any combination of
// scene, shot, generation, type, and storage status (Stage 9B's asset
// library — see docs/architecture/generation-history.md). Returns null if
// the project doesn't exist. Filtering stays simple on purpose: plain
// array .filter() calls, no query language or search engine.
function listAssets(projectId, { shotId, sceneId, generationId, type, storageStatus } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;

  let assets = project.assets;
  if (shotId) assets = assets.filter((asset) => asset.shotId === shotId);
  if (sceneId) assets = assets.filter((asset) => asset.sceneId === sceneId);
  if (generationId) assets = assets.filter((asset) => asset.generationId === generationId);
  if (type) assets = assets.filter((asset) => asset.type === type);
  if (storageStatus) {
    assets = assets.filter((asset) => (asset.storage ? asset.storage.status : 'NOT_ARCHIVED') === storageStatus);
  }
  return assets;
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

// Stage 9B — finds a shot by id WITHOUT already knowing its project
// (needed by get_shot_history, which only takes a shotId). Same reasoning
// and same scale tradeoff as findAssetById above.
function findShotById(shotId) {
  for (const project of projectStore.listProjects()) {
    const shot = (project.shots || []).find((s) => s.shotId === shotId);
    if (shot) return { project, shot };
  }
  return null;
}

// Stage 9B — candidate vs. approved assets (see
// docs/architecture/generation-history.md). Every asset already had an
// `approvalStatus` field (defaulting to 'NONE', meaning "a candidate,
// not yet reviewed") since Stage 5 — this is the smallest possible
// addition on top of that: a named set of valid values, and a setter that
// only ever touches this one field. It never deletes or overwrites an
// asset — a shot can have many candidate assets (one per generation
// attempt) and this only marks which one (if any) a human has approved.
const ASSET_APPROVAL_STATUSES = ['NONE', 'APPROVED', 'REJECTED'];

function setAssetApprovalStatus(projectId, assetId, approvalStatus) {
  if (!ASSET_APPROVAL_STATUSES.includes(approvalStatus)) {
    throw new Error(`"${approvalStatus}" is not a valid asset approval status. Use one of: ${ASSET_APPROVAL_STATUSES.join(', ')}`);
  }
  const project = projectStore.getProject(projectId);
  if (!project) return null;

  const asset = project.assets.find((a) => a.assetId === assetId);
  if (!asset) return null;

  asset.approvalStatus = approvalStatus;
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
  findShotById,
  ASSET_APPROVAL_STATUSES,
  setAssetApprovalStatus,
};
