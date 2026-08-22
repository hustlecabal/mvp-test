// GOLDEN CINEMA TEST — P1 Cinema Director Bridge.
//
// One real, full-chain integration proof: CreativeBlueprint -> Visual
// World -> VisualBeat -> MaterialSpecification/KeyframePromptPackage ->
// VideoPromptPackage -> the actual, final, provider-facing generation
// prompt. Every value asserted below is traced back to a real, canonical
// upstream object (CreativeBlueprint, VisualBible, Storyboard/Shot,
// VisualBeat) via the REAL, unmodified production functions
// (visual-world-service.js's buildMaterialSpecification/
// populateKeyframeFromMaterialSpecification, keyframe-prompt-service.js's
// buildKeyframePromptPackage, video-prompt-service.js's
// buildVideoPromptPackage) — nothing is spliced into the final prompt
// string by hand.
//
// Scene: a cleaner running through a suburban street at night, bleeding
// from the arm while headlights pursue her.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p1-golden-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p1-golden-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p1-golden-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p1-golden-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p1-golden-video-packages-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p1-golden-blueprints-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = keyframePromptTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const visualWorldService = require('../services/visual-world-service');
const keyframePromptService = require('../services/keyframe-prompt-service');
const videoPromptService = require('../services/video-prompt-service');
const { createCreativeBlueprint, createVisualSpecification } = require('../schemas/creative-blueprint-schema');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

test('GOLDEN CINEMA TEST — negative constraint, subject motion, environment motion, and pacing all survive from canonical upstream objects into the actual generation prompt', () => {
  // --- 1. Project + real CreativeBlueprint (the "Creative Brain output") ---
  const project = projectStore.createProject({ title: 'Golden Cinema Test', topic: 'a cleaner pursued at night' });

  const blueprint = createCreativeBlueprint({
    projectId: project.id,
    title: 'Bleeding Cleaner, Suburban Pursuit',
    concept: 'A cleaner runs through a suburban street at night, bleeding from the arm, as headlights pursue her.',
    corePromise: 'Survive the next thirty seconds.',
    visualSpecification: createVisualSpecification({
      composition: 'low-angle tracking shot, subject off-center favoring the direction she is running',
      lighting: 'harsh white headlight beams cutting through streetlight-orange ambient light',
      environmentalTreatment: 'wet suburban asphalt, parked cars, no other pedestrians',
      negativeConstraints: 'no text overlays, no visible car license plates, no comedic tone',
    }),
  });
  creativeBlueprintStore.addCreativeBlueprint(project.id, blueprint);

  // --- 2. Visual Bible — character + location (Story Bible / Character Builder principle) ---
  creativeStore.updateVisualBible(project.id, {
    characters: [
      {
        characterId: 'cleaner',
        name: 'The Cleaner',
        facialCharacteristics: 'gaunt, exhausted expression',
        identityConstraints: 'always wears a blood-stained work uniform, always has a fresh wound on her right arm',
        continuityNotes: 'the arm wound must be visible and consistent in every shot',
      },
    ],
    locations: [
      {
        locationId: 'suburban-street',
        name: 'Suburban Street',
        architecture: 'single-story houses set back from the road',
        atmosphere: 'dead quiet except for the pursuing engine',
        continuityConstraints: 'the same stretch of road across every shot',
      },
    ],
  });

  // --- 3. Storyboard: one scene, one shot, linked to the real blueprint ---
  const ACTION_TEXT = 'She sprints down the middle of the street, clutching her bleeding arm.';
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'The Chase', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    order: 1,
    purpose: 'establish the chase',
    action: ACTION_TEXT,
    characterReferences: ['cleaner'],
    locationReferences: ['suburban-street'],
    visualTreatment: 'AI_VIDEO',
  });
  creativeStore.updateStoryboard(project.id, { blueprintId: blueprint.id });
  const storyboard = creativeStore.getStoryboard(project.id);
  const visualBible = creativeStore.getVisualBible(project.id);

  // --- 4. Visual World — REAL, unmodified buildMaterialSpecification(), reading the REAL blueprint ---
  const materialSpec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible });
  assert.equal(materialSpec.composition, 'low-angle tracking shot, subject off-center favoring the direction she is running');
  assert.ok(materialSpec.negativeConstraints.includes('no text overlays, no visible car license plates, no comedic tone'));

  // --- 5. Keyframe, populated from the REAL MaterialSpecification (REAL, unmodified Visual World code) ---
  // visualDescription is pre-set to the shot's own action (an operator/
  // planner would already have done this) — populateKeyframeFromMaterial-
  // Specification only fills BLANK fields (its own documented, unmodified
  // behavior), so this is preserved rather than overwritten by the
  // MaterialSpecification's derived subject description.
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'COMPOSITION_FRAME',
    sourceShotVersion: storyboard.version,
    visualDescription: ACTION_TEXT,
  });
  visualWorldService.populateKeyframeFromMaterialSpecification(project.id, keyframe.keyframeId, materialSpec);

  // --- 6. Real KeyframePromptPackage — Fix A's actual code path ---
  const kfPackage = keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});
  assert.ok(kfPackage, 'a real KeyframePromptPackage must be built');
  assert.match(kfPackage.prompt, /no text overlays, no visible car license plates, no comedic tone/, 'the real Creative Brain negative constraint must reach the real keyframe prompt (Fix A)');
  assert.match(kfPackage.prompt, /the arm wound must be visible and consistent in every shot/, 'continuity constraint (from VisualBible) must reach the prompt');
  assert.match(kfPackage.prompt, /harsh white headlight beams/, 'lighting decision must reach the prompt');

  // --- 7. An approved, canonical keyframe asset (required to build a VideoPromptPackage) ---
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId, approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });

  // --- 8. A real VisualBeat for this exact shot, carrying real motion/pacing decisions ---
  const beatGraph = createBeatGraph({
    beats: [
      createVisualBeat({
        id: shot.shotId,
        shotId: shot.shotId,
        subjectMotion: 'turns sharply toward the headlights, glancing back in fear before breaking into a full sprint',
        environmentMotion: 'headlights sweep across the wet asphalt as the pursuing engine roars closer',
        pacing: 'a sudden burst of speed, then a held, breathless stillness as the lights crest the hill',
      }),
    ],
  });

  // --- 9. Real VideoPromptPackage — Fix B's actual code path ---
  const vpResult = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, {
    provider: 'evolink',
    model: 'seedance-2.0-mini-image-to-video',
    beatGraph,
  });
  assert.equal(vpResult.ok, true, vpResult.reason);
  const videoPrompt = vpResult.package.prompt;

  // --- 10. THE FINAL ASSERTION — every one of the 8 required elements must
  // be present in the ACTUAL, FINAL, provider-facing generation prompt,
  // each traced back to a real canonical upstream object. ---
  assert.match(videoPrompt, /ACTION:\nShe sprints down the middle of the street, clutching her bleeding arm\./, 'visible subject action (from Shot.action)');
  assert.match(videoPrompt, /SUBJECT MOTION:\nturns sharply toward the headlights/, 'subject motion (from VisualBeat)');
  assert.match(videoPrompt, /ENVIRONMENT MOTION:\nheadlights sweep across the wet asphalt/, 'environment motion (from VisualBeat)');
  assert.match(videoPrompt, /PACING:\na sudden burst of speed/, 'pacing (from VisualBeat)');
  assert.match(videoPrompt, /COMPOSITION:\nlow-angle tracking shot/, 'composition (from CreativeBlueprint via MaterialSpecification/Keyframe)');
  assert.match(videoPrompt, /no text overlays, no visible car license plates, no comedic tone/, 'negative constraints (from CreativeBlueprint via the KeyframePromptPackage carried forward — Fix A)');
  assert.match(videoPrompt, /the arm wound must be visible and consistent in every shot/, 'continuity constraints (from VisualBible, carried forward from the KeyframePromptPackage)');

  // The lighting/environment decision reached the KEYFRAME prompt (asserted
  // in step 6) — video-prompt-service.js does not carry lighting forward
  // into its own CAMERA_MOTION/COMPOSITION/etc. sections by design (no
  // LIGHTING section exists in the video prompt grammar), so this is
  // verified at its own real, correct layer rather than asserted twice.

  // --- 11. Provenance check — nothing here was manually spliced into the
  // final string. Change ONE upstream object and confirm the SAME real
  // pipeline produces a DIFFERENT final prompt, proving live derivation. ---
  const differentBeatGraph = createBeatGraph({
    beats: [createVisualBeat({ id: shot.shotId, shotId: shot.shotId, subjectMotion: 'collapses to her knees, exhausted', environmentMotion: 'the street falls silent', pacing: 'everything slows to a stop' })],
  });
  const vpResult2 = videoPromptService.resolveVideoPackageFields(project.id, keyframe.keyframeId, { provider: 'evolink', model: 'seedance-2.0-mini-image-to-video', beatGraph: differentBeatGraph });
  assert.notEqual(vpResult2.fields.prompt, videoPrompt, 'changing the upstream VisualBeat must change the final prompt — proof this is live derivation, not a fixed/hand-inserted string');
  assert.match(vpResult2.fields.prompt, /collapses to her knees, exhausted/);
});
