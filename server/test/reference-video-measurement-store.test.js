// Tests for services/reference-video-measurement-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvmstore-projects-'));
process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvmstore-'));

const projectStore = require('../services/project-store');
const measurementStore = require('../services/reference-video-measurement-store');
const { createReferenceVideoMeasurements } = require('../schemas/reference-video-measurement-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addMeasurement fails for a non-existent project', () => {
  const result = measurementStore.addMeasurement('00000000-0000-4000-8000-000000000000', createReferenceVideoMeasurements());
  assert.equal(result.ok, false);
});

test('2. addMeasurement stores a measurement and getMeasurement retrieves it by id', () => {
  const project = newProject();
  const m = createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv1' });
  const result = measurementStore.addMeasurement(project.id, m);
  assert.equal(result.ok, true);
  const fetched = measurementStore.getMeasurement(project.id, result.measurements.id);
  assert.equal(fetched.referenceVideoId, 'rv1');
});

test('3. addMeasurement stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const m = createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv1' });
  measurementStore.addMeasurement(project.id, m);
  m.referenceVideoId = 'CORRUPTED';
  const all = measurementStore.listMeasurements(project.id);
  assert.equal(all[0].referenceVideoId, 'rv1');
});

test('4. listMeasurements returns null for a non-existent project, [] for a project with none yet', () => {
  assert.equal(measurementStore.listMeasurements('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(measurementStore.listMeasurements(project.id), []);
});

test('5. re-measuring the same ReferenceVideo always appends — never overwrites (measurement is free, unlike paid acquisition)', () => {
  const project = newProject();
  measurementStore.addMeasurement(project.id, createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv1' }));
  measurementStore.addMeasurement(project.id, createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv1' }));
  assert.equal(measurementStore.listMeasurements(project.id).length, 2);
});

test('6. getLatestMeasurementForReferenceVideo returns the most recently created record for that ReferenceVideo, scoped correctly across multiple ReferenceVideos', () => {
  const project = newProject();
  const first = measurementStore.addMeasurement(project.id, createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv1', createdAt: '2020-01-01T00:00:00.000Z' }));
  measurementStore.addMeasurement(project.id, createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv2', createdAt: '2025-01-01T00:00:00.000Z' }));
  const second = measurementStore.addMeasurement(project.id, createReferenceVideoMeasurements({ projectId: project.id, referenceVideoId: 'rv1', createdAt: '2022-01-01T00:00:00.000Z' }));
  const latest = measurementStore.getLatestMeasurementForReferenceVideo(project.id, 'rv1');
  assert.equal(latest.id, second.measurements.id);
  assert.notEqual(latest.id, first.measurements.id);
});

test('7. getLatestMeasurementForReferenceVideo returns null when there is no measurement for that ReferenceVideo', () => {
  const project = newProject();
  assert.equal(measurementStore.getLatestMeasurementForReferenceVideo(project.id, 'nonexistent'), null);
});

test('8. two different projects never see each other\'s measurements', () => {
  const projectA = newProject();
  const projectB = newProject();
  measurementStore.addMeasurement(projectA.id, createReferenceVideoMeasurements({ projectId: projectA.id, referenceVideoId: 'rv1' }));
  assert.deepEqual(measurementStore.listMeasurements(projectB.id), []);
});
