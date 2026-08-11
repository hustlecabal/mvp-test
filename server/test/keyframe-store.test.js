// Tests for services/keyframe-store.js — get/create/update, versioning,
// stale detection (Part 17), project isolation, and confirmation that
// keyframe-plan updates never touch generation/approval/budget. No
// network, no provider, no generation job is ever created here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-store-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-store-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-store-keyframes-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-store-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');

function newProject(title = 'Keyframe store test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// --- 1/2/3. Keyframe Plan: creation, retrieval, update --------------------------

test('1. getKeyframePlan creates an empty plan on first read (not null)', () => {
  const project = newProject();
  const plan = keyframeStore.getKeyframePlan(project.id);
  assert.equal(plan.projectId, project.id);
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.keyframes, []);
});

test('getKeyframePlan returns null for a project that does not exist', () => {
  assert.equal(keyframeStore.getKeyframePlan('00000000-0000-0000-0000-000000000000'), null);
});

test('2. updateKeyframePlan bumps the version and records history', () => {
  const project = newProject();
  keyframeStore.getKeyframePlan(project.id); // create it
  const updated = keyframeStore.updateKeyframePlan(project.id, {}, { changeNote: 'reviewed, no changes yet' });
  assert.equal(updated.version, 2);
  assert.equal(updated.history.length, 1);
  assert.equal(updated.history[0].version, 1);
});

// --- 3/4. create_keyframe / update_keyframe -------------------------------------

test('3. createKeyframe adds one keyframe and bumps the plan version', () => {
  const project = newProject();
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', frameType: 'CHARACTER_REFERENCE' });

  assert.ok(kf.keyframeId);
  assert.equal(kf.projectId, project.id);
  assert.equal(kf.shotId, 'shot-1');

  const plan = keyframeStore.getKeyframePlan(project.id);
  assert.equal(plan.keyframes.length, 1);
  assert.equal(plan.version, 2, 'creating the plan (v1) then adding a keyframe (v2)');
});

test('createKeyframe returns null for a project that does not exist', () => {
  assert.equal(keyframeStore.createKeyframe('00000000-0000-0000-0000-000000000000', {}), null);
});

test('4. updateKeyframe updates one keyframe in place without touching others', () => {
  const project = newProject();
  const kf1 = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', frameType: 'CHARACTER_REFERENCE' });
  const kf2 = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', frameType: 'WORLD_REFERENCE' });

  const updated = keyframeStore.updateKeyframe(project.id, kf1.keyframeId, { status: 'PLANNED', notes: 'looks good' });
  assert.equal(updated.status, 'PLANNED');
  assert.equal(updated.notes, 'looks good');

  const stillThere = keyframeStore.getKeyframe(project.id, kf2.keyframeId);
  assert.equal(stillThere.status, 'DRAFT', 'a sibling keyframe must be untouched');
});

test('updateKeyframe never lets keyframeId or projectId be overwritten', () => {
  const project = newProject();
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1' });
  const updated = keyframeStore.updateKeyframe(project.id, kf.keyframeId, { keyframeId: 'hacked', projectId: 'hacked', status: 'PLANNED' });
  assert.equal(updated.keyframeId, kf.keyframeId);
  assert.equal(updated.projectId, project.id);
});

test('updateKeyframe returns null for an unknown keyframeId', () => {
  const project = newProject();
  assert.equal(keyframeStore.updateKeyframe(project.id, 'nope', { status: 'PLANNED' }), null);
});

// --- 5. listKeyframes filtering --------------------------------------------------

test('5. listKeyframes filters by shotId, sceneId, frameType, and status', () => {
  const project = newProject();
  keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', sceneId: 'scene-1', frameType: 'CHARACTER_REFERENCE', status: 'DRAFT' });
  keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', sceneId: 'scene-1', frameType: 'WORLD_REFERENCE', status: 'PLANNED' });
  keyframeStore.createKeyframe(project.id, { shotId: 'shot-2', sceneId: 'scene-2', frameType: 'CHARACTER_REFERENCE', status: 'DRAFT' });

  assert.equal(keyframeStore.listKeyframes(project.id, { shotId: 'shot-1' }).length, 2);
  assert.equal(keyframeStore.listKeyframes(project.id, { sceneId: 'scene-2' }).length, 1);
  assert.equal(keyframeStore.listKeyframes(project.id, { frameType: 'CHARACTER_REFERENCE' }).length, 2);
  assert.equal(keyframeStore.listKeyframes(project.id, { status: 'PLANNED' }).length, 1);
  assert.equal(keyframeStore.listKeyframes(project.id, { shotId: 'shot-1', frameType: 'WORLD_REFERENCE' }).length, 1);
});

// --- 6. getKeyframe --------------------------------------------------------------

test('6. getKeyframe retrieves a single keyframe by id, or null if not found', () => {
  const project = newProject();
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1' });
  assert.equal(keyframeStore.getKeyframe(project.id, kf.keyframeId).keyframeId, kf.keyframeId);
  assert.equal(keyframeStore.getKeyframe(project.id, 'nope'), null);
});

// --- 7. findKeyframeById (cross-project lookup) -----------------------------------

test('7. findKeyframeById locates a keyframe without already knowing its project', () => {
  const project = newProject();
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1' });

  const found = keyframeStore.findKeyframeById(kf.keyframeId);
  assert.ok(found);
  assert.equal(found.project.id, project.id);
  assert.equal(found.keyframe.keyframeId, kf.keyframeId);
});

test('findKeyframeById returns null for an id that does not exist anywhere', () => {
  assert.equal(keyframeStore.findKeyframeById('00000000-0000-0000-0000-000000000000'), null);
});

// --- 8. Stale detection (Part 17) -------------------------------------------------

test('8. a keyframe is stale when the storyboard has since been updated past its sourceShotVersion', () => {
  const project = newProject();
  const storyboard = creativeStore.updateStoryboard(project.id, {}, { changeNote: 'init' }); // version 1
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', sourceShotVersion: storyboard.version });

  assert.equal(keyframeStore.getKeyframe(project.id, kf.keyframeId).stale, false, 'not stale immediately after creation');

  creativeStore.updateStoryboard(project.id, {}, { changeNote: 'storyboard changed again' }); // version 2
  assert.equal(keyframeStore.getKeyframe(project.id, kf.keyframeId).stale, true, 'must become stale once the storyboard version moves past sourceShotVersion');
});

test('a keyframe with no recorded sourceShotVersion is never marked stale', () => {
  const project = newProject();
  creativeStore.updateStoryboard(project.id, {}, { changeNote: 'init' });
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1' });
  assert.equal(keyframeStore.getKeyframe(project.id, kf.keyframeId).stale, false);
});

test('stale is computed on read, never persisted to disk', () => {
  const project = newProject();
  const storyboard = creativeStore.updateStoryboard(project.id, {}, { changeNote: 'init' });
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', sourceShotVersion: storyboard.version });
  creativeStore.updateStoryboard(project.id, {}, { changeNote: 'changed' });

  keyframeStore.getKeyframe(project.id, kf.keyframeId); // triggers a read

  const rawFile = JSON.parse(fs.readFileSync(path.join(keyframeTempDir, `${project.id}.json`), 'utf8'));
  const rawKeyframe = rawFile.keyframes.find((k) => k.keyframeId === kf.keyframeId);
  assert.ok(!('stale' in rawKeyframe), 'stale must never be written to the stored JSON');
});

// --- 9. Project isolation ---------------------------------------------------------

test('9. keyframe plans never leak between projects', () => {
  const projectA = newProject('A');
  const projectB = newProject('B');

  keyframeStore.createKeyframe(projectA.id, { shotId: 'a-shot' });
  assert.equal(keyframeStore.listKeyframes(projectA.id).length, 1);
  assert.equal(keyframeStore.listKeyframes(projectB.id).length, 0);
});

// --- 10. Keyframe planning never touches generation/approval/budget --------------

test('10. every keyframe-store write leaves generation jobs and approval/budget state untouched', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', frameType: 'CHARACTER_REFERENCE' });
  keyframeStore.updateKeyframe(project.id, kf.keyframeId, { status: 'PLANNED' });
  keyframeStore.updateKeyframePlan(project.id, {}, { changeNote: 'noop' });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.limit, 100);
  assert.equal(reloaded.creditLedger.reserved, 0);
});

// --- keyframe-store.js never imports a provider/generation/approval module -------

test('services/keyframe-store.js has no require() of any provider, generation-service, or approval-gate module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-store.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});
