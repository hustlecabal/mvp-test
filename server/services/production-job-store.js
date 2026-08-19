// production-job-store.js
//
// P0-ORCH — reads and writes ProductionJob files on disk. Each job is its
// own JSON file, named by its id — the exact same pattern
// generation-store.js/keyframe-store.js already use, kept deliberately
// separate from project/creative/generation files so this store is
// reusable on its own and never risks touching an unrelated record.

const fs = require('fs');
const path = require('path');
const { createProductionJob } = require('../schemas/production-job-schema');

// Overridable for tests, same pattern as GENERATION_JOBS_DATA_DIR/
// CREATIVE_DATA_DIR/PROJECT_DATA_DIR/ASSET_STORAGE_DIR.
const PRODUCTION_JOBS_DIR = process.env.PRODUCTION_JOBS_DATA_DIR
  ? path.resolve(process.env.PRODUCTION_JOBS_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'production-jobs');

fs.mkdirSync(PRODUCTION_JOBS_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function jobFilePath(id) {
  return path.join(PRODUCTION_JOBS_DIR, `${id}.json`);
}

function saveJob(job) {
  fs.writeFileSync(jobFilePath(job.productionJobId), JSON.stringify(job, null, 2));
  return job;
}

function addProductionJob(overrides = {}) {
  const job = createProductionJob(overrides);
  return saveJob(job);
}

function getProductionJob(id) {
  if (!isValidId(id)) return null;
  const filePath = jobFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Optionally filter by projectId and/or status (a single status string, or
// an array of statuses — used by the orchestrator's own idempotency check
// for "any non-terminal job already running for this project").
function listProductionJobs(filters = {}) {
  const files = fs.readdirSync(PRODUCTION_JOBS_DIR).filter((name) => name.endsWith('.json'));
  let jobs = files.map((file) => JSON.parse(fs.readFileSync(path.join(PRODUCTION_JOBS_DIR, file), 'utf8')));

  if (filters.projectId) jobs = jobs.filter((job) => job.projectId === filters.projectId);
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    jobs = jobs.filter((job) => statuses.includes(job.status));
  }

  return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Full-record update — the orchestrator always has the complete, current
// in-memory job object (it built it via createProductionJob/previous
// updateProductionJob calls), so this replaces the whole persisted record
// rather than merging a partial patch. Matches this codebase's other
// "computed snapshot, caller owns the full shape" stores more than
// generation-store.js's own field-allowlist convention, because a
// ProductionJob's own shape (beatProgress[]/escalations[]/diagnostics[])
// grows incrementally in ways a fixed UPDATABLE_FIELDS list would fight,
// not because persistence discipline is any looser — `updatedAt` is always
// stamped fresh here, never trusted from the caller.
function updateProductionJob(id, updatedJob) {
  const existing = getProductionJob(id);
  if (!existing) return null;
  const next = { ...existing, ...updatedJob, productionJobId: id, updatedAt: new Date().toISOString() };
  return saveJob(next);
}

module.exports = {
  addProductionJob,
  getProductionJob,
  listProductionJobs,
  updateProductionJob,
  isValidId,
  PRODUCTION_JOBS_DIR,
};
