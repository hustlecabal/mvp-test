// idea-store.js
//
// PHASE 1 EDITORIAL SPINE, Part 2 — persistence for IdeaSet records
// (schemas/idea-schema.js). Same one-JSON-file-per-project convention as
// recommendation-store.js — `{ projectId, ideaSets: [] }`, append-only.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const IDEA_DATA_DIR = process.env.IDEA_DATA_DIR ? path.resolve(process.env.IDEA_DATA_DIR) : path.join(__dirname, '..', 'data', 'ideas');

fs.mkdirSync(IDEA_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(IDEA_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, ideaSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, ideaSets: [] };
}

function getIdeaSet(projectId, ideaSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.ideaSets.find((s) => s.id === ideaSetId) || null;
}

function listIdeaSets(projectId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.ideaSets.slice();
}

function getLatestIdeaSetForStrategy(projectId, strategyId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.ideaSets.filter((s) => s.strategyId === strategyId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

function addIdeaSet(projectId, ideaSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `no project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(ideaSet));
  library.ideaSets.push(stored);
  saveLibrary(library);
  return { ok: true, ideaSet: stored };
}

// Records the human/system selection of one candidate within an IdeaSet —
// marks that candidate `selected: true` (others false) and the set
// `status: 'SELECTED'`. Never invents a candidate.
function selectIdea(projectId, ideaSetId, ideaId) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `no project found with id "${projectId}"` };
  const ideaSet = library.ideaSets.find((s) => s.id === ideaSetId);
  if (!ideaSet) return { ok: false, reason: `no IdeaSet found with id "${ideaSetId}"` };
  const candidate = ideaSet.candidates.find((c) => c.ideaId === ideaId);
  if (!candidate) return { ok: false, reason: `ideaId "${ideaId}" does not resolve to a candidate in IdeaSet "${ideaSetId}"` };
  for (const c of ideaSet.candidates) c.selected = c.ideaId === ideaId;
  ideaSet.selectedIdeaId = ideaId;
  ideaSet.status = 'SELECTED';
  saveLibrary(library);
  return { ok: true, ideaSet, idea: candidate };
}

// Finds one idea candidate by id, scanning every IdeaSet for this project
// (an ideaId is unique per project by construction — crypto.randomUUID()).
// Used by control-plane-service.js's editorial-spine readiness check.
function findIdeaCandidate(projectId, ideaId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  for (const ideaSet of library.ideaSets) {
    const candidate = ideaSet.candidates.find((c) => c.ideaId === ideaId);
    if (candidate) return { ideaSet, idea: candidate };
  }
  return null;
}

module.exports = {
  IDEA_DATA_DIR,
  getIdeaSet,
  listIdeaSets,
  getLatestIdeaSetForStrategy,
  addIdeaSet,
  selectIdea,
  findIdeaCandidate,
};
