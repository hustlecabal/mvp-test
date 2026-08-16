// Tests for services/reference-video-interpretation-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvistore-projects-'));
process.env.REFERENCE_VIDEO_INTERPRETATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvistore-'));

const projectStore = require('../services/project-store');
const interpretationStore = require('../services/reference-video-interpretation-store');
const { createInterpretation } = require('../schemas/reference-video-interpretation-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addInterpretation fails for a non-existent project', () => {
  const result = interpretationStore.addInterpretation('00000000-0000-4000-8000-000000000000', createInterpretation());
  assert.equal(result.ok, false);
});

test('2. addInterpretation stores a record and getInterpretation retrieves it by id', () => {
  const project = newProject();
  const i = createInterpretation({ projectId: project.id, referenceVideoId: 'rv1', hypothesis: 'h' });
  const result = interpretationStore.addInterpretation(project.id, i);
  assert.equal(result.ok, true);
  const fetched = interpretationStore.getInterpretation(project.id, result.interpretation.id);
  assert.equal(fetched.hypothesis, 'h');
});

test('3. addInterpretation stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const i = createInterpretation({ projectId: project.id, hypothesis: 'h' });
  interpretationStore.addInterpretation(project.id, i);
  i.hypothesis = 'CORRUPTED';
  assert.equal(interpretationStore.listInterpretations(project.id)[0].hypothesis, 'h');
});

test('4. listInterpretations returns null for a non-existent project, [] for a project with none yet', () => {
  assert.equal(interpretationStore.listInterpretations('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(interpretationStore.listInterpretations(project.id), []);
});

test('5. listInterpretations filters by referenceVideoId when given', () => {
  const project = newProject();
  interpretationStore.addInterpretation(project.id, createInterpretation({ projectId: project.id, referenceVideoId: 'rv1' }));
  interpretationStore.addInterpretation(project.id, createInterpretation({ projectId: project.id, referenceVideoId: 'rv2' }));
  assert.equal(interpretationStore.listInterpretations(project.id, { referenceVideoId: 'rv1' }).length, 1);
  assert.equal(interpretationStore.listInterpretations(project.id).length, 2);
});

test('6. updateReviewState updates status and appends a review without touching other fields', () => {
  const project = newProject();
  const saved = interpretationStore.addInterpretation(project.id, createInterpretation({ projectId: project.id, hypothesis: 'original' }));
  const updated = interpretationStore.updateReviewState(project.id, saved.interpretation.id, { status: 'ACCEPTED', review: { decision: 'ACCEPT', reviewedBy: 'x', reviewedAt: new Date().toISOString(), note: null, resultingInterpretationId: null } });
  assert.equal(updated.status, 'ACCEPTED');
  assert.equal(updated.hypothesis, 'original');
  assert.equal(updated.reviews.length, 1);
});

test('7. updateReviewState returns null for a non-existent interpretation', () => {
  const project = newProject();
  assert.equal(interpretationStore.updateReviewState(project.id, '11111111-1111-4111-8111-111111111111', { status: 'ACCEPTED' }), null);
});

test('8. two different projects never see each other\'s interpretations', () => {
  const projectA = newProject();
  const projectB = newProject();
  interpretationStore.addInterpretation(projectA.id, createInterpretation({ projectId: projectA.id }));
  assert.deepEqual(interpretationStore.listInterpretations(projectB.id), []);
});
