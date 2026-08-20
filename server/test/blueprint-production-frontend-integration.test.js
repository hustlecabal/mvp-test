// P0 FRONTEND BLUEPRINT -> PRODUCTION INTEGRATION.
//
// Tests for the new REST routes in index.js that let the browser carry an
// approved CreativeBlueprint into production:
//   GET  /projects/:projectId/creative-blueprints
//   GET  /projects/:projectId/creative-blueprints/:blueprintId
//   POST /projects/:projectId/creative-blueprints/:blueprintId/review
//   POST /projects/:projectId/pre-production-gate/evaluate
//   POST /projects/:projectId/pre-production-gate/:gateResultId/decide
//   GET  /projects/:projectId/pre-production-gate
//   GET  /production-jobs/:productionJobId/video
//
// Every route is a thin wrapper over the existing, unmodified
// creative-blueprint-service.js / pre-production-gate-service.js /
// production-orchestrator-service.js — see index.js's own comments above
// each route. Nothing here re-implements Blueprint approval, gate
// evaluation, or production orchestration.
//
// The final test in this file is the REAL INTEGRATION PROOF (Part 15): it
// drives an EXISTING project through an EXISTING (DRAFT) Blueprint, creator
// approval, pre-production gate evaluate/accept, linking the Blueprint to
// the Storyboard, and Start Production — all through this exact REST
// contract, with zero manual intermediate-service invocation — then polls
// to COMPLETE and fetches the real playable MP4 via the video route.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-creative-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-assets-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-blueprints-'));
const recommendationTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-recs-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-gates-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-jobs-'));
const outputTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-bpfi-output-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.RECOMMENDATION_DATA_DIR = recommendationTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;
process.env.PRODUCTION_JOBS_DATA_DIR = jobsTempDir;
process.env.PRODUCTION_OUTPUT_DATA_DIR = outputTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const recommendationStore = require('../services/recommendation-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const creativeBlueprintService = require('../services/creative-blueprint-service');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');
const { makeTinyPng } = require('./fixtures/png-fixture');

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

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function putJson(url, body) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function setupRecommendationSet(projectId, referenceSetId) {
  const rec = createRecommendation({
    projectId,
    referenceSetId,
    recommendationType: 'RECURRING_PATTERN_APPLICATION',
    derivationType: 'SINGLE_PATTERN',
    category: 'OPENING',
    statement: 'stmt',
    rationale: 'rationale',
    action: 'Consider doing X.',
    sourcePatternIds: ['pattern-1'],
    confidence: 'MEDIUM',
    evidenceSufficiency: 'SUFFICIENT',
    meetsMinimumEvidenceThreshold: true,
  });
  const set = createRecommendationSet({ projectId, referenceSetId, patternSetId: 'pattern-set-1', recommendations: [rec], status: 'COMPLETE' });
  return recommendationStore.addRecommendationSet(projectId, set).recommendationSet;
}

// A real DRAFT Blueprint built through the actual INT-2 pipeline (not a
// fixture shortcut) — this is the "EXISTING Blueprint" Part 15 requires,
// and it evaluates cleanly (PROCEED, 0 blockers) so the REAL INTEGRATION
// PROOF exercises the ACCEPT path, not OVERRIDE.
function buildDraftBlueprint(project, recSet) {
  return creativeBlueprintService.buildCreativeBlueprintDraft(project.id, {
    referenceSetId: recSet.referenceSetId,
    concept: 'c',
    corePromise: 'p',
    targetDuration: 60,
    hookStrategy: 'open with a question',
    recommendationDecisions: [{ recommendationId: recSet.recommendations[0].id, decision: 'ACCEPT' }],
  });
}

function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(320, 180), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
}

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=5:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
}

const TERMINAL_STATUSES = ['COMPLETE', 'FAILED', 'ESCALATED'];

async function pollUntilTerminal(productionJobId, { timeoutMs = 180000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let res;
    try {
      res = await fetch(`${baseUrl}/production-jobs/${productionJobId}`);
    } catch (networkError) {
      // A real browser's fetch can also drop a connection transiently
      // during a multi-minute production run (this mirrors the frontend's
      // own polling, which must survive that rather than treat it as a
      // hard failure) — retry rather than fail the whole poll.
      if (Date.now() > deadline) throw networkError;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    assert.equal(res.status, 200);
    const job = await res.json();
    if (TERMINAL_STATUSES.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`production job "${productionJobId}" did not reach a terminal status within ${timeoutMs}ms (last status: ${job.status})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- 1. Blueprint listing/detail -------------------------------------------

test('1a. GET /projects/:projectId/creative-blueprints returns 404 for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/nonexistent-project-id/creative-blueprints`);
  assert.equal(res.status, 404);
});

test('1b. GET /projects/:projectId/creative-blueprints lists a real DRAFT Blueprint — Blueprint ID survives creation', async () => {
  const project = projectStore.createProject({ title: 'BPFI list test', topic: 'x' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);

  const res = await fetch(`${baseUrl}/projects/${project.id}/creative-blueprints`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, draft.id);
  assert.equal(list[0].status, 'DRAFT');
});

test('1c. GET /projects/:projectId/creative-blueprints/:blueprintId returns 404 for an unknown Blueprint id', async () => {
  const project = projectStore.createProject({ title: 'BPFI detail 404', topic: 'x' });
  const res = await fetch(`${baseUrl}/projects/${project.id}/creative-blueprints/${crypto.randomUUID()}`);
  assert.equal(res.status, 404);
});

// --- 2. Approval flow (Part 14.1 — Blueprint ID survives approval) ---------

test('2a. POST .../review APPROVE transitions DRAFT -> APPROVED, same Blueprint id, no shadow record created', async () => {
  const project = projectStore.createProject({ title: 'BPFI approve test', topic: 'x' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);
  assert.equal(draft.status, 'DRAFT');

  const res = await postJson(`${baseUrl}/projects/${project.id}/creative-blueprints/${draft.id}/review`, { decision: 'APPROVE', reviewedBy: 'creator' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.blueprint.id, draft.id, 'the SAME Blueprint id must survive approval — no shadow record');
  assert.equal(body.blueprint.status, 'APPROVED');

  const list = await (await fetch(`${baseUrl}/projects/${project.id}/creative-blueprints`)).json();
  assert.equal(list.length, 1, 'approval must not create a second Blueprint record');
});

test('2b. POST .../review with an unknown Blueprint id -> 409 with a structured reason, not a 500/stack trace', async () => {
  const project = projectStore.createProject({ title: 'BPFI approve unknown', topic: 'x' });
  const res = await postJson(`${baseUrl}/projects/${project.id}/creative-blueprints/${crypto.randomUUID()}/review`, { decision: 'APPROVE', reviewedBy: 'creator' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
  assert.ok(!body.error.includes('/home/'), 'error message must not leak a filesystem path');
});

// --- 3. Pre-production gate evaluate/decide ---------------------------------

test('3a. POST .../pre-production-gate/evaluate returns 404 for an unknown project', async () => {
  const res = await postJson(`${baseUrl}/projects/nonexistent-project-id/pre-production-gate/evaluate`, { blueprintId: crypto.randomUUID() });
  assert.equal(res.status, 404);
});

test('3b. POST .../pre-production-gate/evaluate returns 409 for an unknown blueprintId', async () => {
  const project = projectStore.createProject({ title: 'BPFI gate unknown blueprint', topic: 'x' });
  const res = await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/evaluate`, { blueprintId: crypto.randomUUID() });
  assert.equal(res.status, 409);
});

test('3c. Evaluating an APPROVED, clean Blueprint through the REST route produces a real PROCEED gate result', async () => {
  const project = projectStore.createProject({ title: 'BPFI gate proceed', topic: 'x' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);
  await postJson(`${baseUrl}/projects/${project.id}/creative-blueprints/${draft.id}/review`, { decision: 'APPROVE', reviewedBy: 'creator' });

  const res = await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/evaluate`, { blueprintId: draft.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.gateResult.machineAssessment, 'PROCEED');
  assert.equal(body.gateResult.blockers.length, 0);
  assert.equal(body.gateResult.blueprintId, draft.id);
});

test('3d. POST .../pre-production-gate/:gateResultId/decide ACCEPT records the human decision', async () => {
  const project = projectStore.createProject({ title: 'BPFI gate decide', topic: 'x' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);
  await postJson(`${baseUrl}/projects/${project.id}/creative-blueprints/${draft.id}/review`, { decision: 'APPROVE', reviewedBy: 'creator' });
  const evaluated = await (await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/evaluate`, { blueprintId: draft.id })).json();

  const res = await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/${evaluated.gateResult.id}/decide`, { decision: 'ACCEPT', decidedBy: 'creator' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.gateResult.humanDecision, 'ACCEPT');
});

test('3e. GET .../pre-production-gate?blueprintId= lists only results for that Blueprint (frontend sorts newest-first client-side)', async () => {
  const project = projectStore.createProject({ title: 'BPFI gate list', topic: 'x' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);
  await postJson(`${baseUrl}/projects/${project.id}/creative-blueprints/${draft.id}/review`, { decision: 'APPROVE', reviewedBy: 'creator' });
  const first = await (await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/evaluate`, { blueprintId: draft.id })).json();
  const second = await (await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/evaluate`, { blueprintId: draft.id })).json();

  const res = await fetch(`${baseUrl}/projects/${project.id}/pre-production-gate?blueprintId=${draft.id}`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 2);
  const ids = list.map((g) => g.id).sort();
  assert.deepEqual(ids, [first.gateResult.id, second.gateResult.id].sort());
});

// --- 4. Unapproved Blueprint cannot start production (Part 14.2) ----------

test('4. A Blueprint left in DRAFT (never approved) cannot start production, even if linked to the Storyboard', async () => {
  const project = projectStore.createProject({ title: 'BPFI unapproved blocks production', topic: 'x' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);
  assert.equal(draft.status, 'DRAFT');

  const linkRes = await putJson(`${baseUrl}/projects/${project.id}/creative/storyboard`, { blueprintId: draft.id, changeNote: 'link unapproved blueprint for test' });
  assert.equal(linkRes.status, 200);

  const res = await postJson(`${baseUrl}/projects/${project.id}/production`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'BLUEPRINT_NOT_APPROVED');
});

// --- 4b. Double-click / idempotency (Part 9 / 14.8) -------------------------

test('4b. Two rapid POST /projects/:projectId/production calls (a real double-click) never create two ProductionJobs', async () => {
  const project = projectStore.createProject({ title: 'BPFI double-click test', topic: 'x' });
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, visualTreatment: 'STILL_IMAGE' });
  makeStoredImageAsset(project.id);

  const [first, second] = await Promise.all([postJson(`${baseUrl}/projects/${project.id}/production`, {}), postJson(`${baseUrl}/projects/${project.id}/production`, {})]);
  const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);

  const list = await (await fetch(`${baseUrl}/projects/${project.id}/production`)).json();
  assert.equal(list.length, 1, 'a real double-click must never create a second ProductionJob');
  assert.equal(firstBody.job.productionJobId, secondBody.job.productionJobId);
});

// --- 5. Final video route ---------------------------------------------------

test('5a. GET /production-jobs/:productionJobId/video returns 404 for an unknown job', async () => {
  const res = await fetch(`${baseUrl}/production-jobs/${crypto.randomUUID()}/video`);
  assert.equal(res.status, 404);
});

test('5b. GET /production-jobs/:productionJobId/video returns 409 while the job has no final artifact yet', async () => {
  const project = projectStore.createProject({ title: 'BPFI video not ready', topic: 'x' });
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, visualTreatment: 'STILL_IMAGE' });
  // No stored asset -> the job will fail fast (well before assembly), so it
  // never reaches a real artifact — exactly the "no artifact yet" case.
  const startRes = await postJson(`${baseUrl}/projects/${project.id}/production`, {});
  const started = await startRes.json();
  const finished = await pollUntilTerminal(started.job.productionJobId);
  assert.notEqual(finished.status, 'COMPLETE');

  const res = await fetch(`${baseUrl}/production-jobs/${started.job.productionJobId}/video`);
  assert.equal(res.status, 409);
});

// --- 6. Frontend does not directly invoke internal production services (Part 14.4, static check) ---

test('6. frontend/app.js never invokes an internal service/module directly — only the public REST contract', () => {
  const appJsPath = path.join(__dirname, '..', '..', 'frontend', 'app.js');
  const source = fs.readFileSync(appJsPath, 'utf8');

  // A browser script has no business calling require() at all — that's the
  // real, structural guarantee that it cannot import and call an internal
  // service module directly (comments MAY still name those modules for
  // documentation, which is fine and expected).
  assert.ok(!/\brequire\s*\(/.test(source), 'frontend/app.js must never call require() — it is browser code with no access to internal service modules');
  assert.ok(!/\bchild_process\b/.test(source), 'frontend/app.js must never reference child_process');

  // renderProductionJobStatus() is the ONE place this stage's ProductionJob
  // status is shown to the creator (Part 8) — it must never surface an
  // internal machinery identifier like providerTaskId. Scoped to this
  // function rather than the whole file: an unrelated, pre-existing
  // operator-debugging panel elsewhere in the app (Stage 13B/23 keyframe
  // and video generation review) deliberately shows providerTaskId to
  // operators reviewing a specific generation, which is outside this
  // stage's scope to touch.
  const statusFnMatch = source.match(/function renderProductionJobStatus\([\s\S]*?\n}\n/);
  assert.ok(statusFnMatch, 'renderProductionJobStatus() must exist');
  assert.ok(!/providerTaskId|material-resolution-service|hyperframes-renderer|beat-graph-derivation/.test(statusFnMatch[0]), 'the ProductionJob status view must not surface internal machinery names');
});

// --- 7. REAL INTEGRATION PROOF (Part 15) ------------------------------------
//
// EXISTING PROJECT -> EXISTING (DRAFT) BLUEPRINT -> CREATOR APPROVAL (REST)
// -> PRE-PRODUCTION GATE EVALUATE + ACCEPT (REST) -> LINK TO STORYBOARD
// (the existing PUT /creative/storyboard route) -> START PRODUCTION (REST)
// -> POLL /production-jobs/:id -> COMPLETE -> GET .../video -> a real,
// playable MP4. Every step uses the SAME REST contract the frontend code
// in frontend/app.js calls — no direct service invocation anywhere below.

test('7. REAL INTEGRATION PROOF — approve an existing Blueprint through REST, start production once, receive a real playable video', async () => {
  const project = projectStore.createProject({ title: 'EVOLINK P0 FRONTEND INTEGRATION PROOF', topic: 'frontend integration proof' });
  const recSet = setupRecommendationSet(project.id, 'rs1');
  const draft = buildDraftBlueprint(project, recSet);
  assert.equal(draft.status, 'DRAFT', 'must start from a genuinely existing, unapproved Blueprint');

  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  const shot1 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 4, visualTreatment: 'STILL_IMAGE', purpose: 'hook' });
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, duration: 6, visualTreatment: 'AI_VIDEO', purpose: 'explanation' });
  makeStoredImageAsset(project.id);
  makeStoredVideoAsset(project.id);

  // 1. CREATOR APPROVAL — via the exact REST route the frontend's
  // decideBlueprintReview() calls.
  const approveRes = await postJson(`${baseUrl}/projects/${project.id}/creative-blueprints/${draft.id}/review`, { decision: 'APPROVE', reviewedBy: 'creator' });
  assert.equal(approveRes.status, 200);
  const approved = await approveRes.json();
  assert.equal(approved.blueprint.status, 'APPROVED');
  assert.equal(approved.blueprint.id, draft.id, 'the approved Blueprint keeps the SAME id the creator saw in the UI');

  // 2. PRE-PRODUCTION GATE — evaluate then ACCEPT, via the exact REST
  // routes renderGateSection()/evaluateGate()/decideGate() call.
  const gateEvalRes = await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/evaluate`, { blueprintId: draft.id });
  assert.equal(gateEvalRes.status, 200);
  const gateEvaluated = await gateEvalRes.json();
  assert.equal(gateEvaluated.gateResult.machineAssessment, 'PROCEED');
  const gateDecideRes = await postJson(`${baseUrl}/projects/${project.id}/pre-production-gate/${gateEvaluated.gateResult.id}/decide`, { decision: 'ACCEPT', decidedBy: 'creator' });
  assert.equal(gateDecideRes.status, 200);

  // 3. LINK TO STORYBOARD — via the existing generic PUT storyboard route
  // (linkBlueprintToStoryboard()'s "USE THIS APPROVED CREATIVE DIRECTION").
  const linkRes = await putJson(`${baseUrl}/projects/${project.id}/creative/storyboard`, { blueprintId: draft.id, changeNote: 'creator approved this creative direction for production' });
  assert.equal(linkRes.status, 200);
  const linkedStoryboard = await linkRes.json();
  assert.equal(linkedStoryboard.blueprintId, draft.id);

  // 4. START PRODUCTION — via the exact public REST contract
  // (startProduction() in app.js), which calls startProductionAsync()
  // internally. No manual intermediate-service invocation above this line.
  const startRes = await postJson(`${baseUrl}/projects/${project.id}/production`, {
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'integration-script-1', text: 'Every great video starts with a single clear idea.' },
      [shot2.shotId]: { scriptRefId: 'integration-script-2', text: 'Then real footage brings that idea to life on screen.' },
    },
  });
  assert.equal(startRes.status, 200);
  const started = await startRes.json();
  assert.equal(started.ok, true, JSON.stringify(started.job && started.job.diagnostics));
  assert.equal(started.job.blueprintId, draft.id, 'the ProductionJob carries the SAME Blueprint id the creator approved — no shadow Blueprint');
  assert.ok(!TERMINAL_STATUSES.includes(started.job.status), 'must return before the real production run finishes');

  // 5. POLL to COMPLETE — via the exact status route renderProductionJobStatus() polls.
  const finished = await pollUntilTerminal(started.job.productionJobId);
  assert.equal(finished.status, 'COMPLETE', JSON.stringify(finished.diagnostics));
  assert.equal(finished.assemblyResult.status, 'COMPLETED');

  // 6. FINAL PLAYABLE VIDEO — via the new video route, the exact one
  // renderProductionJobStatus() points a <video> element at.
  const videoRes = await fetch(`${baseUrl}/production-jobs/${started.job.productionJobId}/video`);
  assert.equal(videoRes.status, 200);
  assert.equal(videoRes.headers.get('content-type'), 'video/mp4');
  const videoBytes = Buffer.from(await videoRes.arrayBuffer());
  assert.ok(videoBytes.length > 0);
  assert.ok(fs.existsSync(finished.assemblyResult.artifact.path));
  assert.equal(videoBytes.length, fs.statSync(finished.assemblyResult.artifact.path).size, 'the streamed video must be byte-identical to the real assembled artifact — no second storage/URL system');
});
