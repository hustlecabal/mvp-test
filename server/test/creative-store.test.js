// Tests for services/creative-store.js — get/create/update, versioning,
// project isolation, storyboard scene/shot creation, and confirmation
// that creative updates never touch generation/approval/budget. No
// network, no provider, no generation job is ever created here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-artifacts-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');

function newProject(title = 'Creative test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// --- 1/2/3. Creative Brief: creation, retrieval, update ---------------------

test('1. updateCreativeBrief creates the brief on first call (version 1, no history)', () => {
  const project = newProject();
  const brief = creativeStore.updateCreativeBrief(project.id, { title: 'My Brief' }, { updatedBy: 'human', changeNote: 'first draft' });

  assert.equal(brief.title, 'My Brief');
  assert.equal(brief.projectId, project.id);
  assert.equal(brief.version, 1);
  assert.deepEqual(brief.history, []);
  assert.equal(brief.updatedBy, 'human');
  assert.equal(brief.changeNote, 'first draft');
});

test('2. getCreativeBrief retrieves what was stored, and null before creation', () => {
  const project = newProject();
  assert.equal(creativeStore.getCreativeBrief(project.id), null);

  creativeStore.updateCreativeBrief(project.id, { title: 'Retrieved Brief' });
  const retrieved = creativeStore.getCreativeBrief(project.id);
  assert.equal(retrieved.title, 'Retrieved Brief');
});

test('3. updateCreativeBrief on an existing brief updates fields and bumps the version', () => {
  const project = newProject();
  creativeStore.updateCreativeBrief(project.id, { title: 'v1 title', concept: 'v1 concept' });
  const updated = creativeStore.updateCreativeBrief(project.id, { concept: 'v2 concept' });

  assert.equal(updated.version, 2);
  assert.equal(updated.title, 'v1 title', 'fields not included in the update must be left alone');
  assert.equal(updated.concept, 'v2 concept');
});

// --- 4/5/6. Master Creative Specification -----------------------------------

test('4/5/6. Master Creative Spec: creation, retrieval, update', () => {
  const project = newProject();
  assert.equal(creativeStore.getMasterCreativeSpec(project.id), null);

  const v1 = creativeStore.updateMasterCreativeSpec(project.id, { coreConcept: 'A lighthouse keeper' });
  assert.equal(v1.version, 1);
  assert.equal(creativeStore.getMasterCreativeSpec(project.id).coreConcept, 'A lighthouse keeper');

  const v2 = creativeStore.updateMasterCreativeSpec(project.id, { tone: 'melancholic' });
  assert.equal(v2.version, 2);
  assert.equal(v2.coreConcept, 'A lighthouse keeper');
  assert.equal(v2.tone, 'melancholic');
});

// --- 7/8/9. Visual Bible ------------------------------------------------------

test('7/8/9. Visual Bible: creation, retrieval, update', () => {
  const project = newProject();
  assert.equal(creativeStore.getVisualBible(project.id), null);

  const v1 = creativeStore.updateVisualBible(project.id, { world: 'A rain-soaked coastal town' });
  assert.equal(v1.version, 1);
  assert.equal(creativeStore.getVisualBible(project.id).world, 'A rain-soaked coastal town');

  const v2 = creativeStore.updateVisualBible(project.id, { lighting: 'Low-key, practical sources only' });
  assert.equal(v2.version, 2);
  assert.equal(v2.world, 'A rain-soaked coastal town');
});

// --- 10. Character definition (stored inside the Visual Bible) --------------

test('10. a character definition can be stored in and retrieved from the Visual Bible', () => {
  const project = newProject();
  const character = {
    characterId: 'char-1',
    name: 'Mira',
    role: 'protagonist',
    identityConstraints: 'always has a scar above the left eyebrow',
  };

  const bible = creativeStore.updateVisualBible(project.id, { characters: [character] });
  assert.equal(bible.characters.length, 1);
  assert.equal(bible.characters[0].name, 'Mira');
  assert.equal(bible.characters[0].identityConstraints, 'always has a scar above the left eyebrow');
});

// --- 11. Location definition --------------------------------------------------

test('11. a location definition can be stored in and retrieved from the Visual Bible', () => {
  const project = newProject();
  const location = { locationId: 'loc-1', name: 'The Lighthouse', atmosphere: 'foggy, isolated' };

  const bible = creativeStore.updateVisualBible(project.id, { locations: [location] });
  assert.equal(bible.locations.length, 1);
  assert.equal(bible.locations[0].name, 'The Lighthouse');
});

// --- 12/13/14. Storyboard: creation, retrieval, update -----------------------

test('12/13/14. Storyboard: creation, retrieval, update', () => {
  const project = newProject();
  assert.equal(creativeStore.getStoryboard(project.id), null);

  const v1 = creativeStore.updateStoryboard(project.id, {}, { changeNote: 'initialized' });
  assert.equal(v1.version, 1);
  assert.deepEqual(creativeStore.getStoryboard(project.id).scenes, []);

  const v2 = creativeStore.updateStoryboard(project.id, {}, { changeNote: 'reviewed, no changes yet' });
  assert.equal(v2.version, 2);
});

// --- 15/16. Scene creation, shot creation -------------------------------------

test('15. addStoryboardScene creates the storyboard if needed and adds one scene', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Opening' });

  assert.ok(scene.sceneId);
  assert.equal(scene.title, 'Opening');
  const storyboard = creativeStore.getStoryboard(project.id);
  assert.equal(storyboard.scenes.length, 1);
});

test('16. addStoryboardShot adds a shot linked to its scene', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Opening' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: 'establish the setting' });

  assert.ok(shot.shotId);
  assert.equal(shot.sceneId, scene.sceneId);
  assert.equal(shot.purpose, 'establish the setting');
  assert.equal(shot.status, 'DRAFT');
});

test('addStoryboardShot rejects a sceneId that does not belong to this project storyboard', () => {
  const project = newProject();
  assert.throws(() => creativeStore.addStoryboardShot(project.id, { sceneId: 'nonexistent-scene' }), /does not belong to project/);
});

// --- 17. Shot ordering ---------------------------------------------------------

test('17. shots preserve their own order field for client-side sorting', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });

  const storyboard = creativeStore.getStoryboard(project.id);
  const orders = storyboard.shots.map((s) => s.order).sort();
  assert.deepEqual(orders, [1, 2]);
});

// --- 18. Shot references -------------------------------------------------------

test('18. a shot can carry character/location/prop/asset references', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    characterReferences: ['char-1', 'char-2'],
    locationReferences: ['loc-1'],
    propReferences: ['prop-1'],
    referenceAssets: ['asset-1'],
  });

  assert.deepEqual(shot.characterReferences, ['char-1', 'char-2']);
  assert.deepEqual(shot.locationReferences, ['loc-1']);
  assert.deepEqual(shot.propReferences, ['prop-1']);
  assert.deepEqual(shot.referenceAssets, ['asset-1']);
});

// --- 19/20/21. Version incrementing, change notes, current-version retrieval

test('19/20. version increments by exactly 1 per update, and change notes are preserved in history', () => {
  const project = newProject();
  creativeStore.updateCreativeBrief(project.id, { title: 'v1' }, { changeNote: 'created' });
  creativeStore.updateCreativeBrief(project.id, { title: 'v2' }, { changeNote: 'renamed' });
  const v3 = creativeStore.updateCreativeBrief(project.id, { title: 'v3' }, { changeNote: 'renamed again' });

  assert.equal(v3.version, 3);
  assert.equal(v3.history.length, 2);
  assert.equal(v3.history[0].version, 1);
  assert.equal(v3.history[0].changeNote, 'created');
  assert.equal(v3.history[1].version, 2);
  assert.equal(v3.history[1].changeNote, 'renamed');
  assert.equal(v3.changeNote, 'renamed again', 'the CURRENT changeNote describes the most recent change');
});

test('21. the current version is always retrievable directly from get* — no separate lookup needed', () => {
  const project = newProject();
  creativeStore.updateCreativeBrief(project.id, { title: 'v1' });
  creativeStore.updateCreativeBrief(project.id, { title: 'v2' });

  const current = creativeStore.getCreativeBrief(project.id);
  assert.equal(current.version, 2);
  assert.equal(current.title, 'v2');
});

// --- 22. Project isolation ------------------------------------------------------

test('22. creative artifacts never leak between projects', () => {
  const projectA = newProject('A');
  const projectB = newProject('B');

  creativeStore.updateCreativeBrief(projectA.id, { title: 'Brief A' });
  creativeStore.updateCreativeBrief(projectB.id, { title: 'Brief B' });

  assert.equal(creativeStore.getCreativeBrief(projectA.id).title, 'Brief A');
  assert.equal(creativeStore.getCreativeBrief(projectB.id).title, 'Brief B');
  assert.equal(creativeStore.getMasterCreativeSpec(projectB.id), null, 'an untouched artifact type must stay null, not inherit from another project');
});

test('creative artifacts require a real, existing project', () => {
  const missingId = '00000000-0000-0000-0000-000000000000';
  assert.equal(creativeStore.getCreativeBrief(missingId), null);
  assert.equal(creativeStore.updateCreativeBrief(missingId, { title: 'x' }), null);
});

// --- 25. Creative updates never trigger generation ------------------------------

test('25. updating every creative artifact never creates a generation job', () => {
  const project = newProject();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  creativeStore.updateCreativeBrief(project.id, { title: 'x' });
  creativeStore.updateMasterCreativeSpec(project.id, { coreConcept: 'x' });
  creativeStore.updateVisualBible(project.id, { world: 'x' });
  creativeStore.updateStoryboard(project.id, {});
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- 26. Creative updates never modify budgets ----------------------------------

test('26. updating creative artifacts never changes the approval/budget state', () => {
  const project = newProject();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  creativeStore.updateCreativeBrief(project.id, { title: 'x' });
  creativeStore.updateVisualBible(project.id, { world: 'x' });
  creativeStore.updateStoryboard(project.id, {});

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.limit, 100);
  assert.equal(reloaded.creditLedger.reserved, 0);
  assert.equal(gate.canProceed(reloaded).allowed, true);
});
