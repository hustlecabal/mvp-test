// Tests for services/packaging-engine-service.js — PHASE 1 EDITORIAL
// SPINE, Part 3. Package generation, independent per-dimension scoring
// (clarity/curiosity/specificity/novelty/emotionalTension/
// audienceRelevance/promiseStrength/titleThumbnailComplementarity/
// alignmentWithIdea), and fewest-FAIL selection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-package-projects-'));
process.env.EDITORIAL_STRATEGY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-package-strategies-'));
process.env.IDEA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-package-ideas-'));
process.env.PACKAGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-package-packages-'));

const projectStore = require('../services/project-store');
const editorialStrategyStore = require('../services/editorial-strategy-store');
const ideaEngineService = require('../services/idea-engine-service');
const packagingEngineService = require('../services/packaging-engine-service');
const packageStore = require('../services/package-store');

async function newProjectWithSelectedIdea() {
  const project = projectStore.createProject({ title: 'package test', topic: 'x' });
  const { strategy } = editorialStrategyStore.addStrategy(project.id, {
    targetAudience: 'early-career software engineers',
    positioning: 'explains the why, not just the how',
    audienceNeed: 'feeling stuck without knowing why',
    contentPromise: 'a specific, named reason and a concrete next step',
  });
  const ideaResult = await ideaEngineService.generateIdeas(project.id, strategy.id);
  return { project, strategy, idea: ideaResult.selectedIdea };
}

test('1. generatePackages fails with IDEA_NOT_FOUND for a bogus ideaId', async () => {
  const project = projectStore.createProject({ title: 'x', topic: 'x' });
  const result = await packagingEngineService.generatePackages(project.id, 'not-a-real-idea-id');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IDEA_NOT_FOUND');
});

test('2. the default deterministic provider generates 3 genuinely distinct package candidates', async () => {
  const { project, idea } = await newProjectWithSelectedIdea();
  const result = await packagingEngineService.generatePackages(project.id, idea.ideaId);
  assert.equal(result.ok, true);
  assert.equal(result.packageSet.candidates.length, 3);
  const titles = new Set(result.packageSet.candidates.map((c) => c.title));
  assert.equal(titles.size, 3);
});

test('3. every candidate has the full worked-example field shape and independent evaluationResults across all 9 dimensions', async () => {
  const { project, idea } = await newProjectWithSelectedIdea();
  const result = await packagingEngineService.generatePackages(project.id, idea.ideaId);
  const expectedDimensions = ['clarity', 'curiosity', 'specificity', 'novelty', 'emotionalTension', 'audienceRelevance', 'promiseStrength', 'titleThumbnailComplementarity', 'alignmentWithIdea'];
  for (const pkg of result.packageSet.candidates) {
    for (const field of ['title', 'thumbnailConcept', 'promise', 'curiosityMechanism', 'specificity', 'novelty', 'stakes', 'packageRationale']) {
      assert.ok(typeof pkg[field] === 'string' && pkg[field].length > 0, `field "${field}" must be a non-empty string`);
    }
    const dims = new Set(pkg.evaluationResults.map((r) => r.dimension));
    for (const expected of expectedDimensions) assert.ok(dims.has(expected), `missing dimension "${expected}"`);
  }
});

test('4. exactly one candidate is selected, and the PackageSet is persisted as SELECTED', async () => {
  const { project, idea } = await newProjectWithSelectedIdea();
  const result = await packagingEngineService.generatePackages(project.id, idea.ideaId);
  assert.equal(result.packageSet.candidates.filter((c) => c.selected).length, 1);
  assert.equal(result.packageSet.status, 'SELECTED');
  assert.equal(result.packageSet.selectedPackageId, result.selectedPackage.packageId);

  const refetched = packageStore.getPackageSet(project.id, result.packageSet.id);
  assert.deepEqual(refetched, result.packageSet);
});

test('5. selectStrongestPackage ties are broken by original order (first wins), never randomly', () => {
  const a = { candidate: { title: 'a' }, results: [{ result: 'FAIL' }] };
  const b = { candidate: { title: 'b' }, results: [{ result: 'FAIL' }] };
  const { best } = packagingEngineService.selectStrongestPackage([a, b]);
  assert.equal(best.candidate.title, 'a');
});

test('6. a thumbnail concept that just restates the title in words WARNs titleThumbnailComplementarity', async () => {
  const { project, idea } = await newProjectWithSelectedIdea();
  const fakeProvider = {
    async generatePackageCandidates() {
      return {
        status: 'COMPLETED',
        candidates: [{ title: 'The Hidden Cost Of Burnout', thumbnailConcept: 'the hidden cost of burnout', promise: idea.premise, curiosityMechanism: 'a question', specificity: 'x', novelty: 'y', stakes: 'z', packageRationale: 'test' }],
      };
    },
  };
  const result = await packagingEngineService.generatePackages(project.id, idea.ideaId, { provider: fakeProvider, candidateCount: 1 });
  const pkg = result.packageSet.candidates[0];
  const complementarity = pkg.evaluationResults.find((r) => r.dimension === 'titleThumbnailComplementarity');
  assert.equal(complementarity.result, 'WARN');
});

test('7. a promise that shares no terms with the source idea premise FAILs alignmentWithIdea', async () => {
  const { project, idea } = await newProjectWithSelectedIdea();
  const fakeProvider = {
    async generatePackageCandidates() {
      return {
        status: 'COMPLETED',
        candidates: [{ title: 'Completely Unrelated Title', thumbnailConcept: 'an unrelated image', promise: 'volcanic obsidian shards glitter beneath abandoned lighthouses', curiosityMechanism: 'a question', specificity: 'x', novelty: 'y', stakes: 'z', packageRationale: 'test' }],
      };
    },
  };
  const result = await packagingEngineService.generatePackages(project.id, idea.ideaId, { provider: fakeProvider, candidateCount: 1 });
  const pkg = result.packageSet.candidates[0];
  const alignment = pkg.evaluationResults.find((r) => r.dimension === 'alignmentWithIdea');
  assert.equal(alignment.result, 'FAIL');
});
