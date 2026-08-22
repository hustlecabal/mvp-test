// Tests for services/creative-brain/claude-creative-brain-provider.js —
// the real Anthropic-backed Creative Brain adapter. Every test injects a
// fake fetchImpl (never a real network call), matching this codebase's
// established convention for provider-adapter unit tests.
//
// P0 Golden Run Blocker Repair, Blocker C — this file exists because the
// routing fix in creative-brain-service.js let this adapter actually
// reach a real model for the first time, and doing so surfaced a real,
// previously-latent bug: a response with extended thinking enabled puts
// a {type: "thinking"} block at content[0] (no `.text` field at all) and
// the real JSON answer at a LATER content[] entry with type "text".
// These tests lock in the fix (find the text block by type, never by
// position) without ever needing a real API call.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClaudeCreativeBrainProvider } = require('../services/creative-brain/claude-creative-brain-provider');

function anthropicResponse({ content, usage = { input_tokens: 10, output_tokens: 20 } } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: 'claude-sonnet-5', content, usage }),
  };
}

const CANDIDATES_JSON = JSON.stringify({ candidates: [{ concept: 'c1', corePromise: 'p1', hookStrategy: 'h1', rationale: 'r1' }] });

test('1. a real-shaped response with a thinking block BEFORE the text block still parses correctly (the exact bug found live)', async () => {
  const fetchImpl = async () =>
    anthropicResponse({
      content: [
        { type: 'thinking', thinking: '', signature: 'sig...' },
        { type: 'text', text: CANDIDATES_JSON },
      ],
    });
  const provider = createClaudeCreativeBrainProvider({ apiKey: 'test-key', fetchImpl });
  const result = await provider.generateAngleCandidates({ topic: 't', candidateCount: 1, recommendations: [], voicePatterns: [] });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].concept, 'c1');
});

test('2. a text-only response (no thinking block, e.g. thinking disabled) still parses correctly — backward compatible', async () => {
  const fetchImpl = async () => anthropicResponse({ content: [{ type: 'text', text: CANDIDATES_JSON }] });
  const provider = createClaudeCreativeBrainProvider({ apiKey: 'test-key', fetchImpl });
  const result = await provider.generateAngleCandidates({ topic: 't', candidateCount: 1, recommendations: [], voicePatterns: [] });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.candidates[0].concept, 'c1');
});

test('3. multiple thinking blocks (redacted_thinking, thinking) before the text block are skipped correctly', async () => {
  const fetchImpl = async () =>
    anthropicResponse({
      content: [
        { type: 'redacted_thinking', data: 'xxx' },
        { type: 'thinking', thinking: 'reasoning...', signature: 'sig...' },
        { type: 'text', text: CANDIDATES_JSON },
      ],
    });
  const provider = createClaudeCreativeBrainProvider({ apiKey: 'test-key', fetchImpl });
  const result = await provider.generateAngleCandidates({ topic: 't', candidateCount: 1, recommendations: [], voicePatterns: [] });
  assert.equal(result.status, 'COMPLETED');
});

test('4. a response with no text block at all (only thinking) fails as INVALID, never crashes', async () => {
  const fetchImpl = async () => anthropicResponse({ content: [{ type: 'thinking', thinking: '', signature: 'sig...' }] });
  const provider = createClaudeCreativeBrainProvider({ apiKey: 'test-key', fetchImpl });
  const result = await provider.generateAngleCandidates({ topic: 't', candidateCount: 1, recommendations: [], voicePatterns: [] });
  assert.equal(result.status, 'INVALID');
  assert.equal(result.diagnostics[0].code, 'CREATIVE_BRAIN_INVALID');
});

test('5. synthesizeDirection has the exact same thinking-block fix applied (same callAnthropic path)', async () => {
  const directionJson = JSON.stringify({
    narrativeStrategy: 'n', pacingStrategy: 'p', tone: 't', emotionalArc: 'e',
    visualDirection: 'v', visualSpecification: {
      composition: 'c', palette: 'p', lighting: 'l', texture: 't', depth: 'd', cameraLanguage: 'c',
      subjectTreatment: 's', environmentalTreatment: 'e', visualDensity: 'v', motionLanguage: 'm', typography: 't', negativeConstraints: 'n',
    },
    narrationStrategy: 'ns', narrationText: 'nt',
  });
  const fetchImpl = async () =>
    anthropicResponse({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: directionJson }] });
  const provider = createClaudeCreativeBrainProvider({ apiKey: 'test-key', fetchImpl });
  const result = await provider.synthesizeDirection({ topic: 't', selectedAngle: { concept: 'c' }, recommendations: [], voicePatterns: [] });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.narrativeStrategy, 'n');
});

test('6. no apiKey configured returns UNAVAILABLE without ever calling fetch', async () => {
  // apiKey: '' (not undefined) — bypasses the default-parameter fallback
  // to process.env.EVOLINK_LLM_API_KEY, which IS genuinely configured in
  // this environment; this explicitly simulates "no credential" instead.
  let called = false;
  const fetchImpl = async () => { called = true; return anthropicResponse({ content: [] }); };
  const provider = createClaudeCreativeBrainProvider({ apiKey: '', fetchImpl });
  const result = await provider.generateAngleCandidates({ topic: 't', candidateCount: 1, recommendations: [], voicePatterns: [] });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(called, false);
});
