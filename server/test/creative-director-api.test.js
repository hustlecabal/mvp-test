// Tests for the Stage 11C Creative Director REST endpoints in index.js.
// Every route is a thin wrapper over services/creative-store.js
// (Stage 11A) — these tests confirm the HTTP wiring, the changeNote
// requirement (Part 13), and that saving a creative artifact can never
// touch generation jobs, budget, or approval state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-api-creative-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-api-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');

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

async function createProject(title = 'Creative director API test') {
  const res = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, topic: 'x' }),
  });
  return res.json();
}

function putJson(url, body) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// --- 3/4. brief retrieval / update -------------------------------------------

test('3. GET creative/brief returns null before creation', async () => {
  const project = await createProject();
  const res = await fetch(`${baseUrl}/projects/${project.id}/creative/brief`);
  assert.equal(res.status, 200);
  assert.equal(await res.json(), null);
});

test('4. PUT creative/brief creates then updates, versioning correctly', async () => {
  const project = await createProject();

  const first = await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'v1', changeNote: 'first draft' });
  assert.equal(first.status, 200);
  const v1 = await first.json();
  assert.equal(v1.version, 1);
  assert.equal(v1.title, 'v1');

  const second = await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { tone: 'hopeful', changeNote: 'added tone' });
  const v2 = await second.json();
  assert.equal(v2.version, 2);
  assert.equal(v2.title, 'v1', 'unrelated field preserved');
  assert.equal(v2.tone, 'hopeful');
});

// --- 5. blank change note rejected --------------------------------------------

test('5. PUT creative/brief rejects a missing or blank changeNote', async () => {
  const project = await createProject();

  const missing = await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'x' });
  assert.equal(missing.status, 400);
  const missingBody = await missing.json();
  assert.match(missingBody.error, /changeNote/);

  const blank = await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'x', changeNote: '   ' });
  assert.equal(blank.status, 400);
});

// --- 6. version increment (also see test 4) -----------------------------------

test('6. version increments by exactly 1 per save', async () => {
  const project = await createProject();
  await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'a', changeNote: '1' });
  await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'b', changeNote: '2' });
  const third = await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'c', changeNote: '3' });
  const v3 = await third.json();
  assert.equal(v3.version, 3);
  assert.equal(v3.history.length, 2);
});

// --- 7/8. specification retrieval / update ------------------------------------

test('7 & 8. GET/PUT creative/spec', async () => {
  const project = await createProject();
  assert.equal(await (await fetch(`${baseUrl}/projects/${project.id}/creative/spec`)).json(), null);

  const res = await putJson(`${baseUrl}/projects/${project.id}/creative/spec`, { coreConcept: 'a quiet mystery', changeNote: 'init' });
  const spec = await res.json();
  assert.equal(spec.coreConcept, 'a quiet mystery');
  assert.equal(spec.version, 1);
});

// --- 9/10. visual bible retrieval / update ------------------------------------

test('9 & 10. GET/PUT creative/bible, including characters array', async () => {
  const project = await createProject();
  assert.equal(await (await fetch(`${baseUrl}/projects/${project.id}/creative/bible`)).json(), null);

  const res = await putJson(`${baseUrl}/projects/${project.id}/creative/bible`, {
    world: 'a coastal town',
    characters: [{ characterId: 'char-1', name: 'Mira', identityConstraints: 'scar above left eyebrow' }],
    changeNote: 'init',
  });
  const bible = await res.json();
  assert.equal(bible.world, 'a coastal town');
  assert.equal(bible.characters[0].name, 'Mira');
});

// --- 15/16. storyboard retrieval / shot display source ------------------------

test('15. GET creative/storyboard', async () => {
  const project = await createProject();
  assert.equal(await (await fetch(`${baseUrl}/projects/${project.id}/creative/storyboard`)).json(), null);

  const res = await putJson(`${baseUrl}/projects/${project.id}/creative/storyboard`, { changeNote: 'init' });
  const storyboard = await res.json();
  assert.deepEqual(storyboard.scenes, []);
});

// --- 18. shot update -----------------------------------------------------------

test('18. PUT creative/storyboard/shots/:shotId updates one shot in place', async () => {
  const project = await createProject();
  const creativeStore = require('../services/creative-store');
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Opening' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: 'establish' });

  const res = await putJson(`${baseUrl}/projects/${project.id}/creative/storyboard/shots/${shot.shotId}`, {
    camera: '35mm handheld',
    changeNote: 'added camera direction',
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.camera, '35mm handheld');
  assert.equal(updated.purpose, 'establish', 'untouched fields preserved');

  const storyboard = await (await fetch(`${baseUrl}/projects/${project.id}/creative/storyboard`)).json();
  // v1 = created (implicit, on first scene add), v2 = scene added, v3 = shot added, v4 = shot edited.
  assert.equal(storyboard.version, 4);
});

test('PUT creative/storyboard/shots/:shotId returns 404 for an unknown shot', async () => {
  const project = await createProject();
  const res = await putJson(`${baseUrl}/projects/${project.id}/creative/storyboard/shots/00000000-0000-0000-0000-000000000000`, {
    camera: 'x',
    changeNote: 'x',
  });
  assert.equal(res.status, 404);
});

// --- Stage 24: POST creative/storyboard/scenes / shots (found missing during
// the UI acceptance audit — previously only reachable via MCP) -----------------

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('POST creative/storyboard/scenes adds one scene and bumps the storyboard version', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/creative/storyboard/scenes`, { title: 'Opening', changeNote: 'added opening scene' });
  assert.equal(res.status, 200);
  const scene = await res.json();
  assert.equal(scene.title, 'Opening');
  assert.ok(scene.sceneId);

  const storyboard = await (await fetch(`${baseUrl}/projects/${project.id}/creative/storyboard`)).json();
  assert.equal(storyboard.scenes.length, 1);
  assert.equal(storyboard.scenes[0].sceneId, scene.sceneId);
});

test('POST creative/storyboard/scenes 400s without a changeNote', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/creative/storyboard/scenes`, { title: 'Opening' });
  assert.equal(res.status, 400);
});

test('POST creative/storyboard/scenes 404s for an unknown project', async () => {
  const res = await postJson(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/creative/storyboard/scenes`, { title: 'x', changeNote: 'x' });
  assert.equal(res.status, 404);
});

test('POST creative/storyboard/shots adds one shot scoped to its scene', async () => {
  const project = await createProject();
  const sceneRes = await postJson(`${baseUrl}/projects/${project.id}/creative/storyboard/scenes`, { title: 'Opening', changeNote: 'x' });
  const scene = await sceneRes.json();

  const res = await postJson(`${baseUrl}/projects/${project.id}/creative/storyboard/shots`, { sceneId: scene.sceneId, purpose: 'establish', changeNote: 'added shot' });
  assert.equal(res.status, 200);
  const shot = await res.json();
  assert.equal(shot.sceneId, scene.sceneId);
  assert.equal(shot.purpose, 'establish');

  const storyboard = await (await fetch(`${baseUrl}/projects/${project.id}/creative/storyboard`)).json();
  assert.equal(storyboard.shots.length, 1);
});

test('POST creative/storyboard/shots 400s for a sceneId that does not belong to the project', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/creative/storyboard/shots`, { sceneId: 'not-a-real-scene', purpose: 'x', changeNote: 'x' });
  assert.equal(res.status, 400);
});

// --- 20. skill recommendation endpoint -----------------------------------------

test('20. GET /skills and /skills/recommendation power the skill panel', async () => {
  const skills = await (await fetch(`${baseUrl}/skills`)).json();
  assert.equal(skills.length, 8);

  const rec = await (
    await fetch(`${baseUrl}/skills/recommendation?desiredOutput=shot-prompt&platform=evolink`)
  ).json();
  assert.equal(rec.skillId, 'video-prompt-builder');

  const cinematicRec = await (await fetch(`${baseUrl}/skills/recommendation?needsCinematicPlanning=true`)).json();
  assert.equal(cinematicRec.skillId, 'cinema-worldbuilder-pro-2.0');
});

// --- unknown project -------------------------------------------------------------

test('creative endpoints return 404 for an unknown project', async () => {
  const missing = '00000000-0000-0000-0000-000000000000';
  assert.equal((await fetch(`${baseUrl}/projects/${missing}/creative`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/projects/${missing}/creative/brief`)).status, 404);
  assert.equal((await putJson(`${baseUrl}/projects/${missing}/creative/brief`, { changeNote: 'x' })).status, 404);
});

// --- error responses never leak internals ---------------------------------------

test('error responses are clean JSON, never a stack trace or filesystem path', async () => {
  const res = await putJson(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/creative/brief`, {});
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes(projectTempDir));
  assert.ok(!('stack' in body));
});

// --- 21/22/23/24. creative saves never touch generation/budget/approval/EvoLink

test('21, 22 & 23. saving every creative artifact via the API never creates a generation job or changes budget/approval', async () => {
  const project = projectStore.getProject((await createProject()).id);
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  await putJson(`${baseUrl}/projects/${project.id}/creative/brief`, { title: 'x', changeNote: 'x' });
  await putJson(`${baseUrl}/projects/${project.id}/creative/spec`, { coreConcept: 'x', changeNote: 'x' });
  await putJson(`${baseUrl}/projects/${project.id}/creative/bible`, { world: 'x', changeNote: 'x' });
  await putJson(`${baseUrl}/projects/${project.id}/creative/storyboard`, { changeNote: 'x' });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.limit, 100);
  assert.equal(reloaded.creditLedger.reserved, 0);
});

test('24. index.js has no import path to the EvoLink provider or its client', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const requireCallPattern = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let match = requireCallPattern.exec(source);
  while (match !== null) {
    assert.doesNotMatch(match[1], /evolink/i, `index.js requires "${match[1]}" — must never import anything EvoLink-related`);
    match = requireCallPattern.exec(source);
  }
});
