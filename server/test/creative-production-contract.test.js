// Tests for the Creative Production Contract milestone: the additive
// schemas/creative-schema.js extensions (Sequence, NarrativeBeat,
// GenerationUnit, Frame State Contract, Character/Location/Prop
// stateTimeline) plus services/creative-production-contract-validator.js's
// structural validation. Pure object factories + pure functions — no file
// I/O, no network, matching this codebase's established test conventions
// (see test/creative-schema.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/creative-schema');
const validator = require('../services/creative-production-contract-validator');

function makeVisualBible({ characterId, locationId, propId }) {
  return schema.createVisualBible({
    characters: [schema.createCharacter({ characterId, name: 'Marcus' })],
    locations: [schema.createLocation({ locationId, name: 'Warehouse' })],
    props: [schema.createProp({ propId, name: 'Phone' })],
  });
}

function makeScene({ sceneId, locationId, characterIds, propIds }) {
  return schema.createStoryboardScene({ sceneId, locationId, characterIds, propIds });
}

// --------------------------------------------------------------------- VALID

test('VALID 1 — a normal short shot with a single GenerationUnit passes structural validation', () => {
  const characterId = 'char-1';
  const locationId = 'loc-1';
  const scene = makeScene({ sceneId: 'scene-1', locationId, characterIds: [characterId], propIds: [] });
  const shot = schema.createStoryboardShot({ sceneId: scene.sceneId, duration: 6, characterReferences: [characterId], locationReferences: [locationId], generationUnitIds: ['gen-1'] });
  const unit = schema.createGenerationUnit({ id: 'gen-1', shotId: shot.shotId, order: 1, durationSeconds: 6, generationMethod: 'IMAGE_TO_VIDEO' });

  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot] });
  const visualBible = makeVisualBible({ characterId, locationId, propId: 'prop-1' });

  const result = validator.validateCreativeProductionContract({ storyboard, visualBible, generationUnits: [unit] });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test('VALID 2 — a 10-second shot split into two valid 5-second GenerationUnits passes', () => {
  const scene = makeScene({ sceneId: 'scene-1', locationId: null, characterIds: [], propIds: [] });
  const shot = schema.createStoryboardShot({ sceneId: scene.sceneId, duration: 10, generationUnitIds: ['a', 'b'] });
  const unitA = schema.createGenerationUnit({ id: 'a', shotId: shot.shotId, order: 1, durationSeconds: 5 });
  const unitB = schema.createGenerationUnit({ id: 'b', shotId: shot.shotId, order: 2, durationSeconds: 5, continuesFromGenerationUnitId: 'a' });

  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot] });
  const visualBible = schema.createVisualBible();

  const result = validator.validateCreativeProductionContract({ storyboard, visualBible, generationUnits: [unitA, unitB] });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test('VALID 3 — sequential frame continuity: Unit B start frame equals Unit A end frame', () => {
  const scene = makeScene({ sceneId: 'scene-1', locationId: null, characterIds: [], propIds: [] });
  const shot = schema.createStoryboardShot({ sceneId: scene.sceneId, generationUnitIds: ['a', 'b'] });
  const unitA = schema.createGenerationUnit({ id: 'a', shotId: shot.shotId, order: 1, durationSeconds: 8, endFrameAssetId: 'asset-frame-1' });
  const unitB = schema.createGenerationUnit({ id: 'b', shotId: shot.shotId, order: 2, durationSeconds: 7, continuesFromGenerationUnitId: 'a', startFrameAssetId: 'asset-frame-1' });

  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot] });
  const result = validator.validateCreativeProductionContract({
    storyboard,
    visualBible: schema.createVisualBible(),
    generationUnits: [unitA, unitB],
    knownAssetIds: new Set(['asset-frame-1']),
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test('VALID 4 — persistent character identity with changing state (fold-forward, no silent reset)', () => {
  const character = schema.createCharacter({
    characterId: 'marcus',
    name: 'Marcus',
    wardrobe: 'outfit_01',
    stateTimeline: [
      { sceneId: 'scene-01', state: schema.createCharacterState({ wardrobeId: 'outfit_01', physicalState: 'uninjured' }) },
      { sceneId: 'scene-07', state: schema.createCharacterState({ physicalState: 'bruised cheek' }) }, // wardrobe unset here — must NOT reset
      { sceneId: 'scene-09', state: schema.createCharacterState({ wardrobeId: 'outfit_02', physicalState: 'bruised cheek, torn sleeve' }) },
    ],
  });
  // identity itself never changes:
  assert.equal(character.name, 'Marcus');

  const sceneOrder = { 'scene-01': 1, 'scene-07': 7, 'scene-09': 9 };

  const atScene7 = validator.resolveStateAtScene(character.stateTimeline, 'scene-07', sceneOrder);
  assert.equal(atScene7.wardrobeId, 'outfit_01', 'wardrobe must carry forward from scene 1, never reset just because scene 7 did not restate it');
  assert.equal(atScene7.physicalState, 'bruised cheek');

  const atScene9 = validator.resolveStateAtScene(character.stateTimeline, 'scene-09', sceneOrder);
  assert.equal(atScene9.wardrobeId, 'outfit_02');
  assert.equal(atScene9.physicalState, 'bruised cheek, torn sleeve');
});

test('VALID 5 — location state change (time of day / weather) folds forward correctly', () => {
  const location = schema.createLocation({
    locationId: 'warehouse-001',
    name: 'Warehouse 001',
    stateTimeline: [
      { sceneId: 'scene-02', state: schema.createLocationState({ timeOfDay: 'day', weather: 'dry', lightingState: 'lights off' }) },
      { sceneId: 'scene-08', state: schema.createLocationState({ timeOfDay: 'night', weather: 'rain outside', lightingState: 'lights on' }) },
    ],
  });
  const sceneOrder = { 'scene-02': 2, 'scene-08': 8 };
  const atScene2 = validator.resolveStateAtScene(location.stateTimeline, 'scene-02', sceneOrder);
  assert.equal(atScene2.timeOfDay, 'day');
  const atScene8 = validator.resolveStateAtScene(location.stateTimeline, 'scene-08', sceneOrder);
  assert.equal(atScene8.timeOfDay, 'night');
  assert.equal(atScene8.weather, 'rain outside');
});

test('VALID 6 — prop state change (holder/position) folds forward correctly', () => {
  const prop = schema.createProp({
    propId: 'phone-001',
    name: 'Phone 001',
    stateTimeline: [
      { sceneId: 'scene-03', state: schema.createPropState({ holderCharacterId: 'marcus', position: 'in hand' }) },
      { sceneId: 'scene-04', state: schema.createPropState({ holderCharacterId: null, position: 'on desk' }) },
      { sceneId: 'scene-05', state: schema.createPropState({ holderCharacterId: 'lena' }) },
    ],
  });
  const sceneOrder = { 'scene-03': 3, 'scene-04': 4, 'scene-05': 5 };
  const atScene5 = validator.resolveStateAtScene(prop.stateTimeline, 'scene-05', sceneOrder);
  assert.equal(atScene5.holderCharacterId, 'lena');
  assert.equal(atScene5.position, 'on desk', 'position was not restated in scene 5 and must carry forward from scene 4, never reset');
});

// -------------------------------------------------------------------- INVALID

test('INVALID 1 — a GenerationUnit over 10 seconds is rejected', () => {
  const unit = schema.createGenerationUnit({ id: 'g1', shotId: 's1', order: 1, durationSeconds: 12 });
  const diagnostics = validator.validateGenerationUnitDuration(unit);
  assert.ok(diagnostics.some((d) => d.code === 'GENERATION_UNIT_DURATION_EXCEEDS_MAXIMUM'));
});

test('INVALID 2 — a dangling character ID (scene references a character absent from the Visual Bible) is rejected', () => {
  const scene = makeScene({ sceneId: 'scene-1', locationId: null, characterIds: ['ghost-character'], propIds: [] });
  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [] });
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible: schema.createVisualBible() });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'DANGLING_CHARACTER_REFERENCE'));
});

test('INVALID 3 — a dangling frame asset (GenerationUnit references a frame asset that does not exist) is rejected', () => {
  const scene = makeScene({ sceneId: 'scene-1', locationId: null, characterIds: [], propIds: [] });
  const shot = schema.createStoryboardShot({ sceneId: scene.sceneId, generationUnitIds: ['g1'] });
  const unit = schema.createGenerationUnit({ id: 'g1', shotId: shot.shotId, order: 1, startFrameAssetId: 'does-not-exist' });
  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot] });
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible: schema.createVisualBible(), generationUnits: [unit], knownAssetIds: new Set() });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'DANGLING_START_FRAME_ASSET'));
});

test('INVALID 4 — a character introduced in a shot but absent from its parent scene is rejected', () => {
  const scene = makeScene({ sceneId: 'scene-1', locationId: null, characterIds: ['declared-character'], propIds: [] });
  const shot = schema.createStoryboardShot({ sceneId: scene.sceneId, characterReferences: ['undeclared-character'] });
  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot] });
  const visualBible = schema.createVisualBible({ characters: [schema.createCharacter({ characterId: 'declared-character' }), schema.createCharacter({ characterId: 'undeclared-character' })] });
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'SHOT_CHARACTER_NOT_IN_SCENE'));
});

test('INVALID 5 — invalid unit ordering (two GenerationUnits in the same shot share order 1) is rejected', () => {
  const shot = schema.createStoryboardShot({ sceneId: 'scene-1', generationUnitIds: ['a', 'b'] });
  const unitA = schema.createGenerationUnit({ id: 'a', shotId: shot.shotId, order: 1, durationSeconds: 5 });
  const unitB = schema.createGenerationUnit({ id: 'b', shotId: shot.shotId, order: 1, durationSeconds: 5 });
  const storyboard = schema.createStoryboard({ scenes: [schema.createStoryboardScene({ sceneId: 'scene-1' })], shots: [shot] });
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB] });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'INVALID_GENERATION_UNIT_ORDERING'));
});

test('INVALID 6 — a broken parent relationship (GenerationUnit not listed in its shot\'s generationUnitIds) is rejected', () => {
  const shot = schema.createStoryboardShot({ sceneId: 'scene-1', generationUnitIds: [] }); // does not list the unit below
  const unit = schema.createGenerationUnit({ id: 'orphan', shotId: shot.shotId, order: 1 });
  const storyboard = schema.createStoryboard({ scenes: [schema.createStoryboardScene({ sceneId: 'scene-1' })], shots: [shot] });
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible: schema.createVisualBible(), generationUnits: [unit] });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'GENERATION_UNIT_WRONG_PARENT_SHOT'));
});

test('INVALID 7 — impossible generation ordering (Unit B claims to continue from a later-ordered Unit A) is rejected', () => {
  const shot = schema.createStoryboardShot({ sceneId: 'scene-1', generationUnitIds: ['a', 'b'] });
  const unitA = schema.createGenerationUnit({ id: 'a', shotId: shot.shotId, order: 2, durationSeconds: 5 });
  const unitB = schema.createGenerationUnit({ id: 'b', shotId: shot.shotId, order: 1, durationSeconds: 5, continuesFromGenerationUnitId: 'a' });
  const storyboard = schema.createStoryboard({ scenes: [schema.createStoryboardScene({ sceneId: 'scene-1' })], shots: [shot] });
  const result = validator.validateCreativeProductionContract({ storyboard, visualBible: schema.createVisualBible(), generationUnits: [unitA, unitB] });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'IMPOSSIBLE_GENERATION_ORDERING'));
});

test('INVALID (bonus) — incompatible sequential frame continuity (declared predecessor end frame != successor start frame) is rejected', () => {
  const shot = schema.createStoryboardShot({ sceneId: 'scene-1', generationUnitIds: ['a', 'b'] });
  const unitA = schema.createGenerationUnit({ id: 'a', shotId: shot.shotId, order: 1, endFrameAssetId: 'frame-A' });
  const unitB = schema.createGenerationUnit({ id: 'b', shotId: shot.shotId, order: 2, continuesFromGenerationUnitId: 'a', startFrameAssetId: 'frame-DIFFERENT' });
  const storyboard = schema.createStoryboard({ scenes: [schema.createStoryboardScene({ sceneId: 'scene-1' })], shots: [shot] });
  const result = validator.validateCreativeProductionContract({
    storyboard,
    visualBible: schema.createVisualBible(),
    generationUnits: [unitA, unitB],
    knownAssetIds: new Set(['frame-A', 'frame-DIFFERENT']),
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'INCOMPATIBLE_SEQUENTIAL_FRAME_CONTINUITY'));
});

// ------------------------------------------------------------- CONTINUITY GRAPH

test('deriveContinuityGraph reports every scene/shot that references a given character', () => {
  const scene = makeScene({ sceneId: 'scene-1', locationId: null, characterIds: ['mara'], propIds: [] });
  const shot = schema.createStoryboardShot({ sceneId: scene.sceneId, characterReferences: ['mara'] });
  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot] });
  const affected = validator.findDownstreamOfCharacterChange('mara', { storyboard, generationUnits: [] });
  assert.ok(affected.some((a) => a.type === 'StoryboardScene' && a.id === 'scene-1'));
  assert.ok(affected.some((a) => a.type === 'StoryboardShot' && a.id === shot.shotId));
});
