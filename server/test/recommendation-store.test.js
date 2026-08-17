// Tests for services/recommendation-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-recstore-projects-'));
process.env.RECOMMENDATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-recstore-'));

const projectStore = require('../services/project-store');
const recommendationStore = require('../services/recommendation-store');
const { createRecommendationSet, createRecommendation, createRecommendationReview } = require('../schemas/recommendation-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addRecommendationSet fails for a non-existent project', () => {
  const result = recommendationStore.addRecommendationSet('00000000-0000-4000-8000-000000000000', createRecommendationSet());
  assert.equal(result.ok, false);
});

test('2. addRecommendationSet stores a set and getRecommendationSet retrieves it by id', () => {
  const project = newProject();
  const set = createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', status: 'COMPLETE' });
  const result = recommendationStore.addRecommendationSet(project.id, set);
  assert.equal(result.ok, true);
  assert.equal(recommendationStore.getRecommendationSet(project.id, result.recommendationSet.id).status, 'COMPLETE');
});

test('3. addRecommendationSet stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const set = createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', status: 'COMPLETE' });
  recommendationStore.addRecommendationSet(project.id, set);
  set.status = 'CORRUPTED';
  assert.equal(recommendationStore.listRecommendationSets(project.id)[0].status, 'COMPLETE');
});

test('4. listRecommendationSets returns null for a non-existent project, [] for one with none yet', () => {
  assert.equal(recommendationStore.listRecommendationSets('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(recommendationStore.listRecommendationSets(project.id), []);
});

test('5. listRecommendationSets filters by referenceSetId when given', () => {
  const project = newProject();
  recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1' }));
  recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs2' }));
  assert.equal(recommendationStore.listRecommendationSets(project.id, { referenceSetId: 'rs1' }).length, 1);
  assert.equal(recommendationStore.listRecommendationSets(project.id).length, 2);
});

test('6. getLatestRecommendationSetForReferenceSet returns the most recently created set for that reference set only', () => {
  const project = newProject();
  recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', createdAt: '2020-01-01T00:00:00.000Z' }));
  const second = recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', createdAt: '2021-01-01T00:00:00.000Z' }));
  recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs2', createdAt: '2022-01-01T00:00:00.000Z' }));
  const latest = recommendationStore.getLatestRecommendationSetForReferenceSet(project.id, 'rs1');
  assert.equal(latest.id, second.recommendationSet.id);
});

test('7. getLatestRecommendationSetForReferenceSet returns null when no set exists for that reference set', () => {
  const project = newProject();
  assert.equal(recommendationStore.getLatestRecommendationSetForReferenceSet(project.id, 'nope'), null);
});

test('8. updateRecommendationReviewState updates only status/reviews[] of one recommendation, leaving statement/rationale/action/prevalence untouched', () => {
  const project = newProject();
  const recommendation = createRecommendation({ statement: 'original statement', rationale: 'original rationale', action: 'original action', prevalence: { supportingCount: 3, totalCount: 3, percentage: 100 } });
  const saved = recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', recommendations: [recommendation] }));
  const updated = recommendationStore.updateRecommendationReviewState(project.id, saved.recommendationSet.id, recommendation.id, {
    status: 'ACCEPTED',
    review: createRecommendationReview({ decision: 'ACCEPT', reviewedBy: 'human1' }),
  });
  assert.equal(updated.status, 'ACCEPTED');
  assert.equal(updated.reviews.length, 1);
  assert.equal(updated.statement, 'original statement');
  assert.equal(updated.rationale, 'original rationale');
  assert.equal(updated.action, 'original action');
  assert.deepEqual(updated.prevalence, { supportingCount: 3, totalCount: 3, percentage: 100 });
});

test('9. updateRecommendationReviewState returns null for a non-existent RecommendationSet or recommendation', () => {
  const project = newProject();
  const recommendation = createRecommendation();
  const saved = recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', recommendations: [recommendation] }));
  assert.equal(recommendationStore.updateRecommendationReviewState(project.id, '11111111-1111-4111-8111-111111111111', recommendation.id, { status: 'ACCEPTED' }), null);
  assert.equal(recommendationStore.updateRecommendationReviewState(project.id, saved.recommendationSet.id, '11111111-1111-4111-8111-111111111111', { status: 'ACCEPTED' }), null);
});

test('10. addRecommendation appends a new recommendation into an EXISTING RecommendationSet, never creating a new set', () => {
  const project = newProject();
  const saved = recommendationStore.addRecommendationSet(project.id, createRecommendationSet({ projectId: project.id, referenceSetId: 'rs1', recommendations: [createRecommendation({ statement: 'first' })] }));
  const added = recommendationStore.addRecommendation(project.id, saved.recommendationSet.id, createRecommendation({ statement: 'edited-second' }));
  assert.equal(added.ok, true);
  assert.equal(recommendationStore.listRecommendationSets(project.id).length, 1);
  assert.equal(recommendationStore.getRecommendationSet(project.id, saved.recommendationSet.id).recommendations.length, 2);
});

test('11. addRecommendation fails for a non-existent RecommendationSet', () => {
  const project = newProject();
  const result = recommendationStore.addRecommendation(project.id, '11111111-1111-4111-8111-111111111111', createRecommendation());
  assert.equal(result.ok, false);
});

test('12. two different projects never see each other\'s recommendation sets', () => {
  const projectA = newProject();
  const projectB = newProject();
  recommendationStore.addRecommendationSet(projectA.id, createRecommendationSet({ projectId: projectA.id, referenceSetId: 'rs1' }));
  assert.deepEqual(recommendationStore.listRecommendationSets(projectB.id), []);
});
