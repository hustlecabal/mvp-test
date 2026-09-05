// Tests for services/story-structure-service.js — PHASE 1 EDITORIAL
// SPINE, Part 5/6/7. Blueprint -> StoryStructure derivation (pure), then
// StoryStructure -> real Storyboard authoring, then StoryStructure ->
// beat-graph-derivation-service.js context translation, proving the full
// Blueprint -> Story Structure -> BeatGraph bridge end to end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-storystructure-projects-'));
process.env.CREATIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-storystructure-creative-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-storystructure-blueprints-'));
process.env.STORY_STRUCTURE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-storystructure-structures-'));

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const storyStructureStore = require('../services/story-structure-store');
const storyStructureService = require('../services/story-structure-service');
const { deriveBeatGraph } = require('../services/beat-graph-derivation-service');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');

function newProject() {
  return projectStore.createProject({ title: 'story structure test', topic: 'x' });
}

// Persists a real CreativeBlueprint via the store directly (schema-factory
// construction, not the full Creative Brain chain — this file's own tests
// are about StoryStructure derivation/authoring, not Creative Brain, which
// already has its own dedicated test file). Storyboard.blueprintId's write-
// time validation requires the blueprintId to resolve to a REAL, persisted
// Blueprint (see test/control-plane-service.test.js scenario J1), so this
// must be a stored record, not a bare in-memory object.
function fakeBlueprint(projectId, overrides = {}) {
  const blueprint = createCreativeBlueprint({
    projectId,
    concept: 'why most side projects die',
    corePromise: 'the real reason is never the code',
    hookStrategy: 'what actually kills a side project in week 3',
    narrativeStrategy: 'a mechanism explanation, not a listicle',
    pacingStrategy: 'quick, concrete steps',
    visualStrategy: 'clean kinetic typography, high contrast',
    emotionalArc: 'curiosity to clarity to resolve',
    targetDuration: 45,
    status: 'APPROVED',
    ...overrides,
  });
  return creativeBlueprintStore.addCreativeBlueprint(projectId, blueprint).blueprint;
}

// --- deriveStoryStructure (pure) -----------------------------------------

test('1. deriveStoryStructure fails for a missing/invalid blueprint', () => {
  const result = storyStructureService.deriveStoryStructure(null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_BLUEPRINT');
});

test('2. deriveStoryStructure produces DEFAULT_BEAT_COUNT beats when structuralDirection is absent', () => {
  const project = newProject();
  const blueprint = fakeBlueprint(project.id);
  const result = storyStructureService.deriveStoryStructure(blueprint);
  assert.equal(result.ok, true);
  assert.equal(result.storyStructure.beats.length, storyStructureService.DEFAULT_BEAT_COUNT);
  assert.equal(result.storyStructure.blueprintId, blueprint.id);
  assert.equal(result.storyStructure.corePromise, blueprint.corePromise);
});

test('3. structuralDirection.plannedSectionCount is honored, clamped to [MIN_BEATS, MAX_BEATS]', () => {
  const project = newProject();
  const low = storyStructureService.deriveStoryStructure(fakeBlueprint(project.id, { structuralDirection: { plannedSectionCount: 1, minimumSectionDurationSeconds: 4 } }));
  assert.equal(low.storyStructure.beats.length, storyStructureService.MIN_BEATS);
  const high = storyStructureService.deriveStoryStructure(fakeBlueprint(project.id, { structuralDirection: { plannedSectionCount: 99, minimumSectionDurationSeconds: 4 } }));
  assert.equal(high.storyStructure.beats.length, storyStructureService.MAX_BEATS);
  const exact = storyStructureService.deriveStoryStructure(fakeBlueprint(project.id, { structuralDirection: { plannedSectionCount: 7, minimumSectionDurationSeconds: 4 } }));
  assert.equal(exact.storyStructure.beats.length, 7);
});

test('4. the arc is HOOK -> ... -> REVEAL -> CONCLUSION, with setup/escalation/reveal/payoff flags set correctly', () => {
  const project = newProject();
  const blueprint = fakeBlueprint(project.id);
  const { storyStructure } = storyStructureService.deriveStoryStructure(blueprint);
  const beats = storyStructure.beats;
  assert.equal(beats[0].narrativeRole, 'HOOK');
  assert.equal(beats[0].isSetup, true);
  assert.equal(beats[0].unresolvedQuestion, blueprint.hookStrategy);
  assert.equal(beats[beats.length - 1].narrativeRole, 'CONCLUSION');
  assert.equal(beats[beats.length - 1].isPayoff, true);
  const reveal = beats.find((b) => b.narrativeRole === 'REVEAL');
  assert.ok(reveal);
  assert.equal(reveal.isReveal, true);
  const escalations = beats.filter((b) => b.isEscalation);
  assert.ok(escalations.length > 0);
  for (const beat of beats) assert.ok(beat.visualObjective && beat.visualObjective.visualObjective.length > 0, 'every beat must have a non-empty visual objective');
});

test('5. edges: exactly one DEPENDS_ON from the hook to the reveal (the hook has an unresolved question) — deliberately NO TRANSITIONS_TO chain', () => {
  const project = newProject();
  const blueprint = fakeBlueprint(project.id);
  const { storyStructure } = storyStructureService.deriveStoryStructure(blueprint);
  // TRANSITIONS_TO carries real, currently-unimplemented rendering
  // semantics elsewhere in this codebase (timeline-compiler-service.js ->
  // video-assembly-service.js's own documented TRANSITION_UNSUPPORTED
  // refusal) — plain sequential order is already fully expressed by each
  // beat's own `order` field and must never be expressed as a
  // TRANSITIONS_TO edge here.
  assert.equal(storyStructure.edges.filter((e) => e.kind === 'TRANSITIONS_TO').length, 0);
  const dependsOn = storyStructure.edges.filter((e) => e.kind === 'DEPENDS_ON');
  assert.equal(dependsOn.length, 1);
  assert.equal(storyStructure.edges.length, 1);
  const hookBeat = storyStructure.beats[0];
  const revealBeat = storyStructure.beats.find((b) => b.narrativeRole === 'REVEAL');
  assert.equal(dependsOn[0].fromBeatKey, hookBeat.beatKey);
  assert.equal(dependsOn[0].toBeatKey, revealBeat.beatKey);
});

test('6. no DEPENDS_ON edge is invented when the hook has no unresolvedQuestion', () => {
  const project = newProject();
  const blueprint = fakeBlueprint(project.id, { hookStrategy: '', corePromise: '' });
  const { storyStructure } = storyStructureService.deriveStoryStructure(blueprint);
  assert.equal(storyStructure.edges.filter((e) => e.kind === 'DEPENDS_ON').length, 0);
});

// --- authorStoryboardFromStoryStructure (the ONE place this bridge writes) ---

test('7. authorStoryboardFromStoryStructure creates one real Storyboard shot per planned beat, in order, links the Blueprint, and marks the StoryStructure AUTHORED', () => {
  const project = newProject();
  const blueprint = fakeBlueprint(project.id);
  const { storyStructure } = storyStructureService.deriveStoryStructure(blueprint);
  const saved = storyStructureStore.addStoryStructure(project.id, storyStructure);
  assert.equal(saved.ok, true);

  const treatments = {};
  for (const beat of saved.storyStructure.beats) treatments[beat.beatKey] = beat.narrativeRole === 'HOOK' || beat.narrativeRole === 'CONCLUSION' ? 'KINETIC_TYPOGRAPHY' : 'STILL_IMAGE';

  const authored = storyStructureService.authorStoryboardFromStoryStructure(project.id, saved.storyStructure, { treatments });
  assert.equal(authored.ok, true);
  assert.equal(authored.storyboard.shots.length, saved.storyStructure.beats.length);
  assert.equal(authored.storyboard.blueprintId, blueprint.id);
  assert.equal(Object.keys(authored.beatKeyToShotId).length, saved.storyStructure.beats.length);

  const shotsInOrder = [...authored.storyboard.shots].sort((a, b) => a.order - b.order);
  assert.equal(shotsInOrder[0].narrativeBeat, 'HOOK');
  assert.equal(shotsInOrder[0].visualTreatment, 'KINETIC_TYPOGRAPHY');

  const refetched = storyStructureStore.getStoryStructure(project.id, saved.storyStructure.id);
  assert.equal(refetched.status, 'AUTHORED');
});

// --- buildBeatGraphContext + full pipe into deriveBeatGraph ---------------

test('8. buildBeatGraphContext + deriveBeatGraph together produce beats carrying the SAME narrativeRole/visualObjective/edges the StoryStructure planned — the full bridge, end to end', () => {
  const project = newProject();
  const blueprint = fakeBlueprint(project.id);
  const { storyStructure } = storyStructureService.deriveStoryStructure(blueprint);
  const saved = storyStructureStore.addStoryStructure(project.id, storyStructure).storyStructure;

  const treatments = {};
  for (const beat of saved.beats) treatments[beat.beatKey] = 'KINETIC_TYPOGRAPHY';
  const authored = storyStructureService.authorStoryboardFromStoryStructure(project.id, saved, { treatments });

  const context = storyStructureService.buildBeatGraphContext(saved, authored.beatKeyToShotId);
  const derivation = deriveBeatGraph(authored.storyboard, context);
  assert.equal(derivation.status, 'DERIVED');
  assert.equal(derivation.beatGraph.beats.length, saved.beats.length);
  assert.equal(derivation.beatGraph.edges.length, saved.edges.length);

  const hookShotId = authored.beatKeyToShotId[saved.beats[0].beatKey];
  const hookOutputBeat = derivation.beatGraph.beats.find((b) => b.id === hookShotId);
  assert.equal(hookOutputBeat.narrativeRole, 'HOOK');
  assert.equal(hookOutputBeat.visualIntent, saved.beats[0].visualObjective.visualObjective);
  assert.equal(hookOutputBeat.visualMode, saved.beats[0].visualObjective.visualMode);
  assert.equal(hookOutputBeat.visualChangeRequired, saved.beats[0].visualObjective.visualChangeRequired);

  // The DEPENDS_ON edge (hook -> reveal) survived translation intact.
  const dependsOnEdge = derivation.beatGraph.edges.find((e) => e.kind === 'DEPENDS_ON');
  assert.ok(dependsOnEdge);
  assert.equal(dependsOnEdge.fromBeatId, hookShotId);
});
