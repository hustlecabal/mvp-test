// Tests for schemas/keyframe-prompt-schema.js — plain object factories
// only, no file I/O, no provider knowledge. Mirrors keyframe-schema.test.js's style.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROMPT_SECTION_KEYS,
  PACKAGE_STATUSES,
  createPromptSections,
  createIdentityLockEntry,
  createWardrobeLockEntry,
  createEnvironmentLockEntry,
  createKeyframePromptPackage,
} = require('../schemas/keyframe-prompt-schema');

// --- 1. Package defaults ------------------------------------------------------

test('1. createKeyframePromptPackage fills in every field with a safe default', () => {
  const pkg = createKeyframePromptPackage();

  assert.ok(pkg.packageId);
  assert.equal(pkg.projectId, null);
  assert.equal(pkg.keyframeId, null);
  assert.equal(pkg.version, 1);
  assert.equal(pkg.sourceShotVersion, null);
  assert.equal(pkg.sourceKeyframePlanVersion, null);
  assert.deepEqual(pkg.characterReferences, []);
  assert.deepEqual(pkg.locationReferences, []);
  assert.deepEqual(pkg.propReferences, []);
  assert.deepEqual(pkg.existingReferenceAssets, []);
  assert.deepEqual(pkg.identityLock, []);
  assert.deepEqual(pkg.wardrobeLock, []);
  assert.deepEqual(pkg.environmentLock, []);
  assert.deepEqual(pkg.continuityRequirements, []);
  assert.deepEqual(pkg.negativeConstraints, []);
  assert.equal(pkg.prompt, null, 'prompt is derived, never invented by the schema');
  assert.equal(pkg.recommendedSkill, null);
  assert.equal(pkg.status, 'CURRENT');
  assert.deepEqual(pkg.warnings, []);
  assert.deepEqual(pkg.history, []);
});

test('createKeyframePromptPackage overrides only the fields given', () => {
  const pkg = createKeyframePromptPackage({ frameType: 'CHARACTER_REFERENCE', keyframeId: 'kf-1' });
  assert.equal(pkg.frameType, 'CHARACTER_REFERENCE');
  assert.equal(pkg.keyframeId, 'kf-1');
  assert.equal(pkg.status, 'CURRENT', 'unrelated defaults must still apply');
});

// --- 2. Prompt sections --------------------------------------------------------

test('2. PROMPT_SECTION_KEYS has all 12 documented sections', () => {
  assert.deepEqual(PROMPT_SECTION_KEYS, [
    'SUBJECT',
    'IDENTITY',
    'WARDROBE',
    'ENVIRONMENT',
    'ACTION',
    'COMPOSITION',
    'CAMERA',
    'LIGHTING',
    'COLOUR',
    'ATMOSPHERE',
    'CONTINUITY',
    'NEGATIVE_CONSTRAINTS',
  ]);
});

test('createPromptSections defaults every section to null (never invented text)', () => {
  const sections = createPromptSections();
  for (const key of PROMPT_SECTION_KEYS) {
    assert.equal(sections[key], null, `${key} must default to null`);
  }
});

// --- lock entry factories -------------------------------------------------------

test('createIdentityLockEntry / createWardrobeLockEntry / createEnvironmentLockEntry default to null/[] without inventing values', () => {
  const identity = createIdentityLockEntry({ characterId: 'char-1' });
  assert.equal(identity.characterId, 'char-1');
  assert.equal(identity.facialCharacteristics, null);

  const wardrobe = createWardrobeLockEntry({ characterId: 'char-1' });
  assert.equal(wardrobe.wardrobe, null);
  assert.equal(wardrobe.wardrobeOverride, null);
  assert.deepEqual(wardrobe.accessories, []);

  const environment = createEnvironmentLockEntry({ locationId: 'loc-1' });
  assert.equal(environment.architecture, null);
  assert.deepEqual(environment.recurringElements, []);
});

// --- 3. Package statuses ---------------------------------------------------------

test('3. PACKAGE_STATUSES is exactly CURRENT/STALE', () => {
  assert.deepEqual(PACKAGE_STATUSES, ['CURRENT', 'STALE']);
});

// --- schema file never imports anything generation/approval related --------------

test('schemas/keyframe-prompt-schema.js has no require() of any provider, generation, or approval module', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'keyframe-prompt-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});
