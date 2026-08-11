// creative-store.js
//
// Stage 11A — reads and writes the creative-planning artifacts defined in
// schemas/creative-schema.js: Creative Brief, Master Creative Specification,
// Visual Bible, and Storyboard. One JSON file per project (a project has at
// most one of each artifact, so a single combined file is simpler than
// four), following the same "one file per id, same pattern everywhere"
// convention as project-store.js and generation-store.js.
//
// IMPORTANT (Part 11): nothing in this file ever touches
// services/approval-gate.js, services/generation-service.js, or the
// EvoLink provider. Creative planning is completely separate from
// generation approval/budget/execution — updating a storyboard, visual
// bible, or character can never approve a generation, spend a credit, or
// call a provider, because this file has no way to reach that code at all.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const creativeSchema = require('../schemas/creative-schema');

// Overridable for tests, same pattern as PROJECT_DATA_DIR/
// GENERATION_JOBS_DATA_DIR/ASSET_STORAGE_DIR.
const CREATIVE_DATA_DIR = process.env.CREATIVE_DATA_DIR
  ? path.resolve(process.env.CREATIVE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'creative');

fs.mkdirSync(CREATIVE_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function recordFilePath(projectId) {
  return path.join(CREATIVE_DATA_DIR, `${projectId}.json`);
}

function loadRecord(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = recordFilePath(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveRecord(record) {
  fs.writeFileSync(recordFilePath(record.projectId), JSON.stringify(record, null, 2));
}

function defaultRecord(projectId) {
  return {
    projectId,
    creativeBrief: null,
    masterCreativeSpec: null,
    visualBible: null,
    storyboard: null,
  };
}

// Loads a project's creative record, creating an empty (all-null) one on
// disk the first time it's touched — mirrors how a project itself always
// exists as a file the moment it's created. Returns null if the project
// itself (project-store.js) doesn't exist — creative artifacts always
// belong to a real project (Part 1/Part 22 project isolation).
function ensureRecord(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let record = loadRecord(projectId);
  if (!record) {
    record = defaultRecord(projectId);
    saveRecord(record);
  }
  return record;
}

// Part 9 — lightweight versioning shared by every artifact type below.
// Pushes the artifact's OWN current version metadata onto its `history`
// before overwriting any field, then bumps version/updatedAt/updatedBy/
// changeNote. Never touches id/projectId/version/history via `updates` —
// those are only ever set by this function itself.
const PROTECTED_FIELDS = new Set(['id', 'projectId', 'version', 'history']);

function applyVersionedUpdate(artifact, updates = {}, { updatedBy, changeNote } = {}) {
  artifact.history = artifact.history || [];
  artifact.history.push({
    version: artifact.version,
    updatedAt: artifact.updatedAt,
    updatedBy: artifact.updatedBy,
    changeNote: artifact.changeNote,
  });

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && !PROTECTED_FIELDS.has(key)) {
      artifact[key] = value;
    }
  }

  artifact.version += 1;
  artifact.updatedAt = new Date().toISOString();
  artifact.updatedBy = updatedBy || null;
  artifact.changeNote = changeNote || null;
  return artifact;
}

// Builds one get/update pair for a single-artifact-per-project field
// (creativeBrief, masterCreativeSpec, visualBible, storyboard), all of
// which share the exact same "create on first update, version on every
// update after that" behavior. This is the one place that logic is
// written, instead of once per artifact type.
function defineArtifact(fieldName, createFn) {
  function get(projectId) {
    const record = ensureRecord(projectId);
    if (!record) return null;
    return record[fieldName];
  }

  function update(projectId, updates = {}, { updatedBy, changeNote } = {}) {
    const record = ensureRecord(projectId);
    if (!record) return null;

    if (!record[fieldName]) {
      record[fieldName] = createFn({
        projectId,
        ...updates,
        updatedBy: updatedBy || null,
        changeNote: changeNote || null,
      });
    } else {
      applyVersionedUpdate(record[fieldName], updates, { updatedBy, changeNote });
    }

    saveRecord(record);
    return record[fieldName];
  }

  return { get, update };
}

const creativeBrief = defineArtifact('creativeBrief', creativeSchema.createCreativeBrief);
const masterCreativeSpec = defineArtifact('masterCreativeSpec', creativeSchema.createMasterCreativeSpec);
const visualBible = defineArtifact('visualBible', creativeSchema.createVisualBible);
const storyboardArtifact = defineArtifact('storyboard', creativeSchema.createStoryboard);

// Part 6/10 — convenience adders for storyboard scenes/shots. Each is
// treated as a deliberate storyboard update (Part 9): the storyboard's
// version bumps and a history entry is recorded, exactly as update_storyboard
// would, so no structural change to a storyboard goes untracked.
function addStoryboardScene(projectId, overrides = {}, { updatedBy, changeNote } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  if (!record.storyboard) {
    record.storyboard = creativeSchema.createStoryboard({ projectId });
  }
  const scene = creativeSchema.createStoryboardScene(overrides);
  applyVersionedUpdate(
    record.storyboard,
    { scenes: [...record.storyboard.scenes, scene] },
    { updatedBy, changeNote: changeNote || `Added scene "${scene.title || scene.sceneId}"` }
  );

  saveRecord(record);
  return scene;
}

function addStoryboardShot(projectId, overrides = {}, { updatedBy, changeNote } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  if (!record.storyboard) {
    record.storyboard = creativeSchema.createStoryboard({ projectId });
  }
  if (overrides.sceneId && !record.storyboard.scenes.some((s) => s.sceneId === overrides.sceneId)) {
    throw new Error(`Storyboard scene "${overrides.sceneId}" does not belong to project "${projectId}"`);
  }

  const shot = creativeSchema.createStoryboardShot(overrides);
  applyVersionedUpdate(
    record.storyboard,
    { shots: [...record.storyboard.shots, shot] },
    { updatedBy, changeNote: changeNote || `Added shot ${shot.shotId}` }
  );

  saveRecord(record);
  return shot;
}

module.exports = {
  CREATIVE_DATA_DIR,
  getCreativeBrief: creativeBrief.get,
  updateCreativeBrief: creativeBrief.update,
  getMasterCreativeSpec: masterCreativeSpec.get,
  updateMasterCreativeSpec: masterCreativeSpec.update,
  getVisualBible: visualBible.get,
  updateVisualBible: visualBible.update,
  getStoryboard: storyboardArtifact.get,
  updateStoryboard: storyboardArtifact.update,
  addStoryboardScene,
  addStoryboardShot,
};
