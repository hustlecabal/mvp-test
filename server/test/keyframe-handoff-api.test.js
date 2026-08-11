// Tests for the Stage 13D REST endpoints in index.js (handoff CRUD + the
// image-ingestion upload), plus the Part 13 fixture lifecycle test, the
// Part 14 security search across every new Stage 13D file, and a static
// check that the Creative Director frontend's Human Execution section has
// no generate/execute/run control (Part 10/23).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-api-handoffs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;

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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

async function createProject(title = 'Keyframe handoff API test') {
  const res = await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, topic: 'x' }) });
  return res.json();
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function putJson(url, body) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function seedShotKeyframeAndPackage(project) {
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  return { scene, shot, keyframe, pkg };
}

async function approveOverHttp(keyframeId, pkg) {
  await postJson(`${baseUrl}/keyframes/${keyframeId}/generation-approval/request`, { estimatedCost: 2, requestedBy: 'tester' });
  await postJson(`${baseUrl}/keyframes/${keyframeId}/generation-approval/decision`, { approve: true, decidedBy: 'tester' });
}

// --- POST /keyframes/:keyframeId/handoff ---------------------------------------------------

test('POST /keyframes/:keyframeId/handoff creates a handoff once approved, 409s before that', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);

  const early = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, { createdBy: 'tester' });
  assert.equal(early.status, 409);

  await approveOverHttp(keyframe.keyframeId, pkg);

  const res = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, { createdBy: 'tester' });
  assert.equal(res.status, 201);
  const handoff = await res.json();
  assert.equal(handoff.status, 'READY');
  assert.equal(handoff.promptPackageVersion, pkg.version);
});

test('POST /keyframes/:keyframeId/handoff 404s for an unknown keyframe', async () => {
  const res = await postJson(`${baseUrl}/keyframes/nope/handoff`, {});
  assert.equal(res.status, 404);
});

// --- GET /keyframes/:keyframeId/handoffs, GET /handoffs/:handoffId -------------------------

test('GET /keyframes/:keyframeId/handoffs and GET /handoffs/:handoffId return the created handoff', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  const list = await (await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoffs`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].handoffId, created.handoffId);

  const single = await (await fetch(`${baseUrl}/handoffs/${created.handoffId}`)).json();
  assert.equal(single.handoffId, created.handoffId);
});

test('GET /handoffs/:handoffId 404s for an unknown handoff', async () => {
  const res = await fetch(`${baseUrl}/handoffs/nope`);
  assert.equal(res.status, 404);
});

// --- PUT /handoffs/:handoffId (MARK IN PROGRESS) --------------------------------------------

test('PUT /handoffs/:handoffId moves status to IN_PROGRESS', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  const res = await putJson(`${baseUrl}/handoffs/${created.handoffId}`, { status: 'IN_PROGRESS', updatedBy: 'tester' });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.status, 'IN_PROGRESS');
});

// --- POST /handoffs/:handoffId/cancel --------------------------------------------------------

test('POST /handoffs/:handoffId/cancel cancels a READY handoff', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  const res = await postJson(`${baseUrl}/handoffs/${created.handoffId}/cancel`, { decidedBy: 'tester' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'CANCELLED');
});

// --- GET /handoffs/:handoffId/package (Part 11, deterministic) -----------------------------

test('GET /handoffs/:handoffId/package returns the deterministic downloadable execution package', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  const first = await (await fetch(`${baseUrl}/handoffs/${created.handoffId}/package`)).json();
  const second = await (await fetch(`${baseUrl}/handoffs/${created.handoffId}/package`)).json();
  assert.equal(first.text, second.text, 'two calls with the same handoff must produce equivalent content');
  assert.match(first.text, /KEYFRAME EXECUTION/);
  assert.equal(first.prompt, pkg.prompt);
});

// --- POST /handoffs/:handoffId/asset (Part 6, image ingestion) -----------------------------

test('POST /handoffs/:handoffId/asset ingests a valid image and the asset starts approvalStatus NONE', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  const res = await fetch(`${baseUrl}/handoffs/${created.handoffId}/asset?completedBy=tester`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG_BYTES,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.handoff.status, 'INGESTED');
  assert.equal(body.asset.approvalStatus, 'NONE');
  assert.equal(body.asset.provider, 'human-handoff');
});

test('POST /handoffs/:handoffId/asset rejects a non-image body with 400, and does not change handoff status', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  const res = await fetch(`${baseUrl}/handoffs/${created.handoffId}/asset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('not an image'),
  });
  assert.equal(res.status, 400);

  const reread = await (await fetch(`${baseUrl}/handoffs/${created.handoffId}`)).json();
  assert.equal(reread.status, 'READY');
});

test('POST /handoffs/:handoffId/asset rejects a second upload for the same handoff (Part 8)', async () => {
  const project = await createProject();
  const { keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, {})).json();

  await fetch(`${baseUrl}/handoffs/${created.handoffId}/asset`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_BYTES });
  const second = await fetch(`${baseUrl}/handoffs/${created.handoffId}/asset`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_BYTES });
  assert.equal(second.status, 409);
});

test('POST /handoffs/:handoffId/asset 404s for an unknown handoff', async () => {
  const res = await fetch(`${baseUrl}/handoffs/nope/asset`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_BYTES });
  assert.equal(res.status, 404);
});

// --- Part 13 fixture test: full disposable-project lifecycle -------------------------------

test('Part 13 fixture: full handoff lifecycle from creation through approval, with the old handoff surviving a package rebuild', async () => {
  const project = await createProject('Stage 13D fixture project');
  const { shot, keyframe, pkg } = seedShotKeyframeAndPackage(project);
  await approveOverHttp(keyframe.keyframeId, pkg);

  // 1. create handoff
  const created = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/handoff`, { createdBy: 'fixture' })).json();
  assert.equal(created.status, 'READY');
  assert.equal(created.promptPackageVersion, pkg.version);
  assert.ok(created.requiredReferences);

  // 2. mark in progress
  const inProgress = await (await putJson(`${baseUrl}/handoffs/${created.handoffId}`, { status: 'IN_PROGRESS' })).json();
  assert.equal(inProgress.status, 'IN_PROGRESS');

  // 3. upload deterministic local fixture PNG
  const uploadRes = await fetch(`${baseUrl}/handoffs/${created.handoffId}/asset?completedBy=fixture`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG_BYTES,
  });
  assert.equal(uploadRes.status, 201);
  const { handoff: ingestedHandoff, asset } = await uploadRes.json();
  assert.equal(ingestedHandoff.status, 'INGESTED');
  assert.equal(asset.storage.status, 'STORED');
  assert.equal(asset.approvalStatus, 'NONE');
  assert.equal(asset.keyframeId, keyframe.keyframeId);
  assert.equal(asset.promptPackageVersion, pkg.version);

  // 4. approve the asset (reusing Stage 13B's review endpoint)
  const approveRes = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/approval`, { approve: true, assetId: asset.assetId, decidedBy: 'fixture' });
  assert.equal(approveRes.status, 200);
  const approved = await approveRes.json();
  assert.equal(approved.asset.approvalStatus, 'APPROVED');

  // 5. rebuild the prompt package -> new version exists, but the OLD handoff stays frozen
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised for fixture' }, { changeNote: 'fixture revision' });
  const rebuilt = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.ok(rebuilt.version > pkg.version);

  const rereadHandoff = await (await fetch(`${baseUrl}/handoffs/${created.handoffId}`)).json();
  assert.equal(rereadHandoff.promptPackageVersion, pkg.version, 'the handoff must still reflect the version it was created against');

  const execPackage = await (await fetch(`${baseUrl}/handoffs/${created.handoffId}/package`)).json();
  assert.equal(execPackage.frozen, true);
  assert.equal(execPackage.currentPromptPackageVersion, rebuilt.version);
});

// --- Part 14 security search across every new Stage 13D file --------------------------------

test('Part 14: no Stage 13D file contains fetch(, axios, http(s):// literals, EVOLINK_API_KEY, Authorization, child_process, exec(, spawn(, or eval(', () => {
  const files = [
    'schemas/keyframe-handoff-schema.js',
    'services/keyframe-handoff-service.js',
    'mcp/tools/keyframe-handoff-tools.js',
  ];
  const forbiddenPatterns = [
    /\bfetch\(/,
    /\baxios\b/,
    /https?:\/\//,
    /EVOLINK_API_KEY/,
    /Authorization/,
    /child_process/,
    /\bexec\(/,
    /\bspawn\(/,
    /\beval\(/,
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(text, pattern, `${rel} must not match ${pattern}`);
    }
  }
});

test('Part 14: the storeUploadedImage upload path in asset-storage.js has no fetch/network call, only local fs writes', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'asset-storage.js'), 'utf8');
  const uploadSectionStart = text.indexOf('function storeUploadedImage');
  assert.ok(uploadSectionStart > -1);
  const uploadSection = text.slice(uploadSectionStart, text.indexOf('module.exports'));
  assert.doesNotMatch(uploadSection, /\bfetch\(/);
  assert.doesNotMatch(uploadSection, /https?:\/\//);
});

// --- UI safety: no GENERATE/EXECUTE/RUN control in the Human Execution section --------------

test('frontend/app.js Human Execution section has no GENERATE IMAGE / EXECUTE SKILL / RUN HIGGSFIELD control', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');
  const sectionStart = text.indexOf('Human Keyframe Execution Handoff (Stage 13D)');
  assert.ok(sectionStart > -1, 'the Stage 13D UI section must exist');
  const sectionEnd = text.indexOf('Creative Skills panel (Part 11)');
  const section = text.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);
  for (const forbidden of ['GENERATE IMAGE', 'EXECUTE SKILL', 'RUN HIGGSFIELD']) {
    // Match only an actual button label assignment, not prose (this file's
    // own comments explain WHY these buttons don't exist, which legitimately
    // mentions the forbidden phrase in plain English).
    const labelPattern = new RegExp(`textContent\\s*=\\s*'${forbidden}'`);
    assert.doesNotMatch(section, labelPattern, `must not contain a "${forbidden}" button label`);
  }
  // The legitimate human-controlled actions must still be present.
  for (const expected of ['START HANDOFF', 'MARK IN PROGRESS', 'UPLOAD GENERATED IMAGE', 'APPROVE IMAGE', 'REJECT IMAGE']) {
    assert.ok(section.includes(expected), `expected to find "${expected}" in the Human Execution section`);
  }
});

test('index.js Stage 13D routes never require an EvoLink or generic image-provider module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const sectionStart = text.indexOf('Stage 13D — Human Keyframe Execution Handoff');
  assert.ok(sectionStart > -1);
  const sectionEnd = text.indexOf('Stage 9A — permanent asset storage download/preview');
  const section = text.slice(sectionStart, sectionEnd > -1 ? sectionEnd : sectionStart + 4000);
  assert.doesNotMatch(section, /providers\/evolink/);
  assert.doesNotMatch(section, /https?:\/\//);
});
