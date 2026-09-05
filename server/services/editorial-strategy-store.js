// editorial-strategy-store.js
//
// PHASE 1 EDITORIAL SPINE, Part 1 — persistence for EditorialStrategy
// records (schemas/editorial-strategy-schema.js). Same one-JSON-file-per-
// project convention every store in this codebase uses —
// `{ projectId, strategies: [] }`. Append-only (mirrors recommendation-
// store.js/creative-blueprint-store.js): creating a new ACTIVE strategy
// retires the previous one rather than overwriting it, so a project's
// strategic history is never lost.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const { createEditorialStrategy } = require('../schemas/editorial-strategy-schema');

const EDITORIAL_STRATEGY_DATA_DIR = process.env.EDITORIAL_STRATEGY_DATA_DIR
  ? path.resolve(process.env.EDITORIAL_STRATEGY_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'editorial-strategies');

fs.mkdirSync(EDITORIAL_STRATEGY_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(EDITORIAL_STRATEGY_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, strategies: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, strategies: [] };
}

function getStrategy(projectId, strategyId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.strategies.find((s) => s.id === strategyId) || null;
}

function listStrategies(projectId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.strategies.slice();
}

function getActiveStrategy(projectId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const active = library.strategies.filter((s) => s.status === 'ACTIVE');
  if (active.length === 0) return null;
  return active.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

// Creates a new ACTIVE strategy, retiring any prior ACTIVE one — a project
// has at most one ACTIVE strategy at a time, but every prior one stays on
// record (RETIRED, never deleted).
function addStrategy(projectId, input = {}) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `no project found with id "${projectId}"` };

  const strategy = createEditorialStrategy({ ...input, projectId, status: 'ACTIVE' });
  for (const existing of library.strategies) {
    if (existing.status === 'ACTIVE') existing.status = 'RETIRED';
  }
  library.strategies.push(JSON.parse(JSON.stringify(strategy)));
  saveLibrary(library);
  return { ok: true, strategy };
}

// Seeds a new strategy from a Project's own lightweight audience/tone
// labels (project-store.js's UPDATABLE_FIELDS) — an optional convenience,
// never the only way to create one. The Project fields are read once, at
// creation time, and never re-synced afterward: EditorialStrategy is its
// own record from that point on, not a live mirror of the Project.
function createStrategyFromProject(projectId, overrides = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, reason: `no project found with id "${projectId}"` };
  return addStrategy(projectId, {
    targetAudience: overrides.targetAudience !== undefined ? overrides.targetAudience : project.audience || '',
    ...overrides,
  });
}

module.exports = {
  EDITORIAL_STRATEGY_DATA_DIR,
  getStrategy,
  listStrategies,
  getActiveStrategy,
  addStrategy,
  createStrategyFromProject,
};
