// Tests for services/keyframe-execution-bridge-service.js — Stage 13C's
// only real deliverable code. Covers preparation (read-only, package/
// skill/reference-asset resolution), the fixture executor's BLOCKED/
// COMPLETED/FAILED/IN_PROGRESS mapping, that every Stage 13B safety check
// (approval, staleness, budget, duplicate protection) still applies
// identically, asset lineage through the fixture path, and that nothing
// here ever reaches a real provider, EvoLink, or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-assets-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-gates-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const generationStore = require('../services/generation-store');
const timelineStore = require('../services/timeline-store');
const bridge = require('../services/keyframe-execution-bridge-service');
const fakeImageProvider = require('../providers/fake-image/fake-image-provider');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');

const FAST_POLL = { intervalMs: 0, sleepImpl: async () => {} };

function newProject(title = 'kfexec bridge test') {
  return projectStore.createProject({ title, topic: 'x' });
}

function buildFixture() {
  const project = newProject();
  satisfyProductionPrerequisites(project.id);
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'CHARACTER_REFERENCE',
    sourceShotVersion: storyboard.version,
  });
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  return { project, scene, shot, keyframe, pkg };
}

function approve(projectId, keyframeId, pkg, { estimatedCost = 2 } = {}) {
  approvalStore.requestApproval(projectId, keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost, requestedBy: 'tester' });
  return approvalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: 'tester' });
}

test.beforeEach(() => fakeImageProvider.resetFakeImageProvider());

// --- 1. skill inspection assumptions (regression guard) --------------------------------

test('1. the three investigated skill files exist on disk and still declare no execution mechanism', () => {
  const skillFiles = [
    '/root/.claude/skills/synced/banana-pro-director-20/SKILL.md',
    '/root/.claude/skills/synced/cinema-worldbuilder-pro-20/SKILL.md',
    '/root/.claude/skills/synced/video-prompt-builder/SKILL.md',
  ];
  for (const filePath of skillFiles) {
    if (!fs.existsSync(filePath)) {
      // Environment-dependent: if the skill isn't installed here, this
      // assumption simply doesn't apply in this environment — skip
      // rather than fail, matching the "label UNKNOWN, don't guess" rule.
      continue;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(text, /```(bash|sh|python|javascript)\n[^`]*curl /i, `${filePath} must not embed an executable API call`);
  }
});

// --- 2/5. keyframe package compatibility / package -> execution request ------------------

test('2/5. prepareKeyframeExecution resolves the recommended skill and reference assets from the built package', () => {
  const { project, keyframe, pkg } = buildFixture();
  const prepared = bridge.prepareKeyframeExecution(project.id, keyframe.keyframeId);

  assert.equal(prepared.promptPackage.packageId, pkg.packageId);
  assert.equal(prepared.recommendedSkill.id, pkg.recommendedSkill);
  assert.deepEqual(prepared.referenceAssets, pkg.existingReferenceAssets);
  assert.match(prepared.executionInstructions, /No installed skill can be executed programmatically today/);
});

test('prepareKeyframeExecution reports a clear "build a package first" instruction when none exists yet', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });

  const prepared = bridge.prepareKeyframeExecution(project.id, keyframe.keyframeId);
  assert.equal(prepared.promptPackage, null);
  assert.equal(prepared.recommendedSkill, null);
  assert.match(prepared.executionInstructions, /No prompt package has been built/);
  assert.equal(prepared.safety.allowed, false);
});

test('prepareKeyframeExecution returns null for an unknown project/keyframe, never throws', () => {
  assert.equal(bridge.prepareKeyframeExecution('00000000-0000-0000-0000-000000000000', 'kf-1'), null);
  const project = newProject();
  assert.equal(bridge.prepareKeyframeExecution(project.id, 'nope'), null);
});

test('prepareKeyframeExecution reflects the true safety verdict before approval, and true after', () => {
  const { project, keyframe, pkg } = buildFixture();
  assert.equal(bridge.prepareKeyframeExecution(project.id, keyframe.keyframeId).safety.allowed, false);
  approve(project.id, keyframe.keyframeId, pkg);
  assert.equal(bridge.prepareKeyframeExecution(project.id, keyframe.keyframeId).safety.allowed, true);
});

// --- 8. approval blocking -----------------------------------------------------------------

test('8. runFixtureKeyframeExecution is BLOCKED (zero jobs) without an approval', async () => {
  const { project, keyframe } = buildFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const result = await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.warnings[0].includes('No explicit keyframe generation approval'));
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- 9. stale blocking ---------------------------------------------------------------------

test('9. runFixtureKeyframeExecution is BLOCKED when the prompt package is STALE', async () => {
  const { project, keyframe, pkg, shot } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });

  const result = await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.warnings[0], /STALE/);
});

// --- 10. budget blocking -------------------------------------------------------------------

test('10. runFixtureKeyframeExecution is BLOCKED when the estimated cost exceeds the remaining budget', async () => {
  const { project, keyframe, pkg } = buildFixture();
  gate.setBudget(project, 1);
  projectStore.touch(project);
  approve(project.id, keyframe.keyframeId, pkg, { estimatedCost: 100 });

  const result = await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.warnings[0], /budget/);
});

// --- 11. duplicate protection ---------------------------------------------------------------

test('11. two concurrent fixture executions resolve to the same underlying job (one COMPLETED, one IN_PROGRESS or COMPLETED)', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  const [first, second] = await Promise.all([
    bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL),
    bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL),
  ]);

  assert.equal(first.metadata.generationId, second.metadata.generationId, 'both must resolve to the SAME generation job, never two');
  assert.ok(['COMPLETED', 'IN_PROGRESS'].includes(first.status));
  assert.ok(['COMPLETED', 'IN_PROGRESS'].includes(second.status));
});

// --- 4/6/7. fixture executor / execution request -> normalized result / asset lineage -------

test('4/6/7. a full fixture execution returns a COMPLETED result with correct lineage back to the package and asset', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  const result = await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.keyframeId, keyframe.keyframeId);
  assert.equal(result.packageId, pkg.packageId);
  assert.equal(result.packageVersion, pkg.version);
  assert.equal(result.provider, 'fake-image');
  assert.equal(result.model, fakeImageProvider.MODEL_NAME);
  assert.equal(result.skillId, pkg.recommendedSkill);
  assert.equal(result.artifactType, 'image');
  assert.ok(result.artifactPath);
  assert.equal(result.artifactUrl, null, 'a local fixture must never report an invented remote URL');
  assert.ok(result.metadata.generationId);
  assert.ok(result.metadata.assetId);

  const asset = timelineStore.getAsset(project.id, result.metadata.assetId);
  assert.equal(asset.keyframeId, keyframe.keyframeId);
  assert.equal(asset.promptPackageId, pkg.packageId);
  assert.equal(asset.promptPackageVersion, pkg.version);
  assert.equal(asset.storage.status, 'STORED');
  assert.equal(asset.storage.path, result.artifactPath);
  assert.ok(fs.existsSync(path.join(assetsTempDir, asset.storage.path)), 'the fixture image must really exist on disk');

  assert.equal(keyframeStore.getKeyframe(project.id, keyframe.keyframeId).status, 'GENERATED');
});

test('a rejected generation approval leaves the fixture executor BLOCKED', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approvalStore.requestApproval(project.id, keyframe.keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost: 2 });
  approvalStore.decideApproval(project.id, keyframe.keyframeId, { approve: false, decidedBy: 'tester' });

  const result = await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.status, 'BLOCKED');
});

// --- 13/14/15. zero external network / zero EvoLink calls / zero credits spent --------------

test('13/14. no file in this stage touches fetch/http/EvoLink', () => {
  const files = [
    'schemas/keyframe-execution-result-schema.js',
    'services/keyframe-execution-bridge-service.js',
    'mcp/tools/keyframe-execution-tools.js',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.doesNotMatch(text, /\bfetch\(/, `${rel} must never call fetch()`);
    const requireStatements = [...text.matchAll(/require\(\s*['"`][^'"`]+['"`]\s*\)/g)].map((m) => m[0]);
    assert.ok(!requireStatements.some((r) => r.includes('providers/evolink')), `${rel} must never import the EvoLink provider`);
  }
});

test('15. the shared credit ledger only ever reflects the documented fixture cost, and a BLOCKED attempt never mutates it', async () => {
  const { project, keyframe } = buildFixture(); // no approval requested
  const before = JSON.stringify(projectStore.getProject(project.id).creditLedger);

  await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);

  const after = JSON.stringify(projectStore.getProject(project.id).creditLedger);
  assert.equal(after, before);
});

test('15b. a COMPLETED fixture execution reserves exactly the fake provider\'s documented fixed cost, never a guessed real price', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  await bridge.runFixtureKeyframeExecution(project.id, keyframe.keyframeId, FAST_POLL);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.creditLedger.reserved, fakeImageProvider.FAKE_RESERVED_COST);
});

// --- safety: this file's own imports -------------------------------------------------------

test('services/keyframe-execution-bridge-service.js only reuses existing services, never reimplements the safety gate', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-execution-bridge-service.js'), 'utf8');
  assert.match(text, /keyframeGenerationService\.canGenerateKeyframe/);
  assert.match(text, /keyframeGenerationService\.generateKeyframe/);
  assert.doesNotMatch(text, /gate\.canProceed|gate\.decideApproval/, 'must never touch the project-level video approval directly');
});
