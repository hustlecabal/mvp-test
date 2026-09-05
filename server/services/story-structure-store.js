// story-structure-store.js
//
// PHASE 1 EDITORIAL SPINE, Part 5 — persistence for StoryStructure records
// (schemas/story-structure-schema.js). Same one-JSON-file-per-project
// convention as creative-blueprint-store.js — `{ projectId, storyStructures: [] }`.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const STORY_STRUCTURE_DATA_DIR = process.env.STORY_STRUCTURE_DATA_DIR
  ? path.resolve(process.env.STORY_STRUCTURE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'story-structures');

fs.mkdirSync(STORY_STRUCTURE_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(STORY_STRUCTURE_DATA_DIR, `${projectId}.json`);
}

function loadLibrary(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveLibrary(library) {
  fs.writeFileSync(fileFor(library.projectId), JSON.stringify(library, null, 2));
}

function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, storyStructures: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, storyStructures: [] };
}

function getStoryStructure(projectId, storyStructureId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.storyStructures.find((s) => s.id === storyStructureId) || null;
}

function listStoryStructures(projectId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.storyStructures.slice();
}

function getLatestStoryStructureForBlueprint(projectId, blueprintId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.storyStructures.filter((s) => s.blueprintId === blueprintId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

function addStoryStructure(projectId, storyStructure) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `no project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(storyStructure));
  library.storyStructures.push(stored);
  saveLibrary(library);
  return { ok: true, storyStructure: stored };
}

// Marks a StoryStructure AUTHORED once authorStoryboardFromStoryStructure()
// has turned its beats into real Storyboard shots. Never mutates beats/
// edges/corePromise — those stay exactly as derived.
function markAuthored(projectId, storyStructureId) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const storyStructure = library.storyStructures.find((s) => s.id === storyStructureId);
  if (!storyStructure) return null;
  storyStructure.status = 'AUTHORED';
  saveLibrary(library);
  return storyStructure;
}

module.exports = {
  STORY_STRUCTURE_DATA_DIR,
  getStoryStructure,
  listStoryStructures,
  getLatestStoryStructureForBlueprint,
  addStoryStructure,
  markAuthored,
};
