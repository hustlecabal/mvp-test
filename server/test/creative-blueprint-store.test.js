// Tests for services/creative-blueprint-store.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cbstore-projects-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-cbstore-'));

const projectStore = require('../services/project-store');
const blueprintStore = require('../services/creative-blueprint-store');
const { createCreativeBlueprint, createCreativeBlueprintReview } = require('../schemas/creative-blueprint-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

test('1. addCreativeBlueprint fails for a non-existent project', () => {
  const result = blueprintStore.addCreativeBlueprint('00000000-0000-4000-8000-000000000000', createCreativeBlueprint());
  assert.equal(result.ok, false);
});

test('2. addCreativeBlueprint stores a blueprint and getCreativeBlueprint retrieves it by id', () => {
  const project = newProject();
  const blueprint = createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', title: 'x' });
  const result = blueprintStore.addCreativeBlueprint(project.id, blueprint);
  assert.equal(result.ok, true);
  assert.equal(blueprintStore.getCreativeBlueprint(project.id, result.blueprint.id).title, 'x');
});

test('3. addCreativeBlueprint stores a deep copy — mutating the caller\'s object afterward never corrupts the stored record', () => {
  const project = newProject();
  const blueprint = createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', title: 'original' });
  blueprintStore.addCreativeBlueprint(project.id, blueprint);
  blueprint.title = 'CORRUPTED';
  assert.equal(blueprintStore.listCreativeBlueprints(project.id)[0].title, 'original');
});

test('4. listCreativeBlueprints returns null for a non-existent project, [] for one with none yet', () => {
  assert.equal(blueprintStore.listCreativeBlueprints('00000000-0000-4000-8000-000000000000'), null);
  const project = newProject();
  assert.deepEqual(blueprintStore.listCreativeBlueprints(project.id), []);
});

test('5. listCreativeBlueprints filters by referenceSetId when given', () => {
  const project = newProject();
  blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1' }));
  blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs2' }));
  assert.equal(blueprintStore.listCreativeBlueprints(project.id, { referenceSetId: 'rs1' }).length, 1);
  assert.equal(blueprintStore.listCreativeBlueprints(project.id).length, 2);
});

test('6. getLatestCreativeBlueprintForReferenceSet returns the most recently created blueprint for that reference set only', () => {
  const project = newProject();
  blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', createdAt: '2020-01-01T00:00:00.000Z' }));
  const second = blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', createdAt: '2021-01-01T00:00:00.000Z' }));
  blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs2', createdAt: '2022-01-01T00:00:00.000Z' }));
  const latest = blueprintStore.getLatestCreativeBlueprintForReferenceSet(project.id, 'rs1');
  assert.equal(latest.id, second.blueprint.id);
});

test('7. updateCreativeBlueprintReviewState updates only status/reviews[]/updatedAt, leaving title/concept/corePromise/recommendationDecisions untouched', () => {
  const project = newProject();
  const blueprint = createCreativeBlueprint({ title: 'original title', concept: 'original concept', corePromise: 'original promise', recommendationDecisions: [{ recommendationId: 'r1', decision: 'ACCEPT' }] });
  const saved = blueprintStore.addCreativeBlueprint(project.id, blueprint);
  const updated = blueprintStore.updateCreativeBlueprintReviewState(project.id, saved.blueprint.id, {
    status: 'APPROVED',
    review: createCreativeBlueprintReview({ decision: 'APPROVE', reviewedBy: 'human1' }),
  });
  assert.equal(updated.status, 'APPROVED');
  assert.equal(updated.reviews.length, 1);
  assert.equal(updated.title, 'original title');
  assert.equal(updated.concept, 'original concept');
  assert.equal(updated.corePromise, 'original promise');
  assert.equal(updated.recommendationDecisions[0].decision, 'ACCEPT');
});

test('8. updateCreativeBlueprintReviewState returns null for a non-existent project or blueprint', () => {
  const project = newProject();
  const saved = blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id }));
  assert.equal(blueprintStore.updateCreativeBlueprintReviewState('00000000-0000-4000-8000-000000000000', saved.blueprint.id, { status: 'APPROVED' }), null);
  assert.equal(blueprintStore.updateCreativeBlueprintReviewState(project.id, '11111111-1111-4111-8111-111111111111', { status: 'APPROVED' }), null);
});

test('9. getRevisionChain walks supersedesBlueprintId back to the first draft, oldest first', () => {
  const project = newProject();
  const v1 = blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', title: 'v1' })).blueprint;
  const v2 = blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', title: 'v2', supersedesBlueprintId: v1.id })).blueprint;
  const v3 = blueprintStore.addCreativeBlueprint(project.id, createCreativeBlueprint({ projectId: project.id, referenceSetId: 'rs1', title: 'v3', supersedesBlueprintId: v2.id })).blueprint;
  const chain = blueprintStore.getRevisionChain(project.id, v3.id);
  assert.deepEqual(chain.map((b) => b.title), ['v1', 'v2', 'v3']);
});

test('10. getRevisionChain returns null for a non-existent blueprint', () => {
  const project = newProject();
  assert.equal(blueprintStore.getRevisionChain(project.id, '11111111-1111-4111-8111-111111111111'), null);
});

test('11. two different projects never see each other\'s blueprints', () => {
  const projectA = newProject();
  const projectB = newProject();
  blueprintStore.addCreativeBlueprint(projectA.id, createCreativeBlueprint({ projectId: projectA.id, referenceSetId: 'rs1' }));
  assert.deepEqual(blueprintStore.listCreativeBlueprints(projectB.id), []);
});
