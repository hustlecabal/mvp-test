// Tests for schemas/creative-schema.js — pure object factories, no file
// I/O, no network. Confirms sensible defaults (null/[] — never invented
// content) for every Stage 11A creative-planning artifact.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/creative-schema');

test('createCreativeBrief defaults every unsupplied field to null/[] — nothing invented', () => {
  const brief = schema.createCreativeBrief({ projectId: 'proj-1' });

  assert.ok(brief.id);
  assert.equal(brief.projectId, 'proj-1');
  assert.equal(brief.title, null);
  assert.equal(brief.concept, null);
  assert.equal(brief.premise, null);
  assert.equal(brief.objective, null);
  assert.equal(brief.audience, null);
  assert.equal(brief.tone, null);
  assert.equal(brief.genre, null);
  assert.equal(brief.format, null);
  assert.equal(brief.targetDuration, null);
  assert.equal(brief.visualDirection, null);
  assert.equal(brief.narrativeApproach, null);
  assert.equal(brief.keyMessage, null);
  assert.deepEqual(brief.constraints, []);
  assert.deepEqual(brief.references, []);
  assert.equal(brief.creativeNotes, null);
  assert.equal(brief.version, 1);
  assert.deepEqual(brief.history, []);
});

test('createMasterCreativeSpec is a structured object, not a text blob', () => {
  const spec = schema.createMasterCreativeSpec({ projectId: 'proj-1' });

  for (const field of [
    'coreConcept',
    'storyLogic',
    'tone',
    'pacing',
    'visualLanguage',
    'cinematography',
    'lighting',
    'colourLanguage',
    'environmentRules',
    'characterRules',
    'wardrobeRules',
    'cameraRules',
    'motionRules',
    'compositionRules',
    'continuityRules',
    'referenceStrategy',
    'masterPrompt',
  ]) {
    assert.equal(spec[field], null, `${field} should default to null`);
  }
  assert.deepEqual(spec.negativeConstraints, []);
  assert.equal(spec.version, 1);
});

test('createCharacter captures a stable identity record with sensible defaults', () => {
  const character = schema.createCharacter({ name: 'Aria' });

  assert.ok(character.characterId);
  assert.equal(character.name, 'Aria');
  assert.equal(character.role, null);
  assert.equal(character.description, null);
  assert.equal(character.facialCharacteristics, null);
  assert.equal(character.bodyCharacteristics, null);
  assert.equal(character.hair, null);
  assert.equal(character.skinDescription, null);
  assert.equal(character.wardrobe, null);
  assert.deepEqual(character.accessories, []);
  assert.deepEqual(character.recurringProps, []);
  assert.equal(character.behaviour, null);
  assert.equal(character.identityConstraints, null);
  assert.equal(character.continuityNotes, null);
  assert.deepEqual(character.referenceAssets, []);
});

test('createLocation captures a reusable world/location record', () => {
  const location = schema.createLocation({ name: 'The Lighthouse' });

  assert.ok(location.locationId);
  assert.equal(location.name, 'The Lighthouse');
  assert.equal(location.description, null);
  assert.equal(location.architecture, null);
  assert.equal(location.geography, null);
  assert.equal(location.materials, null);
  assert.equal(location.colourPalette, null);
  assert.equal(location.lighting, null);
  assert.equal(location.atmosphere, null);
  assert.deepEqual(location.recurringElements, []);
  assert.equal(location.continuityConstraints, null);
  assert.deepEqual(location.referenceAssets, []);
});

test('createProp captures a small recurring-object record', () => {
  const prop = schema.createProp({ name: 'Pocket watch' });
  assert.ok(prop.propId);
  assert.equal(prop.name, 'Pocket watch');
  assert.equal(prop.description, null);
  assert.deepEqual(prop.referenceAssets, []);
});

test('createVisualBible has all 13 requested sections, structured rather than one paragraph', () => {
  const bible = schema.createVisualBible({ projectId: 'proj-1' });

  assert.deepEqual(bible.characters, []);
  assert.deepEqual(bible.props, []);
  assert.deepEqual(bible.locations, []);
  for (const field of [
    'world',
    'wardrobe',
    'architecture',
    'lighting',
    'colour',
    'camera',
    'composition',
    'textureMaterials',
    'atmosphere',
    'continuityRules',
  ]) {
    assert.equal(bible[field], null, `${field} should default to null`);
  }
  assert.equal(bible.version, 1);
});

test('createStoryboard starts empty, with scenes/shots as flat arrays', () => {
  const storyboard = schema.createStoryboard({ projectId: 'proj-1' });
  assert.deepEqual(storyboard.scenes, []);
  assert.deepEqual(storyboard.shots, []);
  assert.equal(storyboard.version, 1);
});

test('createStoryboardShot defaults to DRAFT status and empty reference arrays', () => {
  const shot = schema.createStoryboardShot({ sceneId: 'scene-1' });

  assert.equal(shot.status, 'DRAFT');
  assert.equal(shot.sceneId, 'scene-1');
  assert.equal(shot.promptDraft, null, 'promptDraft must not be invented — structured fields are the source of truth');
  assert.deepEqual(shot.continuityRequirements, []);
  assert.deepEqual(shot.characterReferences, []);
  assert.deepEqual(shot.locationReferences, []);
  assert.deepEqual(shot.propReferences, []);
  assert.deepEqual(shot.referenceAssets, []);
});

test('SHOT_PLANNING_STATUSES is the Part 7 enum, separate from the project state machine', () => {
  assert.deepEqual(schema.SHOT_PLANNING_STATUSES, [
    'DRAFT',
    'PLANNED',
    'READY_FOR_KEYFRAME',
    'KEYFRAME_APPROVED',
    'READY_FOR_VIDEO',
    'GENERATED',
  ]);

  const stateMachine = require('../schemas/state-machine');
  for (const status of schema.SHOT_PLANNING_STATUSES) {
    assert.equal(stateMachine.STATES.includes(status), false, `${status} must not collide with a project state machine state`);
  }
});
