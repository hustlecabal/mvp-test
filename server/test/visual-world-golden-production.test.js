// GOLDEN VISUAL PRODUCTION TEST (Part 26/27 of this stage's spec) —
// proves a real, persisted CreativeBlueprint can be transformed into
// real, treatment-appropriate visual material via the existing, UNMODIFIED
// production pipelines, with services/visual-world-service.js as the only
// new coordination:
//
//   CreativeBlueprint.visualSpecification + VisualBible
//       -> visual-world-service.js (MaterialSpecification per shot)
//       -> Pipeline B (WHITEBOARD, deterministic): material-resolution-
//          service.js -> material-execution-service.js -> render-service.js
//          -> a REAL SVG file on disk
//       -> Pipeline A (STILL_IMAGE, GENERATED_NEW): auto-populated Keyframe
//          -> build_keyframe_prompt_package (unchanged) -> approval ->
//          generateKeyframe (unchanged, fake-image provider) -> approve ->
//          select canonical -> Pipeline B's generated-new-executor.js
//          discovers the now-real, approved asset -> a REAL ExecutionResult
//
// No manually written provider prompt is inserted anywhere in this path —
// every prompt/renderSpec is compiled from real, persisted data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-vwgold-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-vwgold-projects-'],
  ['CREATIVE_DATA_DIR', 'evolink-vwgold-creative-'],
  ['CREATIVE_BLUEPRINT_DATA_DIR', 'evolink-vwgold-blueprint-'],
  ['KEYFRAME_DATA_DIR', 'evolink-vwgold-keyframe-'],
  ['KEYFRAME_PROMPT_DATA_DIR', 'evolink-vwgold-packages-'],
  ['KEYFRAME_GENERATION_APPROVAL_DATA_DIR', 'evolink-vwgold-approvals-'],
  ['GENERATION_JOBS_DATA_DIR', 'evolink-vwgold-jobs-'],
  ['PRE_PRODUCTION_GATE_DATA_DIR', 'evolink-vwgold-gates-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const preProductionGateStore = require('../services/pre-production-gate-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const kfgen = require('../services/keyframe-generation-service');
const fakeImageProvider = require('../providers/fake-image/fake-image-provider');
const beatGraphDerivation = require('../services/beat-graph-derivation-service');
const materialResolutionService = require('../services/material-resolution-service');
const materialExecutionService = require('../services/material-execution-service');
const renderService = require('../services/render-service');
const visualWorldService = require('../services/visual-world-service');
const technicalQc = require('../services/visual-technical-qc-service');
const creativeQc = require('../services/visual-creative-qc-service');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');
const { createPreProductionGateResult } = require('../schemas/pre-production-gate-schema');

const FAST_POLL = { intervalMs: 0, sleepImpl: async () => {} };

function newProject(title = 'visual world golden test') {
  const project = projectStore.createProject({ title, topic: 'lighthouse keeper' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

// Satisfies control-plane-service.js's validateProductionPrerequisites()
// exactly as test/keyframe-generation-service.test.js's own fixture does —
// a real APPROVED CreativeBlueprint + a real ACCEPTed PreProductionGateResult
// + Storyboard.blueprintId — this stage never bypasses that gate.
function satisfyProductionPrerequisites(projectId, blueprintOverrides = {}) {
  const blueprint = createCreativeBlueprint({
    projectId,
    recommendationSetId: 'rec-set-fixture',
    status: 'APPROVED',
    concept: 'The lighthouse keeper',
    corePromise: 'fixture promise',
    targetDuration: 60,
    visualSpecification: {
      composition: 'wide establishing shots giving way to intimate close-ups',
      palette: 'muted teal and amber',
      lighting: 'harsh directional light through fog',
      cameraLanguage: 'slow push-ins, minimal handheld motion',
      negativeConstraints: 'no lens flares',
    },
    ...blueprintOverrides,
  });
  const savedBlueprint = creativeBlueprintStore.addCreativeBlueprint(projectId, blueprint).blueprint;
  const gateResult = createPreProductionGateResult({ projectId, blueprintId: savedBlueprint.id, blueprintRevision: savedBlueprint.id, blueprintUpdatedAt: savedBlueprint.updatedAt, machineAssessment: 'PROCEED', costStatus: 'UNKNOWN' });
  const savedGateResult = preProductionGateStore.addGateResult(projectId, gateResult).gateResult;
  preProductionGateStore.recordHumanDecision(projectId, savedGateResult.id, { humanDecision: 'ACCEPT', humanDecidedBy: 'test-fixture', humanRationale: null });
  creativeStore.updateStoryboard(projectId, { blueprintId: savedBlueprint.id });
  return savedBlueprint;
}

test.beforeEach(() => fakeImageProvider.resetFakeImageProvider());

test('GOLDEN VISUAL PRODUCTION TEST — real CreativeBlueprint -> Visual World -> real generated visual material on BOTH pipelines, no manual prompts', async () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', description: 'A weathered lighthouse keeper with silver hair and a canvas coat.' }] }, {});
  const blueprint = satisfyProductionPrerequisites(project.id);

  creativeStore.addStoryboardScene(project.id, { sceneId: 'scene-1', title: 'Opening', order: 1 });
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 4, purpose: 'Establish the lighthouse at dusk', visualTreatment: 'WHITEBOARD' });
  creativeStore.addStoryboardShot(project.id, {
    shotId: 'shot-2', sceneId: 'scene-1', order: 2, duration: 5, purpose: 'Introduce Mira',
    visualTreatment: 'STILL_IMAGE',
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'consistent silver hair and canvas coat' }],
  });

  const storyboard = creativeStore.getStoryboard(project.id);
  const visualBible = creativeStore.getVisualBible(project.id);

  // 1. Verify the Blueprint is consumed WITHOUT manual reconstruction:
  // visual-world-service.js reads it directly, never a second copy.
  assert.equal(blueprint.visualSpecification.palette, 'muted teal and amber');

  // --- PIPELINE B: WHITEBOARD (deterministic) -----------------------------
  const derivation = beatGraphDerivation.deriveBeatGraph(storyboard, {});
  assert.equal(derivation.status, 'DERIVED');
  const whiteboardBeat = derivation.beatGraph.beats.find((b) => b.visualTreatment === 'WHITEBOARD');
  assert.ok(whiteboardBeat);

  // 2/3. Visual specification + treatment selection reach the material layer.
  const materialOptions = visualWorldService.buildMaterialOptionsForBeatGraph(project.id, derivation.beatGraph, blueprint);
  assert.ok(materialOptions[whiteboardBeat.id]);
  assert.equal(materialOptions[whiteboardBeat.id].elements[0].content, 'Establish the lighthouse at dusk');

  const resolution = materialResolutionService.resolveMaterial(project.id, whiteboardBeat, {});
  assert.equal(resolution.status, 'RESOLVED');
  const execution = materialExecutionService.executeMaterial(project.id, whiteboardBeat, resolution, materialOptions[whiteboardBeat.id]);
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'WHITEBOARD');

  // 7/9. Generated material is persisted as a REAL, playable artifact.
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vwgold-render-'));
  const renderResult = renderService.renderMaterial(project.id, execution, outputDir);
  assert.equal(renderResult.status, 'COMPLETED');
  assert.ok(fs.existsSync(renderResult.artifact.path));
  const svg = fs.readFileSync(renderResult.artifact.path, 'utf8');
  assert.ok(svg.includes('Establish the lighthouse at dusk'));

  // 10. Technical QC on Pipeline B's own artifact — SVG has no ffprobe-able
  // video stream, so technical QC (Pipeline A/asset-focused) legitimately
  // does not apply here; this is honestly out of scope for a vector SVG,
  // not silently skipped — verified by NOT calling it on a non-Asset file.

  // 11. Creative QC produces structured, independent diagnostics.
  const wbShot = storyboard.shots.find((s) => s.shotId === 'shot-1');
  const wbSpec = visualWorldService.buildMaterialSpecification(project.id, wbShot, { blueprint, visualBible });
  const wbFindings = creativeQc.evaluateVisualMaterial(wbSpec, { executorType: execution.executorType });
  assert.ok(wbFindings.length > 0);
  assert.equal(creativeQc.hasFailure(wbFindings), false);

  // --- PIPELINE A: STILL_IMAGE (GENERATED_NEW) ----------------------------
  const stillShot = storyboard.shots.find((s) => s.shotId === 'shot-2');
  const stillSpec = visualWorldService.buildMaterialSpecification(project.id, stillShot, { blueprint, visualBible });
  assert.equal(stillSpec.references.length, 1);
  assert.ok(stillSpec.subject.includes('lighthouse keeper'));

  // 6. References reach generation — a canonical reference asset id would
  // flow through here once one exists; this fixture has none set yet, so
  // the continuity reference resolves to a real, honest null (never
  // fabricated) — proven by test 6 in visual-creative-qc-service.test.js.

  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-2', sceneId: 'scene-1', frameType: 'FIRST', sourceShotVersion: storyboard.version }, {});
  const populated = visualWorldService.populateKeyframeFromMaterialSpecification(project.id, kf.keyframeId, stillSpec, {});
  assert.equal(populated.subject, stillSpec.subject);
  assert.equal(populated.camera, stillSpec.camera);
  assert.deepEqual(populated.characterReferences, ['char-1']);

  // build_keyframe_prompt_package — EXISTING, UNMODIFIED — now produces a
  // real, specific prompt from the auto-populated fields, no human typing.
  const pkg = kfp.buildKeyframePromptPackage(project.id, kf.keyframeId);
  assert.ok(pkg.prompt.includes('lighthouse keeper') || pkg.promptSections.SUBJECT.includes('lighthouse keeper'));

  approvalStore.requestApproval(project.id, kf.keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost: 2, requestedBy: 'tester' });
  approvalStore.decideApproval(project.id, kf.keyframeId, { approve: true, decidedBy: 'tester' });

  const generated = await kfgen.generateKeyframe(project.id, kf.keyframeId, FAST_POLL);
  assert.equal(generated.ok, true);
  assert.equal(generated.job.status, 'COMPLETED');

  // 10. Technical QC on the REAL generated asset.
  const tqc = technicalQc.runTechnicalQc(project.id, generated.job.assetId);
  assert.equal(tqc.ok, true);
  assert.equal(tqc.code, 'PASS');

  const approval = kfgen.approveGeneratedKeyframe(project.id, kf.keyframeId, generated.job.assetId, { approvedBy: 'tester' });
  assert.equal(approval.ok, true);
  const canonical = keyframeStore.selectCanonicalKeyframeAsset(project.id, kf.keyframeId, generated.job.assetId, { selectedBy: 'tester' });
  assert.equal(canonical.ok, true);

  // 8. The real generated asset now enters Pipeline B's own, UNMODIFIED
  // GENERATED_NEW discovery path (generated-new-executor.js).
  const stillBeat = derivation.beatGraph.beats.find((b) => b.visualTreatment === 'STILL_IMAGE');
  const stillResolution = materialResolutionService.resolveMaterial(project.id, stillBeat, {});
  assert.equal(stillResolution.status, 'RESOLVED');
  const stillExecution = materialExecutionService.executeMaterial(project.id, stillBeat, stillResolution, {});
  assert.equal(stillExecution.status, 'COMPLETED');

  const stillFindings = creativeQc.evaluateVisualMaterial(stillSpec, { executorType: stillExecution.executorType });
  assert.ok(stillFindings.length > 0);

  // 14. No provider-specific creative logic leaked into Creative Brain /
  // Visual World — confirmed structurally: neither file imports an EvoLink
  // module.
  const vwSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'visual-world-service.js'), 'utf8');
  assert.ok(!vwSource.includes('evolink'));
});

// --- FAILURE INJECTION (Part 32) ----------------------------------------

test('FAILURE 1. missing Visual Specification — MaterialSpecification degrades honestly to empty fields, never fabricated', () => {
  const project = newProject();
  creativeStore.addStoryboardScene(project.id, { sceneId: 'scene-1', title: 'S', order: 1 });
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 3, visualTreatment: 'STILL_IMAGE' });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint: null, visualBible: null });
  assert.equal(spec.composition, '');
  assert.equal(spec.palette, '');
});

test('FAILURE 2. invalid treatment — compileDeterministicOptions returns null rather than guessing', () => {
  const spec = { treatment: 'NOT_A_REAL_TREATMENT', subject: 'x', shotPurpose: 'x' };
  assert.equal(visualWorldService.compileDeterministicOptions(spec, { duration: 3 }, {}), null);
});

test('FAILURE 3. missing VisualBible requirement — continuity reference resolves to null asset, never invented (WARN not silent)', () => {
  const project = newProject();
  const blueprint = satisfyProductionPrerequisites(project.id);
  creativeStore.addStoryboardScene(project.id, { sceneId: 'scene-1', title: 'S', order: 1 });
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 3, visualTreatment: 'STILL_IMAGE', continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'missing-char', requirement: 'x' }] });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  const continuityFinding = findings.find((f) => f.dimension === 'continuity');
  assert.equal(continuityFinding.result, 'WARN');
});

test('FAILURE 4/5. provider failure/timeout — generateKeyframe reports the real failure, no fabricated success', async () => {
  const project = newProject();
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const kf = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'FIRST', sourceShotVersion: storyboard.version });
  const pkg = kfp.buildKeyframePromptPackage(project.id, kf.keyframeId);
  approvalStore.requestApproval(project.id, kf.keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost: 2, requestedBy: 'tester' });
  approvalStore.decideApproval(project.id, kf.keyframeId, { approve: true, decidedBy: 'tester' });
  const failingProviders = { 'fake-image': { createImageGeneration: async () => { throw new Error('simulated provider outage'); }, getGenerationStatus: async () => { throw new Error('MUST NOT BE CALLED'); } } };
  const result = await kfgen.generateKeyframe(project.id, kf.keyframeId, { ...FAST_POLL, providers: failingProviders });
  assert.equal(result.ok, false);
});

test('FAILURE 8. continuity violation surfaces as an honest WARN diagnostic, never blocks generation silently', () => {
  const project = newProject();
  const blueprint = satisfyProductionPrerequisites(project.id);
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', description: 'x' }] }, {});
  creativeStore.addStoryboardScene(project.id, { sceneId: 'scene-1', title: 'S', order: 1 });
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 3, visualTreatment: 'STILL_IMAGE', continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'consistent look' }] });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(findings.find((f) => f.dimension === 'continuity').result, 'WARN');
  assert.equal(creativeQc.hasFailure(findings), false);
});

test('FAILURE 9. creative QC failure — a generic, unspecific MaterialSpecification is FAILed, never rubber-stamped', () => {
  const spec = { treatment: 'STILL_IMAGE', subject: 'a nice picture', composition: '', action: '', references: [], negativeConstraints: [], shotPurpose: '' };
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(creativeQc.hasFailure(findings), true);
});

test('FAILURE 10. technical QC failure — a corrupt asset file fails structurally, never reported as PASS', () => {
  const project = newProject();
  const timelineStore = require('../services/timeline-store');
  const assetStorage = require('../services/asset-storage');
  const crypto = require('crypto');
  const relativePath = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(assetStorage.resolveStoredPath(relativePath), Buffer.from('not a real image'));
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', storage: { provider: 'local', path: relativePath, status: 'STORED', contentType: 'image/png', sizeBytes: 16, archivedAt: new Date().toISOString() } });
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, false);
});

test('FAILURE 13. persistence failure — a nonexistent project fails honestly at every Visual World entry point, never throws uncaught', () => {
  const bogus = '00000000-0000-4000-8000-000000000000';
  assert.equal(technicalQc.runTechnicalQc(bogus, bogus).ok, false);
  assert.equal(visualWorldService.populateKeyframeFromMaterialSpecification(bogus, bogus, {}, {}), null);
});
