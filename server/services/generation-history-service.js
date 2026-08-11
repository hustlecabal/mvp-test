// generation-history-service.js
//
// Stage 9B — a read-only PRESENTATION layer over data that already exists:
// generation jobs (services/generation-store.js) and the assets they
// produced (services/timeline-store.js). This file never writes anything
// and never calls a provider — it only reads and combines. See
// docs/architecture/generation-history.md.
//
// "Combine without duplicating" means: a history record is built fresh,
// on every call, straight from the underlying job/asset records — nothing
// here is ever saved back to disk as its own copy.

const projectStore = require('./project-store');
const generationStore = require('./generation-store');
const timelineStore = require('./timeline-store');

const TERMINAL_FAILURE_STATUSES = ['FAILED', 'CANCELLED', 'TIMED_OUT'];
const IN_PROGRESS_STATUSES = ['REQUESTED', 'SUBMITTED', 'PROCESSING'];

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Turns one generation job into one history record. Every cost field is
// copied through exactly as the job has it — `null` stays `null` (unknown),
// never coerced to 0. See Part 2 of the Stage 9B task for the target shape.
function buildHistoryRecord(job) {
  let assetType = null;
  let storageStatus = null;
  let assetApprovalStatus = null;
  let previewUrl = null;
  let downloadUrl = null;

  if (job.assetId) {
    const asset = timelineStore.getAsset(job.projectId, job.assetId);
    if (asset) {
      assetType = asset.type;
      storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
      assetApprovalStatus = asset.approvalStatus || 'NONE';
      // Only claim a working preview/download URL once the file is
      // actually archived — otherwise those endpoints would just 409.
      if (asset.storage && asset.storage.status === 'STORED') {
        previewUrl = `/assets/${asset.assetId}/preview`;
        downloadUrl = `/assets/${asset.assetId}/download`;
      }
    }
  }

  return {
    generationId: job.id,
    projectId: job.projectId,
    sceneId: job.sceneId,
    shotId: job.shotId,
    provider: job.provider,
    model: job.model,
    task: job.task,
    status: job.status,
    prompt: job.prompt,
    // Generic, provider-agnostic passthrough of whatever request
    // parameters this job was submitted with (e.g. EvoLink's duration/
    // quality/aspectRatio — see evolink-mapper.js). This file never
    // hardcodes a provider-specific field name; a different provider's
    // history would simply carry its own parameter shape here.
    parameters: job.parameters || {},
    providerTaskId: job.providerTaskId,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt,
    reservedCost: job.reservedCost,
    actualCost: job.actualCost,
    assetId: job.assetId,
    assetType,
    storageStatus,
    assetApprovalStatus,
    previewUrl,
    downloadUrl,
  };
}

// Every generation attempt for a project, newest first (generationStore
// already sorts this way) — nothing is ever filtered out or overwritten,
// so a shot's full history (bad take, better take, approved take, ...)
// stays intact. Returns null if the project doesn't exist.
function listGenerationHistory(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  return generationStore.listGenerationJobs({ projectId }).map(buildHistoryRecord);
}

// One specific generation's history record, scoped to a project (so a
// generationId can't accidentally be read across projects). Returns null
// if the project doesn't exist, the generation doesn't exist, or the
// generation belongs to a different project.
function getGenerationHistory(projectId, generationId) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  const job = generationStore.getGenerationJob(generationId);
  if (!job || job.projectId !== projectId) return null;
  return buildHistoryRecord(job);
}

// Every generation attempt for one shot, across however many separate
// generations were made for it. Returns null if the shot doesn't exist.
function listShotHistory(shotId) {
  const found = timelineStore.findShotById(shotId);
  if (!found) return null;
  return generationStore.listGenerationJobs({ projectId: found.project.id, shotId }).map(buildHistoryRecord);
}

// Rolls a list of history records up into the summary shape
// list_generation_history returns. `totalReservedCredits` is null (not 0)
// when no generation in the list has a known reservedCost — summing zero
// known values is not the same fact as "zero credits reserved".
function summarizeGenerationHistory(records) {
  const completedCount = records.filter((r) => r.status === 'COMPLETED').length;
  const failedCount = records.filter((r) => TERMINAL_FAILURE_STATUSES.includes(r.status)).length;
  const processingCount = records.filter((r) => IN_PROGRESS_STATUSES.includes(r.status)).length;

  const knownReservedCosts = records.map((r) => r.reservedCost).filter((c) => typeof c === 'number');
  const totalReservedCredits = knownReservedCosts.length > 0 ? round2(knownReservedCosts.reduce((a, b) => a + b, 0)) : null;

  const assetsAvailable = records.filter((r) => Boolean(r.assetId)).length;

  return {
    generations: records,
    totalCount: records.length,
    completedCount,
    failedCount,
    processingCount,
    totalReservedCredits,
    assetsAvailable,
  };
}

module.exports = {
  listGenerationHistory,
  getGenerationHistory,
  listShotHistory,
  summarizeGenerationHistory,
};
