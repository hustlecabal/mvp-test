// identity-consistency-review-store.js
//
// Stage 19, Part 9 — persists IdentityConsistencyReview records
// (schemas/identity-consistency-review-schema.js): a human's structured
// 0-5 score across 8 identity dimensions for a generated asset, plus
// free-text notes. One JSON file per project — `{ projectId, reviews:
// { [assetId]: [review, review, ...] } }` — same "one file per project
// id" convention as every other store in this codebase.
//
// IMPORTANT: recording a review NEVER touches an asset's approvalStatus
// (services/timeline-store.js) or a keyframe's canonicalAssetId
// (services/keyframe-store.js) — this file has no import of, or path to,
// either of those write functions. Scoring and approving are two
// separate, deliberate human actions.
//
// Multiple reviews per asset are supported and NEVER overwritten or
// deleted (same "never delete, only ever append" rule Stage 13E's
// canonical-asset history already established) — a reviewer reconsidering
// or a second reviewer scoring the same asset both simply add a new
// entry; listReviews() returns the full history, getLatestReview() the
// most recent one.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const timelineStore = require('./timeline-store');
const {
  REVIEW_DIMENSIONS,
  MIN_SCORE,
  MAX_SCORE,
  createIdentityConsistencyReview,
} = require('../schemas/identity-consistency-review-schema');

const IDENTITY_CONSISTENCY_REVIEW_DATA_DIR = process.env.IDENTITY_CONSISTENCY_REVIEW_DATA_DIR
  ? path.resolve(process.env.IDENTITY_CONSISTENCY_REVIEW_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'identity-consistency-reviews');

fs.mkdirSync(IDENTITY_CONSISTENCY_REVIEW_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(IDENTITY_CONSISTENCY_REVIEW_DATA_DIR, `${projectId}.json`);
}

function loadRecord(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveRecord(record) {
  fs.writeFileSync(fileFor(record.projectId), JSON.stringify(record, null, 2));
}

function ensureRecord(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let record = loadRecord(projectId);
  if (!record) {
    record = { projectId, reviews: {} };
    saveRecord(record);
  }
  return record;
}

// Sums only the dimensions a reviewer actually scored (non-null) — a
// partially-scored review is allowed (nothing here forces every
// dimension to be filled in) and its total honestly reflects only what
// was scored, never treating a skipped dimension as a zero.
function computeTotal(scores) {
  const scored = REVIEW_DIMENSIONS.map((dim) => scores[dim]).filter((v) => typeof v === 'number');
  if (scored.length === 0) return null;
  return scored.reduce((sum, v) => sum + v, 0);
}

function validateScores(scores) {
  for (const [key, value] of Object.entries(scores || {})) {
    if (!REVIEW_DIMENSIONS.includes(key)) {
      throw new Error(`"${key}" is not a valid identity-consistency review dimension. Use one of: ${REVIEW_DIMENSIONS.join(', ')}`);
    }
    if (value !== null && value !== undefined && (typeof value !== 'number' || value < MIN_SCORE || value > MAX_SCORE || !Number.isInteger(value))) {
      throw new Error(`Score for "${key}" must be an integer between ${MIN_SCORE} and ${MAX_SCORE}, got ${value}.`);
    }
  }
}

// Records a new review for an asset. Returns the created review, or null
// if the project doesn't exist. Throws on an invalid dimension name or an
// out-of-range score (Part 9: this is a human-entered score, so it's
// worth rejecting nonsense input rather than silently storing it).
// Never validates the review AGAINST the asset's own recorded references
// — that cross-check, if ever wanted, is a caller/UI concern, not a
// storage-layer one.
function recordReview(projectId, assetId, { keyframeId, referenceAssetId, scores = {}, notes, reviewedBy } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) {
    throw new Error(`No asset found with id "${assetId}" in project "${projectId}"`);
  }

  validateScores(scores);
  const mergedScores = { ...createIdentityConsistencyReview().scores, ...scores };

  const review = createIdentityConsistencyReview({
    projectId,
    assetId,
    keyframeId: keyframeId || asset.keyframeId || null,
    referenceAssetId: referenceAssetId || null,
    scores: mergedScores,
    total: computeTotal(mergedScores),
    notes: notes || null,
    reviewedBy: reviewedBy || null,
    reviewedAt: new Date().toISOString(),
  });

  record.reviews[assetId] = [...(record.reviews[assetId] || []), review];
  saveRecord(record);
  return review;
}

// Every review ever recorded for an asset, oldest first — never deleted,
// never overwritten. Returns [] (not null) for an asset with no reviews
// yet, as long as the project itself exists; returns null only if the
// project doesn't exist.
function listReviews(projectId, assetId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  return record.reviews[assetId] || [];
}

// The most recently recorded review for an asset, or null if none exists
// yet (or the project doesn't exist).
function getLatestReview(projectId, assetId) {
  const reviews = listReviews(projectId, assetId);
  if (!reviews || reviews.length === 0) return null;
  return reviews[reviews.length - 1];
}

module.exports = {
  IDENTITY_CONSISTENCY_REVIEW_DATA_DIR,
  REVIEW_DIMENSIONS,
  recordReview,
  listReviews,
  getLatestReview,
};
