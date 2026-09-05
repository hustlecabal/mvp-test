// Tests for services/story-architecture/claude-story-architecture-
// provider.js — using an INJECTED fetchImpl mock throughout (no network),
// same convention as test/claude-interpretation-provider.test.js. Live,
// real-API tests are in test/story-architecture-claude-live.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeStoryArchitectureProvider, validateAndBuildStoryArgument } = require('../services/story-architecture/claude-story-architecture-provider');
const { evaluateStoryArgument } = require('../services/story-architecture/story-architecture-evaluator');

function fixtureInput() {
  return {
    idea: { ideaId: 'idea-1', topic: 'why more choice makes decisions harder instead of easier', premise: 'the paralysis comes from a specific comparison cost' },
    package: { packageId: 'pkg-1', title: 'The Mechanism Behind Choice Overload', promise: 'the paralysis comes from a specific comparison cost', curiosityMechanism: 'the real driver is a comparison habit', stakes: 'the viewer keeps repeating the mistake', specificity: 'x', novelty: 'y' },
    blueprint: { concept: 'choice overload', corePromise: 'the paralysis comes from a specific comparison cost', hookStrategy: 'x', narrativeStrategy: 'y', pacingStrategy: 'z', visualStrategy: 'v', emotionalArc: 'e', targetDuration: 48 },
    strategy: { targetAudience: 'a', positioning: 'b', audienceNeed: 'c', contentPromise: 'd', avoid: [] },
  };
}

function wellFormedRawResponse() {
  return {
    shape: 'PROBLEM_MECHANISM_REVEAL',
    coreQuestion: 'Why does having more options make deciding harder?',
    stakes: 'People waste real time and energy stuck comparing options that barely differ.',
    startingBelief: 'Most people assume more options is always a good thing.',
    reframedBelief: 'The brain pays a real, rising comparison cost for every option added.',
    mechanism: 'Each new option forces a fresh pairwise comparison against every existing one, and that comparison count grows combinatorially.',
    payoff: 'Cut your options to three before you start comparing, and the paralysis disappears.',
    questions: [{ id: 'q1', text: 'Why does more choice make deciding harder?', createdBy: 'beat1', resolvedBy: 'beat4' }],
    beats: [
      { id: 'beat1', order: 1, beatFunction: 'HOOK', narrativeRole: 'HOOK', purpose: 'open on the question', claim: 'Why does having more options make deciding harder?', whyItExists: 'introduces the question', isSetup: true, isEscalation: false, isReveal: false, isPayoff: false, unresolvedQuestion: 'why', creates: ['q1'], resolves: [], paysOff: [], visualObjective: 'show a shelf with 3 items, then 30', visualMode: 'EMOTIONAL' },
      { id: 'beat2', order: 2, beatFunction: 'STARTING_BELIEF', narrativeRole: 'EXPLANATION', purpose: 'state the assumption', claim: 'Most people assume more options is always a good thing.', whyItExists: 'sets up the contrast', isSetup: true, isEscalation: false, isReveal: false, isPayoff: false, unresolvedQuestion: null, creates: [], resolves: [], paysOff: [], visualObjective: 'a person nodding at a big menu', visualMode: 'ILLUSTRATIVE' },
      { id: 'beat3', order: 3, beatFunction: 'MECHANISM', narrativeRole: 'EXPLANATION', purpose: 'explain the mechanism', claim: 'Each new option forces a fresh pairwise comparison against every existing one, and that comparison count grows combinatorially.', whyItExists: 'grounds the reveal', isSetup: false, isEscalation: true, isReveal: false, isPayoff: false, unresolvedQuestion: null, creates: [], resolves: [], paysOff: [], visualObjective: 'lines connecting every pair of items on a shelf', visualMode: 'EXPLANATORY' },
      { id: 'beat4', order: 4, beatFunction: 'REVEAL', narrativeRole: 'REVEAL', purpose: 'deliver the reframe', claim: 'The brain pays a real, rising comparison cost for every option added.', whyItExists: 'answers the hook', isSetup: false, isEscalation: false, isReveal: true, isPayoff: false, unresolvedQuestion: null, creates: [], resolves: ['q1'], paysOff: [], visualObjective: 'a graph of comparisons rising steeply', visualMode: 'EVIDENCE' },
      { id: 'beat5', order: 5, beatFunction: 'PAYOFF', narrativeRole: 'CONCLUSION', purpose: 'land the takeaway', claim: 'Cut your options to three before you start comparing, and the paralysis disappears.', whyItExists: 'gives a concrete action', isSetup: false, isEscalation: false, isReveal: false, isPayoff: true, unresolvedQuestion: null, creates: [], resolves: [], paysOff: ['beat1'], visualObjective: 'the shelf reduced to three clear options', visualMode: 'EMOTIONAL' },
    ],
  };
}

function mockFetchReturning(jsonText, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    // Real Anthropic responses can carry a leading "thinking" block before
    // the "text" block (see claude-story-architecture-provider.js's own
    // extraction comment) — mocked here too so this suite would catch a
    // regression back to a content[0]-only assumption.
    json: async () => ({
      content: [
        { type: 'thinking', thinking: 'reasoning about the topic...' },
        { type: 'text', text: jsonText },
      ],
      usage: { input_tokens: 500, output_tokens: 800 },
    }),
    text: async () => jsonText,
  });
}

test('1. no apiKey -> UNAVAILABLE, never a network call', async () => {
  let called = false;
  const provider = createClaudeStoryArchitectureProvider({ apiKey: '', fetchImpl: async () => { called = true; } });
  const result = await provider.generateStoryArgument(fixtureInput());
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(called, false);
});

test('2. missing idea/package/blueprint -> FAILED before any network call', async () => {
  let called = false;
  const provider = createClaudeStoryArchitectureProvider({ apiKey: 'x', fetchImpl: async () => { called = true; } });
  const result = await provider.generateStoryArgument({});
  assert.equal(result.status, 'FAILED');
  assert.equal(called, false);
});

test('3. HTTP error from Anthropic -> FAILED, with the status code surfaced', async () => {
  const provider = createClaudeStoryArchitectureProvider({ apiKey: 'x', fetchImpl: mockFetchReturning('irrelevant', { ok: false, status: 529 }) });
  const result = await provider.generateStoryArgument(fixtureInput());
  assert.equal(result.status, 'FAILED');
  assert.match(result.diagnostics[0].message, /529/);
});

test('4. unparseable JSON in the model response -> INVALID, never repaired/guessed', async () => {
  const provider = createClaudeStoryArchitectureProvider({ apiKey: 'x', fetchImpl: mockFetchReturning('not json at all {{{') });
  const result = await provider.generateStoryArgument(fixtureInput());
  assert.equal(result.status, 'INVALID');
});

test('5. a well-formed response is parsed, validated, and remapped into a real StoryArgument with real UUID beatKeys/questionIds', async () => {
  const provider = createClaudeStoryArchitectureProvider({ apiKey: 'x', fetchImpl: mockFetchReturning(JSON.stringify(wellFormedRawResponse())) });
  const result = await provider.generateStoryArgument(fixtureInput());
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.equal(result.storyArgument.beats.length, 5);
  const claims = result.storyArgument.beats.map((b) => b.claim);
  assert.equal(new Set(claims).size, 5, 'all beat claims must be distinct');
  // beatKeys are real UUIDs, not Claude's own "beat1"/"beat2" strings
  for (const beat of result.storyArgument.beats) assert.doesNotMatch(beat.beatKey, /^beat\d$/);
  const q = result.storyArgument.questions[0];
  assert.doesNotMatch(q.questionId, /^q\d$/);
  const hookBeat = result.storyArgument.beats.find((b) => b.beatFunction === 'HOOK');
  const revealBeat = result.storyArgument.beats.find((b) => b.isReveal);
  const payoffBeat = result.storyArgument.beats.find((b) => b.isPayoff);
  assert.equal(q.createdByBeatKey, hookBeat.beatKey);
  assert.equal(q.resolvedByBeatKey, revealBeat.beatKey);
  assert.deepEqual(revealBeat.resolves, [q.questionId]);
  assert.deepEqual(payoffBeat.paysOffBeatKeys, [hookBeat.beatKey]);
});

test('6. the remapped StoryArgument passes the REAL, unmodified evaluator with zero FAILs', async () => {
  const provider = createClaudeStoryArchitectureProvider({ apiKey: 'x', fetchImpl: mockFetchReturning(JSON.stringify(wellFormedRawResponse())) });
  const result = await provider.generateStoryArgument(fixtureInput());
  const fails = evaluateStoryArgument(result.storyArgument).filter((r) => r.result === 'FAIL');
  assert.equal(fails.length, 0, JSON.stringify(fails, null, 2));
});

// --- validateAndBuildStoryArgument: structural validation, no silent repair ---

test('7. a missing top-level key is rejected, never defaulted', () => {
  const bad = wellFormedRawResponse();
  delete bad.mechanism;
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MISSING_KEYS');
});

test('8. a beat count below MIN_BEATS is rejected', () => {
  const bad = wellFormedRawResponse();
  bad.beats = bad.beats.slice(0, 2);
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BEAT_COUNT_OUT_OF_RANGE');
});

test('9. an invalid narrativeRole is rejected, never coerced to a guessed value', () => {
  const bad = wellFormedRawResponse();
  bad.beats[0].narrativeRole = 'INTRO';
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_NARRATIVE_ROLE');
});

test('10. a dangling question reference (creates an id that no question record has) is rejected', () => {
  const bad = wellFormedRawResponse();
  bad.beats[0].creates = ['q-does-not-exist'];
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DANGLING_QUESTION_REFERENCE');
});

test('11. a dangling paysOff beat reference is rejected', () => {
  const bad = wellFormedRawResponse();
  bad.beats[4].paysOff = ['beat-does-not-exist'];
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DANGLING_BEAT_REFERENCE');
});

test('12. no isReveal beat that resolves anything -> rejected', () => {
  const bad = wellFormedRawResponse();
  bad.beats[3].isReveal = false;
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_REVEAL_WITH_RESOLUTION');
});

test('13. no isPayoff beat -> rejected', () => {
  const bad = wellFormedRawResponse();
  bad.beats[4].isPayoff = false;
  const result = validateAndBuildStoryArgument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PAYOFF_BEAT');
});

// --- THE PHASE BRIEF'S EXPLICIT NEAR-DUPLICATE EXAMPLE, run through the REAL evaluator ---

test('14. a Claude response with two near-duplicate beats ("More options make decisions harder." / "Having more options makes choosing difficult.") is FLAGGED by the real evaluator', () => {
  const bad = wellFormedRawResponse();
  bad.beats[1].claim = 'More options make decisions harder.';
  bad.beats[2].claim = 'Having more options makes choosing difficult.';
  const validated = validateAndBuildStoryArgument(bad);
  assert.equal(validated.ok, true);
  const fails = evaluateStoryArgument(validated.storyArgument).filter((r) => r.dimension === 'beatDistinctness' && r.result === 'FAIL');
  assert.ok(fails.length > 0, 'the evaluator must catch this even though it came from the Claude provider path, not the deterministic one');
});
