// Tests for services/story-architecture-service.js — STORY ARCHITECTURE
// ENGINE. Same GENERATE N -> EVALUATE EACH INDEPENDENTLY -> SELECT
// STRONGEST pattern as idea-engine-service.js/packaging-engine-service.js,
// exercised against real, persisted Strategy/Idea/Package/Blueprint
// records.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [envVar, prefix] of [
  ['PROJECT_DATA_DIR', 'evolink-storyarch-projects-'],
  ['CREATIVE_DATA_DIR', 'evolink-storyarch-creative-'],
  ['CREATIVE_BLUEPRINT_DATA_DIR', 'evolink-storyarch-blueprints-'],
  ['EDITORIAL_STRATEGY_DATA_DIR', 'evolink-storyarch-strategies-'],
  ['IDEA_DATA_DIR', 'evolink-storyarch-ideas-'],
  ['PACKAGE_DATA_DIR', 'evolink-storyarch-packages-'],
  ['STORY_ARGUMENT_DATA_DIR', 'evolink-storyarch-arguments-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const editorialStrategyStore = require('../services/editorial-strategy-store');
const ideaEngineService = require('../services/idea-engine-service');
const packagingEngineService = require('../services/packaging-engine-service');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');
const storyArchitectureService = require('../services/story-architecture-service');
const storyArgumentStore = require('../services/story-argument-store');

async function newFullSetup() {
  const project = projectStore.createProject({ title: 'story architecture test', topic: 'x' });
  const strategy = editorialStrategyStore.addStrategy(project.id, {
    targetAudience: 'people who feel paralyzed by too many options',
    positioning: 'the number of options is the problem',
    audienceNeed: 'why more choice makes decisions harder instead of easier',
    contentPromise: 'a specific, named mechanism and one concrete way to counter it',
  }).strategy;
  const idea = (await ideaEngineService.generateIdeas(project.id, strategy.id)).selectedIdea;
  const pkg = (await packagingEngineService.generatePackages(project.id, idea.ideaId)).selectedPackage;
  const blueprint = creativeBlueprintStore.addCreativeBlueprint(
    project.id,
    createCreativeBlueprint({
      projectId: project.id,
      strategyId: strategy.id,
      ideaId: idea.ideaId,
      packageId: pkg.packageId,
      concept: idea.topic,
      corePromise: pkg.promise,
      hookStrategy: pkg.curiosityMechanism,
      narrativeStrategy: 'build from the everyday moment toward the reframed promise',
      pacingStrategy: 'slow open, accelerate through evidence, land on the reframe',
      visualStrategy: 'clean kinetic typography',
      emotionalArc: 'curiosity, unease, clarity',
      targetDuration: 48,
      status: 'APPROVED',
    })
  ).blueprint;
  return { project, strategy, idea, pkg, blueprint };
}

test('1. generateStoryArgument fails with IDEA_NOT_FOUND for a bogus ideaId', async () => {
  const { project, pkg, blueprint } = await newFullSetup();
  const result = await storyArchitectureService.generateStoryArgument(project.id, { ideaId: 'not-real', packageId: pkg.packageId, blueprintId: blueprint.id });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IDEA_NOT_FOUND');
});

test('2. generateStoryArgument fails with BLUEPRINT_NOT_FOUND for a bogus blueprintId', async () => {
  const { project, idea, pkg } = await newFullSetup();
  const result = await storyArchitectureService.generateStoryArgument(project.id, { ideaId: idea.ideaId, packageId: pkg.packageId, blueprintId: 'not-real' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLUEPRINT_NOT_FOUND');
});

test('3. generateStoryArgument succeeds, produces a real 6-beat StoryArgument with distinct claims, and persists it as SELECTED', async () => {
  const { project, idea, pkg, blueprint } = await newFullSetup();
  const result = await storyArchitectureService.generateStoryArgument(project.id, { ideaId: idea.ideaId, packageId: pkg.packageId, blueprintId: blueprint.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.selectedStoryArgument.status, 'SELECTED');
  assert.equal(result.storyArgumentSet.status, 'SELECTED');
  assert.equal(result.selectedStoryArgument.beats.length, 6);
  const claims = result.selectedStoryArgument.beats.map((b) => b.claim);
  assert.equal(new Set(claims).size, 6, 'all 6 beat claims must be distinct');

  const refetched = storyArgumentStore.getStoryArgumentSet(project.id, result.storyArgumentSet.id);
  assert.deepEqual(refetched, result.storyArgumentSet);
});

test('4. the selected candidate carries zero FAIL evaluationResults for a well-formed generation', async () => {
  const { project, idea, pkg, blueprint } = await newFullSetup();
  const result = await storyArchitectureService.generateStoryArgument(project.id, { ideaId: idea.ideaId, packageId: pkg.packageId, blueprintId: blueprint.id });
  const fails = result.selectedStoryArgument.evaluationResults.filter((r) => r.result === 'FAIL');
  assert.equal(fails.length, 0, JSON.stringify(fails, null, 2));
  assert.equal(result.allCandidatesPassed, true);
});

test('5. requesting a non-default shape explicitly still generates and evaluates it as a real candidate, and it wins the tie-break (listed first)', async () => {
  const { project, idea, pkg, blueprint } = await newFullSetup();
  const result = await storyArchitectureService.generateStoryArgument(project.id, { ideaId: idea.ideaId, packageId: pkg.packageId, blueprintId: blueprint.id }, { shape: 'MYTH_BUSTING' });
  assert.equal(result.ok, true);
  assert.equal(result.selectedStoryArgument.shape, 'MYTH_BUSTING');
  assert.equal(result.storyArgumentSet.candidates.length, 2, 'MYTH_BUSTING + the default make 2 distinct candidates');
});

test('6. selectStrongestStoryArgument ties are broken by original order (first wins), never randomly', () => {
  const a = { candidate: { shape: 'a' }, results: [{ result: 'FAIL' }] };
  const b = { candidate: { shape: 'b' }, results: [{ result: 'FAIL' }] };
  const { best } = storyArchitectureService.selectStrongestStoryArgument([a, b]);
  assert.equal(best.candidate.shape, 'a');
});
