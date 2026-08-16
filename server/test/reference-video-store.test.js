// Tests for services/reference-video-store.js — INT-1A, Part 15/16/22.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-store-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const rvTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-store-data-'));
process.env.REFERENCE_VIDEO_DATA_DIR = rvTempDir;

const projectStore = require('../services/project-store');
const referenceVideoStore = require('../services/reference-video-store');
const { createReferenceVideo } = require('../schemas/reference-video-schema');

test('1. listReferenceVideos returns null for a nonexistent project, [] for an existing project with none yet — never writes a file on a pure read', () => {
  assert.equal(referenceVideoStore.listReferenceVideos('does-not-exist'), null);
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  assert.deepEqual(referenceVideoStore.listReferenceVideos(project.id), []);
  assert.equal(fs.existsSync(path.join(rvTempDir, `${project.id}.json`)), false);
});

test('2. addReferenceVideo persists and listReferenceVideos reflects it', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const rv = createReferenceVideo({ projectId: project.id, source: { platform: 'YOUTUBE', externalId: 'abc12345678' }, status: 'COMPLETE' });
  const result = referenceVideoStore.addReferenceVideo(project.id, rv);
  assert.equal(result.ok, true);
  assert.equal(referenceVideoStore.listReferenceVideos(project.id).length, 1);
  assert.equal(referenceVideoStore.getReferenceVideo(project.id, rv.id).id, rv.id);
});

test('3. addReferenceVideo fails structurally for a nonexistent project', () => {
  const rv = createReferenceVideo({ projectId: 'nope' });
  const result = referenceVideoStore.addReferenceVideo('nope', rv);
  assert.equal(result.ok, false);
});

test('4. findByExternalId is the Part 15 idempotency lookup — keyed by (platform, externalId), never the URL string', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const rv = createReferenceVideo({ projectId: project.id, source: { platform: 'YOUTUBE', externalId: 'abc12345678', originalUrl: 'https://youtu.be/abc12345678' } });
  referenceVideoStore.addReferenceVideo(project.id, rv);

  const found = referenceVideoStore.findByExternalId(project.id, 'YOUTUBE', 'abc12345678');
  assert.equal(found.id, rv.id);
  assert.equal(referenceVideoStore.findByExternalId(project.id, 'YOUTUBE', 'differentId'), null);
  assert.equal(referenceVideoStore.findByExternalId(project.id, 'VIMEO', 'abc12345678'), null);
});

test('5. two different projects never see each other\'s reference videos', () => {
  const p1 = projectStore.createProject({ title: 'a', topic: 'x' });
  const p2 = projectStore.createProject({ title: 'b', topic: 'x' });
  referenceVideoStore.addReferenceVideo(p1.id, createReferenceVideo({ projectId: p1.id, source: { platform: 'YOUTUBE', externalId: 'sharedid1234' } }));
  assert.equal(referenceVideoStore.findByExternalId(p2.id, 'YOUTUBE', 'sharedid1234'), null);
  assert.deepEqual(referenceVideoStore.listReferenceVideos(p2.id), []);
});

test('6. addReferenceVideo stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const rv = createReferenceVideo({ projectId: project.id, source: { platform: 'YOUTUBE', externalId: 'copytest1234' }, status: 'COMPLETE' });
  referenceVideoStore.addReferenceVideo(project.id, rv);
  rv.status = 'FAILED'; // mutate the original after storing
  const stored = referenceVideoStore.getReferenceVideo(project.id, rv.id);
  assert.equal(stored.status, 'COMPLETE');
});
