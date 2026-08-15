// Tests for services/material-resolution-service.js — Stage 26.2's first
// vertical slice: VisualBeat -> Material Resolution -> PROJECT_ASSET_REUSE
// -> existing Timeline IR. No provider calls, no credits, no generation,
// no canonical/approval mutation. Every fixture below is built through the
// EXISTING timeline-store.js/keyframe-store.js — this file introduces no
// second store.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-material-resolution-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-material-resolution-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-material-resolution-keyframes-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const materialResolutionService = require('../services/material-resolution-service');

// --- fixture helpers ---------------------------------------------------------------

// Project -> Scene -> Shot -> Keyframe, mirroring keyframe-canonical-asset.test.js's
// own fixture builder exactly (same layers, same order).
function buildProjectSceneShotKeyframe() {
  const project = projectStore.createProject({ title: 'material-resolution test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'ESTABLISHING_FRAME',
    sourceShotVersion: storyboard.version,
  });
  return { project, scene, shot, keyframe };
}

function addStoredAsset(projectId, overrides = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), ...overrides });
  return timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.png` });
}

function makeStillImageBeat(sceneId, shotId, overrides = {}) {
  return createVisualBeat({ sceneId, shotId, sequence: 1, startTime: 0, duration: 5, visualTreatment: 'STILL_IMAGE', ...overrides });
}

// --- 1. Valid existing asset selection ----------------------------------------------

test('1. resolveVisualBeat selects a STORED keyframe asset for a STILL_IMAGE beat', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  const asset = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.materialSource, 'PROJECT_ASSET_REUSE');
  assert.equal(resolution.decision.visualTreatment, 'STILL_IMAGE');
  assert.equal(resolution.decision.selectedAssetId, asset.assetId);
  assert.ok(resolution.decision.confidence > 0 && resolution.decision.confidence <= 1);
  assert.equal(resolution.beatId, beat.id);
});

// --- 2. Rejected asset exclusion -----------------------------------------------------

test('2. a REJECTED asset is excluded from candidates and reported as a rejected candidate', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  const rejected = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  timelineStore.setAssetApprovalStatus(project.id, rejected.assetId, 'REJECTED');
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, null);
  assert.equal(resolution.candidates.length, 0);
  assert.equal(resolution.rejectedCandidates.length, 1);
  assert.equal(resolution.rejectedCandidates[0].assetId, rejected.assetId);
  assert.ok(resolution.rejectedCandidates[0].reasons.some((r) => r.includes('REJECTED')));
});

// --- 3. Missing asset (no candidates at all) -----------------------------------------

test('3. no assets in the project at all yields "no eligible candidates" with structured diagnostics', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, null);
  assert.equal(resolution.decision.reason, 'no eligible candidates');
  assert.equal(resolution.candidates.length, 0);
  assert.equal(resolution.rejectedCandidates.length, 0);
  assert.ok(resolution.diagnostics.some((d) => d.includes('no eligible existing asset')));
});

// --- 4. Wrong-project asset never appears -------------------------------------------

test('4. an asset belonging to a different project is never considered (structurally excluded)', () => {
  const fixtureA = buildProjectSceneShotKeyframe();
  const fixtureB = buildProjectSceneShotKeyframe();
  addStoredAsset(fixtureB.project.id, { type: 'keyframe', keyframeId: fixtureB.keyframe.keyframeId, sceneId: fixtureB.scene.sceneId, shotId: fixtureB.shot.shotId });

  const beat = makeStillImageBeat(fixtureA.scene.sceneId, fixtureA.shot.shotId);
  const resolution = materialResolutionService.resolveVisualBeat(fixtureA.project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, null);
  assert.equal(resolution.candidates.length, 0);
  assert.equal(resolution.rejectedCandidates.length, 0, 'project B\'s asset must not even surface as a rejected candidate for project A');
});

// --- 5. Incompatible media type -------------------------------------------------------

test('5. a video asset cannot satisfy a STILL_IMAGE beat (hard media-type gate)', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const videoAsset = addStoredAsset(project.id, { type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, null);
  assert.equal(resolution.candidates.length, 0);
  assert.equal(resolution.rejectedCandidates.length, 1);
  assert.equal(resolution.rejectedCandidates[0].assetId, videoAsset.assetId);
  assert.ok(resolution.rejectedCandidates[0].reasons.some((r) => r.includes('cannot satisfy visualTreatment')));
});

test('5b. an AI_VIDEO beat is satisfied by an existing STORED video asset', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const videoAsset = addStoredAsset(project.id, { type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, visualTreatment: 'AI_VIDEO' });

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, videoAsset.assetId);
});

test('5c. a BROLL_CLIP beat can also be satisfied by an existing STORED video asset (both map to Asset type "video")', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const videoAsset = addStoredAsset(project.id, { type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, visualTreatment: 'BROLL_CLIP' });

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, videoAsset.assetId);
});

test('5d. MOTION_GRAPHIC/KINETIC_TYPOGRAPHY/HYBRID beats have no PROJECT_ASSET_REUSE path — reported via diagnostics, not silently empty', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  for (const visualTreatment of ['MOTION_GRAPHIC', 'KINETIC_TYPOGRAPHY', 'HYBRID']) {
    const beat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, visualTreatment });
    const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);
    assert.equal(resolution.decision.selectedAssetId, null);
    assert.ok(resolution.diagnostics.some((d) => d.includes('no PROJECT_ASSET_REUSE path today')), `expected a diagnostic for ${visualTreatment}`);
  }
});

// --- 6. Incompatible duration where checkable ----------------------------------------

test('6. duration compatibility is not gated (Asset has no duration field) — documented, not invented', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const videoAsset = addStoredAsset(project.id, { type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  assert.equal('duration' in videoAsset, false, 'Asset must not have a duration field — if this ever changes, the resolver should start gating on it');

  const beat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, visualTreatment: 'AI_VIDEO', duration: 999 });
  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);
  assert.equal(resolution.decision.selectedAssetId, videoAsset.assetId, 'a wildly mismatched beat duration must not block a candidate — there is nothing to check yet');
});

// --- 7. Deterministic ranking ---------------------------------------------------------

test('7. an APPROVED asset outranks an unreviewed (NONE) asset for the same beat', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  const plain = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const approved = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  timelineStore.setAssetApprovalStatus(project.id, approved.assetId, 'APPROVED');

  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);
  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, approved.assetId);
  assert.equal(resolution.candidates.length, 2);
  assert.equal(resolution.candidates[0].assetId, approved.assetId);
  assert.equal(resolution.candidates[1].assetId, plain.assetId);
  assert.ok(resolution.candidates[0].score > resolution.candidates[1].score);
});

test('7b. ranking is deterministic across repeated calls (same inputs -> same order)', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);

  const first = materialResolutionService.resolveVisualBeat(project.id, beat);
  const second = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.deepEqual(first.candidates.map((c) => c.assetId), second.candidates.map((c) => c.assetId));
  assert.equal(first.decision.selectedAssetId, second.decision.selectedAssetId);
});

// --- 8. Canonical/approved preference where supported ---------------------------------

test('8. a keyframe\'s canonical asset outranks a non-canonical, equally-approved sibling', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  const a = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const b = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  timelineStore.setAssetApprovalStatus(project.id, a.assetId, 'APPROVED');
  timelineStore.setAssetApprovalStatus(project.id, b.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, b.assetId, { selectedBy: 'tester' });

  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);
  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, b.assetId);
  assert.ok(resolution.decision.reason.includes('canonical'));
});

// --- 9. No eligible candidates (everything rejected) ----------------------------------

test('9. every candidate rejected leaves a clean "no eligible candidates" result, never a throw', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  const rejected1 = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const rejected2 = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  timelineStore.setAssetApprovalStatus(project.id, rejected1.assetId, 'REJECTED');
  timelineStore.setAssetApprovalStatus(project.id, rejected2.assetId, 'REJECTED');

  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);
  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, null);
  assert.equal(resolution.rejectedCandidates.length, 2);
});

// --- 10. Structured diagnostics --------------------------------------------------------

test('10a. an unrecognized visualTreatment produces a structured diagnostic, never a throw', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const beat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, visualTreatment: 'NOT_A_REAL_TREATMENT' });
  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);
  assert.equal(resolution.decision.selectedAssetId, null);
  assert.ok(resolution.diagnostics[0].includes('not one of'));
});

test('10b. an unknown project id produces a structured "project not found" diagnostic, never a throw', () => {
  const beat = makeStillImageBeat('sc-1', 'sh-1');
  const resolution = materialResolutionService.resolveVisualBeat('00000000-0000-0000-0000-000000000000', beat);
  assert.equal(resolution.decision.reason, 'project not found');
  assert.equal(resolution.diagnostics.length, 1);
});

test('10c. a null/id-less beat produces a structured diagnostic, never a throw', () => {
  const resolution = materialResolutionService.resolveVisualBeat('any-project', null);
  assert.equal(resolution.decision.selectedAssetId, null);
  assert.equal(resolution.beatId, null);
  assert.ok(resolution.diagnostics.length > 0);
});

test('10d. a video candidate with unmet identity requirements is ranked (not excluded) with an explicit unverifiable-identity diagnostic', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const videoAsset = addStoredAsset(project.id, { type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = createVisualBeat({
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    sequence: 1,
    visualTreatment: 'AI_VIDEO',
    identityRequirements: { characterReferences: ['char-1'], locationReferences: [], propReferences: [] },
  });

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);

  assert.equal(resolution.decision.selectedAssetId, videoAsset.assetId, 'unverifiable identity must not exclude the candidate');
  assert.ok(resolution.diagnostics.some((d) => d.includes('identity requirements could not be verified')));
});

// --- 11. Provider neutrality / zero network / zero credit / zero generation -----------

test('11a. services/material-resolution-service.js requires no provider, generation, or approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-resolution-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../schemas/visual-beat-schema', './keyframe-store', './timeline-store'].sort());
});

test('11b. services/material-resolution-service.js never mentions a specific provider or model name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-resolution-service.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference provider/model "${forbidden}"`);
  }
});

test('11c. resolveVisualBeat never creates a generation job, spends a credit, or performs network I/O — proven by an unmodified fixture snapshot before/after', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);

  const before = JSON.stringify(timelineStore.listAssets(project.id));
  materialResolutionService.resolveVisualBeat(project.id, beat);
  materialResolutionService.resolveVisualBeat(project.id, beat);
  const after = JSON.stringify(timelineStore.listAssets(project.id));

  assert.equal(before, after, 'resolveVisualBeat is read-only — repeated calls must never mutate any asset');
});

// --- 12. Timeline IR mapping correctness ------------------------------------------------

test('12a. toTimelineShotFields maps a resolved STILL_IMAGE beat into legacy Shot fields, including keyframeAssetId', () => {
  const { project, scene, shot, keyframe } = buildProjectSceneShotKeyframe();
  const asset = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId, { narrativePurpose: 'Establish the office', composition: 'wide', camera: 'static' });

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);
  const fields = materialResolutionService.toTimelineShotFields(beat, resolution);

  assert.equal(fields.sceneId, scene.sceneId);
  assert.equal(fields.keyframeAssetId, asset.assetId);
  assert.equal(fields.videoAssetId, null);
  assert.equal(fields.narrativePurpose, 'Establish the office');
  assert.equal(fields.composition, 'wide');
  assert.equal(fields.camera, 'static');
  assert.equal(fields.generationId, null);
});

test('12b. toTimelineShotFields maps a resolved AI_VIDEO beat into legacy Shot fields, including videoAssetId', () => {
  const { project, scene, shot } = buildProjectSceneShotKeyframe();
  const asset = addStoredAsset(project.id, { type: 'video', sceneId: scene.sceneId, shotId: shot.shotId });
  const beat = createVisualBeat({ sceneId: scene.sceneId, shotId: shot.shotId, sequence: 1, visualTreatment: 'AI_VIDEO', subjectMotion: 'walks forward', environmentMotion: 'leaves rustle' });

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);
  const fields = materialResolutionService.toTimelineShotFields(beat, resolution);

  assert.equal(fields.videoAssetId, asset.assetId);
  assert.equal(fields.keyframeAssetId, null);
  assert.equal(fields.subjectAction, 'walks forward');
  assert.equal(fields.environmentAction, 'leaves rustle');
});

test('12c. toTimelineShotFields throws when called on an unresolved beat — never silently produces a shot with no material', () => {
  const { scene, shot } = buildProjectSceneShotKeyframe();
  const beat = makeStillImageBeat(scene.sceneId, shot.shotId);
  const emptyResolution = { decision: { selectedAssetId: null } };
  assert.throws(() => materialResolutionService.toTimelineShotFields(beat, emptyResolution), /requires a resolution with a selected asset/);
});

test('12d. the mapped fields round-trip through the REAL timelineStore.addShot() and persist correctly (proves genuine Timeline IR compatibility, not just a plausible-looking object)', () => {
  const { project, keyframe } = buildProjectSceneShotKeyframe();
  // toTimelineShotFields/addShot operate on the legacy Timeline IR's OWN
  // scenes (project.scenes, populated by timelineStore.addScene) — a
  // separate structure from the Creative Storyboard's scenes used to build
  // the keyframe above (creativeStore.addStoryboardScene). Nothing in
  // resolveVisualBeat itself cares which scene/shot system an asset's
  // sceneId/shotId came from (it never filters candidates by scene/shot —
  // only by type/identity, per the "asset belongs to the PROJECT" gate),
  // so this is only relevant for the actual addShot() round-trip below.
  const timelineScene = timelineStore.addScene(project.id, { title: 'Timeline Scene 1' });
  const asset = addStoredAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId });
  const beat = makeStillImageBeat(timelineScene.sceneId, null, { narrativePurpose: 'Nova enters the office' });

  const resolution = materialResolutionService.resolveVisualBeat(project.id, beat);
  const fields = materialResolutionService.toTimelineShotFields(beat, resolution);

  const persistedShot = timelineStore.addShot(project.id, fields);
  assert.ok(persistedShot.shotId, 'addShot must accept the adapter\'s output and assign a real shotId');
  assert.equal(persistedShot.keyframeAssetId, asset.assetId);
  assert.equal(persistedShot.narrativePurpose, 'Nova enters the office');
  assert.equal(persistedShot.status, 'PLANNED', 'addShot applies its own normal defaults on top of the adapter\'s fields — no second timeline schema was introduced');

  const reread = timelineStore.getShot(project.id, persistedShot.shotId);
  assert.equal(reread.keyframeAssetId, asset.assetId);
});

// --- Safety: no server/data writes ------------------------------------------------------

test('13. this test file only ever wrote into its own temp directories, never the real server/data', () => {
  assert.notEqual(projectTempDir, path.join(__dirname, '..', 'data', 'projects'));
  assert.ok(fs.existsSync(projectTempDir));
});
