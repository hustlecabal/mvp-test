// generation-store.js
//
// Reads and writes generation job files on disk. Each job is its own JSON
// file, named by its id — the same pattern project-store.js uses for
// projects, kept deliberately separate from project files so this store
// is reusable on its own and never risks touching an unrelated project.

const fs = require('fs');
const path = require('path');
const productionSchema = require('../schemas/production-schema');

// Where generation job files live. Can be overridden with an environment
// variable so tests can point this at a temporary, throwaway folder.
const GENERATION_JOBS_DIR = process.env.GENERATION_JOBS_DATA_DIR
  ? path.resolve(process.env.GENERATION_JOBS_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'generation-jobs');

fs.mkdirSync(GENERATION_JOBS_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function jobFilePath(id) {
  return path.join(GENERATION_JOBS_DIR, `${id}.json`);
}

function saveJob(job) {
  fs.writeFileSync(jobFilePath(job.id), JSON.stringify(job, null, 2));
}

function createGenerationJob(overrides = {}) {
  const job = productionSchema.createGenerationJob(overrides);
  saveJob(job);
  return job;
}

function getGenerationJob(id) {
  if (!isValidId(id)) return null;
  const filePath = jobFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Optionally filter by projectId, shotId, and/or status.
function listGenerationJobs(filters = {}) {
  const files = fs.readdirSync(GENERATION_JOBS_DIR).filter((name) => name.endsWith('.json'));
  let jobs = files.map((file) => JSON.parse(fs.readFileSync(path.join(GENERATION_JOBS_DIR, file), 'utf8')));

  if (filters.projectId) jobs = jobs.filter((job) => job.projectId === filters.projectId);
  if (filters.shotId) jobs = jobs.filter((job) => job.shotId === filters.shotId);
  if (filters.status) jobs = jobs.filter((job) => job.status === filters.status);

  return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Fields that can be changed after a job is created. Identity fields
// (id, projectId, shotId, provider, model, task, prompt, references,
// parameters, createdAt) are set once at creation and never rewritten.
const UPDATABLE_FIELDS = [
  'status',
  'providerTaskId',
  'progress',
  'estimatedCost',
  'reservedCost',
  'actualCost',
  'result',
  'assetId',
  'error',
  'lastPollError',
  'submittedAt',
  'completedAt',
  'failedAt',
  'timedOutAt',
];

function updateGenerationJob(id, updates = {}) {
  const job = getGenerationJob(id);
  if (!job) return null;

  for (const field of UPDATABLE_FIELDS) {
    if (updates[field] !== undefined) {
      job[field] = updates[field];
    }
  }

  saveJob(job);
  return job;
}

module.exports = {
  createGenerationJob,
  getGenerationJob,
  listGenerationJobs,
  updateGenerationJob,
  isValidId,
  GENERATION_JOBS_DIR,
};
