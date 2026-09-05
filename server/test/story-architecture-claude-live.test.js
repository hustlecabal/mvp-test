// LIVE-PROVIDER test for Story Architecture's Claude provider — a real
// network call to Anthropic, using EVOLINK_LLM_API_KEY (the credential
// name deliberately does NOT contain "ANTHROPIC"/"CLAUDE" — see
// services/reference-video/claude-interpretation-provider.js's header for
// why). Deliberately kept in a SEPARATE file from
// story-architecture-claude-provider.test.js (which uses only an
// injected fetchImpl mock) — `node --test` runs every *.test.js file, so
// this file uses node:test's own `skip` option whenever the key is
// missing, never a thrown error, so `npm test` stays fully green with no
// key configured, and this file's real coverage only activates once a
// key is present.
//
// Run explicitly:
//   NODE_USE_ENV_PROXY=1 EVOLINK_LLM_API_KEY=... node --test test/story-architecture-claude-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeStoryArchitectureProvider } = require('../services/story-architecture/claude-story-architecture-provider');
const { evaluateStoryArgument } = require('../services/story-architecture/story-architecture-evaluator');
const { findDuplicateBeats } = require('../services/story-architecture/distinctness-checker');

const hasKey = Boolean(process.env.EVOLINK_LLM_API_KEY);

function fixtureInput(topic) {
  return {
    idea: { ideaId: 'idea-1', topic, premise: 'there is a specific, non-obvious mechanism behind this that most people never learn' },
    package: {
      packageId: 'pkg-1',
      title: `The Real Reason Behind ${topic}`,
      promise: 'a concrete, specific mechanism explanation, not a vague generality',
      curiosityMechanism: 'the true driver is hidden behind a much more obvious, incorrect explanation',
      stakes: 'the viewer keeps misunderstanding their own everyday experience',
      specificity: 'names the actual mechanism, not just "psychology" or "design"',
      novelty: 'most explanations stop at the surface-level cause',
    },
    blueprint: {
      concept: topic,
      corePromise: 'a concrete, specific mechanism explanation, not a vague generality',
      hookStrategy: 'open on the surface belief, then question it',
      narrativeStrategy: 'problem -> mechanism -> reveal -> payoff',
      pacingStrategy: 'steady build, one escalation before the reveal',
      visualStrategy: 'concrete, literal visuals of the real-world scenario',
      emotionalArc: 'mild confusion -> clarity -> confidence',
      targetDuration: 50,
    },
    strategy: {
      targetAudience: 'curious general audience',
      positioning: 'explains the hidden mechanism behind everyday things',
      audienceNeed: 'wants a satisfying, specific explanation, not surface trivia',
      contentPromise: 'you will understand the real mechanism, not just the popular myth',
      avoid: ['vague claims', 'unverifiable statistics'],
    },
  };
}

test(
  'live: Claude generates a real, topic-grounded StoryArgument for "the paradox of choice" that passes structural validation and the real evaluator',
  { skip: hasKey ? false : 'EVOLINK_LLM_API_KEY not set — skipped, not failed' },
  async () => {
    const provider = createClaudeStoryArchitectureProvider();
    const result = await provider.generateStoryArgument(fixtureInput('the paradox of choice'));

    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
    assert.ok(result.storyArgument.beats.length >= 4 && result.storyArgument.beats.length <= 10);

    const claims = result.storyArgument.beats.map((b) => b.claim);
    assert.equal(new Set(claims).size, claims.length, 'every beat claim must be distinct');

    const dupes = findDuplicateBeats(result.storyArgument.beats);
    assert.equal(dupes.length, 0, `Claude produced near-duplicate beats: ${JSON.stringify(dupes, null, 2)}`);

    const fails = evaluateStoryArgument(result.storyArgument).filter((r) => r.result === 'FAIL');
    assert.equal(fails.length, 0, `evaluator FAILs: ${JSON.stringify(fails, null, 2)}`);
  }
);

test(
  'live: Claude generates a real, topic-grounded StoryArgument for the supermarket-design topic that passes structural validation and the real evaluator',
  { skip: hasKey ? false : 'EVOLINK_LLM_API_KEY not set — skipped, not failed' },
  async () => {
    const provider = createClaudeStoryArchitectureProvider();
    const result = await provider.generateStoryArgument(fixtureInput('the hidden reason supermarkets are designed the way they are'));

    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
    const claims = result.storyArgument.beats.map((b) => b.claim);
    assert.equal(new Set(claims).size, claims.length, 'every beat claim must be distinct');

    const dupes = findDuplicateBeats(result.storyArgument.beats);
    assert.equal(dupes.length, 0, `Claude produced near-duplicate beats: ${JSON.stringify(dupes, null, 2)}`);

    const fails = evaluateStoryArgument(result.storyArgument).filter((r) => r.result === 'FAIL');
    assert.equal(fails.length, 0, `evaluator FAILs: ${JSON.stringify(fails, null, 2)}`);
  }
);
