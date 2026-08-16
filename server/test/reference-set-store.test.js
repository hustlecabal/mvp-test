// Tests for services/reference-set-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rsstore-projects-'));
process.env.REFERENCE_SET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rsstore-'));

const projectStore = require('../services/project-store');
const referenceSetStore = require('../services/reference-set-store');
const { createReferenceSet } = require('../schemas/reference-set-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addReferenceSet fails for a non-existent project', () => {
  const result = referenceSetStore.addReferenceSet('00000000-0000-4000-8000-000000000000', createReferenceSet());
  assert.equal(result.ok, false);
});

test('2. addReferenceSet stores a set and getReferenceSet retrieves it by id', () => {
  const project = newProject();
  const set = createReferenceSet({ projectId: project.id, name: 'x' });
  const result = referenceSetStore.addReferenceSet(project.id, set);
  assert.equal(result.ok, true);
  assert.equal(referenceSetStore.getReferenceSet(project.id, result.referenceSet.id).name, 'x');
});

test('3. addReferenceSet stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const set = createReferenceSet({ projectId: project.id, name: 'original' });
  referenceSetStore.addReferenceSet(project.id, set);
  set.name = 'CORRUPTED';
  assert.equal(referenceSetStore.listReferenceSets(project.id)[0].name, 'original');
});

test('4. listReferenceSets returns null for a non-existent project, [] for one with none yet', () => {
  assert.equal(referenceSetStore.listReferenceSets('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(referenceSetStore.listReferenceSets(project.id), []);
});

test('5. updateReferenceSet replaces the stored record in place', () => {
  const project = newProject();
  const saved = referenceSetStore.addReferenceSet(project.id, createReferenceSet({ projectId: project.id, name: 'v1' }));
  const modified = { ...saved.referenceSet, name: 'v2' };
  const updated = referenceSetStore.updateReferenceSet(project.id, modified);
  assert.equal(updated.name, 'v2');
  assert.equal(referenceSetStore.getReferenceSet(project.id, saved.referenceSet.id).name, 'v2');
});

test('6. updateReferenceSet returns null for a set that does not exist', () => {
  const project = newProject();
  assert.equal(referenceSetStore.updateReferenceSet(project.id, createReferenceSet({ projectId: project.id })), null);
});

test('7. two different projects never see each other\'s reference sets', () => {
  const projectA = newProject();
  const projectB = newProject();
  referenceSetStore.addReferenceSet(projectA.id, createReferenceSet({ projectId: projectA.id }));
  assert.deepEqual(referenceSetStore.listReferenceSets(projectB.id), []);
});
