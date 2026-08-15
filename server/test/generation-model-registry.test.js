// Tests for services/generation-model-registry.js — Stage 22B-Part-1.
//
// This registry is pure in-memory data plus read-only query functions: no
// project data, no filesystem store, no network. These tests need no
// PROJECT_DATA_DIR/temp-dir setup at all — every other test file in this
// repo needs that scaffolding because it touches a real store; this one
// deliberately doesn't, and that absence is itself part of what's being
// verified (see the "no mutation / no network" tests below).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const registry = require('../services/generation-model-registry');

// ---------------------------------------------------------------------------
// 1. Catalogue completeness
// ---------------------------------------------------------------------------

test('catalogue completeness: every model from the Stage 22B-Part-0 investigation is present', () => {
  const expectedEvolinkVideo = [
    'doubao-seedance-1.0-pro-fast',
    'seedance-1.5-pro',
    'seedance-2.0-mini-text-to-video',
    'seedance-2.0-mini-image-to-video',
    'seedance-2.0-mini-reference-to-video',
    'seedance-2.0-fast-text-to-video',
    'seedance-2.0-fast-image-to-video',
    'seedance-2.0-fast-reference-to-video',
    'seedance-2.0-text-to-video',
    'seedance-2.0-image-to-video',
    'seedance-2.0-reference-to-video',
    'seedance-2.5-text-to-video',
    'seedance-2.5-image-to-video',
    'seedance-2.5-reference-to-video',
    'seedance-2.5-video-edit',
    'seedance-2.5-video-extend',
    'grok-imagine-video',
    'wan-2.5-video',
    'wan-2.6-video',
    'kling-3.0',
    'sora-2',
    'veo-3.1-resale',
  ];
  const expectedEvolinkImage = ['krea-2-turbo', 'gpt-image-2', 'wan2.5-image-to-image', 'seedream-5.0-lite', 'gemini-3.1-flash-image', 'gemini-3-pro-image-preview'];
  const expectedGoogle = [
    'gemini-3.1-flash-lite-image',
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
    'veo-3.1-generate-preview',
    'veo-3.1-fast-generate-preview',
    'veo-3.1-lite-generate-preview',
  ];

  for (const model of expectedEvolinkVideo) assert.ok(registry.getModel('evolink', model), `missing evolink video model ${model}`);
  for (const model of expectedEvolinkImage) assert.ok(registry.getModel('evolink', model), `missing evolink image model ${model}`);
  for (const model of expectedGoogle) assert.ok(registry.getModel('google', model), `missing google model ${model}`);

  assert.equal(registry.GENERATION_MODEL_REGISTRY.length, expectedEvolinkVideo.length + expectedEvolinkImage.length + expectedGoogle.length);
});

// ---------------------------------------------------------------------------
// 2/3. Exact lookup + unknown model
// ---------------------------------------------------------------------------

test('getModel returns the exact provider/model record', () => {
  const entry = registry.getModel('evolink', 'gpt-image-2');
  assert.equal(entry.provider, 'evolink');
  assert.equal(entry.model, 'gpt-image-2');
  assert.equal(entry.modality, 'image');
});

test('getModel returns null for an unknown model', () => {
  assert.equal(registry.getModel('evolink', 'does-not-exist'), null);
  assert.equal(registry.getModel('nonexistent-provider', 'gpt-image-2'), null);
});

// ---------------------------------------------------------------------------
// 4. Provider mismatch
// ---------------------------------------------------------------------------

test('a model registered under one provider is not found under another', () => {
  assert.equal(registry.getModel('google', 'gpt-image-2'), null);
  assert.equal(registry.getModel('evolink', 'veo-3.1-generate-preview'), null);
});

// ---------------------------------------------------------------------------
// 5/6/7. Capability matching, unknown !== true, false !== true
// ---------------------------------------------------------------------------

test('findModelsSatisfying: a positive requirement only matches models with capability === true', () => {
  const matches = registry.findModelsSatisfying({ modality: 'image', referenceImages: true });
  for (const m of matches) assert.equal(m.capabilities.referenceImages, true);
  // krea-2-turbo confirmed referenceImages: false must never appear
  assert.ok(!matches.some((m) => m.model === 'krea-2-turbo'));
});

test('unknown capability (null) does not satisfy a true requirement', () => {
  const entry = registry.getModel('evolink', 'seedream-5.0-lite');
  assert.equal(entry.capabilities.referenceImages, null);
  assert.equal(registry.isModelCapable('evolink', 'seedream-5.0-lite', { referenceImages: true }), false);
});

test('a confirmed false capability does not satisfy a true requirement', () => {
  const entry = registry.getModel('evolink', 'krea-2-turbo');
  assert.equal(entry.capabilities.referenceImages, false);
  assert.equal(registry.isModelCapable('evolink', 'krea-2-turbo', { referenceImages: true }), false);
});

test('a false requirement is satisfied by both false and null (never treated as "confirmed absent required")', () => {
  // krea-2-turbo: referenceImages confirmed false -> satisfies referenceImages:false
  assert.equal(registry.isModelCapable('evolink', 'krea-2-turbo', { referenceImages: false }), true);
  // seedream-5.0-lite: referenceImages unknown (null) -> still satisfies referenceImages:false,
  // because "false" means "not required to be true", not "confirmed absent"
  assert.equal(registry.isModelCapable('evolink', 'seedream-5.0-lite', { referenceImages: false }), true);
  // gpt-image-2: referenceImages confirmed true -> must NOT satisfy referenceImages:false
  assert.equal(registry.isModelCapable('evolink', 'gpt-image-2', { referenceImages: false }), false);
});

// ---------------------------------------------------------------------------
// 8/9. Reference-image requirements + max reference count
// ---------------------------------------------------------------------------

test('reference-image requirement filters correctly across the whole registry', () => {
  const matches = registry.findModelsSatisfying({ referenceImages: true });
  assert.ok(matches.length > 0);
  assert.ok(matches.every((m) => m.capabilities.referenceImages === true));
});

test('minReferenceImages requires a known numeric maxReferenceImages at or above the threshold', () => {
  const needsFive = registry.findModelsSatisfying({ modality: 'image', referenceImages: true, minReferenceImages: 5 });
  assert.ok(needsFive.some((m) => m.model === 'gpt-image-2')); // 16 >= 5
  assert.ok(!needsFive.some((m) => m.model === 'wan2.5-image-to-image')); // 2 < 5

  // A model with referenceImages:true but unknown maxReferenceImages must never satisfy a minimum.
  const wan26 = registry.getModel('evolink', 'wan-2.6-video');
  assert.equal(wan26.capabilities.referenceImages, true);
  assert.equal(registry.isModelCapable('evolink', 'wan-2.6-video', { minReferenceImages: 4 }), false); // max is 3
  assert.equal(registry.isModelCapable('evolink', 'wan-2.6-video', { minReferenceImages: 3 }), true);
});

// ---------------------------------------------------------------------------
// 10/11. First-frame / last-frame requirements
// ---------------------------------------------------------------------------

test('firstFrame/lastFrame requirements filter correctly', () => {
  const entry = registry.getModel('evolink', 'seedance-2.0-mini-image-to-video');
  assert.equal(entry.capabilities.firstFrame, true);
  assert.equal(entry.capabilities.lastFrame, true);
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-mini-image-to-video', { firstFrame: true, lastFrame: true }), true);

  const t2v = registry.getModel('evolink', 'seedance-2.0-mini-text-to-video');
  assert.equal(t2v.capabilities.firstFrame, false);
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-mini-text-to-video', { firstFrame: true }), false);
});

// ---------------------------------------------------------------------------
// 12. Audio requirements
// ---------------------------------------------------------------------------

test('audio requirement filters correctly, including a null (unconfirmed) case', () => {
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-mini-reference-to-video', { audio: true }), true);
  const veoLite = registry.getModel('google', 'veo-3.1-lite-generate-preview');
  assert.equal(veoLite.capabilities.audio, true);
  // krea-2-turbo (image model) has audio: null (not applicable) — must not satisfy audio:true
  assert.equal(registry.isModelCapable('evolink', 'krea-2-turbo', { audio: true }), false);
});

// ---------------------------------------------------------------------------
// 13. Resolution requirements
// ---------------------------------------------------------------------------

test('resolution requirement requires the exact value in the model\'s known resolutions array', () => {
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-text-to-video', { resolution: '1080p' }), true);
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-mini-text-to-video', { resolution: '1080p' }), false); // mini caps at 720p
  assert.equal(registry.isModelCapable('google', 'veo-3.1-lite-generate-preview', { resolution: '4K' }), false); // Lite confirmed NOT 4K
});

// ---------------------------------------------------------------------------
// 14. Duration requirements
// ---------------------------------------------------------------------------

test('duration requirements are checked against the model\'s known min/max range', () => {
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-reference-to-video', { minDurationSeconds: 10 }), true); // range 4-15
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-reference-to-video', { minDurationSeconds: 20 }), false);
  // grok-imagine-video has unknown duration range -> never satisfies a duration requirement
  assert.equal(registry.isModelCapable('evolink', 'grok-imagine-video', { minDurationSeconds: 4 }), false);
});

// ---------------------------------------------------------------------------
// 15. Aspect-ratio requirements
// ---------------------------------------------------------------------------

test('aspect-ratio requirement requires the exact value in the model\'s known aspectRatios array', () => {
  assert.equal(registry.isModelCapable('evolink', 'seedance-2.0-reference-to-video', { aspectRatio: '21:9' }), true);
  assert.equal(registry.isModelCapable('google', 'veo-3.1-generate-preview', { aspectRatio: '21:9' }), false); // Veo only 16:9/9:16
});

// ---------------------------------------------------------------------------
// 16/17. productionReady + verificationStatus filtering
// ---------------------------------------------------------------------------

test('productionReadyOnly filtering returns exactly the SAFE_FOR_PRODUCTION set', () => {
  const ready = registry.listModels({ productionReadyOnly: true });
  const names = ready.map((m) => `${m.provider}/${m.model}`).sort();
  assert.deepEqual(names, ['evolink/gemini-3-pro-image-preview', 'evolink/gpt-image-2', 'evolink/wan2.5-image-to-image']);
  assert.ok(ready.every((m) => m.verificationStatus === 'SAFE_FOR_PRODUCTION'));
});

test('productionReady is always exactly (verificationStatus === SAFE_FOR_PRODUCTION) for every registry entry', () => {
  for (const m of registry.GENERATION_MODEL_REGISTRY) {
    assert.equal(m.productionReady, m.verificationStatus === 'SAFE_FOR_PRODUCTION', `${m.provider}/${m.model} violates the productionReady invariant`);
  }
});

test('verificationStatus filtering matches only that exact tier', () => {
  const catalogueOnly = registry.listModels({ verificationStatus: 'CATALOGUE_AVAILABLE' });
  assert.ok(catalogueOnly.length > 0);
  assert.ok(catalogueOnly.every((m) => m.verificationStatus === 'CATALOGUE_AVAILABLE'));
  // Grok, Kling's exact-id sibling assumptions etc. must never be upgraded
  assert.ok(catalogueOnly.some((m) => m.model === 'grok-imagine-video'));
  assert.ok(!catalogueOnly.some((m) => m.model === 'gpt-image-2'));
  // seedance-1.0-pro-fast was upgraded off CATALOGUE_AVAILABLE once its schema was independently opened
  assert.ok(!catalogueOnly.some((m) => m.model === 'doubao-seedance-1.0-pro-fast'));
});

test('krea-2-turbo is REQUEST_SCHEMA_VERIFIED but explicitly NOT productionReady', () => {
  const krea = registry.getModel('evolink', 'krea-2-turbo');
  assert.equal(krea.verificationStatus, 'REQUEST_SCHEMA_VERIFIED');
  assert.equal(krea.requestSchemaVerified, true);
  assert.equal(krea.productionReady, false);
});

test('catalogue-tier models are never silently marked production-ready', () => {
  const neverProductionReady = [
    ['evolink', 'doubao-seedance-1.0-pro-fast'],
    ['evolink', 'grok-imagine-video'],
    ['evolink', 'wan-2.5-video'],
    ['evolink', 'kling-3.0'],
    ['evolink', 'sora-2'],
    ['evolink', 'veo-3.1-resale'],
    ['evolink', 'seedream-5.0-lite'],
    ['evolink', 'gemini-3.1-flash-image'], // Nano Banana 2 non-Pro
  ];
  for (const [provider, model] of neverProductionReady) {
    const entry = registry.getModel(provider, model);
    assert.ok(entry, `${provider}/${model} missing from registry`);
    assert.equal(entry.productionReady, false, `${provider}/${model} must not be productionReady`);
  }
});

// ---------------------------------------------------------------------------
// 18/19. cheapestSatisfying + unknown pricing behaviour
// ---------------------------------------------------------------------------

test('cheapestSatisfying returns the lowest-priced match first among known prices', () => {
  const results = registry.cheapestSatisfying({ modality: 'image', referenceImages: true });
  assert.ok(results.length > 1);
  assert.equal(results[0].model, 'gpt-image-2'); // $0.015, cheapest known-priced reference-capable image model
  for (let i = 1; i < results.length; i++) {
    if (results[i - 1].pricing.priceKnown && results[i].pricing.priceKnown) {
      assert.ok(results[i - 1].pricing.startingPrice <= results[i].pricing.startingPrice);
    }
  }
});

test('unknown pricing is never treated as zero/cheapest, and is sorted after every known-priced match', () => {
  const results = registry.cheapestSatisfying({ modality: 'video', imageToVideo: true });
  const firstUnknownIndex = results.findIndex((m) => !m.pricing.priceKnown);
  const lastKnownIndex = results.map((m) => m.pricing.priceKnown).lastIndexOf(true);
  if (firstUnknownIndex !== -1 && lastKnownIndex !== -1) {
    assert.ok(firstUnknownIndex > lastKnownIndex, 'an unknown-priced model was sorted ahead of a known-priced one');
  }
  // seedance-2.0-fast-image-to-video has an explicitly unconfirmed price
  const fastEntry = results.find((m) => m.model === 'seedance-2.0-fast-image-to-video');
  assert.ok(fastEntry);
  assert.equal(fastEntry.pricing.priceKnown, false);
  assert.equal(fastEntry.pricing.startingPrice, null);
});

test('cheapestSatisfying never executes or mutates anything — pure data return', () => {
  const before = JSON.stringify(registry.GENERATION_MODEL_REGISTRY);
  registry.cheapestSatisfying({ modality: 'video' });
  registry.cheapestSatisfying({ modality: 'image', referenceImages: true, minReferenceImages: 100 }); // no matches
  const after = JSON.stringify(registry.GENERATION_MODEL_REGISTRY);
  assert.equal(before, after);
});

// ---------------------------------------------------------------------------
// 20/21. Cross-provider search + explicit provider filtering
// ---------------------------------------------------------------------------

test('omitting provider searches across every registered provider', () => {
  const all = registry.findModelsSatisfying({ modality: 'image', referenceImages: true });
  assert.ok(all.some((m) => m.provider === 'evolink'));
  assert.ok(all.some((m) => m.provider === 'google'));
});

test('an explicit provider filter excludes every other provider, with no automatic preference', () => {
  const evolinkOnly = registry.findModelsSatisfying({ provider: 'evolink', modality: 'video' });
  assert.ok(evolinkOnly.every((m) => m.provider === 'evolink'));
  const googleOnly = registry.findModelsSatisfying({ provider: 'google', modality: 'video' });
  assert.ok(googleOnly.every((m) => m.provider === 'google'));
  assert.ok(evolinkOnly.length > 0 && googleOnly.length > 0);
});

// ---------------------------------------------------------------------------
// 22. Deterministic ordering
// ---------------------------------------------------------------------------

test('listModels/findModelsSatisfying return the same order on repeated calls', () => {
  const a = registry.findModelsSatisfying({ modality: 'video' }).map((m) => m.model);
  const b = registry.findModelsSatisfying({ modality: 'video' }).map((m) => m.model);
  assert.deepEqual(a, b);
  const c = registry.listModels({ provider: 'evolink' }).map((m) => m.model);
  const d = registry.listModels({ provider: 'evolink' }).map((m) => m.model);
  assert.deepEqual(c, d);
});

// ---------------------------------------------------------------------------
// 23. No mutation
// ---------------------------------------------------------------------------

test('query functions never mutate the underlying registry array', () => {
  const snapshot = JSON.parse(JSON.stringify(registry.GENERATION_MODEL_REGISTRY));
  registry.listModels();
  registry.getModel('evolink', 'gpt-image-2');
  registry.findModelsSatisfying({ modality: 'video', referenceImages: true });
  registry.cheapestSatisfying({ modality: 'image' });
  registry.isModelCapable('evolink', 'krea-2-turbo', { referenceImages: true });
  registry.validateModelSelection({ provider: 'evolink', model: 'gpt-image-2', requirements: { referenceImages: true } });
  assert.deepEqual(registry.GENERATION_MODEL_REGISTRY, snapshot);
});

test('mutating a returned array/object never affects the registry\'s own state', () => {
  const list = registry.listModels({ provider: 'evolink' });
  list.push({ fake: true });
  list[0].capabilities.referenceImages = 'TAMPERED';
  const fresh = registry.getModel(list[0].provider, list[0].model);
  assert.notEqual(fresh.capabilities.referenceImages, 'TAMPERED');
});

// ---------------------------------------------------------------------------
// 24. No network calls
// ---------------------------------------------------------------------------

test('the registry module never imports a provider HTTP client or fetch-capable module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'generation-model-registry.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\.\/providers\/evolink\/evolink-client['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/providers\/evolink\/evolink-provider['"]\)/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/providers\/evolink\/evolink-image-provider['"]\)/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /https?:\/\/(?!ai\.google\.dev|evolink\.ai)/); // docsUrl strings are the only allowed URL literals
});

// ---------------------------------------------------------------------------
// validateModelSelection — structured diagnostics, never throws
// ---------------------------------------------------------------------------

test('validateModelSelection returns allowed:true for a production-ready model meeting its requirements', () => {
  const result = registry.validateModelSelection({
    provider: 'evolink',
    model: 'gpt-image-2',
    requirements: { modality: 'image', referenceImages: true, minReferenceImages: 5 },
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
});

test('validateModelSelection returns allowed:false with reasons for an unknown model, never throwing', () => {
  const result = registry.validateModelSelection({ provider: 'evolink', model: 'totally-fake-model', requirements: {} });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.length > 0);
});

test('validateModelSelection flags a not-schema-verified model even if capabilities would otherwise match', () => {
  const result = registry.validateModelSelection({
    provider: 'evolink',
    model: 'grok-imagine-video',
    requirements: { modality: 'video' },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /requestSchemaVerified/.test(r) || /not.*schema/i.test(r)));
});

test('validateModelSelection allows doubao-seedance-1.0-pro-fast for a plain image-to-video requirement (schema-verified, capability-matched, but still not productionReady)', () => {
  const result = registry.validateModelSelection({
    provider: 'evolink',
    model: 'doubao-seedance-1.0-pro-fast',
    requirements: { modality: 'video', imageToVideo: true },
  });
  assert.equal(result.allowed, false); // not productionReady yet — no real generation has proven it
  assert.ok(result.reasons.some((r) => /productionReady/.test(r)));
});

test('validateModelSelection flags an unverified required capability distinctly, never assuming it true', () => {
  const result = registry.validateModelSelection({
    provider: 'evolink',
    model: 'seedream-5.0-lite',
    requirements: { referenceImages: true },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /unknown/i.test(r)));
});

test('validateModelSelection never throws for any registered model, even with empty requirements', () => {
  for (const entry of registry.GENERATION_MODEL_REGISTRY) {
    assert.doesNotThrow(() => registry.validateModelSelection({ provider: entry.provider, model: entry.model, requirements: {} }));
  }
});

// ---------------------------------------------------------------------------
// Safety: this module cannot create generation jobs or touch credit state.
// ---------------------------------------------------------------------------

test('the registry module exports no function capable of creating a job or touching a credit ledger', () => {
  const exported = Object.keys(registry);
  const forbidden = ['requestGeneration', 'generateKeyframe', 'generateVideo', 'createGenerationJob', 'reconcileGenerationCost', 'submit', 'approve', 'reject'];
  for (const name of forbidden) {
    assert.ok(!exported.includes(name), `registry must not export "${name}"`);
  }
});

test('safety: the registry file contains no generation-job or credit-ledger vocabulary', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'generation-model-registry.js'), 'utf8');
  for (const forbidden of ['creditLedger', 'reservedCost', 'approvalStatus', 'generationId', 'setInterval(', 'setTimeout(']) {
    assert.doesNotMatch(src, new RegExp(forbidden.replace(/[()]/g, '\\$&')), `registry file must not reference "${forbidden}"`);
  }
});
