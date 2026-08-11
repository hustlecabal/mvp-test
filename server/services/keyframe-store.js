// keyframe-store.js
//
// Stage 12 — reads and writes a project's Keyframe Plan (see
// schemas/keyframe-schema.js). One JSON file per project, following the
// exact "one file per project id" convention services/creative-store.js
// already uses for the Creative IR.
//
// IMPORTANT: nothing in this file ever touches services/approval-gate.js,
// services/generation-service.js, or the EvoLink provider. This file only
// reads/writes planning data about WHICH keyframes might be worth
// generating later — it never creates a generation job, spends a credit,
// or calls a provider, because it has no way to reach any of that code.
// The one cross-reference it does make — to services/creative-store.js,
// to read the current Storyboard version for stale detection (Part 17) —
// is read-only and stays within the creative-planning layer.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const timelineStore = require('./timeline-store');
const keyframeSchema = require('../schemas/keyframe-schema');

// Overridable for tests, same pattern as CREATIVE_DATA_DIR/PROJECT_DATA_DIR.
const KEYFRAME_DATA_DIR = process.env.KEYFRAME_DATA_DIR
  ? path.resolve(process.env.KEYFRAME_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'keyframes');

fs.mkdirSync(KEYFRAME_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function planFilePath(projectId) {
  return path.join(KEYFRAME_DATA_DIR, `${projectId}.json`);
}

function loadPlan(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = planFilePath(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function savePlan(plan) {
  fs.writeFileSync(planFilePath(plan.projectId), JSON.stringify(plan, null, 2));
}

// Loads a project's keyframe plan, creating an empty one on disk the first
// time it's touched. Returns null if the project itself doesn't exist —
// same rule creative-store.js's ensureRecord follows.
function ensurePlan(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let plan = loadPlan(projectId);
  if (!plan) {
    plan = keyframeSchema.createKeyframePlan({ projectId });
    savePlan(plan);
  }
  return plan;
}

// Part 9/17 — lightweight versioning, identical shape to
// creative-store.js's applyVersionedUpdate: push the plan's own current
// version metadata onto history, then bump version/updatedAt/updatedBy/
// changeNote. `keyframes` is a normal field here (like `scenes`/`shots` on
// a storyboard) — updates to it go through this same path.
const PROTECTED_FIELDS = new Set(['projectId', 'version', 'history']);

function applyVersionedUpdate(plan, updates = {}, { updatedBy, changeNote } = {}) {
  plan.history = plan.history || [];
  plan.history.push({
    version: plan.version,
    updatedAt: plan.updatedAt,
    updatedBy: plan.updatedBy,
    changeNote: plan.changeNote,
  });

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && !PROTECTED_FIELDS.has(key)) {
      plan[key] = value;
    }
  }

  plan.version += 1;
  plan.updatedAt = new Date().toISOString();
  plan.updatedBy = updatedBy || null;
  plan.changeNote = changeNote || null;
  return plan;
}

function getKeyframePlan(projectId) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;
  return { ...plan, keyframes: plan.keyframes.map((k) => attachStale(projectId, k)) };
}

// Stage 14, Part 13/20 — a cheap companion to getKeyframePlan() for a
// caller that only needs the Keyframe Plan's OWN version number (e.g.
// keyframe-prompt-service.js's attachLiveStatus, comparing a package's
// sourceKeyframePlanVersion against the current one). getKeyframePlan()
// itself is O(keyframe count) — it runs attachStale() (a storyboard read)
// per keyframe — so a caller that calls it once per PACKAGE while
// listing every package for a project turns an O(n) listing into O(n^2).
// This never touches attachStale at all.
function getKeyframePlanVersion(projectId) {
  const plan = ensurePlan(projectId);
  return plan ? plan.version : null;
}

function updateKeyframePlan(projectId, updates = {}, { updatedBy, changeNote } = {}) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;

  applyVersionedUpdate(plan, updates, { updatedBy, changeNote });
  savePlan(plan);
  return getKeyframePlan(projectId);
}

// Part 17 — stale detection. Compute-on-read, never persisted: compares
// the keyframe's recorded sourceShotVersion against the storyboard's
// CURRENT version. A keyframe with no sourceShotVersion recorded yet, or
// belonging to a project with no storyboard at all, is never marked stale
// — there is nothing to have drifted from.
function attachStale(projectId, keyframe) {
  const storyboard = creativeStore.getStoryboard(projectId);
  const currentStoryboardVersion = storyboard ? storyboard.version : null;
  const stale = Boolean(
    keyframe.sourceShotVersion != null && currentStoryboardVersion != null && keyframe.sourceShotVersion !== currentStoryboardVersion
  );
  return { ...keyframe, stale, currentStoryboardVersion };
}

// Part 14 — optionally filtered by shotId/sceneId/frameType/status. Same
// simple array-filter approach as timelineStore.listAssets.
function listKeyframes(projectId, { shotId, sceneId, frameType, status } = {}) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;

  let keyframes = plan.keyframes;
  if (shotId) keyframes = keyframes.filter((k) => k.shotId === shotId);
  if (sceneId) keyframes = keyframes.filter((k) => k.sceneId === sceneId);
  if (frameType) keyframes = keyframes.filter((k) => k.frameType === frameType);
  if (status) keyframes = keyframes.filter((k) => k.status === status);
  return keyframes.map((k) => attachStale(projectId, k));
}

function getKeyframe(projectId, keyframeId) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;
  const keyframe = plan.keyframes.find((k) => k.keyframeId === keyframeId);
  if (!keyframe) return null;
  return attachStale(projectId, keyframe);
}

// Adds one new keyframe to the plan. Counts as a plan update (Part 9): the
// plan's version bumps and a history entry is recorded, exactly like
// creative-store.js's addStoryboardShot bumping the storyboard.
function createKeyframe(projectId, overrides = {}, { updatedBy, changeNote } = {}) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;

  const keyframe = keyframeSchema.createKeyframe({ ...overrides, projectId });
  applyVersionedUpdate(
    plan,
    { keyframes: [...plan.keyframes, keyframe] },
    { updatedBy, changeNote: changeNote || `Added ${keyframe.frameType || 'keyframe'} for shot ${keyframe.shotId || 'unknown'}` }
  );
  savePlan(plan);
  return attachStale(projectId, keyframe);
}

// Updates one existing keyframe's fields in place. Never touches
// keyframeId/projectId even if present in `updates`. Returns the updated
// keyframe, or null if the project/plan/keyframe doesn't exist.
function updateKeyframe(projectId, keyframeId, updates = {}, { updatedBy, changeNote } = {}) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;

  const index = plan.keyframes.findIndex((k) => k.keyframeId === keyframeId);
  if (index === -1) return null;

  const updatedKeyframe = { ...plan.keyframes[index] };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key !== 'keyframeId' && key !== 'projectId') {
      updatedKeyframe[key] = value;
    }
  }

  const newKeyframes = [...plan.keyframes];
  newKeyframes[index] = updatedKeyframe;

  applyVersionedUpdate(plan, { keyframes: newKeyframes }, { updatedBy, changeNote });
  savePlan(plan);
  return attachStale(projectId, updatedKeyframe);
}

// Stage 13B — updates ONLY a keyframe's `status` field, WITHOUT bumping
// the Keyframe Plan's version or recording a history entry. Deliberately
// separate from updateKeyframe(): the generation-lifecycle transitions
// this is for (GENERATING while a provider call is in flight, GENERATED/
// APPROVED/REJECTED as its outcome — see services/keyframe-generation-
// service.js) are process bookkeeping, not a creative-planning edit. If
// plan-version bumps counted these, every generation attempt would
// immediately mark its own just-built prompt package STALE (Stage 13A's
// sourceKeyframePlanVersion check comparing against a plan version this
// same call just changed) even though nothing about the shot, storyboard,
// or keyframe's own creative content actually changed. A human editing a
// keyframe's real fields (frameType, subject, composition, ...) still
// always goes through the versioned updateKeyframe() above.
function setKeyframeGenerationStatus(projectId, keyframeId, status) {
  const plan = ensurePlan(projectId);
  if (!plan) return null;

  const index = plan.keyframes.findIndex((k) => k.keyframeId === keyframeId);
  if (index === -1) return null;

  plan.keyframes[index] = { ...plan.keyframes[index], status };
  savePlan(plan);
  return attachStale(projectId, plan.keyframes[index]);
}

// Stage 13E, Part 1 — canonical asset selection. Bookkeeping like
// setKeyframeGenerationStatus above (does not bump the plan's own
// version/history — see the schema comment for why), but keeps its OWN
// complete history so no prior selection is ever lost.
//
// Eligibility: the asset must exist and belong to this exact project +
// keyframe, and must NOT currently be REJECTED (Part 7 test 5 — a
// rejected asset can never become canonical). Beyond that, approval
// status is not a hard gate: an APPROVED or still-NONE (unreviewed) asset
// can be selected — "prefer APPROVED assets as eligible candidates" (Part
// 1) is a UI-ordering concern (see the Creative Director UI), not a
// stricter service-layer requirement. A currently-canonical asset that
// LATER becomes REJECTED is deliberately NOT auto-cleared here — this
// function is never called by the approval flow, so a human must
// explicitly call it again to pick a different one (Part 1: "canonical
// selection must be explicitly changed"). Selecting an asset never
// changes its approvalStatus.
function selectCanonicalKeyframeAsset(projectId, keyframeId, assetId, { selectedBy, changeNote } = {}) {
  const plan = ensurePlan(projectId);
  if (!plan) return { ok: false, reason: `No project found with id "${projectId}"` };

  const index = plan.keyframes.findIndex((k) => k.keyframeId === keyframeId);
  if (index === -1) return { ok: false, reason: `No keyframe found with id "${keyframeId}" in project "${projectId}"` };

  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) return { ok: false, reason: `No asset found with id "${assetId}" in project "${projectId}"` };
  if (asset.keyframeId !== keyframeId) {
    return { ok: false, reason: `Asset "${assetId}" does not belong to keyframe "${keyframeId}".` };
  }
  if (asset.approvalStatus === 'REJECTED') {
    return { ok: false, reason: `Asset "${assetId}" has been REJECTED and cannot be selected as canonical.` };
  }

  const keyframe = plan.keyframes[index];
  const history = keyframe.canonicalAssetHistory ? [...keyframe.canonicalAssetHistory] : [];
  // The PREVIOUS selection (if any) is archived, never discarded — even a
  // re-selection of the very same asset records a new history entry, so
  // "who chose this and when" is always fully reconstructable.
  if (keyframe.canonicalAssetId) {
    history.push({
      assetId: keyframe.canonicalAssetId,
      selectedAt: keyframe.canonicalAssetSelectedAt,
      selectedBy: keyframe.canonicalAssetSelectedBy,
      changeNote: keyframe.canonicalAssetChangeNote || null,
      supersededAt: new Date().toISOString(),
    });
  }

  plan.keyframes[index] = {
    ...keyframe,
    canonicalAssetId: assetId,
    canonicalAssetSelectedAt: new Date().toISOString(),
    canonicalAssetSelectedBy: selectedBy || null,
    canonicalAssetChangeNote: changeNote || null,
    canonicalAssetHistory: history,
  };
  savePlan(plan);
  return { ok: true, keyframe: attachStale(projectId, plan.keyframes[index]) };
}

// Read-only. Returns null only if the project/keyframe doesn't exist —
// a keyframe with no canonical selection yet still returns a real object
// with canonicalAssetId: null and asset: null, never an error.
function getCanonicalKeyframeAsset(projectId, keyframeId) {
  const keyframe = getKeyframe(projectId, keyframeId);
  if (!keyframe) return null;

  const asset = keyframe.canonicalAssetId ? timelineStore.getAsset(projectId, keyframe.canonicalAssetId) : null;
  return {
    keyframeId,
    canonicalAssetId: keyframe.canonicalAssetId,
    canonicalAssetSelectedAt: keyframe.canonicalAssetSelectedAt,
    canonicalAssetSelectedBy: keyframe.canonicalAssetSelectedBy,
    canonicalAssetChangeNote: keyframe.canonicalAssetChangeNote,
    canonicalAssetHistory: keyframe.canonicalAssetHistory || [],
    asset,
  };
}

// Stage 12 REST route /keyframes/:keyframeId — finds a keyframe by id
// WITHOUT already knowing its project. Same reasoning and scale tradeoff
// as timelineStore.findAssetById/findShotById.
function findKeyframeById(keyframeId) {
  for (const project of projectStore.listProjects()) {
    const plan = loadPlan(project.id);
    if (!plan) continue;
    const keyframe = plan.keyframes.find((k) => k.keyframeId === keyframeId);
    if (keyframe) return { project, keyframe: attachStale(project.id, keyframe) };
  }
  return null;
}

module.exports = {
  KEYFRAME_DATA_DIR,
  getKeyframePlan,
  getKeyframePlanVersion,
  updateKeyframePlan,
  setKeyframeGenerationStatus,
  listKeyframes,
  getKeyframe,
  createKeyframe,
  updateKeyframe,
  findKeyframeById,
  selectCanonicalKeyframeAsset,
  getCanonicalKeyframeAsset,
};
