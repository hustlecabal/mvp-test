// identity-consistency-review-schema.js
//
// Stage 19, Part 9 — a lightweight, structured HUMAN-review record for a
// generated asset, scored across the same 8 dimensions Stage 18's manual
// A/B experiment used. This is explicitly NOT computer vision — every
// field here is filled in by a human (or an agent acting on a human's
// behalf), never computed from pixels. Recording a review NEVER changes
// an asset's approvalStatus (services/timeline-store.js) — scoring and
// approving are two separate, deliberate actions, same separation Stage
// 13B already established between generation and approval.
//
// Same rules as every other schema file in this codebase: plain object
// factories only, no file I/O, nothing invents information — a field a
// reviewer didn't fill in stays null, never guessed.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// The exact 8 dimensions from Stage 18's docs/integrations/
// reference-conditioning-experiment.md scoring table, in the same order.
const REVIEW_DIMENSIONS = [
  'headFaceGeometry',
  'hairHeadOrnament',
  'clothing',
  'colourPalette',
  'eyesFacialCharacteristics',
  'distinctiveAccessory',
  'silhouette',
  'overallIdentityResemblance',
];

const MIN_SCORE = 0;
const MAX_SCORE = 5;

function createEmptyScores() {
  const scores = {};
  for (const dim of REVIEW_DIMENSIONS) scores[dim] = null;
  return scores;
}

function createIdentityConsistencyReview(overrides = {}) {
  const base = {
    reviewId: crypto.randomUUID(),
    projectId: null,
    assetId: null,
    keyframeId: null,
    // Which reference (if any) this review is judging the asset AGAINST —
    // purely informational, never validated against the asset's own
    // recorded `references` lineage by this schema (that cross-check, if
    // ever wanted, belongs in the service layer, not here).
    referenceAssetId: null,
    scores: createEmptyScores(),
    total: null, // derived by the service layer (sum of non-null scores), never invented here
    notes: null,
    reviewedBy: null,
    reviewedAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  REVIEW_DIMENSIONS,
  MIN_SCORE,
  MAX_SCORE,
  createEmptyScores,
  createIdentityConsistencyReview,
};
