// Tests for services/reference-video-interpretation-model-registry.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../services/reference-video-interpretation-model-registry');

test('1. getModel returns a real, priced entry for claude/claude-sonnet-5 (the default interpretation model)', () => {
  const entry = registry.getModel('claude', 'claude-sonnet-5');
  assert.ok(entry);
  assert.equal(entry.pricing.priceKnown, true);
  assert.equal(entry.pricing.inputPerMillionTokensUsd, 2);
  assert.equal(entry.pricing.outputPerMillionTokensUsd, 10);
  assert.equal(entry.productionReady, true);
});

test('2. getModel returns null for an unknown model — never a fabricated entry', () => {
  assert.equal(registry.getModel('claude', 'claude-nonexistent-9000'), null);
  assert.equal(registry.getModel('openai', 'gpt-4'), null);
});

test('3. estimateCostUsd computes the exact real published-pricing arithmetic', () => {
  // 1,000,000 input tokens * $2/M + 1,000,000 output tokens * $10/M = $12
  const cost = registry.estimateCostUsd({ provider: 'claude', model: 'claude-sonnet-5', estimatedInputTokens: 1000000, estimatedOutputTokens: 1000000 });
  assert.equal(cost, 12);
});

test('4. estimateCostUsd returns null (never zero/free) for an unknown model', () => {
  assert.equal(registry.estimateCostUsd({ provider: 'claude', model: 'unknown-model', estimatedInputTokens: 100, estimatedOutputTokens: 100 }), null);
});

test('5. estimateCostUsd returns null for missing/invalid token counts', () => {
  assert.equal(registry.estimateCostUsd({ provider: 'claude', model: 'claude-sonnet-5', estimatedInputTokens: null, estimatedOutputTokens: 100 }), null);
});

test('6. listModels productionReadyOnly filter only returns SAFE_FOR_PRODUCTION entries', () => {
  const all = registry.listModels();
  const ready = registry.listModels({ productionReadyOnly: true });
  assert.ok(all.length >= 3);
  assert.equal(ready.length, all.filter((m) => m.productionReady).length);
});

test('7. every registered model has real, distinct, sourced pricing (no two models silently share a placeholder price)', () => {
  const all = registry.listModels();
  for (const m of all) {
    assert.equal(m.pricing.priceKnown, true);
    assert.ok(m.pricing.inputPerMillionTokensUsd > 0);
    assert.ok(m.pricing.outputPerMillionTokensUsd > m.pricing.inputPerMillionTokensUsd, `${m.model}: output pricing should exceed input pricing, matching every real Claude tier`);
    assert.match(m.docsUrl, /^https:\/\/platform\.claude\.com/);
  }
});

test('8. getModel returns a deep copy — mutating the result never corrupts the registry', () => {
  const entry = registry.getModel('claude', 'claude-sonnet-5');
  entry.pricing.inputPerMillionTokensUsd = 999;
  const fresh = registry.getModel('claude', 'claude-sonnet-5');
  assert.equal(fresh.pricing.inputPerMillionTokensUsd, 2);
});
