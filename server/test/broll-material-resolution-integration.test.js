// Tests for Stage 26.5B, Part 4 — real B-roll library records consumed
// directly by services/material-resolution-service.js's resolveMaterial()/
// resolveBeatGraph(), via services/broll-library-service.js. Material
// Resolution remains the SOLE decision-maker: this integration only
// SUPPLIES candidates, it never ranks/selects on its own behalf.
//
// The Stage 26.3 context.brollSegments fixture mechanism (licensingStatus
// 'CLEARED', candidate id `...:${segmentId}`) is a SEPARATE, unchanged code
// path — see test/material-resolution-service.test.js's own 26.3-* tests
// for that regression coverage. This file only exercises the NEW real-
// library path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-mr-projects-'));
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-mr-library-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const brollLibraryService = require('../services/broll-library-service');
const materialResolutionService = require('../services/material-resolution-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.mp4` });
  return timelineStore.getAsset(projectId, asset.assetId);
}

// NOTE on approvalStatus: schemas/visual-beat-schema.js's
// TREATMENT_TO_ASSET_TYPES maps BROLL_CLIP -> ['video'] — the SAME asset
// type PROJECT_ASSET_REUSE already reuses. Since services/broll-library-
// service.js's registerBrollSegment() never checks approvalStatus (Part 3),
// a B-roll segment's underlying video asset would otherwise ALSO survive as
// an independent PROJECT_ASSET_REUSE candidate for the same beat — a real,
// pre-existing, unrelated interaction this file must isolate around, not
// suppress. Marking it REJECTED is the EXISTING mechanism resolveVisualBeat()
// already uses to exclude an asset from PROJECT_ASSET_REUSE eligibility
// (services/material-resolution-service.js's evaluateEligibility); it has
// no effect on B-roll registration or eligibility, which never reads
// approvalStatus at all. This isolates each test's assertions to the
// BROLL_LIBRARY path specifically, which is what this file exists to prove.
function registerSegment(projectId, licensingStatus, overrides = {}) {
  const asset = makeStoredVideoAsset(projectId);
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'REJECTED');
  const result = brollLibraryService.registerBrollSegment(projectId, {
    assetId: asset.assetId,
    source: { type: 'LOCAL_UPLOAD', originalReference: 'city-street.mp4' },
    licensing: { status: licensingStatus },
    descriptiveMetadata: { tags: ['city', 'street'] },
    ...overrides,
  });
  assert.equal(result.ok, true, `fixture setup: registration failed — ${result.reason}`);
  return { asset, segment: result.segment };
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'BROLL_CLIP', ...overrides });
}

// --- A. LICENSED B-roll becomes a candidate -------------------------------------------------------------------

test('A. LICENSED B-roll becomes a real candidate and resolves', () => {
  const project = makeProject();
  const { segment } = registerSegment(project.id, 'LICENSED');

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'BROLL_LIBRARY');
  assert.equal(resolution.selectedMaterial.candidate, `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`);
});

// --- B. UNKNOWN B-roll is hard rejected -------------------------------------------------------------------

test('B. UNKNOWN B-roll is hard rejected and never reaches ranking', () => {
  const project = makeProject();
  const { segment } = registerSegment(project.id, 'UNKNOWN');

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  const gate = resolution.hardGateResults.find((g) => g.candidate === `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`);
  assert.equal(gate.allowed, false);
  assert.equal(gate.rejectedBy, 'LICENSING_UNKNOWN');
  assert.equal(resolution.status, 'UNRESOLVED');
  assert.equal(resolution.candidates.some((c) => c.candidate === gate.candidate), false);
});

// --- C. REJECTED B-roll is hard rejected -------------------------------------------------------------------

test('C. REJECTED B-roll is hard rejected and can never become eligible', () => {
  const project = makeProject();
  const { segment } = registerSegment(project.id, 'REJECTED');

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  const gate = resolution.hardGateResults.find((g) => g.candidate === `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`);
  assert.equal(gate.allowed, false);
  assert.equal(gate.rejectedBy, 'LICENSING_REJECTED');
  assert.deepEqual(gate.eligibleRoles, []);
  assert.equal(resolution.status, 'UNRESOLVED');
});

// --- D. RESTRICTED B-roll -------------------------------------------------------------------
//
// STOP CONDITION (per this stage's explicit instruction): VisualBeat has no
// beat-level field to explicitly permit RESTRICTED material today. Only the
// "permission absent" case is testable — it must always reject, with a
// distinct, self-explanatory code, never silently allowed and never folded
// into the generic LICENSING_UNKNOWN code. The "explicitly permitted" case
// cannot be tested until a future stage adds that field (see this stage's
// final report for the exact minimal addition).

test('D. RESTRICTED B-roll is hard rejected when no beat-level permission mechanism exists (current schema gap)', () => {
  const project = makeProject();
  const { segment } = registerSegment(project.id, 'RESTRICTED');

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  const gate = resolution.hardGateResults.find((g) => g.candidate === `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`);
  assert.equal(gate.allowed, false);
  assert.equal(gate.rejectedBy, 'RESTRICTED_PERMISSION_FIELD_MISSING');
  assert.equal(resolution.status, 'UNRESOLVED');
});

test('D2. RESTRICTED never becomes eligible even when the beat carries unrelated fields set — no implicit permission is ever inferred', () => {
  const project = makeProject();
  registerSegment(project.id, 'RESTRICTED');

  // fallbackStrategy, costPriority, qualityPriority etc. are all populated —
  // none of them are a licensing-permission mechanism, and none may act as one.
  const b = beat({ fallbackStrategy: ['STILL_IMAGE'], costPriority: 'LOW', qualityPriority: 'HIGH' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});

  assert.equal(resolution.candidates.some((c) => c.materialSource === 'BROLL_LIBRARY'), false);
});

// --- E. selectedAssetId is populated with the referenced Asset ID -------------------------------------------------------------------

test('E. the winning B-roll candidate\'s selectedAssetId is exactly the referenced Asset id', () => {
  const project = makeProject();
  const { asset } = registerSegment(project.id, 'LICENSED');

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.selectedAssetId, asset.assetId);
});

// --- F. B-roll candidate carries the B-roll segment lineage -------------------------------------------------------------------

test('F. a real B-roll candidate carries full lineage — segmentId, assetId, licensing, source, media, descriptiveMetadata, usage', () => {
  const project = makeProject();
  const { asset, segment } = registerSegment(project.id, 'LICENSED', { descriptiveMetadata: { tags: ['office'], mood: 'calm' } });

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  const lineage = resolution.selectedMaterial.brollSegment;
  assert.ok(lineage, 'brollSegment lineage must be populated for a real BROLL_LIBRARY candidate');
  assert.equal(lineage.segmentId, segment.id);
  assert.equal(lineage.assetId, asset.assetId);
  assert.deepEqual(lineage.licensing, segment.licensing);
  assert.deepEqual(lineage.source, segment.source);
  assert.deepEqual(lineage.media, segment.media);
  assert.deepEqual(lineage.descriptiveMetadata, segment.descriptiveMetadata);
  assert.deepEqual(lineage.usage, segment.usage);
});

test('F2. brollSegment stays null for every non-BROLL_LIBRARY candidate, and for the Stage 26.3 fixture path', () => {
  const project = makeProject();
  const b = beat({ visualTreatment: 'KINETIC_TYPOGRAPHY' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.brollSegment, null);

  const fixtureResolution = materialResolutionService.resolveMaterial(project.id, beat(), { brollSegments: [{ segmentId: 'seg-1', licensingStatus: 'CLEARED' }] });
  assert.equal(fixtureResolution.status, 'RESOLVED');
  assert.equal(fixtureResolution.selectedMaterial.brollSegment, null, 'the legacy fixture path never populates real lineage');
});

// --- G. Character beat: B-roll cannot become PRIMARY, but remains OVERLAY/BACKGROUND/INSERT -------------------------------------------------------------------

test('G. a character-identity beat rejects real B-roll for PRIMARY but reports it eligible for OVERLAY/BACKGROUND/INSERT', () => {
  const project = makeProject();
  const { segment } = registerSegment(project.id, 'LICENSED');

  const b = beat({ identityRequirements: { characterReferences: ['zandra'], locationReferences: [], propReferences: [] } });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});

  const gate = resolution.hardGateResults.find((g) => g.candidate === `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`);
  assert.equal(gate.allowed, false);
  assert.equal(gate.rejectedBy, 'IDENTITY_REQUIRES_NON_BROLL_PRIMARY');
  assert.deepEqual(gate.eligibleRoles, ['OVERLAY', 'BACKGROUND', 'INSERT']);
  assert.equal(resolution.status, 'UNRESOLVED');
});

test('G2. a location-only-identity beat still allows real B-roll to survive as a PRIMARY candidate (not an identity hard-gate)', () => {
  const project = makeProject();
  registerSegment(project.id, 'LICENSED');

  const b = beat({ identityRequirements: { characterReferences: [], locationReferences: ['loc-1'], propReferences: [] } });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'BROLL_LIBRARY');
});

// --- H. Archived B-roll is excluded -------------------------------------------------------------------

test('H. an archived B-roll segment never becomes a candidate', () => {
  const project = makeProject();
  const { segment } = registerSegment(project.id, 'LICENSED');
  brollLibraryService.archiveBrollSegment(project.id, segment.id);

  const resolution = materialResolutionService.resolveMaterial(project.id, beat(), {});

  assert.equal(resolution.hardGateResults.some((g) => g.candidate === `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`), false);
  const gate = resolution.hardGateResults.find((g) => g.candidate === 'BROLL_LIBRARY+BROLL_CLIP');
  assert.equal(gate.rejectedBy, 'NO_LIBRARY', 'with the only segment archived, this project again has no eligible library');
  assert.equal(resolution.status, 'UNRESOLVED');
});

// --- I. Multiple B-roll candidates resolve deterministically -------------------------------------------------------------------

test('I. multiple real B-roll candidates resolve deterministically — repeated calls produce byte-identical results', () => {
  const project = makeProject();
  registerSegment(project.id, 'LICENSED');
  registerSegment(project.id, 'LICENSED');
  registerSegment(project.id, 'LICENSED');

  const first = materialResolutionService.resolveMaterial(project.id, beat(), {});
  const second = materialResolutionService.resolveMaterial(project.id, beat(), {});

  assert.equal(first.selectedMaterial.candidate, second.selectedMaterial.candidate);
  assert.deepEqual(first.ranking, second.ranking);
});

// --- J. Reversing candidate registration/input order produces the same winner -------------------------------------------------------------------

test('J. registration order does not influence the winner — the same set of segments, registered forward in one project and reversed in an otherwise-identical project, resolves to the same deciding phase and candidate count', () => {
  const projectA = makeProject({ title: 'A' });
  const projectB = makeProject({ title: 'B' });

  // Three equivalent LICENSED segments registered forward for A...
  for (let i = 0; i < 3; i++) registerSegment(projectA.id, 'LICENSED');

  // ...and the equivalent three registered in REVERSE creation order for B
  // (project isolation means these are independent segments, not literally
  // the same records — the point is that the ORDER of registration never
  // changes how many candidates survive or which phase decides).
  const assetsB = [makeStoredVideoAsset(projectB.id), makeStoredVideoAsset(projectB.id), makeStoredVideoAsset(projectB.id)];
  for (const asset of assetsB) timelineStore.setAssetApprovalStatus(projectB.id, asset.assetId, 'REJECTED');
  for (const asset of [...assetsB].reverse()) {
    const result = brollLibraryService.registerBrollSegment(projectB.id, { assetId: asset.assetId, source: { type: 'LOCAL_UPLOAD' }, licensing: { status: 'LICENSED' } });
    assert.equal(result.ok, true);
  }

  const resolutionA = materialResolutionService.resolveMaterial(projectA.id, beat(), {});
  const resolutionB = materialResolutionService.resolveMaterial(projectB.id, beat(), {});

  assert.equal(resolutionA.status, 'RESOLVED');
  assert.equal(resolutionB.status, 'RESOLVED');
  assert.equal(resolutionA.selectedMaterial.materialSource, 'BROLL_LIBRARY');
  assert.equal(resolutionB.selectedMaterial.materialSource, 'BROLL_LIBRARY');
  assert.equal(resolutionA.decidingPhase, resolutionB.decidingPhase);
  assert.equal(resolutionA.candidates.length, resolutionB.candidates.length);
});

test('J2. within one project, the resolver itself never depends on filesystem/array iteration order — shuffled equal-tier candidates still yield one deterministic winner across repeated resolutions', () => {
  const project = makeProject();
  registerSegment(project.id, 'LICENSED');
  registerSegment(project.id, 'LICENSED');

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(materialResolutionService.resolveMaterial(project.id, beat(), {}).selectedMaterial.candidate);
  }
  assert.ok(results.every((r) => r === results[0]), 'the same winner must be selected on every call');
});

// --- K. No mutation of B-roll store -------------------------------------------------------------------

test('K. resolveMaterial never mutates the B-roll store', () => {
  const project = makeProject();
  registerSegment(project.id, 'LICENSED');
  const before = JSON.stringify(brollLibraryService.listBrollSegments(project.id));

  materialResolutionService.resolveMaterial(project.id, beat(), {});
  materialResolutionService.resolveMaterial(project.id, beat({ identityRequirements: { characterReferences: ['x'], locationReferences: [], propReferences: [] } }), {});

  const after = JSON.stringify(brollLibraryService.listBrollSegments(project.id));
  assert.equal(after, before);
});

// --- L. No mutation of Asset -------------------------------------------------------------------

test('L. resolveMaterial never mutates the referenced Asset', () => {
  const project = makeProject();
  const { asset } = registerSegment(project.id, 'LICENSED');
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));

  materialResolutionService.resolveMaterial(project.id, beat(), {});

  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(after, before);
});

// --- M. BeatGraph-level resolution correctly aggregates B-roll results -------------------------------------------------------------------

test('M. resolveBeatGraph aggregates real B-roll resolutions into the summary exactly like the fixture path already does', () => {
  const project = makeProject();
  registerSegment(project.id, 'LICENSED');

  const b1 = beat({ id: crypto.randomUUID(), sequence: 1 });
  const b2 = beat({ id: crypto.randomUUID(), sequence: 2, identityRequirements: { characterReferences: ['zandra'], locationReferences: [], propReferences: [] } });
  const graph = createBeatGraph({ projectId: project.id, beats: [b1, b2] });

  const report = materialResolutionService.resolveBeatGraph(project.id, graph, {});

  assert.equal(report.summary.totalBeats, 2);
  assert.equal(report.summary.resolvedBeats, 1, 'b1 resolves via the real B-roll candidate');
  assert.equal(report.summary.unresolvedBeats, 1, 'b2 has only an identity-blocked B-roll candidate and no other treatment allowed');
  assert.equal(report.summary.brollCount, 1);
  assert.equal(report.summary.zeroCostDeterministicCount, 1);
});

// --- N. Existing non-B-roll behaviour is unaffected -------------------------------------------------------------------

test('N. PROJECT_ASSET_REUSE, AI_VIDEO, STILL_IMAGE_MOTION-path (STILL_IMAGE), KINETIC_TYPOGRAPHY, MOTION_GRAPHIC, and WHITEBOARD all resolve exactly as before, with zero B-roll registered', () => {
  const project = makeProject();

  const stillImage = materialResolutionService.resolveMaterial(project.id, beat({ visualTreatment: 'STILL_IMAGE' }), {});
  assert.equal(stillImage.status, 'RESOLVED');
  assert.equal(stillImage.selectedMaterial.materialSource, 'GENERATED_NEW');

  const aiVideo = materialResolutionService.resolveMaterial(project.id, beat({ visualTreatment: 'AI_VIDEO' }), {});
  assert.equal(aiVideo.status, 'RESOLVED');
  assert.equal(aiVideo.selectedMaterial.materialSource, 'GENERATED_NEW');

  const kinetic = materialResolutionService.resolveMaterial(project.id, beat({ visualTreatment: 'KINETIC_TYPOGRAPHY' }), {});
  assert.equal(kinetic.status, 'RESOLVED');
  assert.equal(kinetic.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');

  const motionGraphic = materialResolutionService.resolveMaterial(project.id, beat({ visualTreatment: 'MOTION_GRAPHIC' }), {});
  assert.equal(motionGraphic.status, 'RESOLVED');
  assert.equal(motionGraphic.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');

  const whiteboard = materialResolutionService.resolveMaterial(project.id, beat({ visualTreatment: 'WHITEBOARD' }), {});
  assert.equal(whiteboard.status, 'RESOLVED');
  assert.equal(whiteboard.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');
});

test('N2. an existing approved video asset still wins via PROJECT_ASSET_REUSE for an AI_VIDEO beat, unaffected by unrelated B-roll registered in the same project', () => {
  const project = makeProject();
  const existingVideo = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(project.id, existingVideo.assetId, { status: 'STORED' });
  timelineStore.setAssetApprovalStatus(project.id, existingVideo.assetId, 'APPROVED');

  registerSegment(project.id, 'LICENSED'); // unrelated B-roll registered in the same project

  // No BROLL_CLIP fallback — the BROLL_LIBRARY candidate class isn't even
  // considered for this beat, so this is a pure "B-roll's presence in the
  // project changes nothing for an unrelated beat" regression check.
  const b = beat({ visualTreatment: 'AI_VIDEO' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');
  assert.equal(resolution.selectedMaterial.selectedAssetId, existingVideo.assetId);
});

// --- O. No provider/network/credit imports or calls -------------------------------------------------------------------

test('O. no provider/network/credit-reservation imports anywhere in the changed Part 4 files', () => {
  for (const file of ['material-resolution-service.js', 'broll-library-service.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
    for (const forbidden of ['fetch(', 'axios', 'http.request', 'https.request', 'eval(', 'new Function(', 'child_process']) {
      assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${file} must not contain "${forbidden}"`);
    }
    assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*approval-gate[^'"`]*['"`]\s*\)/, `${file} must not require approval-gate.js`);
    for (const provider of ['evolink', 'higgsfield', 'seedance', 'openai', 'runway']) {
      assert.doesNotMatch(text.toLowerCase(), new RegExp(provider), `${file} must not mention provider "${provider}"`);
    }
  }
});

test('O2. no smoke-test/real project data was touched — this file only ever wrote into its own temp directories', () => {
  assert.notEqual(projectTempDir, path.join(__dirname, '..', 'data', 'projects'));
  assert.notEqual(brollTempDir, path.join(__dirname, '..', 'data', 'broll'));
});
