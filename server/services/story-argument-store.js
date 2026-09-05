// story-argument-store.js
//
// STORY ARCHITECTURE ENGINE — persistence for StoryArgumentSet records
// (schemas/story-argument-schema.js). Same one-JSON-file-per-project
// convention as idea-store.js/package-store.js — `{ projectId, storyArgumentSets: [] }`.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const STORY_ARGUMENT_DATA_DIR = process.env.STORY_ARGUMENT_DATA_DIR
  ? path.resolve(process.env.STORY_ARGUMENT_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'story-arguments');

fs.mkdirSync(STORY_ARGUMENT_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(STORY_ARGUMENT_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, storyArgumentSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, storyArgumentSets: [] };
}

function getStoryArgumentSet(projectId, storyArgumentSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.storyArgumentSets.find((s) => s.id === storyArgumentSetId) || null;
}

function listStoryArgumentSets(projectId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.storyArgumentSets.slice();
}

function getLatestStoryArgumentSetForBlueprint(projectId, blueprintId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.storyArgumentSets.filter((s) => s.blueprintId === blueprintId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

function addStoryArgumentSet(projectId, storyArgumentSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `no project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(storyArgumentSet));
  library.storyArgumentSets.push(stored);
  saveLibrary(library);
  return { ok: true, storyArgumentSet: stored };
}

// Finds one StoryArgument candidate by id, scanning every set for this
// project — same convenience pattern as idea-store.js's findIdeaCandidate.
function findStoryArgument(projectId, storyArgumentId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  for (const set of library.storyArgumentSets) {
    const candidate = set.candidates.find((c) => c.id === storyArgumentId);
    if (candidate) return { storyArgumentSet: set, storyArgument: candidate };
  }
  return null;
}

module.exports = {
  STORY_ARGUMENT_DATA_DIR,
  getStoryArgumentSet,
  listStoryArgumentSets,
  getLatestStoryArgumentSetForBlueprint,
  addStoryArgumentSet,
  findStoryArgument,
};
