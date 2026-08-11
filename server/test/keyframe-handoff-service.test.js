// Tests for services/keyframe-handoff-service.js — Stage 13D's core
// deliverable, the HUMAN EXECUTION HANDOFF. Covers: creation and its
// safety gates (project/keyframe/package existence, staleness, approval,
// approval-version match), skill/reference/prompt preservation, the
// "frozen at creation" behavior after the live package is rebuilt,
// status transitions, cancellation, image ingestion (success, duplicate
// prevention, unsupported format), asset lineage, and the deterministic
// downloadable execution package. Never touches a real provider, EvoLink,
// or the network — every "execution" here is writing local bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-handoffs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const timelineStore = require('../services/timeline-store');
const handoffService = require('../services/keyframe-handoff-service');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

function newProject(title = 'kfhandoff test') {
  return projectStore.createProject({ title, topic: 'x' });
}

function buildFixture() {
  const project = newProject();
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

function fullyApprovedFixture() {
  const fixture = buildFixture();
  approve(fixture.project.id, fixture.keyframe.keyframeId, fixture.pkg);
  return fixture;
}

// --- 2. creation success -----------------------------------------------------------

test('2. createHandoff succeeds once a CURRENT package and a matching APPROVED approval exist', () => {
  const { project, keyframe, pkg } = fullyApprovedFixture();
  const result = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.handoff.status, 'READY');
  assert.equal(result.handoff.promptPackageId, pkg.packageId);
  assert.equal(result.handoff.promptPackageVersion, pkg.version);
  assert.ok(result.handoff.handoffId);
  assert.equal(result.handoff.createdBy, 'tester');
});

// --- 3. missing project -------------------------------------------------------------

test('3. createHandoff fails clearly for an unknown project', () => {
  const result = handoffService.createHandoff('00000000-0000-0000-0000-000000000000', 'kf-1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No project found/);
});

// --- 4. missing keyframe -------------------------------------------------------------

test('4. createHandoff fails clearly for an unknown keyframe', () => {
  const project = newProject();
  const result = handoffService.createHandoff(project.id, 'nope');
  assert.equal(result.ok, false);
  assert.match(result.reason, /No keyframe found/);
});

// --- 5. missing package ---------------------------------------------------------------

test('5. createHandoff fails clearly when no prompt package has been built yet', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });

  const result = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /No prompt package has been built/);
});

// --- 6. stale-package blocking (creation time only, Part 9) ---------------------------

test('6. createHandoff is BLOCKED while the prompt package is STALE', () => {
  const { project, keyframe, pkg, shot } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });

  const result = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /STALE/);
});

// --- 7. approval blocking --------------------------------------------------------------

test('7. createHandoff is BLOCKED without an explicit APPROVED keyframe generation approval', () => {
  const { project, keyframe } = buildFixture();
  const result = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /No explicit keyframe generation approval/);
});

// --- 8. approval-version mismatch blocking ----------------------------------------------

test('8. createHandoff is BLOCKED when the approval was granted for a different package version', () => {
  const { project, keyframe, pkg, shot } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  // Rebuild the package to a new version WITHOUT re-approving.
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  const result = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /different prompt package version|Request and approve generation again/);
});

// --- 9. skill preservation ---------------------------------------------------------------

test('9. the handoff freezes the package\'s recommended skill', () => {
  const { project, keyframe, pkg } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(handoff.skillId, pkg.recommendedSkill);
  assert.ok(handoff.skillName);
});

// --- 10. reference preservation -----------------------------------------------------------

test('10. the handoff freezes the package\'s existing reference assets', () => {
  const { project, keyframe, pkg } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.deepEqual(handoff.requiredReferences, pkg.existingReferenceAssets);
});

// --- 11. package generation (Part 3/11 downloadable execution package) --------------------

test('11. buildExecutionPackage returns the frozen prompt, locks, references, and instructions', () => {
  const { project, keyframe, pkg } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  const built = handoffService.buildExecutionPackage(project.id, handoff.handoffId);

  assert.equal(built.handoffId, handoff.handoffId);
  assert.equal(built.promptPackage.version, pkg.version);
  assert.equal(built.prompt, pkg.prompt);
  assert.equal(built.frozen, false);
  assert.match(built.text, /KEYFRAME EXECUTION/);
  assert.match(built.text, /SOURCE OF TRUTH/);
  assert.match(built.text, /REFERENCES/);
  assert.match(built.text, /PROMPT/);
  assert.match(built.text, /EXECUTION INSTRUCTIONS/);
  assert.match(built.instructions, /10\. Complete the handoff/);
});

test('buildExecutionPackage is deterministic — two calls produce equivalent content', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  const first = handoffService.buildExecutionPackage(project.id, handoff.handoffId);
  const second = handoffService.buildExecutionPackage(project.id, handoff.handoffId);
  assert.equal(first.text, second.text);
  assert.deepEqual(first.identityLock, second.identityLock);
});

// --- 12/22. status transitions + stale-after-creation (Part 9: existing handoff stays valid) --

test('12. updateHandoff can only move status to IN_PROGRESS, never anything else', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);

  const bad = handoffService.updateHandoff(project.id, handoff.handoffId, { status: 'INGESTED' });
  assert.equal(bad.ok, false);

  const good = handoffService.updateHandoff(project.id, handoff.handoffId, { status: 'IN_PROGRESS' }, { updatedBy: 'tester' });
  assert.equal(good.ok, true);
  assert.equal(good.handoff.status, 'IN_PROGRESS');
});

test('22. a handoff created before the package went stale remains valid and its own version never changes (Part 9)', () => {
  const { project, keyframe, pkg, shot } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(handoff.promptPackageVersion, pkg.version);

  // Now make the live package stale AND rebuild it to a new version.
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });
  const rebuilt = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.ok(rebuilt.version > pkg.version);

  const reread = handoffService.getHandoff(project.id, handoff.handoffId);
  assert.equal(reread.promptPackageVersion, pkg.version, 'the handoff must NOT silently update to the new version');

  const built = handoffService.buildExecutionPackage(project.id, handoff.handoffId);
  assert.equal(built.frozen, true);
  assert.equal(built.currentPromptPackageVersion, rebuilt.version);
  assert.match(built.text, /EXECUTION PACKAGE FROZEN/);

  // And a fresh handoff creation attempt is blocked (the old approval no
  // longer matches the new package version) — silently rebuilding the old
  // handoff is never an option.
  const second = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(second.ok, false);
});

// --- 13. cancellation ------------------------------------------------------------------

test('13. cancelHandoff marks a READY handoff CANCELLED, and refuses to cancel twice', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);

  const cancelled = handoffService.cancelHandoff(project.id, handoff.handoffId, { decidedBy: 'tester', reason: 'no longer needed' });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.handoff.status, 'CANCELLED');

  const again = handoffService.cancelHandoff(project.id, handoff.handoffId);
  assert.equal(again.ok, false);
});

test('cancelHandoff refuses to cancel an already-INGESTED handoff', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.ingestHandoffAsset(handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });

  const result = handoffService.cancelHandoff(project.id, handoff.handoffId);
  assert.equal(result.ok, false);
  assert.match(result.reason, /already has an ingested asset/);
});

// --- 14/18/19. image ingestion + asset lineage + approvalStatus NONE ---------------------

test('14. ingestHandoffAsset stores the image and transitions the handoff to INGESTED', async () => {
  const { project, keyframe, pkg } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);

  const result = handoffService.ingestHandoffAsset(handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.handoff.status, 'INGESTED');
  assert.ok(result.handoff.assetId);
  assert.equal(result.handoff.completedBy, 'tester');

  // --- lineage (Part 7) ---
  const asset = result.asset;
  assert.equal(asset.projectId, project.id);
  assert.equal(asset.sceneId, handoff.sceneId);
  assert.equal(asset.shotId, handoff.shotId);
  assert.equal(asset.keyframeId, handoff.keyframeId);
  assert.equal(asset.handoffId, handoff.handoffId);
  assert.equal(asset.generationId, null, 'a handoff-ingested asset has no generation job');
  assert.equal(asset.provider, 'human-handoff');
  assert.equal(asset.model, null, 'must never invent a model name');
  assert.equal(asset.generationType, 'KEYFRAME');
  assert.equal(asset.promptPackageId, pkg.packageId);
  assert.equal(asset.promptPackageVersion, pkg.version);
  assert.equal(asset.skillId, handoff.skillId);
  assert.equal(asset.approvalStatus, 'NONE', 'Part 6/18 — asset starts unreviewed');
  assert.equal(asset.storage.status, 'STORED');
  assert.ok(fs.existsSync(path.join(assetsTempDir, asset.storage.path)), 'the uploaded image must really exist on disk');
});

test('15. an unsupported image format is rejected and no handoff/asset state changes', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);

  const result = handoffService.ingestHandoffAsset(handoff.handoffId, Buffer.from('not an image'), { completedBy: 'tester' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_format');

  const reread = handoffService.getHandoff(project.id, handoff.handoffId);
  assert.equal(reread.status, 'READY', 'a failed ingestion must not change the handoff status');
  assert.equal(reread.assetId, null);
});

// --- 21. duplicate ingestion prevention (Part 8) -------------------------------------------

test('21. a handoff can only ever produce ONE ingested asset — a second upload is refused', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  const first = handoffService.ingestHandoffAsset(handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });
  assert.equal(first.ok, true);

  const second = handoffService.ingestHandoffAsset(handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already_ingested');

  // Exactly one asset must exist for this handoff/keyframe.
  const assets = timelineStore.listAssets ? timelineStore.listAssets(project.id) : null;
  if (assets) {
    const forThisHandoff = assets.filter((a) => a.handoffId === handoff.handoffId);
    assert.equal(forThisHandoff.length, 1);
  }
});

test('ingestHandoffAsset refuses a cancelled handoff', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.cancelHandoff(project.id, handoff.handoffId);

  const result = handoffService.ingestHandoffAsset(handoff.handoffId, PNG_BYTES);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
});

// --- enrichment: getHandoff/findHandoffById/listHandoffs attach the linked asset -----------

test('getHandoff/findHandoffById/listHandoffs enrich an INGESTED handoff with its asset, and stay null before that', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);

  assert.equal(handoffService.getHandoff(project.id, handoff.handoffId).asset, null);
  assert.equal(handoffService.findHandoffById(handoff.handoffId).handoff.asset, null);
  assert.equal(handoffService.listHandoffs(project.id, { keyframeId: keyframe.keyframeId })[0].asset, null);

  handoffService.ingestHandoffAsset(handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });

  assert.equal(handoffService.getHandoff(project.id, handoff.handoffId).asset.approvalStatus, 'NONE');
  assert.equal(handoffService.findHandoffById(handoff.handoffId).handoff.asset.approvalStatus, 'NONE');
  assert.equal(handoffService.listHandoffs(project.id, { keyframeId: keyframe.keyframeId })[0].asset.approvalStatus, 'NONE');
});

// --- Stage 13E, Part 2 — handoff concurrency (at most one ACTIVE handoff per keyframe) ----

test('7. a second handoff is blocked while the first is READY', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const first = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(first.ok, true);
  assert.equal(first.handoff.status, 'READY');

  const second = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(second.ok, false);
  assert.match(second.reason, /active handoff/i);
});

test('8. a second handoff is blocked while the first is IN_PROGRESS', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const first = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.updateHandoff(project.id, first.handoff.handoffId, { status: 'IN_PROGRESS' }, { updatedBy: 'tester' });

  const second = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(second.ok, false);
  assert.match(second.reason, /active handoff/i);
});

test('9. a new handoff IS permitted once the active one is INGESTED', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const first = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.ingestHandoffAsset(first.handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });

  // A fresh approval + a fresh (still-CURRENT) package are required for a
  // second handoff regardless of concurrency — re-approve for the same
  // current package version to isolate the concurrency behavior itself.
  approvalStore.requestApproval(project.id, keyframe.keyframeId, {
    promptPackageId: first.handoff.promptPackageId,
    promptPackageVersion: first.handoff.promptPackageVersion,
    estimatedCost: 2,
  });
  approvalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });

  const second = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(second.ok, true, second.reason);
  assert.notEqual(second.handoff.handoffId, first.handoff.handoffId);
});

test('10. a new handoff IS permitted once the active one is CANCELLED', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const first = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.cancelHandoff(project.id, first.handoff.handoffId);

  const second = handoffService.createHandoff(project.id, keyframe.keyframeId);
  assert.equal(second.ok, true, second.reason);
  assert.notEqual(second.handoff.handoffId, first.handoff.handoffId);
});

test('11. historical (INGESTED/CANCELLED) handoffs remain fully queryable, never deleted', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const first = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.cancelHandoff(project.id, first.handoff.handoffId, { decidedBy: 'tester', reason: 'no longer needed' });

  const second = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.ingestHandoffAsset(second.handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });

  const all = handoffService.listHandoffs(project.id, { keyframeId: keyframe.keyframeId });
  assert.equal(all.length, 2);
  const statuses = all.map((h) => h.status).sort();
  assert.deepEqual(statuses, ['CANCELLED', 'INGESTED']);

  // Each one is still individually fetchable with its own full record.
  assert.equal(handoffService.getHandoff(project.id, first.handoff.handoffId).status, 'CANCELLED');
  assert.equal(handoffService.getHandoff(project.id, second.handoff.handoffId).status, 'INGESTED');
});

// --- listHandoffs filtering ------------------------------------------------------------

test('listHandoffs filters by status', () => {
  const { project, keyframe } = fullyApprovedFixture();
  const { handoff } = handoffService.createHandoff(project.id, keyframe.keyframeId);
  handoffService.cancelHandoff(project.id, handoff.handoffId);

  const cancelled = handoffService.listHandoffs(project.id, { status: 'CANCELLED' });
  assert.equal(cancelled.length, 1);
  const ready = handoffService.listHandoffs(project.id, { status: 'READY' });
  assert.equal(ready.length, 0);
});

// --- safety: this file's own imports -----------------------------------------------------

test('services/keyframe-handoff-service.js never imports a provider, EvoLink, or the generation service', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-handoff-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|fake-image|generation-service|keyframe-generation-service/i.test(req), `unexpected import: ${req}`);
  }
  assert.doesNotMatch(text, /\bfetch\(/, 'must never call fetch()');
});
