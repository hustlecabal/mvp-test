#!/usr/bin/env node
// build-creative-production-contract-example.js
//
// Section 22/25 — builds the milestone's own ACCEPTANCE TEST example: one
// scene, 28 seconds, three director-designed shots, the same character
// across all three (identity/wardrobe/location held constant, position/
// pose/expression changing), Shot 2 split into two GenerationUnits with
// an approved continuation between them. Structural test only — no
// image/video generation, no FFmpeg, no network. See test/creative-
// production-contract-acceptance.test.js for the automated assertions;
// this script exists to print the result readably for the final report.

const schema = require('../schemas/creative-schema');
const validator = require('../services/creative-production-contract-validator');

function build() {
  const character = schema.createCharacter({
    characterId: 'char-mara',
    name: 'Mara',
    identityConstraints: 'short black hair, grey wool sweater — never changes across this example',
    wardrobe: 'grey wool sweater',
  });

  const location = schema.createLocation({ locationId: 'loc-kitchen', name: "Mara's kitchen" });

  const scene = schema.createStoryboardScene({
    sceneId: 'scene-04',
    title: 'Morning coffee',
    order: 4,
    locationId: location.locationId,
    characterIds: [character.characterId],
    propIds: [],
  });

  // SHOT 04.01 — 6s, one GenerationUnit.
  const shot1 = schema.createStoryboardShot({
    shotId: 'shot-04-01',
    sceneId: scene.sceneId,
    order: 1,
    duration: 6,
    purpose: 'Establish Mara entering the kitchen.',
    characterReferences: [character.characterId],
    locationReferences: [location.locationId],
    generationUnitIds: ['gen-04-01-a'],
  });
  const gen0401A = schema.createGenerationUnit({
    id: 'gen-04-01-a',
    shotId: shot1.shotId,
    order: 1,
    durationSeconds: 6,
    generationMethod: 'IMAGE_TO_VIDEO',
    continuationStrategy: 'STATE_ONLY',
    startState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'doorway', pose: 'walking in', facialExpression: 'neutral' })] }),
    endState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'at counter', pose: 'reaching for mug', facialExpression: 'neutral' })] }),
  });

  // SHOT 04.02 — 15s, split into two GenerationUnits (8s + 7s), B
  // continuing from A's approved end frame.
  const shot2 = schema.createStoryboardShot({
    shotId: 'shot-04-02',
    sceneId: scene.sceneId,
    order: 2,
    duration: 15,
    purpose: 'Mara pours coffee and looks out the window.',
    characterReferences: [character.characterId],
    locationReferences: [location.locationId],
    generationUnitIds: ['gen-04-02-a', 'gen-04-02-b'],
  });
  const gen0402A = schema.createGenerationUnit({
    id: 'gen-04-02-a',
    shotId: shot2.shotId,
    order: 1,
    durationSeconds: 8,
    generationMethod: 'IMAGE_TO_VIDEO',
    continuationStrategy: 'EXTRACTED_FINAL_FRAME',
    startState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'at counter', pose: 'pouring coffee', facialExpression: 'focused' })] }),
    endFrameAssetId: 'asset-frame-0402a-final',
    endState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'at counter', pose: 'mug in both hands', facialExpression: 'calm' })] }),
  });
  const gen0402B = schema.createGenerationUnit({
    id: 'gen-04-02-b',
    shotId: shot2.shotId,
    order: 2,
    durationSeconds: 7,
    generationMethod: 'IMAGE_TO_VIDEO',
    continuationStrategy: 'STATE_ONLY',
    continuesFromGenerationUnitId: 'gen-04-02-a',
    startFrameAssetId: 'asset-frame-0402a-final', // == gen0402A.endFrameAssetId — the approved continuation
    startState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'at counter', pose: 'mug in both hands', facialExpression: 'calm' })] }),
    endState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'at window', pose: 'looking out', facialExpression: 'reflective' })] }),
  });

  // SHOT 04.03 — 7s, one GenerationUnit.
  const shot3 = schema.createStoryboardShot({
    shotId: 'shot-04-03',
    sceneId: scene.sceneId,
    order: 3,
    duration: 7,
    purpose: 'Mara sets the mug down and exits.',
    characterReferences: [character.characterId],
    locationReferences: [location.locationId],
    generationUnitIds: ['gen-04-03-a'],
  });
  const gen0403A = schema.createGenerationUnit({
    id: 'gen-04-03-a',
    shotId: shot3.shotId,
    order: 1,
    durationSeconds: 7,
    generationMethod: 'IMAGE_TO_VIDEO',
    continuationStrategy: 'STATE_ONLY',
    startState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'at window', pose: 'turning back to counter', facialExpression: 'neutral' })] }),
    endState: schema.createFrameState({ characterStates: [schema.createCharacterState({ characterId: character.characterId, position: 'doorway', pose: 'exiting', facialExpression: 'neutral' })] }),
  });

  const storyboard = schema.createStoryboard({ scenes: [scene], shots: [shot1, shot2, shot3] });
  const visualBible = schema.createVisualBible({ characters: [character], locations: [location] });
  const generationUnits = [gen0401A, gen0402A, gen0402B, gen0403A];
  const knownAssetIds = new Set(['asset-frame-0402a-final']);

  return { storyboard, visualBible, generationUnits, knownAssetIds, scene, shot1, shot2, shot3 };
}

function main() {
  const { storyboard, visualBible, generationUnits, knownAssetIds, scene, shot1, shot2, shot3 } = build();
  const totalSeconds = [shot1, shot2, shot3].reduce((sum, s) => sum + s.duration, 0);

  console.log(`[creative-production-contract-example] Scene "${scene.title}" — ${totalSeconds}s total, ${storyboard.shots.length} shots, ${generationUnits.length} GenerationUnits`);
  for (const shot of storyboard.shots) {
    const units = generationUnits.filter((u) => u.shotId === shot.shotId).sort((a, b) => a.order - b.order);
    console.log(`  SHOT ${shot.shotId} — ${shot.duration}s — ${units.length} unit(s): ${units.map((u) => `${u.durationSeconds}s`).join(' + ')}`);
    for (const u of units) {
      console.log(`    ${u.id} [${u.generationMethod}/${u.continuationStrategy}] continuesFrom=${u.continuesFromGenerationUnitId || '(none)'}`);
    }
  }

  const result = validator.validateCreativeProductionContract({ storyboard, visualBible, generationUnits, knownAssetIds });
  console.log(`[creative-production-contract-example] structural validation: ok=${result.ok}`);
  if (!result.ok) console.log(JSON.stringify(result.diagnostics, null, 2));
}

if (require.main === module) main();
module.exports = { build };
