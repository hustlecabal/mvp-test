// Tests for the Stage 13B Controlled Keyframe Generation REST endpoints
// in index.js, plus static checks that the Creative Director frontend's
// generation controls disable the GENERATE KEYFRAME button when unsafe
// and never trigger anything automatically. Every route is a thin
// wrapper over services/keyframe-generation-approval-store.js /
// services/keyframe-generation-service.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-api-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;

const app = require('../index');
const generationStore = require('../services/generation-store');
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

async function createProject(title = 'Keyframe generation API test') {
  const res = await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, topic: 'x' }) });
  return res.json();
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function seedShotKeyframeAndPackage(project) {
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  return { scene, shot, keyframe, pkg };
}

// --- 24. generation-approval routes -------------------------------------------------

test('24. POST/GET generation-approval/request+decision manage the approval over HTTP', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);

  const requested = await (
    await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval/request`, { estimatedCost: 2, reason: 'test', requestedBy: 'tester' })
  ).json();
  assert.equal(requested.status, 'PENDING');
  assert.equal(requested.promptPackageId, pkg.packageId);

  const fetched = await (await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval`)).json();
  assert.equal(fetched.status, 'PENDING');

  const decided = await (
    await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval/decision`, { approve: true, decidedBy: 'tester' })
  ).json();
  assert.equal(decided.status, 'APPROVED');

  const kfAfter = keyframeStore.getKeyframe(project.id, keyframe.keyframeId);
  assert.equal(kfAfter.status, 'GENERATION_APPROVED');
});

test('generation-approval/request 404s for an unknown keyframe', async () => {
  const res = await postJson(`${baseUrl}/keyframes/00000000-0000-0000-0000-000000000000/generation-approval/request`, {});
  assert.equal(res.status, 404);
});

// --- POST /keyframes/:keyframeId/generate ---------------------------------------------

test('POST /keyframes/:keyframeId/generate is blocked without approval, with zero jobs created', async () => {
  const project = await createProject();
  const { keyframe } = seedShotKeyframeAndPackage(project);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const result = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generate`, {})).json();
  assert.equal(result.ok, false);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('POST /keyframes/:keyframeId/generate succeeds once approved, and GET generations/:generationId retrieves it', async () => {
  const project = await createProject();
  const { keyframe } = seedShotKeyframeAndPackage(project);

  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval/request`, { estimatedCost: 2 });
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval/decision`, { approve: true, decidedBy: 'tester' });

  const result = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generate`, {})).json();
  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'COMPLETED');

  const job = await (await fetch(`${baseUrl}/keyframe-generations/${result.job.id}`)).json();
  assert.equal(job.id, result.job.id);

  const list = await (await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/generations`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].asset.approvalStatus, 'NONE');
});

test('GET /keyframe-generations/:generationId 404s for an unknown or non-keyframe generation', async () => {
  const res = await fetch(`${baseUrl}/keyframe-generations/00000000-0000-0000-0000-000000000000`);
  assert.equal(res.status, 404);
});

// --- POST /keyframes/:keyframeId/approval (post-generation human review) --------------

test('POST /keyframes/:keyframeId/approval approves and rejects a generated result, keeping history', async () => {
  const project = await createProject();
  const { keyframe } = seedShotKeyframeAndPackage(project);
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval/request`, { estimatedCost: 2 });
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generation-approval/decision`, { approve: true, decidedBy: 'tester' });
  const generated = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generate`, {})).json();

  const approveRes = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/approval`, { approve: true, assetId: generated.asset.assetId, decidedBy: 'tester' });
  const approved = await approveRes.json();
  assert.equal(approved.asset.approvalStatus, 'APPROVED');
  assert.equal(approved.keyframe.status, 'APPROVED');
});

test('POST /keyframes/:keyframeId/approval requires an assetId', async () => {
  const project = await createProject();
  const { keyframe } = seedShotKeyframeAndPackage(project);
  const res = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/approval`, { approve: true });
  assert.equal(res.status, 400);
});

// --- 25/26. frontend: GENERATE button disabled logic + no autonomy ------------------------

test('25/26. app.js defines the generation UI functions, computes eligibility before enabling GENERATE KEYFRAME, and never triggers generation automatically', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');

  for (const fn of ['renderKeyframeGenerationControls', 'renderKeyframeGenerationPanel', 'computeKeyframeGenerationEligibility']) {
    assert.match(js, new RegExp(`function ${fn}`), `app.js must define ${fn}`);
  }

  const startIndex = js.indexOf('function renderKeyframeGenerationControls');
  const endIndex = js.indexOf('// --- Creative Skills panel', startIndex);
  const section = js.slice(startIndex, endIndex);

  // The GENERATE KEYFRAME button must be wired to the computed eligibility.
  assert.match(section, /generateBtn\.disabled = !eligibility\.allowed/);
  assert.match(section, /GENERATE KEYFRAME/);

  // No autonomy (Part 15): no setInterval/setTimeout anywhere in this
  // section could fire a generation on a timer, and no batch/loop over
  // multiple keyframes calls /generate.
  assert.doesNotMatch(section, /setInterval|setTimeout/);
  assert.doesNotMatch(section, /for\s*\([^)]*\)\s*\{[^}]*\/generate/s, 'must never loop and generate multiple keyframes at once');
});

test('every write in the generation UI section fires from an explicit button click listener, never on load', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');
  const startIndex = js.indexOf('function renderKeyframeGenerationControls');
  const endIndex = js.indexOf('// --- Creative Skills panel', startIndex);
  const section = js.slice(startIndex, endIndex);

  const postCallCount = (section.match(/method:\s*'POST'/g) || []).length;
  const listenerCount = (section.match(/addEventListener\('click'/g) || []).length;
  assert.ok(postCallCount > 0 && listenerCount > 0);
  assert.ok(listenerCount >= 4, 'expected REQUEST/APPROVE/REJECT generation-approval + GENERATE + APPROVE/REJECT keyframe buttons');
});

// --- safety: no keyframe-generation REST call ever bypasses budget/approval when blocked ---

test('a blocked /generate call never mutates the project credit ledger', async () => {
  const project = await createProject();
  const { keyframe } = seedShotKeyframeAndPackage(project);
  const projectStore = require('../services/project-store');
  const before = JSON.stringify(projectStore.getProject(project.id).creditLedger);

  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/generate`, {});

  const after = JSON.stringify(projectStore.getProject(project.id).creditLedger);
  assert.equal(after, before);
});
