// Tests for services/image-generation-executor.js — the Stage 13B, Part
// 8/9 execution boundary. Confirms it deterministically converts a
// KeyframePromptPackage into the canonical normalized image request, and
// never touches a skill, provider, or network itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildNormalizedImageRequest, FakeImageGenerationExecutor } = require('../services/image-generation-executor');

function fixturePackage(overrides = {}) {
  return {
    projectId: 'proj-1',
    keyframeId: 'kf-1',
    packageId: 'pkg-1',
    version: 3,
    prompt: 'SUBJECT:\nMira',
    promptSections: { SUBJECT: 'Mira', IDENTITY: null },
    existingReferenceAssets: [{ assetId: 'asset-1', role: 'character:Mira' }, { assetId: 'asset-2', role: 'location:Lighthouse' }],
    recommendedSkill: 'banana-pro-director-2.0',
    ...overrides,
  };
}

// --- 3. normalized image request ----------------------------------------------------

test('3. buildNormalizedImageRequest produces exactly the canonical shape', () => {
  const request = buildNormalizedImageRequest(fixturePackage());
  assert.deepEqual(Object.keys(request).sort(), [
    'keyframeId',
    'parameters',
    'projectId',
    'prompt',
    'promptPackageId',
    'promptPackageVersion',
    'promptSections',
    'recommendedSkill',
    'referenceAssets',
    'referenceDetails',
  ].sort());
});

test('normalized request fields map exactly onto the source package', () => {
  const pkg = fixturePackage();
  const request = buildNormalizedImageRequest(pkg);
  assert.equal(request.projectId, pkg.projectId);
  assert.equal(request.keyframeId, pkg.keyframeId);
  assert.equal(request.promptPackageId, pkg.packageId);
  assert.equal(request.promptPackageVersion, pkg.version);
  assert.equal(request.prompt, pkg.prompt);
  assert.deepEqual(request.promptSections, pkg.promptSections);
  assert.deepEqual(request.referenceAssets, ['asset-1', 'asset-2']);
  assert.equal(request.recommendedSkill, pkg.recommendedSkill);
  assert.deepEqual(request.parameters, {});
});

// --- Stage 16, Part 2 — additive referenceDetails (role/type preservation) -----------

test('Stage 16: referenceDetails carries assetId/roleType/role for every reference, alongside the unchanged referenceAssets array', () => {
  const pkg = fixturePackage({
    existingReferenceAssets: [
      { assetId: 'asset-1', role: 'character:Mira', roleType: 'CHARACTER' },
      { assetId: 'asset-2', role: 'location:Lighthouse', roleType: 'ENVIRONMENT' },
    ],
  });
  const request = buildNormalizedImageRequest(pkg);
  assert.deepEqual(request.referenceAssets, ['asset-1', 'asset-2']);
  assert.deepEqual(request.referenceDetails, [
    { assetId: 'asset-1', roleType: 'CHARACTER', role: 'character:Mira', canonical: false },
    { assetId: 'asset-2', roleType: 'ENVIRONMENT', role: 'location:Lighthouse', canonical: false },
  ]);
});

test('Stage 19: referenceDetails carries the canonical flag through from the source package', () => {
  const pkg = fixturePackage({
    existingReferenceAssets: [
      { assetId: 'asset-1', role: 'character:Mira', roleType: 'CHARACTER', canonical: true },
      { assetId: 'asset-2', role: 'location:Lighthouse', roleType: 'ENVIRONMENT', canonical: false },
    ],
  });
  const request = buildNormalizedImageRequest(pkg);
  assert.deepEqual(
    request.referenceDetails.map((r) => r.canonical),
    [true, false]
  );
});

test('Stage 16: empty references produce empty referenceAssets and referenceDetails arrays, not null', () => {
  const pkg = fixturePackage({ existingReferenceAssets: [] });
  const request = buildNormalizedImageRequest(pkg);
  assert.deepEqual(request.referenceAssets, []);
  assert.deepEqual(request.referenceDetails, []);
});

test('Stage 16: a package built before this extension (entries missing roleType) defaults to OTHER, never throws', () => {
  // fixturePackage()'s default existingReferenceAssets entries have no
  // roleType field at all -- exactly what a pre-Stage-16 persisted package
  // looks like on disk.
  const pkg = fixturePackage();
  assert.equal(pkg.existingReferenceAssets.every((r) => r.roleType === undefined), true);

  const request = buildNormalizedImageRequest(pkg);
  assert.deepEqual(
    request.referenceDetails.map((r) => r.roleType),
    ['OTHER', 'OTHER']
  );
  // and the original, pre-existing referenceAssets array is completely unaffected
  assert.deepEqual(request.referenceAssets, ['asset-1', 'asset-2']);
});

test('never leaks an EvoLink-specific field name into the normalized request', () => {
  const request = buildNormalizedImageRequest(fixturePackage());
  for (const key of Object.keys(request)) {
    assert.doesNotMatch(key, /evolink/i);
  }
});

test('buildNormalizedImageRequest requires a package', () => {
  assert.throws(() => buildNormalizedImageRequest(null), /requires a KeyframePromptPackage/);
});

// --- FakeImageGenerationExecutor: the execution boundary -----------------------------

test('FakeImageGenerationExecutor.buildRequest wraps buildNormalizedImageRequest identically', () => {
  const pkg = fixturePackage();
  assert.deepEqual(FakeImageGenerationExecutor.buildRequest(pkg), buildNormalizedImageRequest(pkg));
});

test('image-generation-executor.js never imports or calls a skill/provider/network module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'image-generation-executor.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, [], 'this file must have zero requires — it is a pure function module');
  assert.doesNotMatch(text, /\bfetch\(/);
});
