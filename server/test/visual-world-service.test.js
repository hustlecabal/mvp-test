// Tests for services/visual-world-service.js — the translation layer
// between CreativeBlueprint.visualSpecification/VisualBible and the two
// existing execution paths (Pipeline A: Keyframe/PromptPackage/EvoLink;
// Pipeline B: VisualBeat/MaterialResolution/MaterialExecution/renderers).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-vw-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-vw-projects-'],
  ['CREATIVE_DATA_DIR', 'evolink-vw-creative-'],
  ['CREATIVE_BLUEPRINT_DATA_DIR', 'evolink-vw-blueprint-'],
  ['KEYFRAME_DATA_DIR', 'evolink-vw-keyframe-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const keyframeStore = require('../services/keyframe-store');
const beatGraphDerivation = require('../services/beat-graph-derivation-service');
const visualWorldService = require('../services/visual-world-service');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');

function newProject() {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, 1000);
  gate.requestApproval(project, { estimatedCost: 1 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return projectStore.touch(project);
}

function setupProjectWithShots({ character = true } = {}) {
  const project = newProject();
  if (character) {
    creativeStore.updateVisualBible(project.id, { characters: [{ characterId: 'char-1', name: 'Mira', description: 'A weathered lighthouse keeper with silver hair.' }] }, {});
  }
  const blueprint = createCreativeBlueprint({
    projectId: project.id,
    concept: 'The lighthouse keeper',
    visualSpecification: {
      composition: 'wide establishing shots',
      palette: 'muted teal and amber',
      lighting: 'harsh directional light through fog',
      cameraLanguage: 'slow push-ins',
      negativeConstraints: 'no lens flares',
    },
  });
  creativeBlueprintStore.addCreativeBlueprint(project.id, blueprint);
  creativeStore.addStoryboardScene(project.id, { sceneId: 'scene-1', title: 'Opening', order: 1 });
  return { project, blueprint };
}

test('1. buildMaterialSpecification merges blueprint-level fields onto a shot with no shot-level override', () => {
  const { project, blueprint } = setupProjectWithShots();
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 4, purpose: 'Establish the lighthouse', visualTreatment: 'WHITEBOARD' });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  assert.equal(spec.composition, 'wide establishing shots');
  assert.equal(spec.camera, 'slow push-ins');
  assert.equal(spec.lighting, 'harsh directional light through fog');
  assert.equal(spec.treatment, 'WHITEBOARD');
  assert.equal(spec.materialType, 'DETERMINISTIC_RENDER');
});

test('2. buildMaterialSpecification — shot-level fields ALWAYS win over blueprint-level (Part 14)', () => {
  const { project, blueprint } = setupProjectWithShots();
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 4, composition: 'extreme close-up, shallow depth of field', visualTreatment: 'STILL_IMAGE' });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  assert.equal(spec.composition, 'extreme close-up, shallow depth of field');
  assert.notEqual(spec.composition, blueprint.visualSpecification.composition);
});

test('3. buildMaterialSpecification resolves continuityRequirements into references[] with entity description feeding subject', () => {
  const { project, blueprint } = setupProjectWithShots();
  creativeStore.addStoryboardShot(project.id, {
    shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 5,
    visualTreatment: 'STILL_IMAGE',
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'consistent silver hair' }],
  });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  assert.equal(spec.references.length, 1);
  assert.equal(spec.references[0].entityType, 'CHARACTER');
  assert.equal(spec.references[0].entityId, 'char-1');
  assert.ok(spec.subject.includes('lighthouse keeper'));
});

test('4. buildMaterialSpecification never invents a reference for an entity absent from VisualBible', () => {
  const { project, blueprint } = setupProjectWithShots({ character: false });
  creativeStore.addStoryboardShot(project.id, {
    shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 5, visualTreatment: 'STILL_IMAGE',
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'ghost-entity', requirement: 'x' }],
  });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  assert.equal(spec.references[0].assetId, null);
  assert.equal(spec.subject, '');
});

test('5. populateKeyframeFromMaterialSpecification fills only BLANK fields, never overwrites an already-set field', () => {
  const { project, blueprint } = setupProjectWithShots();
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 5, visualTreatment: 'STILL_IMAGE' });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', sceneId: 'scene-1', frameType: 'FIRST', camera: 'human-authored: dutch angle' }, {});
  const updated = visualWorldService.populateKeyframeFromMaterialSpecification(project.id, kf.keyframeId, spec, {});
  assert.equal(updated.camera, 'human-authored: dutch angle');
  assert.equal(updated.lighting, spec.lighting);
});

test('6. populateKeyframeFromMaterialSpecification links continuity-required character ids into characterReferences without duplicating existing ones', () => {
  const { project, blueprint } = setupProjectWithShots();
  creativeStore.addStoryboardShot(project.id, {
    shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 5, visualTreatment: 'STILL_IMAGE',
    continuityRequirements: [{ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'x' }],
  });
  const shot = creativeStore.getStoryboard(project.id).shots[0];
  const spec = visualWorldService.buildMaterialSpecification(project.id, shot, { blueprint, visualBible: creativeStore.getVisualBible(project.id) });
  const kf = keyframeStore.createKeyframe(project.id, { shotId: 'shot-1', sceneId: 'scene-1', frameType: 'FIRST', characterReferences: ['char-1'] }, {});
  const updated = visualWorldService.populateKeyframeFromMaterialSpecification(project.id, kf.keyframeId, spec, {});
  assert.deepEqual(updated.characterReferences, ['char-1']);
});

test('7. populateKeyframeFromMaterialSpecification returns null for a nonexistent keyframe', () => {
  const { project } = setupProjectWithShots();
  const spec = { subject: 'x', composition: '', camera: '', lighting: '', palette: '', references: [] };
  assert.equal(visualWorldService.populateKeyframeFromMaterialSpecification(project.id, '00000000-0000-4000-8000-000000000000', spec, {}), null);
});

test('8. compileDeterministicOptions — WHITEBOARD falls back to one whole-beat element when no caption timing overlaps', () => {
  const spec = { treatment: 'WHITEBOARD', subject: 'A lighthouse at dusk', shotPurpose: 'establish' };
  const beat = { duration: 4, startTime: 0 };
  const options = visualWorldService.compileDeterministicOptions(spec, beat, { captionSegments: [] });
  assert.equal(options.elements.length, 1);
  assert.equal(options.elements[0].content, 'A lighthouse at dusk');
  assert.equal(options.duration, 4);
});

test('9. compileDeterministicOptions — WHITEBOARD uses REAL overlapping caption timing when available (Part 24/31)', () => {
  const spec = { treatment: 'WHITEBOARD', subject: 'x', shotPurpose: 'x' };
  const beat = { duration: 4, startTime: 10 };
  const captionSegments = [
    { text: 'The keeper climbs', startTime: 10, endTime: 11.5 },
    { text: 'the spiral stairs', startTime: 11.5, endTime: 13 },
    { text: 'unrelated, outside beat window', startTime: 20, endTime: 21 },
  ];
  const options = visualWorldService.compileDeterministicOptions(spec, beat, { captionSegments });
  assert.equal(options.elements.length, 2);
  assert.equal(options.elements[0].content, 'The keeper climbs');
  assert.equal(options.elements[0].drawStartOffset, 0);
  assert.ok(Math.abs(options.elements[0].drawDuration - 1.5) < 1e-9);
  assert.equal(options.elements[1].content, 'the spiral stairs');
  assert.ok(Math.abs(options.elements[1].drawStartOffset - 1.5) < 1e-9);
});

test('10. compileDeterministicOptions — KINETIC_TYPOGRAPHY supplies options.text explicitly (executor requires it)', () => {
  const spec = { treatment: 'KINETIC_TYPOGRAPHY', subject: 'MONEY DOES NOT BUY TIME', shotPurpose: 'hook' };
  const options = visualWorldService.compileDeterministicOptions(spec, { duration: 3 }, {});
  assert.equal(options.text, 'MONEY DOES NOT BUY TIME');
  assert.equal(options.duration, 3);
});

test('11. compileDeterministicOptions — MOTION_GRAPHIC supplies a real TEXT primitive from the MaterialSpecification', () => {
  const spec = { treatment: 'MOTION_GRAPHIC', subject: '', shotPurpose: '73% of respondents agreed' };
  const options = visualWorldService.compileDeterministicOptions(spec, { duration: 2 }, {});
  assert.equal(options.elements[0].kind, 'TEXT');
  assert.equal(options.elements[0].label, '73% of respondents agreed');
});

test('12. compileDeterministicOptions returns null for a GENERATED_NEW treatment (not this file\'s job)', () => {
  const spec = { treatment: 'STILL_IMAGE', subject: 'x' };
  assert.equal(visualWorldService.compileDeterministicOptions(spec, { duration: 2 }, {}), null);
});

test('13. compileDeterministicOptions returns null when beat.duration is missing/invalid', () => {
  const spec = { treatment: 'WHITEBOARD', subject: 'x', shotPurpose: 'x' };
  assert.equal(visualWorldService.compileDeterministicOptions(spec, { duration: null }, {}), null);
});

test('14. buildMaterialOptionsForBeatGraph produces one entry per DETERMINISTIC beat, none for GENERATED_NEW beats', () => {
  const { project, blueprint } = setupProjectWithShots();
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-1', sceneId: 'scene-1', order: 1, duration: 4, purpose: 'A', visualTreatment: 'WHITEBOARD' });
  creativeStore.addStoryboardShot(project.id, { shotId: 'shot-2', sceneId: 'scene-1', order: 2, duration: 5, purpose: 'B', visualTreatment: 'STILL_IMAGE' });
  creativeStore.updateStoryboard(project.id, { blueprintId: blueprint.id }, {});
  const storyboard = creativeStore.getStoryboard(project.id);
  const derivation = beatGraphDerivation.deriveBeatGraph(storyboard, {});
  const materialOptions = visualWorldService.buildMaterialOptionsForBeatGraph(project.id, derivation.beatGraph, blueprint);
  const whiteboardBeat = derivation.beatGraph.beats.find((b) => b.visualTreatment === 'WHITEBOARD');
  const stillBeat = derivation.beatGraph.beats.find((b) => b.visualTreatment === 'STILL_IMAGE');
  assert.ok(materialOptions[whiteboardBeat.id]);
  assert.equal(materialOptions[stillBeat.id], undefined);
});

test('15. GENERATED_NEW_TREATMENTS and DETERMINISTIC_TREATMENTS are disjoint and match schemas/visual-beat-schema.js VISUAL_TREATMENTS', () => {
  const { VISUAL_TREATMENTS } = require('../schemas/visual-beat-schema');
  for (const t of visualWorldService.GENERATED_NEW_TREATMENTS) assert.ok(VISUAL_TREATMENTS.includes(t));
  for (const t of visualWorldService.DETERMINISTIC_TREATMENTS) assert.ok(VISUAL_TREATMENTS.includes(t));
  const overlap = visualWorldService.GENERATED_NEW_TREATMENTS.filter((t) => visualWorldService.DETERMINISTIC_TREATMENTS.includes(t));
  assert.deepEqual(overlap, []);
});

test('16. security — visual-world-service.js has no eval/new Function/child_process/network call', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'visual-world-service.js'), 'utf8');
  assert.ok(!/\beval\(/.test(source));
  assert.ok(!/new Function\(/.test(source));
  assert.ok(!/child_process/.test(source));
  assert.ok(!/\bfetch\(/.test(source));
});
