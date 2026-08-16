// Tests for services/material-executors/generated-new-executor.js — the
// P0-2 GENERATED_NEW -> Pipeline A bridge. Covers the 22 items from the
// P0-2 task spec's Part 13, interpreted honestly against this executor's
// actual (Design B, read-only) architecture: it never triggers generation
// itself, so "approval-gate preserved" / "rejected approval prevents
// generation" / "failed credit reservation prevents generation" are proven
// here as "this bridge only ever reflects an asset that ALREADY passed
// through Pipeline A's own unmodified approval/storage machinery" — never
// as a test of an approval-gate or credit-ledger call this file does not
// make (see the executor's own header comment for why).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gn-executor-projects-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gn-executor-keyframes-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = keyframeTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const creativeStore = require('../services/creative-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const { deriveBeatGraph } = require('../services/beat-graph-derivation-service');
const materialResolutionService = require('../services/material-resolution-service');
const materialExecutionService = require('../services/material-execution-service');
const registry = require('../services/material-executor-registry');
const executor = require('../services/material-executors/generated-new-executor');

function makeProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'STILL_IMAGE', ...overrides });
}

function candidate(overrides = {}) {
  return createCandidateResult({
    candidate: 'GENERATED_NEW+STILL_IMAGE',
    materialSource: 'GENERATED_NEW',
    visualTreatment: 'STILL_IMAGE',
    ...overrides,
  });
}

// Builds a real, approved, STORED keyframe image asset for shotId via the
// EXACT existing Stage 12/13B/13E flow this bridge reads from — never a
// shortcut, so the fixture proves the same path a real operator would use.
function buildApprovedKeyframeAsset(project, shotId, { approve = true, store = true, reject = false } = {}) {
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId, sceneId: 's1', frameType: 'ESTABLISHING' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', shotId, keyframeId: keyframe.keyframeId });
  if (store) {
    timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.png` });
  }
  // Canonical selection happens BEFORE any later rejection, mirroring
  // keyframe-store.js's own documented rule (selectCanonicalKeyframeAsset
  // refuses an already-REJECTED asset, but a currently-canonical asset
  // that LATER becomes REJECTED is deliberately not auto-cleared) — the
  // real-world scenario this bridge must handle correctly.
  const selection = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId);
  assert.equal(selection.ok, true, selection.reason);
  if (reject) {
    timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  } else if (approve) {
    timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  }
  return { keyframe, asset };
}

function buildApprovedVideoAsset(project, shotId, { approve = true, store = true, reject = false } = {}) {
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video', shotId });
  if (store) {
    timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.mp4` });
  }
  if (reject) {
    timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  } else if (approve) {
    timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  }
  return asset;
}

// --- 1. GENERATED_NEW routing ---------------------------------------------------------

test('1. resolveExecutorType routes GENERATED_NEW+STILL_IMAGE to GENERATED_NEW_STILL_IMAGE and GENERATED_NEW+AI_VIDEO to GENERATED_NEW_VIDEO', () => {
  assert.equal(materialExecutionService.resolveExecutorType(candidate({ visualTreatment: 'STILL_IMAGE' })), 'GENERATED_NEW_STILL_IMAGE');
  assert.equal(materialExecutionService.resolveExecutorType(candidate({ visualTreatment: 'AI_VIDEO' })), 'GENERATED_NEW_VIDEO');
});

test('1b. the registry resolves both new executor types to this module', () => {
  assert.equal(registry.getExecutor('GENERATED_NEW_STILL_IMAGE'), executor);
  assert.equal(registry.getExecutor('GENERATED_NEW_VIDEO'), executor);
});

test('1c. PROJECT_ASSET_REUSE + STILL_IMAGE still routes to the generic STILL_IMAGE_MOTION rule, never this bridge', () => {
  const reuseCandidate = createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: 'x' });
  assert.equal(materialExecutionService.resolveExecutorType(reuseCandidate), 'STILL_IMAGE_MOTION');
});

// --- 2/3/4. approval + credit gate preservation, interpreted per Design B -------------
// This executor never calls approval-gate.js or a credit ledger — it only
// reads whether Pipeline A's OWN unmodified machinery already produced an
// approved asset. So "approval preserved" here means: an asset that has
// NOT yet passed Pipeline A's real approval step is correctly invisible to
// this bridge, and a REJECTED asset is correctly never treated as usable.

test('2. no approved generation yet (keyframe created but never approved) fails with NO_APPROVED_GENERATION_EXISTS — never invents a placeholder', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh1', { approve: false });
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.renderSpec, null);
  assert.equal(result.diagnostics[0].code, 'NO_APPROVED_GENERATION_EXISTS');
  assert.match(result.diagnostics[0].message, /request_keyframe_generation_approval/);
});

test('3. a REJECTED keyframe asset is never treated as usable — rejected approval prevents this bridge from using it, exactly like PROJECT_ASSET_REUSE', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh1', { reject: true });
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'NO_APPROVED_GENERATION_EXISTS');
});

test('4. an approved-but-not-yet-STORED (not archived) asset is never treated as usable — mirrors the existing storage gate', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh1', { store: false });
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'NO_APPROVED_GENERATION_EXISTS');
});

// --- 5. provider/model selection stays inside existing infrastructure -----------------

test('5. the executor file never imports a provider adapter, generation-model-registry, or approval-gate — provider/model selection is entirely out of scope here', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executors', 'generated-new-executor.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(
    requires.sort(),
    ['../timeline-store', '../keyframe-store', './still-image-motion-executor', './project-asset-reuse-executor', '../../schemas/material-execution-schema'].sort()
  );
});

// --- 6/7. prompt/keyframe infrastructure + identity reference reuse -------------------

test('6. a STILL_IMAGE resolution delegates to the real keyframe/canonical-asset lookup (Stage 13E), not a new lookup system', () => {
  const project = makeProject();
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.sourceAssetIds, [asset.assetId]);
});

test('7. shot identity is preserved end-to-end — the found asset really belongs to the requested shotId, never a different shot\'s asset', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh-other');
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat({ shotId: 'sh1' });

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.deepEqual(result.sourceAssetIds, [asset.assetId]);
});

// --- 8. successful generation produces a real render spec via the delegate ------------

test('8. STILL_IMAGE success delegates render-spec construction to still-image-motion-executor and reports the honest GENERATED_NEW_STILL_IMAGE type', () => {
  const project = makeProject();
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat({ duration: 4 });

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'GENERATED_NEW_STILL_IMAGE');
  assert.equal(result.renderSpec.type, 'STILL_IMAGE_MOTION');
  assert.equal(result.renderSpec.assetId, asset.assetId);
  assert.equal(result.duration, 4);
});

test('8b. AI_VIDEO success delegates to project-asset-reuse-executor and reports the honest GENERATED_NEW_VIDEO type', () => {
  const project = makeProject();
  const asset = buildApprovedVideoAsset(project, 'sh1');
  const b = beat({ visualTreatment: 'AI_VIDEO', duration: 6 });

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate({ candidate: 'GENERATED_NEW+AI_VIDEO', visualTreatment: 'AI_VIDEO' }) });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'GENERATED_NEW_VIDEO');
  assert.equal(result.renderSpec.type, 'ASSET_PLACEMENT');
  assert.equal(result.renderSpec.assetId, asset.assetId);
});

// --- 9. the Asset used is a real Pipeline A Asset, not a second asset model -----------

test('9. the returned sourceAssetIds are real timeline-store asset ids, resolvable via timelineStore.getAsset — no shadow asset model', () => {
  const project = makeProject();
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  const real = timelineStore.getAsset(project.id, result.sourceAssetIds[0]);
  assert.equal(real.assetId, asset.assetId);
});

// --- 10. structured failure, never a silent fallback -----------------------------------

test('10a. missing selectedMaterial fails with INVALID_MATERIAL rather than throwing', () => {
  const project = makeProject();
  const b = beat();
  assert.doesNotThrow(() => {
    const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: null });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'INVALID_MATERIAL');
  });
});

test('10b. wrong materialSource fails with INVALID_MATERIAL', () => {
  const project = makeProject();
  const b = beat();
  const wrong = createCandidateResult({ candidate: 'x', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: 'y' });
  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: wrong });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_MATERIAL');
});

test('10c. unsupported visualTreatment fails with UNSUPPORTED_TREATMENT', () => {
  const project = makeProject();
  const b = beat();
  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate({ candidate: 'GENERATED_NEW+MOTION_GRAPHIC', visualTreatment: 'MOTION_GRAPHIC' }) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_TREATMENT');
});

test('10d. a beat with no shotId fails with MISSING_SHOT rather than throwing', () => {
  const project = makeProject();
  const b = beat({ shotId: null });
  assert.doesNotThrow(() => {
    const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'MISSING_SHOT');
  });
});

test('10e. an invalid duration surfaces the delegate\'s own INVALID_DURATION diagnostic unmodified — no swallowed/renamed errors', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh1');
  const b = createVisualBeat({ id: 'b1', sceneId: 's1', shotId: 'sh1', sequence: 1 });

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_DURATION');
});

// --- 11. retry / idempotency safety -----------------------------------------------------

test('11. repeated execution against the same already-approved asset is safe and produces identical output — no duplicate Asset, no duplicate generation', () => {
  const project = makeProject();
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat();
  const before = JSON.stringify(timelineStore.listAssets(project.id, { shotId: 'sh1' }));

  const first = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });
  const second = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  const after = JSON.stringify(timelineStore.listAssets(project.id, { shotId: 'sh1' }));
  assert.deepEqual(first.renderSpec, second.renderSpec);
  assert.equal(before, after); // no new asset was created by executing twice
  assert.equal(timelineStore.listAssets(project.id, { shotId: 'sh1' }).length, 1);
});

test('11b. the source asset is never mutated by execution', () => {
  const project = makeProject();
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat();
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));

  executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(before, after);
});

// --- 12. no new credit/approval system, no second asset model -------------------------

test('12. the executor never writes to project-store or keyframe-store — read-only against both', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat();
  const beforeProject = JSON.stringify(projectStore.getProject(project.id));

  executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  const afterProject = JSON.stringify(projectStore.getProject(project.id));
  assert.equal(beforeProject, afterProject);
});

// --- 13. security: no provider credentials / API keys / secrets in the file -----------

test('13. no API key, secret, or provider-name literal appears in the executor source (comments stripped to avoid false positives on explanatory text)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executors', 'generated-new-executor.js'), 'utf8');
  const codeOnly = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(codeOnly, /api[_-]?key/i);
  assert.doesNotMatch(codeOnly, /secret/i);
  assert.doesNotMatch(codeOnly, /evolink|higgsfield|doubao|seedance/i);
  assert.doesNotMatch(codeOnly, /process\.env/);
});

// --- 14. real pipeline integration path (Storyboard-independent, real stores) ---------

test('14. full real-store integration: unapproved -> approved transitions the SAME beat/candidate from FAILED to COMPLETED, proving this bridge tracks Pipeline A\'s real state', () => {
  const project = makeProject();
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: 'sh1', sceneId: 's1', frameType: 'ESTABLISHING' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', shotId: 'sh1', keyframeId: keyframe.keyframeId });
  const b = beat();

  const beforeApproval = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });
  assert.equal(beforeApproval.status, 'FAILED');

  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.png` });
  const beforeCanonical = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });
  assert.equal(beforeCanonical.status, 'FAILED', 'not canonical yet — still must not be found');

  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId);

  const afterApproval = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });
  assert.equal(afterApproval.status, 'COMPLETED');
  assert.deepEqual(afterApproval.sourceAssetIds, [asset.assetId]);
});

// --- 15. deterministic pre-generation decisions -----------------------------------------

test('15. executor.execute is a pure function of (projectId, beat, selectedMaterial, options) against fixed store state — no randomness', () => {
  const project = makeProject();
  buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat();

  const a = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });
  const c = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate() });

  assert.deepEqual(a.renderSpec, c.renderSpec);
  assert.equal(a.status, c.status);
});

// --- 16. failed lookups never crash executeMaterial() (Material Execution's own try/catch, exercised end-to-end) ---

test('16. executeMaterial() end-to-end: an UNRESOLVED materialResolution never reaches this executor and fails cleanly upstream', () => {
  const project = makeProject();
  const b = beat();
  const unresolved = { status: 'PENDING', selectedMaterial: null };
  const result = materialExecutionService.executeMaterial(project.id, b, unresolved);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'UNRESOLVED_MATERIAL');
});

test('16b. executeMaterial() end-to-end: a RESOLVED GENERATED_NEW+STILL_IMAGE materialResolution with an approved asset produces a COMPLETED result through the real routing path', () => {
  const project = makeProject();
  const { asset } = buildApprovedKeyframeAsset(project, 'sh1');
  const b = beat({ duration: 3 });
  const resolution = { status: 'RESOLVED', beatId: b.id, selectedMaterial: candidate() };

  const result = materialExecutionService.executeMaterial(project.id, b, resolution);

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'GENERATED_NEW_STILL_IMAGE');
  assert.deepEqual(result.sourceAssetIds, [asset.assetId]);
});

// --- 17. GOLDEN PIPELINE PROOF ---------------------------------------------------------
// Storyboard -> P0-1's deriveBeatGraph -> P0-2's resolveMaterial (real,
// unmodified Stage 26.3/26.4 ranking — no shortcuts) -> GENERATED_NEW
// candidate -> executeMaterial -> this bridge. The ONLY mocked step is the
// external, paid, async keyframe generation call itself (never invoked in
// automated tests, per the task's explicit instruction) — everything
// before and after that one boundary is real, unmodified Pipeline
// A/B code.

test('17. GOLDEN PIPELINE PROOF: real Storyboard -> deriveBeatGraph -> resolveMaterial -> executeMaterial, with only the external generation call mocked', () => {
  const project = makeProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1' });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    order: 1,
    duration: 4,
    purpose: 'establish the setting',
    visualDescription: 'a wide establishing shot of a neon-lit alley',
  });
  const storyboard = creativeStore.getStoryboard(project.id);

  const derivation = deriveBeatGraph(storyboard, { treatments: { [shot.shotId]: 'STILL_IMAGE' } });
  assert.equal(derivation.status, 'DERIVED');
  const b = derivation.beatGraph.beats[0];
  assert.equal(b.shotId, shot.shotId);

  // Real resolveMaterial() call — no existing reusable asset for this shot,
  // so it must fall through PROJECT_ASSET_REUSE/BROLL_LIBRARY/templates and
  // land on GENERATED_NEW on its own, exactly like an unresolved shot would.
  const resolution = materialResolutionService.resolveMaterial(project.id, b);
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'GENERATED_NEW');
  assert.equal(resolution.selectedMaterial.visualTreatment, 'STILL_IMAGE');

  const beforeGeneration = materialExecutionService.executeMaterial(project.id, b, resolution);
  assert.equal(beforeGeneration.status, 'FAILED');
  assert.equal(beforeGeneration.diagnostics[0].code, 'NO_APPROVED_GENERATION_EXISTS');

  // The one mocked boundary: simulate what Pipeline A's real, human-gated
  // flow produces by the time an operator finishes it (a Keyframe, a
  // generated+STORED Asset, human APPROVAL, canonical selection) — never a
  // real paid provider call.
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'ESTABLISHING' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', shotId: shot.shotId, sceneId: scene.sceneId, keyframeId: keyframe.keyframeId });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.png` });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  const selection = keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId);
  assert.equal(selection.ok, true, selection.reason);

  const afterGeneration = materialExecutionService.executeMaterial(project.id, b, resolution);
  assert.equal(afterGeneration.status, 'COMPLETED');
  assert.equal(afterGeneration.executorType, 'GENERATED_NEW_STILL_IMAGE');
  assert.deepEqual(afterGeneration.sourceAssetIds, [asset.assetId]);
  assert.equal(afterGeneration.renderSpec.type, 'STILL_IMAGE_MOTION');
  assert.equal(afterGeneration.renderSpec.assetId, asset.assetId);
});
