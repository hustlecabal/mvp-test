// Tests for services/keyframe-planner.js — the deterministic
// analyzeShotKeyframes requirement analysis (Parts 6-10). Every rule here
// is a plain structural/keyword check; these tests exercise each rule in
// isolation, the reuse/existing dedup logic, and confirm the planner never
// creates a generation job or touches approval/budget state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-planner-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-planner-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-planner-keyframes-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-planner-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const { analyzeShotKeyframes } = require('../services/keyframe-planner');

function newProject(title = 'Keyframe planner test') {
  return projectStore.createProject({ title, topic: 'x' });
}

function findEntry(list, frameType) {
  return list.find((e) => e.frameType === frameType);
}

// --- 1. Missing project/storyboard/shot -----------------------------------------

test('1. analyzeShotKeyframes returns null when the project has no storyboard yet', () => {
  const project = newProject();
  assert.equal(analyzeShotKeyframes(project.id, 'shot-1'), null);
});

test('analyzeShotKeyframes returns null for an unknown shotId', () => {
  const project = newProject();
  creativeStore.updateStoryboard(project.id, {}, { changeNote: 'init' });
  assert.equal(analyzeShotKeyframes(project.id, 'nope'), null);
});

// --- 2. CHARACTER_REFERENCE: recommend / reuse / existing -----------------------

test('2. a shot with a character reference and no approved asset gets a CHARACTER_REFERENCE recommendation', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  const rec = findEntry(result.recommendations, 'CHARACTER_REFERENCE');
  assert.ok(rec, 'expected a CHARACTER_REFERENCE recommendation');
  assert.equal(rec.characterId, 'char-1');
  assert.equal(rec.subject, 'Mira');
  assert.equal(rec.recommendedSkill, 'banana-pro-director-2.0');
});

test('a character with an APPROVED reference asset is satisfied via reuse, not recommended again', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [asset.assetId] }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(findEntry(result.recommendations, 'CHARACTER_REFERENCE'), undefined);
  const reused = findEntry(result.reused, 'CHARACTER_REFERENCE');
  assert.ok(reused);
  assert.equal(reused.assetId, asset.assetId);
});

test('a character reference asset that is NOT approved still gets recommended (candidate assets do not satisfy the requirement)', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [asset.assetId] }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.ok(findEntry(result.recommendations, 'CHARACTER_REFERENCE'), 'an unapproved candidate asset must not silently satisfy the requirement');
});

test('a character that already has a planned keyframe for this shot is reported as existing, not recommended again', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });
  const existingKf = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    frameType: 'CHARACTER_REFERENCE',
    characterReferences: ['char-1'],
  });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(findEntry(result.recommendations, 'CHARACTER_REFERENCE'), undefined);
  const existing = findEntry(result.existing, 'CHARACTER_REFERENCE');
  assert.ok(existing);
  assert.equal(existing.keyframeId, existingKf.keyframeId);
});

test('a REJECTED existing keyframe is still respected as "existing", never re-recommended', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });
  keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, frameType: 'CHARACTER_REFERENCE', characterReferences: ['char-1'], status: 'REJECTED' });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(findEntry(result.recommendations, 'CHARACTER_REFERENCE'), undefined);
  assert.equal(findEntry(result.existing, 'CHARACTER_REFERENCE').status, 'REJECTED');
});

// --- 3. WORLD_REFERENCE (same logic, for locations) ------------------------------

test('3. a shot with a location reference and no approved asset gets a WORLD_REFERENCE recommendation', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { locations: [{ locationId: 'loc-1', name: 'The Lighthouse' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, locationReferences: ['loc-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  const rec = findEntry(result.recommendations, 'WORLD_REFERENCE');
  assert.ok(rec);
  assert.equal(rec.locationId, 'loc-1');
  assert.equal(rec.subject, 'The Lighthouse');
});

test('a location with an APPROVED reference asset is satisfied via reuse', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'location_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { locations: [{ locationId: 'loc-1', name: 'The Lighthouse', referenceAssets: [asset.assetId] }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, locationReferences: ['loc-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.ok(findEntry(result.reused, 'WORLD_REFERENCE'));
});

// --- 4. ESTABLISHING_FRAME: first shot in scene only -----------------------------

test('4. only the first shot (by order) in a scene gets an ESTABLISHING_FRAME recommendation', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const first = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });
  const second = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2 });

  const firstResult = analyzeShotKeyframes(project.id, first.shotId);
  const secondResult = analyzeShotKeyframes(project.id, second.shotId);

  assert.ok(findEntry(firstResult.recommendations, 'ESTABLISHING_FRAME'));
  assert.equal(findEntry(secondResult.recommendations, 'ESTABLISHING_FRAME'), undefined);
});

// --- 5. COMPOSITION_FRAME: character + location together ------------------------

test('5. a shot with both character and location references gets a COMPOSITION_FRAME recommendation', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, {
    characters: [{ characterId: 'char-1', name: 'Mira' }],
    locations: [{ locationId: 'loc-1', name: 'The Lighthouse' }],
  });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    characterReferences: ['char-1'],
    locationReferences: ['loc-1'],
  });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.ok(findEntry(result.recommendations, 'COMPOSITION_FRAME'));
});

test('a shot with only a character reference (no location) does not get a COMPOSITION_FRAME recommendation', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(findEntry(result.recommendations, 'COMPOSITION_FRAME'), undefined);
});

// --- 6. ACTION_FRAME: action keyword match ---------------------------------------

test('6. a shot whose action text matches an action keyword gets an ACTION_FRAME recommendation', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, action: 'The two duel with swords.' });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.ok(findEntry(result.recommendations, 'ACTION_FRAME'));
});

test('a shot with unrelated action text does not get an ACTION_FRAME recommendation', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, action: 'She reads a letter quietly.' });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(findEntry(result.recommendations, 'ACTION_FRAME'), undefined);
});

// --- 7. FIRST_FRAME + LAST_FRAME: movement keyword, always together --------------

test('7. a shot with movement text implying travel gets BOTH FIRST_FRAME and LAST_FRAME recommendations', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, movement: 'She walks slowly across the beach.' });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.ok(findEntry(result.recommendations, 'FIRST_FRAME'));
  assert.ok(findEntry(result.recommendations, 'LAST_FRAME'));
});

test('a shot with no movement/action text gets neither FIRST_FRAME nor LAST_FRAME', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(findEntry(result.recommendations, 'FIRST_FRAME'), undefined);
  assert.equal(findEntry(result.recommendations, 'LAST_FRAME'), undefined);
});

// --- 8. TRANSITION_FRAME: non-trivial transitions only ---------------------------

test('8. a non-trivial transition gets a TRANSITION_FRAME recommendation', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, transition: 'match cut on the lighthouse beam' });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.ok(findEntry(result.recommendations, 'TRANSITION_FRAME'));
});

test('a trivial transition ("cut", "none", blank) never gets a TRANSITION_FRAME recommendation', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  for (const transition of ['cut', 'Cut', 'none', 'hard cut', '', null]) {
    const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, transition });
    const result = analyzeShotKeyframes(project.id, shot.shotId);
    assert.equal(findEntry(result.recommendations, 'TRANSITION_FRAME'), undefined, `"${transition}" must be treated as trivial`);
  }
});

// --- 9. DETAIL_FRAME: prop references --------------------------------------------

test('9. a shot with prop references gets a DETAIL_FRAME recommendation', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, propReferences: ['prop-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  const rec = findEntry(result.recommendations, 'DETAIL_FRAME');
  assert.ok(rec);
  assert.equal(rec.recommendedSkill, 'banana-pro-director-2.0');
});

// --- 10. Summary counts ------------------------------------------------------------

test('10. summary totals match the recommendations/reused/existing arrays', () => {
  const project = newProject();
  creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, characterReferences: ['char-1'], propReferences: ['prop-1'] });

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(result.summary.totalRequired, result.recommendations.length + result.reused.length + result.existing.length);
  assert.equal(result.summary.newRecommended, result.recommendations.length);
  assert.equal(result.summary.reusable, result.reused.length);
  assert.equal(result.summary.alreadyPlanned, result.existing.length);
});

test('sourceShotVersion in the result matches the storyboard\'s current version at analysis time', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);

  const result = analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(result.sourceShotVersion, storyboard.version);
});

// --- 11. Never generates, never touches approval/budget ---------------------------

test('11. running the analysis repeatedly never creates a generation job or changes approval/budget state', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    characterReferences: ['char-1'],
    locationReferences: ['loc-1'],
    propReferences: ['prop-1'],
    action: 'a fierce battle',
    movement: 'they run across the field',
    transition: 'dissolve',
  });

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  for (let i = 0; i < 3; i++) analyzeShotKeyframes(project.id, shot.shotId);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.reserved, 0);
});

// --- keyframe-planner.js never imports a provider/generation/approval module -----

test('services/keyframe-planner.js has no require() of any provider, generation-service, or approval-gate module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-planner.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});
