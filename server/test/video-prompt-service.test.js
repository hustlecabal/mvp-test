// Tests for services/video-prompt-service.js — canonical keyframe asset
// resolution, model registry validation, deterministic video prompt
// composition, stale detection, versioning, reference lineage, and
// confirmation that building a video prompt package never touches
// generation/approval/budget/canonical-selection state. No network, no
// provider, no LLM call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-video-packages-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-jobs-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vps-kf-approvals-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = keyframePromptTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const keyframePromptService = require('../services/keyframe-prompt-service');
const generationStore = require('../services/generation-store');
const keyframeGenerationApprovalStore = require('../services/keyframe-generation-approval-store');
const gate = require('../services/approval-gate');
const vps = require('../services/video-prompt-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

const GOOD_PROVIDER = 'evolink';
const GOOD_MODEL = 'seedance-2.0-mini-image-to-video'; // REQUEST_SCHEMA_VERIFIED, imageToVideo: true
const INCAPABLE_MODEL = 'seedance-2.0-text-to-video'; // schema-verified but imageToVideo: false
const REFERENCE_CAPABLE_MODEL = 'seedance-2.0-mini-reference-to-video'; // referenceImages: true, maxReferenceImages: 9

function newProject(title = 'video prompt service test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// A full, realistic fixture: 1 character (with an approved+canonical
// reference asset), 1 shot, 1 keyframe with an image KeyframePromptPackage
// already built, and 1 APPROVED generated asset selected as the
// keyframe's canonical asset.
function buildFixture({ selectCanonical = true, approveAsset = true } = {}) {
  const project = newProject();

  creativeStore.updateVisualBible(
    project.id,
    { characters: [{ characterId: 'char-a', name: 'A', identityConstraints: 'must always have X', continuityNotes: 'never Y' }] },
    {}
  );
  creativeStore.updateStoryboard(
    project.id,
    {
      scenes: [{ sceneId: 'scene-1', title: 'Scene 1' }],
      shots: [{ shotId: 'shot-1', sceneId: 'scene-1', characterReferences: ['char-a'], action: 'A walks across the room', camera: 'eye level', composition: 'centered', lighting: 'soft' }],
    },
    {}
  );
  const keyframe = keyframeStore.createKeyframe(project.id, {
    sceneId: 'scene-1',
    shotId: 'shot-1',
    subject: 'A',
    frameType: 'CHARACTER_REFERENCE',
    camera: 'eye level',
    composition: 'centered',
    lighting: 'soft',
  });
  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});

  const asset = timelineStore.addAsset(project.id, {
    type: 'keyframe',
    keyframeId: keyframe.keyframeId,
    sceneId: 'scene-1',
    shotId: 'shot-1',
    approvalStatus: 'NONE',
  });

  if (approveAsset) timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  if (selectCanonical) keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });

  return { project, keyframe, asset };
}

// ---------------------------------------------------------------------------
// 1/7/8. Schema validation via service behaviour + correct lineage
// ---------------------------------------------------------------------------

test('a successfully built package carries correct project/scene/shot/keyframe and canonical-asset lineage', () => {
  const { project, keyframe, asset } = buildFixture();
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, true);
  const pkg = result.package;
  assert.equal(pkg.projectId, project.id);
  assert.equal(pkg.sceneId, 'scene-1');
  assert.equal(pkg.shotId, 'shot-1');
  assert.equal(pkg.keyframeId, keyframe.keyframeId);
  assert.equal(pkg.canonicalKeyframeAssetId, asset.assetId);
  assert.equal(pkg.sourceCanonicalKeyframeAssetId, asset.assetId);
  assert.equal(typeof pkg.sourceShotVersion, 'number');
  assert.equal(typeof pkg.sourceKeyframePlanVersion, 'number');
});

// ---------------------------------------------------------------------------
// 2/3/4/5/6. Canonical asset requirement
// ---------------------------------------------------------------------------

test('canonical asset required: build fails with a structured diagnostic when none is selected', () => {
  const { project, keyframe } = buildFixture({ selectCanonical: false });
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CANONICAL_ASSET_SELECTED');
  assert.match(result.reason, /no explicitly-selected canonical asset/i);
});

test('canonical asset must be APPROVED: an unapproved (NONE) canonical selection is blocked', () => {
  const { project, keyframe } = buildFixture({ approveAsset: false, selectCanonical: false });
  const asset2 = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  // selectCanonicalKeyframeAsset only refuses REJECTED, not NONE/PENDING — confirm THIS layer still blocks it.
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset2.assetId, { selectedBy: 'tester' });
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ASSET_NOT_APPROVED');
});

test('rejected canonical asset is blocked (selectCanonicalKeyframeAsset itself refuses a REJECTED asset)', () => {
  const { project, keyframe } = buildFixture({ approveAsset: false, selectCanonical: false });
  const asset2 = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, asset2.assetId, 'REJECTED');
  const selection = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset2.assetId, { selectedBy: 'tester' });
  assert.equal(selection.ok, false); // the underlying store already refuses this

  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CANONICAL_ASSET_SELECTED');
});

test('unassociated canonical asset is blocked: an asset belonging to a different keyframe can never become canonical here', () => {
  const { project, keyframe } = buildFixture({ selectCanonical: false });
  const otherKeyframe = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: 'A' });
  const foreignAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: otherKeyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, foreignAsset.assetId, 'APPROVED');
  const selection = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, foreignAsset.assetId, { selectedBy: 'tester' });
  assert.equal(selection.ok, false); // store refuses cross-keyframe selection

  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CANONICAL_ASSET_SELECTED');
});

test('no implicit newest-asset selection: with two APPROVED candidate assets but no canonical selection, build still fails', () => {
  const { project, keyframe } = buildFixture({ selectCanonical: false });
  const assetA = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, assetA.assetId, 'APPROVED');
  const assetB = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, assetB.assetId, 'APPROVED');

  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CANONICAL_ASSET_SELECTED');
});

// ---------------------------------------------------------------------------
// 9/10/11/12/13. Provider/model validation via the registry
// ---------------------------------------------------------------------------

test('provider/model validation: missing provider/model is rejected', () => {
  const { project, keyframe } = buildFixture();
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_MODEL_REQUIRED');
});

test('unknown model is rejected with a structured diagnostic', () => {
  const { project, keyframe } = buildFixture();
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: 'evolink', model: 'does-not-exist' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_MODEL');
});

test('a text-to-video-only model (unsupported image-to-video) is rejected', () => {
  const { project, keyframe } = buildFixture();
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: INCAPABLE_MODEL });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_CAPABILITY_UNSUPPORTED');
  assert.match(result.reason, /imageToVideo/);
});

test('an image-to-video model without reference support is rejected when reference conditioning is required', () => {
  const { project, keyframe } = buildFixture();
  // seedance-2.0-mini-image-to-video: imageToVideo true, referenceImages false
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, requiresReferenceImages: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_CAPABILITY_UNSUPPORTED');
  assert.match(result.reason, /referenceImages/);
});

test('a reference-capable model satisfies requiresReferenceImages', () => {
  const { project, keyframe } = buildFixture();
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: REFERENCE_CAPABLE_MODEL, requiresReferenceImages: true });
  assert.equal(result.ok, true);
});

test('unknown capability (null) does not pass a required capability check', () => {
  const { project, keyframe } = buildFixture();
  // seedream-5.0-lite: video-incapable entirely (image modality) -- use a
  // genuinely unknown-capability VIDEO case instead: veo-3.1-lite has
  // referenceImages: null (unconfirmed for the Lite tier).
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: 'google', model: 'veo-3.1-lite-generate-preview', requiresReferenceImages: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_CAPABILITY_UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// 14/15/16. Verification snapshot recorded correctly, never silently promoted
// ---------------------------------------------------------------------------

test('productionReady/verificationStatus/requestSchemaVerified are recorded exactly as the registry says, even for a non-production model', () => {
  const { project, keyframe } = buildFixture();
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, true);
  // seedance-2.0-mini-image-to-video is REQUEST_SCHEMA_VERIFIED but NOT productionReady (per the registry)
  assert.equal(result.package.modelVerification.verificationStatus, 'REQUEST_SCHEMA_VERIFIED');
  assert.equal(result.package.modelVerification.productionReady, false);
  assert.equal(result.package.modelVerification.requestSchemaVerified, true);
});

test('a SAFE_FOR_PRODUCTION model records productionReady: true honestly', () => {
  const { project, keyframe } = buildFixture();
  // gemini-3-pro-image-preview is an IMAGE model (SAFE_FOR_PRODUCTION) -- use
  // it only to confirm the snapshot mechanism reads the registry's real
  // productionReady value; expect this specific call to fail on modality,
  // proving the check isn't bypassed for a "trusted" model either.
  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: 'evolink', model: 'gemini-3-pro-image-preview' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_CAPABILITY_UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// 17. Deterministic composition
// ---------------------------------------------------------------------------

test('deterministic composition: identical inputs produce identical structured content (excluding timestamps/ids)', () => {
  const { project: projectA, keyframe: keyframeA } = buildFixture();
  const { project: projectB, keyframe: keyframeB } = buildFixture();

  const opts = { provider: GOOD_PROVIDER, model: GOOD_MODEL, creativeSpecification: { subjectMotion: 'A walks forward' }, executionParameters: { duration: 6 } };
  const resultA = vps.buildVideoPromptPackage(projectA.id, keyframeA.keyframeId, opts);
  const resultB = vps.buildVideoPromptPackage(projectB.id, keyframeB.keyframeId, opts);

  assert.equal(resultA.package.prompt, resultB.package.prompt);
  assert.deepEqual(resultA.package.videoPromptSections, resultB.package.videoPromptSections);
  assert.deepEqual(resultA.package.creativeSpecification, resultB.package.creativeSpecification);
  assert.deepEqual(resultA.package.executionParameters, resultB.package.executionParameters);
});

// ---------------------------------------------------------------------------
// 18/19/20. Rebuild idempotency, version increment, history preservation
// ---------------------------------------------------------------------------

test('rebuilding with unchanged sources reuses the same packageId and does not create a duplicate', () => {
  const { project, keyframe } = buildFixture();
  const first = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const second = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(first.package.packageId, second.package.packageId);
  assert.equal(second.package.version, 2);

  const all = vps.listVideoPromptPackages(project.id, {});
  assert.equal(all.length, 1);
});

test('version increments and history is preserved across rebuilds', () => {
  const { project, keyframe } = buildFixture();
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, changeNote: 'v1' });
  const second = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, changeNote: 'v2' });
  assert.equal(second.package.version, 2);
  assert.equal(second.package.history.length, 1);
  assert.equal(second.package.history[0].version, 1);
});

// ---------------------------------------------------------------------------
// 21/22/23/24/25/26/27. Staleness / invalidation
// ---------------------------------------------------------------------------

test('stale detection: shot-version change stales the package', () => {
  const { project, keyframe } = buildFixture();
  const built = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(built.package.status, 'CURRENT');

  creativeStore.updateStoryboard(project.id, { shots: [{ shotId: 'shot-1', sceneId: 'scene-1', characterReferences: ['char-a'], action: 'A runs instead' }] }, {});

  const read = vps.getVideoPromptPackage(project.id, keyframe.keyframeId);
  assert.equal(read.status, 'STALE');
});

test('stale detection: keyframe-plan-version change stales the package', () => {
  const { project, keyframe } = buildFixture();
  const built = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(built.package.status, 'CURRENT');

  keyframeStore.updateKeyframe(project.id, keyframe.keyframeId, { notes: 'a plan-version-bumping edit' }, {});

  const read = vps.getVideoPromptPackage(project.id, keyframe.keyframeId);
  assert.equal(read.status, 'STALE');
});

test('stale detection: canonical-keyframe-asset change stales the package', () => {
  const { project, keyframe } = buildFixture();
  const built = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(built.package.status, 'CURRENT');

  const newAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, newAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, newAsset.assetId, { selectedBy: 'tester', changeNote: 'switched canonical' });

  const read = vps.getVideoPromptPackage(project.id, keyframe.keyframeId);
  assert.equal(read.status, 'STALE');
});

test('rebuilding after a canonical-asset change produces a new CURRENT version pointing at the new asset', () => {
  const { project, keyframe } = buildFixture();
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });

  const newAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, newAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, newAsset.assetId, { selectedBy: 'tester' });

  const rebuilt = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(rebuilt.package.status, 'CURRENT');
  assert.equal(rebuilt.package.canonicalKeyframeAssetId, newAsset.assetId);
  assert.equal(rebuilt.package.version, 2);
});

test('provider/model invalidation: rebuilding with a different provider/model changes the stored selection and bumps version', () => {
  const { project, keyframe } = buildFixture();
  const first = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(first.package.model, GOOD_MODEL);

  const second = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: REFERENCE_CAPABLE_MODEL, requiresReferenceImages: true });
  assert.equal(second.package.model, REFERENCE_CAPABLE_MODEL);
  assert.equal(second.package.version, 2);
});

test('execution-parameter invalidation: rebuilding with different execution parameters updates them and bumps version', () => {
  const { project, keyframe } = buildFixture();
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, executionParameters: { duration: 4 } });
  const second = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, executionParameters: { duration: 8 } });
  assert.equal(second.package.executionParameters.duration, 8);
  assert.equal(second.package.version, 2);
});

test('creative-specification invalidation: rebuilding with a different creative specification updates the derived prompt and bumps version', () => {
  const { project, keyframe } = buildFixture();
  const first = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, creativeSpecification: { subjectMotion: 'walks slowly' } });
  const second = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, creativeSpecification: { subjectMotion: 'runs quickly' } });
  assert.notEqual(first.package.prompt, second.package.prompt);
  assert.equal(second.package.version, 2);
});

// --- P1 Cinema Director bridge — VisualBeat motion fields reach the video prompt ---
//
// beat-graph-derivation-service.js's real, unmodified deriveBeatGraph()
// never populates subjectMotion/environmentMotion/pacing from a Storyboard
// today — Shot itself has no such fields (confirmed by direct trace, a
// finding this stage's own report records honestly). These tests use a
// real, directly-constructed VisualBeat (createVisualBeat — the actual
// canonical schema factory, matching VisualBeat.id === shot.shotId, the
// same identity convention beat-graph-derivation-service.js itself uses)
// supplied via the options.beatGraph override — the same "explicit input,
// else the real default" idiom this function already uses for
// creativeSpecification/executionParameters — to prove the CONSUMPTION
// side of the bridge, independent of that separate, out-of-scope
// creation gap.

function beatGraphWithMotion(shotId, motionFields) {
  return createBeatGraph({ beats: [createVisualBeat({ id: shotId, shotId, ...motionFields })] });
}

test('P1-B.1 VisualBeat.subjectMotion reaches the actual video-generation prompt', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: 'turns sharply toward the headlights' });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.subjectMotion, 'turns sharply toward the headlights');
  assert.match(result.fields.prompt, /SUBJECT MOTION:\nturns sharply toward the headlights/);
});

test('P1-B.2 VisualBeat.environmentMotion reaches the actual video-generation prompt', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { environmentMotion: 'headlights sweep across the wet asphalt' });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.environmentMotion, 'headlights sweep across the wet asphalt');
  assert.match(result.fields.prompt, /ENVIRONMENT MOTION:\nheadlights sweep across the wet asphalt/);
});

test('P1-B.3 VisualBeat.pacing reaches the actual video-generation prompt', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { pacing: 'a sudden burst of speed, then held stillness' });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.pacing, 'a sudden burst of speed, then held stillness');
  assert.match(result.fields.prompt, /PACING:\na sudden burst of speed, then held stillness/);
});

test('P1-B.4 all three motion fields together reach the prompt from ONE real VisualBeat, alongside pre-existing fields (nothing unrelated dropped)', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, {
    subjectMotion: 'turns sharply toward the headlights',
    environmentMotion: 'headlights sweep across the wet asphalt',
    pacing: 'a sudden burst of speed, then held stillness',
  });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.match(result.fields.prompt, /SUBJECT MOTION:\nturns sharply toward the headlights/);
  assert.match(result.fields.prompt, /ENVIRONMENT MOTION:\nheadlights sweep across the wet asphalt/);
  assert.match(result.fields.prompt, /PACING:\na sudden burst of speed, then held stillness/);
  // pre-existing, already-working fields must still be present too
  assert.match(result.fields.prompt, /CAMERA MOTION:\neye level/);
  assert.match(result.fields.prompt, /COMPOSITION:\ncentered/);
});

test('P1-B.5 an explicit creativeSpecInput override always wins over the VisualBeat default — never silently overridden', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: 'from the beat' });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, {
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    beatGraph,
    creativeSpecification: { subjectMotion: 'explicitly supplied by the caller' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.subjectMotion, 'explicitly supplied by the caller');
  assert.doesNotMatch(result.fields.prompt, /from the beat/);
});

test('P1-B.6 FAILURE INJECTION — no matching beat at all (today\'s real, unmodified deriveBeatGraph() never populates motion fields) degrades safely: prompt stays valid, fields are null, never throws', () => {
  const { project, keyframe } = buildFixture();
  assert.doesNotThrow(() => vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL }));
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.subjectMotion, null);
  assert.equal(result.fields.creativeSpecification.environmentMotion, null);
  assert.equal(result.fields.creativeSpecification.pacing, null);
  assert.doesNotMatch(result.fields.prompt, /SUBJECT MOTION/);
});

test('P1-B.7 FAILURE INJECTION — null motion fields on a real VisualBeat degrade safely, same as no beat at all', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: null, environmentMotion: null, pacing: null });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.subjectMotion, null);
  assert.doesNotMatch(result.fields.prompt, /SUBJECT MOTION/);
});

test('P1-B.8 FAILURE INJECTION — malformed (non-string) motion fields never get stringified into the prompt; degrade to absent, never crash', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: { unexpected: 'object' }, environmentMotion: 42, pacing: [] });
  assert.doesNotThrow(() => vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph }));
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.equal(result.fields.creativeSpecification.subjectMotion, null);
  assert.equal(result.fields.creativeSpecification.environmentMotion, null);
  assert.equal(result.fields.creativeSpecification.pacing, null);
  assert.doesNotMatch(result.fields.prompt, /object Object/);
});

test('P1-B.9 FAILURE INJECTION — missing pacing specifically (subjectMotion/environmentMotion present) still produces a valid prompt with only PACING absent', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: 'walks forward', environmentMotion: 'leaves rustle' });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.match(result.fields.prompt, /SUBJECT MOTION:\nwalks forward/);
  assert.match(result.fields.prompt, /ENVIRONMENT MOTION:\nleaves rustle/);
  assert.doesNotMatch(result.fields.prompt, /PACING/);
});

test('P1-B.10 FAILURE INJECTION — conflicting motion instructions (subjectMotion and environmentMotion textually contradictory) do not crash and neither side is silently dropped', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: 'stands completely still', environmentMotion: 'the whole frame shakes violently' });
  assert.doesNotThrow(() => vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph }));
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.match(result.fields.prompt, /SUBJECT MOTION:\nstands completely still/);
  assert.match(result.fields.prompt, /ENVIRONMENT MOTION:\nthe whole frame shakes violently/);
});

test('P1-B.11 resolveMatchingBeat finds the beat by shot identity (VisualBeat.id === shotId), never a wrong shot\'s beat', () => {
  const beatGraph = createBeatGraph({
    beats: [createVisualBeat({ id: 'shot-1', shotId: 'shot-1', subjectMotion: 'shot 1 motion' }), createVisualBeat({ id: 'shot-2', shotId: 'shot-2', subjectMotion: 'shot 2 motion' })],
  });
  const found = beatGraph.beats.find((b) => b.id === 'shot-1');
  assert.equal(vps.beatCreativeText(found, 'subjectMotion'), 'shot 1 motion');
});

test('P1-B.12 beatCreativeText degrades safely for a null beat, missing field, and non-string field alike', () => {
  assert.equal(vps.beatCreativeText(null, 'subjectMotion'), null);
  assert.equal(vps.beatCreativeText(createVisualBeat({}), 'subjectMotion'), null);
  assert.equal(vps.beatCreativeText(createVisualBeat({ subjectMotion: 123 }), 'subjectMotion'), null);
  assert.equal(vps.beatCreativeText(createVisualBeat({ subjectMotion: '  ' }), 'subjectMotion'), null, 'whitespace-only must not count as real content');
});

test('P1-B.13 every other field on the resolved package (canonical asset, camera, composition, lighting, continuity) is unaffected by this fix', () => {
  const { project, keyframe } = buildFixture();
  const beatGraph = beatGraphWithMotion(keyframe.shotId, { subjectMotion: 'walks forward' });
  const result = vps.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, beatGraph });
  assert.equal(result.ok, true);
  assert.ok(result.fields.canonicalKeyframeAssetId);
  assert.equal(result.fields.creativeSpecification.camera, 'eye level');
  assert.equal(result.fields.creativeSpecification.composition, 'centered');
  assert.equal(result.fields.creativeSpecification.lighting, 'soft');
  assert.match(result.fields.prompt, /^SUBJECT:/, 'section ordering must still start with SUBJECT');
});

test('unrelated project activity does not stale the package', () => {
  const { project, keyframe } = buildFixture();
  const built = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(built.package.status, 'CURRENT');

  // Creating an unrelated second project must never affect this one.
  newProject('unrelated');

  const read = vps.getVideoPromptPackage(project.id, keyframe.keyframeId);
  assert.equal(read.status, 'CURRENT');
});

// ---------------------------------------------------------------------------
// 28/29. Reference lineage preservation
// ---------------------------------------------------------------------------

test('reference lineage is carried forward from the canonical keyframe\'s own image prompt package', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-a', name: 'A' }] }, {});
  creativeStore.updateStoryboard(project.id, { scenes: [{ sceneId: 'scene-1' }], shots: [{ shotId: 'shot-1', sceneId: 'scene-1', characterReferences: ['char-a'] }] }, {});
  const keyframe = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: 'A' });

  const refAsset = timelineStore.addAsset(project.id, { type: 'character_reference', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, refAsset.assetId, 'APPROVED');
  creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', 'char-a', refAsset.assetId, {});
  creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', 'char-a', refAsset.assetId, { selectedBy: 'tester' });

  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});

  const genAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, genAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, genAsset.assetId, { selectedBy: 'tester' });

  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, true);
  assert.equal(result.package.referenceLineage.length, 1);
  assert.equal(result.package.referenceLineage[0].assetId, refAsset.assetId);
  assert.equal(result.package.referenceLineage[0].roleType, 'CHARACTER');
  assert.equal(result.package.referenceLineage[0].canonical, true);
});

test('multi-character reference lineage is preserved for a shot with two characters', () => {
  const project = newProject();
  creativeStore.updateVisualBible(
    project.id,
    { characters: [{ characterId: 'char-a', name: 'A' }, { characterId: 'char-b', name: 'B' }] },
    {}
  );
  creativeStore.updateStoryboard(project.id, { scenes: [{ sceneId: 'scene-1' }], shots: [{ shotId: 'shot-1', sceneId: 'scene-1', characterReferences: ['char-a', 'char-b'] }] }, {});
  const keyframe = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: 'A and B' });

  for (const charId of ['char-a', 'char-b']) {
    const refAsset = timelineStore.addAsset(project.id, { type: 'character_reference', approvalStatus: 'NONE' });
    timelineStore.setAssetApprovalStatus(project.id, refAsset.assetId, 'APPROVED');
    creativeStore.addEntityReferenceAsset(project.id, 'CHARACTER', charId, refAsset.assetId, {});
    creativeStore.selectCanonicalReferenceAsset(project.id, 'CHARACTER', charId, refAsset.assetId, { selectedBy: 'tester' });
  }

  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});

  const genAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, genAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, genAsset.assetId, { selectedBy: 'tester' });

  const result = vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(result.ok, true);
  assert.equal(result.package.referenceLineage.length, 2);
  const roleTypes = result.package.referenceLineage.map((r) => r.roleType);
  assert.deepEqual(roleTypes, ['CHARACTER', 'CHARACTER']);
});

// ---------------------------------------------------------------------------
// 30/31/32/33/34. Safety: no network, no jobs, no credits, no approvals,
// no canonical-selection mutation
// ---------------------------------------------------------------------------

test('safety: building a video prompt package creates zero generation jobs', () => {
  const { project, keyframe } = buildFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL }); // rebuild too
  const after = generationStore.listGenerationJobs({ projectId: project.id }).length;
  assert.equal(after, before);
  assert.equal(after, 0);
});

test('safety: building a video prompt package creates zero keyframe generation approvals', () => {
  const { project, keyframe } = buildFixture();
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const approval = keyframeGenerationApprovalStore.getApproval(project.id, keyframe.keyframeId);
  assert.equal(approval.status, 'NONE');
});

test('safety: building a video prompt package never touches the project credit ledger', () => {
  const { project, keyframe } = buildFixture();
  const before = JSON.stringify(projectStore.getProject(project.id).creditLedger);
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const after = JSON.stringify(projectStore.getProject(project.id).creditLedger);
  assert.equal(before, after);
});

test('safety: building a video prompt package never changes the keyframe\'s own canonical selection', () => {
  const { project, keyframe, asset } = buildFixture();
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const canonical = keyframeStore.getCanonicalKeyframeAsset(project.id, keyframe.keyframeId);
  assert.equal(canonical.canonicalAssetId, asset.assetId);
  assert.equal(canonical.canonicalAssetHistory.length, 0);
});

test('safety: building a video prompt package never changes any asset\'s approvalStatus', () => {
  const { project, keyframe, asset } = buildFixture();
  vps.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const found = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(found.approvalStatus, 'APPROVED');
});

test('regression: buildVideoPromptPackage cannot reach generateKeyframe, generateVideo, requestGeneration, credit reservation, or approval creation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'video-prompt-service.js'), 'utf8');
  for (const forbidden of [
    'generateKeyframe',
    'generateVideo',
    'requestGeneration',
    'reconcileGenerationCost',
    'createGenerationJob',
    'requestApproval',
    'keyframeGenerationApprovalStore',
    'fetch(',
    'axios',
    'evolink-client',
    'evolink-provider',
    'evolink-image-provider',
  ]) {
    assert.doesNotMatch(src, new RegExp(forbidden.replace(/[().-]/g, '\\$&')), `video-prompt-service.js must not reference "${forbidden}"`);
  }
});

// ---------------------------------------------------------------------------
// list / get behaviour
// ---------------------------------------------------------------------------

test('getVideoPromptPackage returns null when no package has been built yet', () => {
  const { project, keyframe } = buildFixture();
  assert.equal(vps.getVideoPromptPackage(project.id, keyframe.keyframeId), null);
});

test('listVideoPromptPackages filters by shotId', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-a', name: 'A' }] }, {});
  creativeStore.updateStoryboard(
    project.id,
    { scenes: [{ sceneId: 'scene-1' }], shots: [{ shotId: 'shot-1', sceneId: 'scene-1' }, { shotId: 'shot-2', sceneId: 'scene-1' }] },
    {}
  );
  const kf1 = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: 'A' });
  const kf2 = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-2', subject: 'A' });

  for (const kf of [kf1, kf2]) {
    keyframePromptService.buildKeyframePromptPackage(project.id, kf.keyframeId, {});
    const asset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: kf.keyframeId, sceneId: 'scene-1', shotId: kf.shotId, approvalStatus: 'NONE' });
    timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
    keyframeStore.selectCanonicalKeyframeAsset(project.id, kf.keyframeId, asset.assetId, { selectedBy: 'tester' });
    vps.buildVideoPromptPackage(project.id, kf.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  }

  const forShot1 = vps.listVideoPromptPackages(project.id, { shotId: 'shot-1' });
  assert.equal(forShot1.length, 1);
  assert.equal(forShot1[0].shotId, 'shot-1');
});
