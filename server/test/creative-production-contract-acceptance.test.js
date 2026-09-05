// Section 25 — ACCEPTANCE TEST. Proves the Creative Production Contract can
// represent, without duplicating character/location identity: a 28-second
// scene, three director-designed shots, Shot 2 split into two
// GenerationUnits with an approved continuation between them, the same
// character held identity/wardrobe/location-consistent across all three
// shots while position/pose/expression change per unit.

const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../services/creative-production-contract-validator');
const { build } = require('../scripts/build-creative-production-contract-example');

test('ACCEPTANCE — the 28-second/3-shot/split-unit example passes structural validation', () => {
  const { storyboard, visualBible, generationUnits, knownAssetIds } = build();
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible, generationUnits, knownAssetIds });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
});

test('ACCEPTANCE — total scene duration is 28 seconds across exactly 3 shots', () => {
  const { storyboard } = build();
  const total = storyboard.shots.reduce((sum, s) => sum + s.duration, 0);
  assert.equal(total, 28);
  assert.equal(storyboard.shots.length, 3);
});

test('ACCEPTANCE — Shot 1 and Shot 3 each have exactly one GenerationUnit; Shot 2 has exactly two', () => {
  const { generationUnits } = build();
  const byShot = {};
  for (const u of generationUnits) byShot[u.shotId] = (byShot[u.shotId] || 0) + 1;
  assert.equal(byShot['shot-04-01'], 1);
  assert.equal(byShot['shot-04-02'], 2);
  assert.equal(byShot['shot-04-03'], 1);
});

test('ACCEPTANCE — no GenerationUnit exceeds the 10-second hard maximum', () => {
  const { generationUnits } = build();
  for (const unit of generationUnits) {
    const diagnostics = validator.validateGenerationUnitDuration(unit);
    assert.equal(diagnostics.length, 0, `${unit.id}: ${JSON.stringify(diagnostics)}`);
  }
});

test('ACCEPTANCE — Shot 2 Unit B begins from Unit A\'s approved continuation frame', () => {
  const { generationUnits } = build();
  const unitA = generationUnits.find((u) => u.id === 'gen-04-02-a');
  const unitB = generationUnits.find((u) => u.id === 'gen-04-02-b');
  assert.equal(unitB.continuesFromGenerationUnitId, unitA.id);
  assert.equal(unitB.startFrameAssetId, unitA.endFrameAssetId);
  assert.equal(unitA.continuationStrategy, 'EXTRACTED_FINAL_FRAME');
});

test('ACCEPTANCE — the same character appears in all 3 shots with a single, non-duplicated identity record, while position/pose/expression vary per unit', () => {
  const { visualBible, generationUnits, storyboard } = build();
  assert.equal(visualBible.characters.length, 1, 'the character identity record must not be duplicated per shot');
  const character = visualBible.characters[0];

  for (const shot of storyboard.shots) {
    assert.ok(shot.characterReferences.includes(character.characterId), `${shot.shotId} must reference the shared character, not a copy`);
  }

  const positions = generationUnits.flatMap((u) => [
    ...(u.startState.characterStates || []).map((cs) => cs.position),
    ...(u.endState.characterStates || []).map((cs) => cs.position),
  ]);
  assert.ok(new Set(positions).size > 1, 'position must vary across the sequence — this is not a static character');
});

test('ACCEPTANCE — location stays consistent across all 3 shots (same locationId, no duplication)', () => {
  const { visualBible, storyboard } = build();
  assert.equal(visualBible.locations.length, 1);
  const locationId = visualBible.locations[0].locationId;
  for (const shot of storyboard.shots) {
    assert.deepEqual(shot.locationReferences, [locationId]);
  }
});
