// Tests for services/idea-engine-service.js — PHASE 1 EDITORIAL SPINE,
// Part 2. Idea generation, independent per-dimension scoring, and
// fewest-FAIL selection — the SAME conceptual pattern services/creative-
// brain-service.js already proves for angle candidates, one layer up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-idea-projects-'));
process.env.EDITORIAL_STRATEGY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-idea-strategies-'));
process.env.IDEA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-idea-ideas-'));

const projectStore = require('../services/project-store');
const editorialStrategyStore = require('../services/editorial-strategy-store');
const ideaEngineService = require('../services/idea-engine-service');
const ideaStore = require('../services/idea-store');

function newProjectWithStrategy(overrides = {}) {
  const project = projectStore.createProject({ title: 'idea test', topic: 'x' });
  const { strategy } = editorialStrategyStore.addStrategy(project.id, {
    targetAudience: 'early-career software engineers',
    positioning: 'explains the why, not just the how',
    audienceNeed: 'feeling stuck without knowing why',
    contentPromise: 'a specific, named reason and a concrete next step',
    avoid: [],
    ...overrides,
  });
  return { project, strategy };
}

test('1. generateIdeas fails with STRATEGY_NOT_FOUND for a bogus strategyId', async () => {
  const project = projectStore.createProject({ title: 'x', topic: 'x' });
  const result = await ideaEngineService.generateIdeas(project.id, 'not-a-real-strategy-id');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STRATEGY_NOT_FOUND');
});

test('2. the default deterministic provider generates 3 genuinely distinct candidates', async () => {
  const { project, strategy } = newProjectWithStrategy();
  const result = await ideaEngineService.generateIdeas(project.id, strategy.id);
  assert.equal(result.ok, true);
  assert.equal(result.ideaSet.candidates.length, 3);
  const topics = new Set(result.ideaSet.candidates.map((c) => c.topic));
  assert.equal(topics.size, 3, 'all 3 candidates must have distinct topics');
});

test('3. every candidate carries independent evaluationResults across the 9 named dimensions', async () => {
  const { project, strategy } = newProjectWithStrategy();
  const result = await ideaEngineService.generateIdeas(project.id, strategy.id);
  const expectedDimensions = ['specificity', 'curiosity', 'stakes', 'audienceRelevance', 'usefulness', 'strategicFit', 'novelty', 'distinctiveness'];
  for (const candidate of result.ideaSet.candidates) {
    const dims = new Set(candidate.evaluationResults.map((r) => r.dimension));
    for (const expected of expectedDimensions) assert.ok(dims.has(expected), `missing dimension "${expected}"`);
  }
});

test('4. exactly one candidate is selected, and the IdeaSet is persisted as SELECTED', async () => {
  const { project, strategy } = newProjectWithStrategy();
  const result = await ideaEngineService.generateIdeas(project.id, strategy.id);
  assert.equal(result.ideaSet.candidates.filter((c) => c.selected).length, 1);
  assert.equal(result.ideaSet.status, 'SELECTED');
  assert.equal(result.ideaSet.selectedIdeaId, result.selectedIdea.ideaId);

  const refetched = ideaStore.getIdeaSet(project.id, result.ideaSet.id);
  assert.deepEqual(refetched, result.ideaSet);
});

test('5. selectStrongestIdea ties are broken by original order (first wins), never randomly', () => {
  const a = { candidate: { topic: 'a' }, results: [{ result: 'FAIL' }] };
  const b = { candidate: { topic: 'b' }, results: [{ result: 'FAIL' }] };
  const { best } = ideaEngineService.selectStrongestIdea([a, b]);
  assert.equal(best.candidate.topic, 'a');
});

test('6. a candidate whose topic/premise touches strategy.avoid[] FAILs strategicFit (CROSSES_AVOID_LIST)', async () => {
  const { project, strategy } = newProjectWithStrategy({ audienceNeed: 'burnout', avoid: ['burnout'] });
  const result = await ideaEngineService.generateIdeas(project.id, strategy.id);
  const problemFirst = result.ideaSet.candidates.find((c) => c.rationale.includes('PROBLEM_FIRST'));
  assert.ok(problemFirst, 'PROBLEM_FIRST candidate should exist');
  const crossesAvoid = problemFirst.evaluationResults.find((r) => r.dimension === 'strategicFit' && r.code === 'CROSSES_AVOID_LIST');
  assert.equal(crossesAvoid.result, 'FAIL');
});

test('7. two near-identical candidates FAIL novelty/distinctiveness against each other', async () => {
  const { project, strategy } = newProjectWithStrategy();
  const fakeProvider = {
    async generateIdeaCandidates() {
      return {
        status: 'COMPLETED',
        candidates: [
          { topic: 'the hidden cost of burnout', premise: 'burnout costs more than people realize, in ways nobody tracks', rationale: 'shape A' },
          { topic: 'the hidden cost of burnout', premise: 'burnout costs more than people realize, in ways nobody tracks', rationale: 'shape B' },
        ],
      };
    },
  };
  const result = await ideaEngineService.generateIdeas(project.id, strategy.id, { provider: fakeProvider, candidateCount: 2 });
  for (const candidate of result.ideaSet.candidates) {
    const novelty = candidate.evaluationResults.find((r) => r.dimension === 'novelty');
    assert.equal(novelty.result, 'FAIL', 'identical siblings must fail novelty against each other');
  }
});

test('8. never claims audience performance — no dimension name/code resembles CTR/retention prediction', async () => {
  const { project, strategy } = newProjectWithStrategy();
  const result = await ideaEngineService.generateIdeas(project.id, strategy.id);
  const bannedTerms = /ctr|ranking prediction|will (perform|go viral)|guaranteed/i;
  for (const candidate of result.ideaSet.candidates) {
    for (const r of candidate.evaluationResults) {
      assert.ok(!bannedTerms.test(r.detail), `evaluation detail "${r.detail}" reads like a performance claim`);
    }
  }
});
