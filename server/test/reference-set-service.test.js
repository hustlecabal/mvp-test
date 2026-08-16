// Tests for services/reference-set-service.js — membership management.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-rsvc-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-rsvc-projects-'],
  ['REFERENCE_VIDEO_DATA_DIR', 'evolink-rsvc-rvstore-'],
  ['REFERENCE_SET_DATA_DIR', 'evolink-rsvc-rsstore-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const referenceSetSvc = require('../services/reference-set-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function makeOneShotVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rsvc-src-'));
  const p = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:size=320x180:duration=2:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  return p;
}

async function ingestFixture(project) {
  const videoPath = makeOneShotVideo();
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 't', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'FAILED', diagnostics: [] }),
  };
  return ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl });
}

test('1. createSet fails for a non-existent project', () => {
  const result = referenceSetSvc.createSet('00000000-0000-4000-8000-000000000000', { name: 'x' });
  assert.equal(result.ok, false);
});

test('2. createSet + getSet + listSets round-trip', () => {
  const project = newProject();
  const created = referenceSetSvc.createSet(project.id, { name: 'My Set', criteria: 'shorts' });
  assert.equal(created.ok, true);
  const fetched = referenceSetSvc.getSet(project.id, created.referenceSet.id);
  assert.equal(fetched.name, 'My Set');
  assert.equal(referenceSetSvc.listSets(project.id).length, 1);
});

test('3. addVideo refuses a referenceVideoId that does not resolve to a real ReferenceVideo — membership is never inferred or accepted on faith', () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'x' }).referenceSet;
  const result = referenceSetSvc.addVideo(project.id, set.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.ok, false);
  assert.match(result.reason, /unverified/i);
});

test('4. addVideo succeeds for a real, existing ReferenceVideo and re-adding is an idempotent no-op', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'x' }).referenceSet;
  const rv = await ingestFixture(project);
  const first = referenceSetSvc.addVideo(project.id, set.id, rv.id, { addedBy: 'tester' });
  assert.equal(first.ok, true);
  assert.equal(first.referenceSet.members.length, 1);
  const second = referenceSetSvc.addVideo(project.id, set.id, rv.id);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyMember, true);
  assert.equal(referenceSetSvc.getSet(project.id, set.id).members.length, 1); // never duplicated
});

test('5. removeVideo removes membership without touching the underlying ReferenceVideo', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'x' }).referenceSet;
  const rv = await ingestFixture(project);
  referenceSetSvc.addVideo(project.id, set.id, rv.id);
  const removed = referenceSetSvc.removeVideo(project.id, set.id, rv.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.referenceSet.members.length, 0);
  const referenceVideoStore = require('../services/reference-video-store');
  assert.ok(referenceVideoStore.getReferenceVideo(project.id, rv.id)); // untouched
});

test('6. removeVideo fails for a video that is not a member', () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'x' }).referenceSet;
  const result = referenceSetSvc.removeVideo(project.id, set.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.ok, false);
});

test('7. curateVideo APPROVEs/REJECTs/LABELs a member (Part 17)', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'x' }).referenceSet;
  const rv = await ingestFixture(project);
  referenceSetSvc.addVideo(project.id, set.id, rv.id);

  const labeled = referenceSetSvc.curateVideo(project.id, set.id, rv.id, { label: 'finance-explainer' });
  assert.equal(labeled.ok, true);
  assert.equal(labeled.referenceSet.members[0].label, 'finance-explainer');

  const approved = referenceSetSvc.curateVideo(project.id, set.id, rv.id, { curationStatus: 'APPROVED', curatedBy: 'human1' });
  assert.equal(approved.referenceSet.members[0].curationStatus, 'APPROVED');
  assert.equal(approved.referenceSet.members[0].curatedBy, 'human1');
  assert.ok(approved.referenceSet.members[0].curatedAt);
});

test('8. curateVideo rejects an invalid curationStatus value', async () => {
  const project = newProject();
  const set = referenceSetSvc.createSet(project.id, { name: 'x' }).referenceSet;
  const rv = await ingestFixture(project);
  referenceSetSvc.addVideo(project.id, set.id, rv.id);
  const result = referenceSetSvc.curateVideo(project.id, set.id, rv.id, { curationStatus: 'NOT_A_REAL_STATUS' });
  assert.equal(result.ok, false);
});

test('9. two different projects never see each other\'s reference sets', () => {
  const projectA = newProject();
  const projectB = newProject();
  referenceSetSvc.createSet(projectA.id, { name: 'x' });
  assert.deepEqual(referenceSetSvc.listSets(projectB.id), []);
});
