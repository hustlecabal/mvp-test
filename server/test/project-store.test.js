// Tests for services/project-store.js directly (no HTTP involved).
// Uses Node's built-in test runner, so no extra test library is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Point the store at a fresh temporary folder so these tests never touch
// (or get confused by) real project data.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-store-test-'));
process.env.PROJECT_DATA_DIR = tempDir;

const store = require('../services/project-store');

test('createProject fills in id, timestamps, status, and default fields', () => {
  const project = store.createProject({ title: 'Test', topic: 'Testing topic' });

  assert.ok(project.id, 'should have an id');
  assert.equal(project.title, 'Test');
  assert.equal(project.topic, 'Testing topic');
  assert.equal(project.status, 'PLANNING');
  assert.ok(project.createdAt);
  assert.equal(project.createdAt, project.updatedAt);
  assert.deepEqual(project.characters, []);
  assert.deepEqual(project.shots, []);
});

test('the project file actually exists on disk after creating it', () => {
  const project = store.createProject({ title: 'Disk test', topic: 'x' });
  const filePath = path.join(tempDir, `${project.id}.json`);

  assert.ok(fs.existsSync(filePath), 'project file should exist on disk');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.id, project.id);
  assert.equal(onDisk.title, 'Disk test');
});

test('listProjects includes newly created projects', () => {
  const before = store.listProjects().length;
  store.createProject({ title: 'List test', topic: 'x' });
  const after = store.listProjects().length;

  assert.equal(after, before + 1);
});

test('getProject retrieves a project by id', () => {
  const created = store.createProject({ title: 'Get test', topic: 'x' });
  const fetched = store.getProject(created.id);

  assert.deepEqual(fetched, created);
});

test('getProject returns null for an id that does not exist', () => {
  const randomId = crypto.randomUUID();
  assert.equal(store.getProject(randomId), null);
});

test('getProject refuses to follow a malicious path instead of a real id', () => {
  assert.equal(store.getProject('../../etc/passwd'), null);
});

test('updateProject changes allowed fields and updates updatedAt', async () => {
  const created = store.createProject({ title: 'Old title', topic: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const updated = store.updateProject(created.id, { title: 'New title', status: 'RESEARCH' });

  assert.equal(updated.title, 'New title');
  assert.equal(updated.status, 'RESEARCH');
  assert.notEqual(updated.updatedAt, created.updatedAt);
});

test('updateProject returns null when the project does not exist', () => {
  assert.equal(store.updateProject(crypto.randomUUID(), { title: 'x' }), null);
});
