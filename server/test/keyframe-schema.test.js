// Tests for schemas/keyframe-schema.js — plain object factories only, no
// file I/O, no provider knowledge. Mirrors creative-schema.test.js's style.

const test = require('node:test');
const assert = require('node:assert/strict');
const { FRAME_TYPES, KEYFRAME_STATUSES, createKeyframe, createKeyframePlan } = require('../schemas/keyframe-schema');

// --- 1. Keyframe defaults -----------------------------------------------------

test('1. createKeyframe fills in every field with a safe default', () => {
  const kf = createKeyframe();

  assert.ok(kf.keyframeId);
  assert.equal(kf.projectId, null);
  assert.equal(kf.sceneId, null);
  assert.equal(kf.shotId, null);
  assert.equal(kf.frameType, null);
  assert.equal(kf.status, 'DRAFT');
  assert.deepEqual(kf.characterReferences, []);
  assert.deepEqual(kf.locationReferences, []);
  assert.deepEqual(kf.propReferences, []);
  assert.deepEqual(kf.referenceAssets, []);
  assert.deepEqual(kf.continuityRequirements, []);
  assert.equal(kf.promptDraft, null, 'promptDraft is derived, never invented by the schema');
  assert.equal(kf.sourceShotVersion, null);
  assert.equal(kf.recommendedSkill, null);
  assert.equal(kf.recommendationReason, null);
});

test('createKeyframe overrides only the fields given, without wiping others to undefined', () => {
  const kf = createKeyframe({ frameType: 'CHARACTER_REFERENCE', shotId: 'shot-1', subject: 'Mira' });
  assert.equal(kf.frameType, 'CHARACTER_REFERENCE');
  assert.equal(kf.shotId, 'shot-1');
  assert.equal(kf.subject, 'Mira');
  assert.equal(kf.status, 'DRAFT', 'unrelated defaults must still apply');
});

test('createKeyframe never lets an explicit undefined override a default', () => {
  const kf = createKeyframe({ status: undefined });
  assert.equal(kf.status, 'DRAFT');
});

// --- 2. Frame type vocabulary --------------------------------------------------

test('2. FRAME_TYPES is a fixed, non-empty vocabulary including every documented frame type', () => {
  assert.ok(Array.isArray(FRAME_TYPES));
  for (const type of [
    'CHARACTER_REFERENCE',
    'WORLD_REFERENCE',
    'ESTABLISHING_FRAME',
    'COMPOSITION_FRAME',
    'ACTION_FRAME',
    'FIRST_FRAME',
    'LAST_FRAME',
    'TRANSITION_FRAME',
    'DETAIL_FRAME',
  ]) {
    assert.ok(FRAME_TYPES.includes(type), `FRAME_TYPES must include ${type}`);
  }
});

// --- 3. Keyframe planning statuses ---------------------------------------------

test('3. KEYFRAME_STATUSES is separate from the production state machine and creative shot statuses', () => {
  assert.deepEqual(KEYFRAME_STATUSES, ['DRAFT', 'PLANNED', 'READY_FOR_GENERATION', 'GENERATED', 'APPROVED', 'REJECTED']);
});

// --- 4. Keyframe Plan defaults --------------------------------------------------

test('4. createKeyframePlan fills in versioning defaults and an empty keyframes array', () => {
  const plan = createKeyframePlan({ projectId: 'p1' });
  assert.equal(plan.projectId, 'p1');
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.history, []);
  assert.deepEqual(plan.keyframes, []);
  assert.equal(plan.changeNote, null);
});

// --- schema file never imports anything generation/approval related ------------

test('schemas/keyframe-schema.js has no require() of any provider, generation, or approval module', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'keyframe-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});
