// Tests for services/story-architecture/deterministic-story-architecture-
// provider.js and services/story-architecture/story-architecture-
// evaluator.js — STORY ARCHITECTURE ENGINE, Parts 2/3/7/8/11. No store/env
// setup needed — the provider is pure and takes plain objects directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeterministicStoryArchitectureProvider, asQuestion } = require('../services/story-architecture/deterministic-story-architecture-provider');
const { evaluateStoryArgument, PHASE_1_CANNED_VISUAL_PHRASES } = require('../services/story-architecture/story-architecture-evaluator');
const { getShape, listShapeKeys } = require('../services/story-architecture/story-shapes');

const provider = createDeterministicStoryArchitectureProvider();

function fixtureInput(overrides = {}) {
  return {
    idea: { ideaId: 'idea-1', topic: 'why more choice makes decisions harder instead of easier', premise: 'the paralysis comes from a specific comparison cost' },
    package: {
      packageId: 'pkg-1',
      title: 'The Mechanism Behind Choice Overload',
      promise: 'the paralysis comes from a specific comparison cost',
      curiosityMechanism: 'the real driver is a single, nameable comparison habit, not the number of options itself',
      stakes: 'the viewer keeps making the same mistake without knowing why',
      specificity: 'names the exact mechanism',
      novelty: 'leads with the mechanism rather than the symptom',
    },
    blueprint: {
      corePromise: 'the paralysis comes from a specific comparison cost',
      hookStrategy: 'the real driver is a single, nameable comparison habit, not the number of options itself',
      narrativeStrategy: 'build from the everyday moment of standing in front of a shelf toward the comparison-cost mechanism',
      pacingStrategy: 'slow open, accelerate through the mechanism, land on the reframe',
      visualStrategy: 'clean, high-contrast kinetic typography',
      emotionalArc: 'curiosity, unease, clarity',
      targetDuration: 48,
    },
    strategy: {
      targetAudience: 'people who feel paralyzed by too many options',
      positioning: 'the number of options is the problem',
      audienceNeed: 'why more choice makes decisions harder instead of easier',
      contentPromise: 'a specific, named mechanism and one concrete way to counter it',
      avoid: [],
    },
    ...overrides,
  };
}

// --- asQuestion guard (avoiding Phase 1's "Why why...?" defect class in NEW code) ---

test('1. asQuestion does not double an existing interrogative', () => {
  assert.equal(asQuestion('why more choice makes decisions harder'), 'why more choice makes decisions harder?');
  assert.equal(asQuestion('why more choice makes decisions harder?'), 'why more choice makes decisions harder?');
});

test('2. asQuestion prepends "Why" only when the text is not already a question', () => {
  assert.equal(asQuestion('the paradox of choice'), 'Why the paradox of choice?');
});

// --- generation produces 6 distinct beats bound to 6 distinct fields ---

test('3. generateStoryArgument produces COMPLETED status with 6 beats for the default shape', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.storyArgument.beats.length, 6);
});

test('4. every beat has a non-empty, DISTINCT claim (the structural fix for Phase 1\'s duplicate-escalation-beat bug)', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  const claims = result.storyArgument.beats.map((b) => b.claim);
  for (const c of claims) assert.ok(typeof c === 'string' && c.trim().length > 0);
  assert.equal(new Set(claims).size, claims.length, 'every beat claim must be unique');
});

test('5. every beat has a non-empty, content-specific visualObjective that references its own claim', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  for (const beat of result.storyArgument.beats) {
    assert.ok(beat.visualObjective.visualObjective.includes(beat.claim), 'visualObjective must ground itself in the beat\'s own claim text');
    assert.ok(!PHASE_1_CANNED_VISUAL_PHRASES.includes(beat.visualObjective.visualObjective), 'must not be one of Phase 1\'s fixed role-only phrases');
  }
});

test('6. two questions are tracked, both created by real beats and resolved by the reveal beat', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  const { beats, questions } = result.storyArgument;
  assert.equal(questions.length, 2);
  const beatKeys = new Set(beats.map((b) => b.beatKey));
  const revealBeat = beats.find((b) => b.isReveal);
  for (const q of questions) {
    assert.ok(beatKeys.has(q.createdByBeatKey));
    assert.equal(q.resolvedByBeatKey, revealBeat.beatKey);
    assert.equal(q.status, 'RESOLVED');
  }
});

test('7. the payoff beat structurally references the hook and reveal beats via paysOffBeatKeys', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  const { beats } = result.storyArgument;
  const hookBeat = beats.find((b) => b.beatFunction === 'HOOK');
  const revealBeat = beats.find((b) => b.isReveal);
  const payoffBeat = beats.find((b) => b.isPayoff);
  assert.ok(payoffBeat.paysOffBeatKeys.includes(hookBeat.beatKey));
  assert.ok(payoffBeat.paysOffBeatKeys.includes(revealBeat.beatKey));
});

test('8. requesting the MYTH_BUSTING shape produces a structurally different beatFunction sequence than the default', async () => {
  const defaultResult = await provider.generateStoryArgument(fixtureInput());
  const mythResult = await provider.generateStoryArgument({ ...fixtureInput(), shape: 'MYTH_BUSTING' });
  const defaultSequence = defaultResult.storyArgument.beats.map((b) => b.beatFunction);
  const mythSequence = mythResult.storyArgument.beats.map((b) => b.beatFunction);
  assert.notDeepEqual(defaultSequence, mythSequence);
  assert.equal(mythResult.storyArgument.shape, 'MYTH_BUSTING');
});

test('9. every registered shape has exactly 6 steps, each binding one of the 6 distinct content fields exactly once', () => {
  for (const key of listShapeKeys()) {
    const shape = getShape(key);
    const fields = shape.steps.map((s) => s.field);
    assert.equal(new Set(fields).size, 6, `shape ${key} must bind each content field exactly once`);
  }
});

// --- evaluator: a real, generated StoryArgument passes cleanly ---

test('10. the evaluator finds ZERO FAILs on a real, generated, well-formed StoryArgument', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  const results = evaluateStoryArgument(result.storyArgument);
  const fails = results.filter((r) => r.result === 'FAIL');
  assert.equal(fails.length, 0, JSON.stringify(fails, null, 2));
});

test('11. the evaluator covers all 8 named dimensions', async () => {
  const result = await provider.generateStoryArgument(fixtureInput());
  const results = evaluateStoryArgument(result.storyArgument);
  const dims = new Set(results.map((r) => r.dimension));
  for (const expected of ['promiseAlignment', 'storyProgression', 'beatDistinctness', 'questionContinuity', 'revealLinkage', 'payoffLinkage', 'contentCoverage', 'visualObjectiveSpecificity']) {
    assert.ok(dims.has(expected), `missing dimension "${expected}"`);
  }
});

// --- REQUIRED TEST (phase brief, Part 14): a deliberately bad story with duplicated beats ---

test('12. THE PHASE BRIEF\'S REQUIRED DUPLICATE-BEAT TEST: a deliberately bad story (Beat 3 "More choice makes decisions harder." / Beat 4 "Having more choices makes choosing harder.") is FLAGGED by beatDistinctness', () => {
  const badArgument = {
    payoff: 'ship loud, learn fast',
    beats: [
      { beatKey: 'b1', order: 1, claim: 'Why does more choice make decisions harder?', isReveal: false, isPayoff: false, creates: ['q1'], resolves: [], visualObjective: { visualObjective: 'a shelf of products' } },
      { beatKey: 'b2', order: 2, claim: 'Most people assume more choice is always better.', isSetup: true, creates: [], resolves: [], visualObjective: { visualObjective: 'someone shrugging' } },
      { beatKey: 'b3', order: 3, claim: 'More choice makes decisions harder.', isEscalation: true, creates: [], resolves: [], visualObjective: { visualObjective: 'a person comparing two products' } },
      { beatKey: 'b4', order: 4, claim: 'Having more choices makes choosing harder.', isEscalation: true, creates: [], resolves: [], visualObjective: { visualObjective: 'a person comparing two products' } },
      { beatKey: 'b5', order: 5, claim: 'The real mechanism is comparison cost, not option count.', isReveal: true, creates: [], resolves: ['q1'], visualObjective: { visualObjective: 'a comparison table' } },
      { beatKey: 'b6', order: 6, claim: 'ship loud, learn fast', isPayoff: true, creates: [], resolves: [], paysOffBeatKeys: ['b1'], visualObjective: { visualObjective: 'a closing card' } },
    ],
    questions: [{ questionId: 'q1', text: 'Why does more choice make decisions harder?', createdByBeatKey: 'b1', resolvedByBeatKey: 'b5', status: 'RESOLVED' }],
  };
  const results = evaluateStoryArgument(badArgument);
  const distinctnessFails = results.filter((r) => r.dimension === 'beatDistinctness' && r.result === 'FAIL');
  assert.ok(distinctnessFails.length > 0, 'the evaluator MUST reject/flag the duplicated beats 3 and 4');
  assert.ok(distinctnessFails.some((r) => r.detail.includes('b3') && r.detail.includes('b4')), `expected a finding naming both b3 and b4, got: ${JSON.stringify(distinctnessFails)}`);
});
