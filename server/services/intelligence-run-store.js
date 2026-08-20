// intelligence-run-store.js
//
// P0-INTEL — reads and writes IntelligenceRun files on disk. Exact same
// pattern as services/production-job-store.js (its own header is the
// direct precedent): one JSON file per run, named by its id.

const fs = require('fs');
const path = require('path');
const { createIntelligenceRun } = require('../schemas/intelligence-run-schema');

// Overridable for tests, same pattern as PRODUCTION_JOBS_DATA_DIR.
const INTELLIGENCE_RUNS_DIR = process.env.INTELLIGENCE_RUNS_DATA_DIR ? path.resolve(process.env.INTELLIGENCE_RUNS_DATA_DIR) : path.join(__dirname, '..', 'data', 'intelligence-runs');

fs.mkdirSync(INTELLIGENCE_RUNS_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function runFilePath(id) {
  return path.join(INTELLIGENCE_RUNS_DIR, `${id}.json`);
}

function saveRun(run) {
  fs.writeFileSync(runFilePath(run.intelligenceRunId), JSON.stringify(run, null, 2));
  return run;
}

function addIntelligenceRun(overrides = {}) {
  const run = createIntelligenceRun(overrides);
  return saveRun(run);
}

function getIntelligenceRun(id) {
  if (!isValidId(id)) return null;
  const filePath = runFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Optionally filter by projectId and/or status (a single status string, or
// an array — used by the orchestrator's own idempotency check for "any
// non-terminal run already in progress for this project").
function listIntelligenceRuns(filters = {}) {
  const files = fs.readdirSync(INTELLIGENCE_RUNS_DIR).filter((name) => name.endsWith('.json'));
  let runs = files.map((file) => JSON.parse(fs.readFileSync(path.join(INTELLIGENCE_RUNS_DIR, file), 'utf8')));

  if (filters.projectId) runs = runs.filter((run) => run.projectId === filters.projectId);
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    runs = runs.filter((run) => statuses.includes(run.status));
  }

  return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Full-record update — same rationale as production-job-store.js's own
// updateProductionJob: the orchestrator always holds the complete,
// current in-memory run object, so this replaces the whole persisted
// record rather than merging a partial patch. updatedAt is always
// stamped fresh here, never trusted from the caller.
function updateIntelligenceRun(id, updatedRun) {
  const existing = getIntelligenceRun(id);
  if (!existing) return null;
  const next = { ...existing, ...updatedRun, intelligenceRunId: id, updatedAt: new Date().toISOString() };
  return saveRun(next);
}

module.exports = {
  addIntelligenceRun,
  getIntelligenceRun,
  listIntelligenceRuns,
  updateIntelligenceRun,
  isValidId,
  INTELLIGENCE_RUNS_DIR,
};
