// Tests for schemas/keyframe-handoff-schema.js — Stage 13D, Part 1's
// EXECUTION HANDOFF record. Pure factory, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');
const { HANDOFF_STATUSES, createKeyframeHandoff } = require('../schemas/keyframe-handoff-schema');

// --- 1. schema defaults --------------------------------------------------------------

test('1. createKeyframeHandoff fills in every field with a safe default', () => {
  const handoff = createKeyframeHandoff();
  assert.ok(handoff.handoffId);
  assert.equal(handoff.projectId, null);
  assert.equal(handoff.keyframeId, null);
  assert.equal(handoff.shotId, null);
  assert.equal(handoff.sceneId, null);
  assert.equal(handoff.promptPackageId, null);
  assert.equal(handoff.promptPackageVersion, null);
  assert.equal(handoff.skillId, null);
  assert.equal(handoff.skillName, null);
  assert.equal(handoff.status, 'READY');
  assert.ok(handoff.createdAt);
  assert.equal(handoff.createdBy, null);
  assert.equal(handoff.instructions, null);
  assert.deepEqual(handoff.requiredReferences, []);
  assert.deepEqual(handoff.optionalReferences, []);
  assert.equal(handoff.outputRequirements, null);
  assert.equal(handoff.returnInstructions, null);
  assert.equal(handoff.completedAt, null);
  assert.equal(handoff.completedBy, null);
  assert.equal(handoff.assetId, null);
  assert.equal(handoff.notes, null);
  assert.equal(handoff.version, 1);
  assert.ok(handoff.updatedAt);
  assert.equal(handoff.updatedBy, null);
  assert.equal(handoff.changeNote, null);
  assert.deepEqual(handoff.history, []);
});

test('createKeyframeHandoff overrides only the fields given', () => {
  const handoff = createKeyframeHandoff({ status: 'INGESTED', assetId: 'x' });
  assert.equal(handoff.status, 'INGESTED');
  assert.equal(handoff.assetId, 'x');
  assert.equal(handoff.skillId, null, 'unrelated defaults must still apply');
});

// --- statuses --------------------------------------------------------------------------

test('HANDOFF_STATUSES is exactly READY/IN_PROGRESS/INGESTED/CANCELLED — no RETURNED', () => {
  assert.deepEqual(HANDOFF_STATUSES, ['READY', 'IN_PROGRESS', 'INGESTED', 'CANCELLED']);
});

// --- safety: no import of a provider/generation module ---------------------------------

test('schemas/keyframe-handoff-schema.js has no require() of any provider, generation, or approval-gate module', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'keyframe-handoff-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});
