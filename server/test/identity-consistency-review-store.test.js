// Tests for services/identity-consistency-review-store.js — Stage 19,
// Part 9. A lightweight, human-entered structured review, NEVER computer
// vision, and NEVER touching an asset's approvalStatus.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-review-projects-'));
const reviewTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-review-store-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.IDENTITY_CONSISTENCY_REVIEW_DATA_DIR = reviewTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const reviewStore = require('../services/identity-consistency-review-store');

function newProject() {
  return projectStore.createProject({ title: 'review store test', topic: 'x' });
}

function newAsset(projectId) {
  return timelineStore.addAsset(projectId, { type: 'keyframe' });
}

// --- recording ---------------------------------------------------------------------

test('recordReview stores a full 8-dimension score and computes the total', () => {
  const project = newProject();
  const asset = newAsset(project.id);

  const review = reviewStore.recordReview(project.id, asset.assetId, {
    scores: {
      headFaceGeometry: 4,
      hairHeadOrnament: 4,
      clothing: 3,
      colourPalette: 4,
      eyesFacialCharacteristics: 5,
      distinctiveAccessory: 4,
      silhouette: 4,
      overallIdentityResemblance: 4,
    },
    notes: 'strong match',
    reviewedBy: 'director',
  });

  assert.equal(review.total, 32);
  assert.equal(review.notes, 'strong match');
  assert.equal(review.reviewedBy, 'director');
  assert.equal(review.assetId, asset.assetId);
});

test('recordReview allows a PARTIAL score, totalling only the dimensions actually scored', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  const review = reviewStore.recordReview(project.id, asset.assetId, { scores: { headFaceGeometry: 3, clothing: 2 } });
  assert.equal(review.total, 5);
  assert.equal(review.scores.eyesFacialCharacteristics, null);
});

test('recordReview rejects an out-of-range score', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  assert.throws(() => reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 6 } }), /must be an integer between 0 and 5/);
  assert.throws(() => reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: -1 } }), /must be an integer between 0 and 5/);
  assert.throws(() => reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 2.5 } }), /must be an integer between 0 and 5/);
});

test('recordReview rejects an unknown dimension name', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  assert.throws(() => reviewStore.recordReview(project.id, asset.assetId, { scores: { madeUpDimension: 3 } }), /not a valid identity-consistency review dimension/);
});

test('recordReview throws for an asset that does not exist', () => {
  const project = newProject();
  assert.throws(() => reviewStore.recordReview(project.id, '00000000-0000-0000-0000-000000000000', { scores: {} }), /No asset found/);
});

test('recordReview returns null for a nonexistent project', () => {
  const result = reviewStore.recordReview('00000000-0000-0000-0000-000000000000', 'x', { scores: {} });
  assert.equal(result, null);
});

// --- never touches approval status --------------------------------------------------

test('recordReview never changes the reviewed asset\'s approvalStatus', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  assert.equal(asset.approvalStatus, 'NONE');

  reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 5 } });

  const reloaded = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(reloaded.approvalStatus, 'NONE');
});

test('identity-consistency-review-store.js never requires timeline-store.js\'s approval setter', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'identity-consistency-review-store.js'), 'utf8');
  assert.doesNotMatch(text, /setAssetApprovalStatus/);
});

// --- multiple reviews, never deleted -------------------------------------------------

test('multiple reviews on the same asset are all preserved, never overwritten', () => {
  const project = newProject();
  const asset = newAsset(project.id);

  reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 2 }, reviewedBy: 'alice' });
  reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 4 }, reviewedBy: 'bob' });

  const reviews = reviewStore.listReviews(project.id, asset.assetId);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].reviewedBy, 'alice');
  assert.equal(reviews[1].reviewedBy, 'bob');
});

test('getLatestReview returns the most recently recorded review', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 2 }, reviewedBy: 'alice' });
  reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 4 }, reviewedBy: 'bob' });

  const latest = reviewStore.getLatestReview(project.id, asset.assetId);
  assert.equal(latest.reviewedBy, 'bob');
});

test('listReviews returns [] (not null) for an asset with no reviews yet', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  assert.deepEqual(reviewStore.listReviews(project.id, asset.assetId), []);
});

test('getLatestReview returns null for an asset with no reviews yet', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  assert.equal(reviewStore.getLatestReview(project.id, asset.assetId), null);
});

test('reviews never leak between projects', () => {
  const projectA = newProject();
  const projectB = newProject();
  const assetA = newAsset(projectA.id);
  reviewStore.recordReview(projectA.id, assetA.assetId, { scores: { clothing: 3 } });

  assert.deepEqual(reviewStore.listReviews(projectB.id, assetA.assetId), []);
});

// --- persistence / restart behaviour ------------------------------------------------

test('reviews persist across a fresh require of the store module (restart simulation)', () => {
  const project = newProject();
  const asset = newAsset(project.id);
  reviewStore.recordReview(project.id, asset.assetId, { scores: { clothing: 3 }, reviewedBy: 'alice' });

  delete require.cache[require.resolve('../services/identity-consistency-review-store')];
  const reloadedStore = require('../services/identity-consistency-review-store');
  const reviews = reloadedStore.listReviews(project.id, asset.assetId);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewedBy, 'alice');
});
