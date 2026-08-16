// Tests for services/cross-video-pattern-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cvpstore-projects-'));
process.env.CROSS_VIDEO_PATTERN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cvpstore-'));

const projectStore = require('../services/project-store');
const patternStore = require('../services/cross-video-pattern-store');
const { createPatternSet, createPattern, createPatternReview } = require('../schemas/cross-video-pattern-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addPatternSet fails for a non-existent project', () => {
  const result = patternStore.addPatternSet('00000000-0000-4000-8000-000000000000', createPatternSet());
  assert.equal(result.ok, false);
});

test('2. addPatternSet stores a set and getPatternSet retrieves it by id', () => {
  const project = newProject();
  const set = createPatternSet({ projectId: project.id, referenceSetId: 'rs1', status: 'COMPLETE' });
  const result = patternStore.addPatternSet(project.id, set);
  assert.equal(result.ok, true);
  assert.equal(patternStore.getPatternSet(project.id, result.patternSet.id).status, 'COMPLETE');
});

test('3. addPatternSet stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const set = createPatternSet({ projectId: project.id, referenceSetId: 'rs1', status: 'COMPLETE' });
  patternStore.addPatternSet(project.id, set);
  set.status = 'CORRUPTED';
  assert.equal(patternStore.listPatternSets(project.id)[0].status, 'COMPLETE');
});

test('4. listPatternSets returns null for a non-existent project, [] for one with none yet', () => {
  assert.equal(patternStore.listPatternSets('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(patternStore.listPatternSets(project.id), []);
});

test('5. listPatternSets filters by referenceSetId when given', () => {
  const project = newProject();
  patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs1' }));
  patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs2' }));
  assert.equal(patternStore.listPatternSets(project.id, { referenceSetId: 'rs1' }).length, 1);
  assert.equal(patternStore.listPatternSets(project.id).length, 2);
});

test('6. getLatestPatternSetForReferenceSet returns the most recently created set for that reference set only', () => {
  const project = newProject();
  patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs1', createdAt: '2020-01-01T00:00:00.000Z' }));
  const second = patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs1', createdAt: '2021-01-01T00:00:00.000Z' }));
  patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs2', createdAt: '2022-01-01T00:00:00.000Z' }));
  const latest = patternStore.getLatestPatternSetForReferenceSet(project.id, 'rs1');
  assert.equal(latest.id, second.patternSet.id);
});

test('7. getLatestPatternSetForReferenceSet returns null when no set exists for that reference set', () => {
  const project = newProject();
  assert.equal(patternStore.getLatestPatternSetForReferenceSet(project.id, 'nope'), null);
});

test('8. updatePatternReviewState updates only status/reviews[] of one pattern, leaving statement/prevalence/support untouched', () => {
  const project = newProject();
  const pattern = createPattern({ statement: 'original statement', prevalence: { supportingCount: 3, totalCount: 3, percentage: 100 } });
  const saved = patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs1', patterns: [pattern] }));
  const updated = patternStore.updatePatternReviewState(project.id, saved.patternSet.id, pattern.id, {
    status: 'ACCEPTED',
    review: createPatternReview({ decision: 'ACCEPT', reviewedBy: 'human1' }),
  });
  assert.equal(updated.status, 'ACCEPTED');
  assert.equal(updated.reviews.length, 1);
  assert.equal(updated.statement, 'original statement');
  assert.deepEqual(updated.prevalence, { supportingCount: 3, totalCount: 3, percentage: 100 });
});

test('9. updatePatternReviewState returns null for a non-existent PatternSet or pattern', () => {
  const project = newProject();
  const pattern = createPattern();
  const saved = patternStore.addPatternSet(project.id, createPatternSet({ projectId: project.id, referenceSetId: 'rs1', patterns: [pattern] }));
  assert.equal(patternStore.updatePatternReviewState(project.id, '11111111-1111-4111-8111-111111111111', pattern.id, { status: 'ACCEPTED' }), null);
  assert.equal(patternStore.updatePatternReviewState(project.id, saved.patternSet.id, '11111111-1111-4111-8111-111111111111', { status: 'ACCEPTED' }), null);
});

test('10. two different projects never see each other\'s pattern sets', () => {
  const projectA = newProject();
  const projectB = newProject();
  patternStore.addPatternSet(projectA.id, createPatternSet({ projectId: projectA.id, referenceSetId: 'rs1' }));
  assert.deepEqual(patternStore.listPatternSets(projectB.id), []);
});
