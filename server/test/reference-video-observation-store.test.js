// Tests for services/reference-video-observation-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvostore-projects-'));
process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvostore-'));

const projectStore = require('../services/project-store');
const observationStore = require('../services/reference-video-observation-store');
const { createObservationSet } = require('../schemas/reference-video-observation-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addObservationSet fails for a non-existent project', () => {
  const result = observationStore.addObservationSet('00000000-0000-4000-8000-000000000000', createObservationSet());
  assert.equal(result.ok, false);
});

test('2. addObservationSet stores a set and getObservationSet retrieves it by id', () => {
  const project = newProject();
  const set = createObservationSet({ projectId: project.id, measurementsId: 'm1' });
  const result = observationStore.addObservationSet(project.id, set);
  assert.equal(result.ok, true);
  const fetched = observationStore.getObservationSet(project.id, result.observationSet.id);
  assert.equal(fetched.measurementsId, 'm1');
});

test('3. addObservationSet stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const set = createObservationSet({ projectId: project.id, measurementsId: 'm1' });
  observationStore.addObservationSet(project.id, set);
  set.measurementsId = 'CORRUPTED';
  const all = observationStore.listObservationSets(project.id);
  assert.equal(all[0].measurementsId, 'm1');
});

test('4. listObservationSets returns null for a non-existent project, [] for a project with none yet', () => {
  assert.equal(observationStore.listObservationSets('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(observationStore.listObservationSets(project.id), []);
});

test('5. re-deriving for the same measurements always appends — never overwrites', () => {
  const project = newProject();
  observationStore.addObservationSet(project.id, createObservationSet({ projectId: project.id, measurementsId: 'm1' }));
  observationStore.addObservationSet(project.id, createObservationSet({ projectId: project.id, measurementsId: 'm1' }));
  assert.equal(observationStore.listObservationSets(project.id).length, 2);
});

test('6. getLatestObservationSetForMeasurements returns the most recent set for that measurements record, scoped correctly across multiple', () => {
  const project = newProject();
  const first = observationStore.addObservationSet(project.id, createObservationSet({ projectId: project.id, measurementsId: 'm1', createdAt: '2020-01-01T00:00:00.000Z' }));
  observationStore.addObservationSet(project.id, createObservationSet({ projectId: project.id, measurementsId: 'm2', createdAt: '2025-01-01T00:00:00.000Z' }));
  const second = observationStore.addObservationSet(project.id, createObservationSet({ projectId: project.id, measurementsId: 'm1', createdAt: '2022-01-01T00:00:00.000Z' }));
  const latest = observationStore.getLatestObservationSetForMeasurements(project.id, 'm1');
  assert.equal(latest.id, second.observationSet.id);
  assert.notEqual(latest.id, first.observationSet.id);
});

test('7. getLatestObservationSetForMeasurements returns null when none exist for that measurements record', () => {
  const project = newProject();
  assert.equal(observationStore.getLatestObservationSetForMeasurements(project.id, 'nonexistent'), null);
});

test('8. two different projects never see each other\'s observation sets', () => {
  const projectA = newProject();
  const projectB = newProject();
  observationStore.addObservationSet(projectA.id, createObservationSet({ projectId: projectA.id, measurementsId: 'm1' }));
  assert.deepEqual(observationStore.listObservationSets(projectB.id), []);
});
