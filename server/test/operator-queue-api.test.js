// Tests for Stage 14, Part 8 — the Operator Queue REST endpoints
// (GET /projects/:id/operator-queue, /operator-queue/summary,
// /operator-queue/next, and /shot-readiness). Every route is a thin
// wrapper over services/operator-queue-service.js — verified by a static
// check that no queue logic lives in index.js itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-api-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-api-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-api-approvals-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;

const app = require('../index');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

async function createProject(title = 'operator queue API test') {
  const res = await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, topic: 'x' }) });
  return res.json();
}

function seedShotAndKeyframe(project) {
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });
  return { scene, shot, keyframe };
}

// --- 27. REST endpoints -------------------------------------------------------------------

test('27. GET /projects/:id/operator-queue returns the queue', async () => {
  const project = await createProject();
  const { keyframe } = seedShotAndKeyframe(project);
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  const res = await fetch(`${baseUrl}/projects/${project.id}/operator-queue`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].category, 'NEEDS_APPROVAL');
});

test('GET /projects/:id/operator-queue 404s for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/operator-queue`);
  assert.equal(res.status, 404);
});

test('GET /projects/:id/operator-queue/summary returns the rollup', async () => {
  const project = await createProject();
  seedShotAndKeyframe(project);

  const res = await fetch(`${baseUrl}/projects/${project.id}/operator-queue/summary`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalKeyframes, 1);
  assert.equal(typeof body.completionPercentage, 'number');
});

test('GET /projects/:id/operator-queue/next returns the highest-priority item, or nextAction: null', async () => {
  const empty = await createProject('empty for next');
  let res = await fetch(`${baseUrl}/projects/${empty.id}/operator-queue/next`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { nextAction: null });

  const project = await createProject();
  seedShotAndKeyframe(project);
  res = await fetch(`${baseUrl}/projects/${project.id}/operator-queue/next`);
  const body = await res.json();
  assert.equal(body.category, 'NEEDS_PROMPT_PACKAGE');
});

test('GET /projects/:id/shot-readiness returns per-shot readiness', async () => {
  const project = await createProject();
  const { shot } = seedShotAndKeyframe(project);

  const res = await fetch(`${baseUrl}/projects/${project.id}/shot-readiness`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const entry = body.find((r) => r.shotId === shot.shotId);
  assert.ok(entry);
  assert.equal(entry.readyForVideo, false);
});

// --- no queue logic lives in index.js -------------------------------------------------------

test('index.js\'s operator-queue routes are thin wrappers — no category/priority logic lives there', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const sectionStart = text.indexOf('Stage 14 — the Operator Queue');
  assert.ok(sectionStart > -1);
  const sectionEnd = text.indexOf('Stage 9A — permanent asset storage');
  const section = text.slice(sectionStart, sectionEnd > -1 ? sectionEnd : sectionStart + 1500);

  assert.match(section, /operatorQueueService\.buildProjectQueue/);
  assert.match(section, /operatorQueueService\.getQueueSummary/);
  assert.match(section, /operatorQueueService\.getNextAction/);
  assert.match(section, /operatorQueueService\.getShotReadiness/);
  // no category name or priority number literal should appear in the
  // route handlers themselves — those decisions live only in the service.
  for (const category of ['NEEDS_KEYFRAME_PLAN', 'NEEDS_PROMPT_PACKAGE', 'READY_FOR_HANDOFF', 'COMPLETE']) {
    assert.doesNotMatch(section, new RegExp(category));
  }
});
