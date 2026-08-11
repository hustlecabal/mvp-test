// Tests for the Stage 13A Keyframe Prompt Packaging REST endpoints in
// index.js, plus a static check that the Creative Director frontend's
// prompt-package UI never renders a GENERATE/EXECUTE/SUBMIT button (Part
// 17). Every route is a thin wrapper over
// services/keyframe-prompt-service.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-api-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-api-packages-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-api-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const app = require('../index');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');

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

test.after(() => {
  server.close();
});

async function createProject(title = 'Keyframe prompt API test') {
  const res = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, topic: 'x' }),
  });
  return res.json();
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function seedShotAndKeyframe(project) {
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'CHARACTER_REFERENCE', sourceShotVersion: storyboard.version });
  return { scene, shot, keyframe };
}

// --- GET/POST /keyframes/:keyframeId/prompt-package ------------------------------

test('GET /keyframes/:keyframeId/prompt-package 404s before any package has been built', async () => {
  const project = await createProject();
  const { keyframe } = seedShotAndKeyframe(project);

  const res = await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`);
  assert.equal(res.status, 404);
});

test('GET /keyframes/:keyframeId/prompt-package 404s for an unknown keyframe', async () => {
  const res = await fetch(`${baseUrl}/keyframes/00000000-0000-0000-0000-000000000000/prompt-package`);
  assert.equal(res.status, 404);
});

test('POST /keyframes/:keyframeId/prompt-package builds a package, and a subsequent GET retrieves it', async () => {
  const project = await createProject();
  const { keyframe } = seedShotAndKeyframe(project);

  const built = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`, {})).json();
  assert.ok(built.packageId);
  assert.equal(built.version, 1);
  assert.ok(built.prompt.length > 0);

  const fetched = await (await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`)).json();
  assert.equal(fetched.packageId, built.packageId);
});

test('POST /keyframes/:keyframeId/prompt-package rebuilding bumps the version', async () => {
  const project = await createProject();
  const { keyframe } = seedShotAndKeyframe(project);

  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`, {});
  const second = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`, {})).json();
  assert.equal(second.version, 2);
});

test('POST /keyframes/:keyframeId/prompt-package 404s for an unknown keyframe', async () => {
  const res = await postJson(`${baseUrl}/keyframes/00000000-0000-0000-0000-000000000000/prompt-package`, {});
  assert.equal(res.status, 404);
});

// --- GET /projects/:id/keyframe-prompt-packages -----------------------------------

test('GET /projects/:id/keyframe-prompt-packages lists built packages, empty array before any exist', async () => {
  const project = await createProject();
  const { keyframe } = seedShotAndKeyframe(project);

  const before = await (await fetch(`${baseUrl}/projects/${project.id}/keyframe-prompt-packages`)).json();
  assert.deepEqual(before, []);

  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`, {});
  const after = await (await fetch(`${baseUrl}/projects/${project.id}/keyframe-prompt-packages`)).json();
  assert.equal(after.length, 1);
});

test('GET /projects/:id/keyframe-prompt-packages 404s for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/keyframe-prompt-packages`);
  assert.equal(res.status, 404);
});

// --- 24. Creative Director UI: no generation buttons anywhere in the prompt-package section ---

test('24/25. app.js defines the prompt-package UI functions and never renders a Generate/Execute/Submit button for it', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');

  for (const fn of ['renderPromptPackageControls', 'renderPromptPackagePanel', 'renderCreditEfficiencySummary']) {
    assert.match(js, new RegExp(`function ${fn}`), `app.js must define ${fn}`);
  }

  // Isolate just the prompt-package-related section of the file and confirm
  // no forbidden button label appears inside it.
  const startIndex = js.indexOf('function renderPromptPackageControls');
  const endIndex = js.indexOf('function renderPromptPackagePanel', startIndex);
  const panelEnd = js.indexOf('\n// ---', js.indexOf('function renderPromptPackagePanel'));
  const section = js.slice(startIndex, panelEnd > 0 ? panelEnd : js.length);

  for (const forbidden of ['GENERATE', 'EXECUTE', 'SUBMIT']) {
    assert.doesNotMatch(section, new RegExp(forbidden), `prompt-package UI must never show a "${forbidden}" button`);
  }
  assert.match(section, /BUILD \/ REFRESH PACKAGE/);
  assert.match(section, /VIEW PACKAGE/);
  assert.match(section, /SOURCE OF TRUTH/);
  assert.match(section, /DERIVED PROMPT/);
});

// --- safety: no keyframe-prompt REST call ever creates a generation job -------------

test('no keyframe-prompt REST call ever creates a generation job or changes approval/budget state', async () => {
  const project = await createProject();
  const projectRecord = projectStore.getProject(project.id);
  gate.setBudget(projectRecord, 100);
  gate.requestApproval(projectRecord, { estimatedCost: 10 });
  gate.decideApproval(projectRecord, { approve: true });
  projectStore.touch(projectRecord);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const { keyframe } = seedShotAndKeyframe(project);
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`, {});
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`, {});
  await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/prompt-package`);
  await fetch(`${baseUrl}/projects/${project.id}/keyframe-prompt-packages`);

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.reserved, 0);
});
