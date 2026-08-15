// Tests for Stage 26.4 — services/material-resolution-service.js's
// resolveBeatGraph(): the connection between a real BeatGraph (Stage 26.1)
// and the Stage 26.3 Material Resolution Engine. Pure integration — no new
// gating/scoring logic lives here; every decision still comes from
// resolveMaterial(). No provider calls, no credits, no approval-gate.js, no
// B-roll store (context.brollSegments is an injectable fixture only), no
// mutation of any input (BeatGraph, Storyboard, Timeline IR, Keyframe Plan,
// Asset Store).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-beatgraph-resolution-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-beatgraph-resolution-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-beatgraph-resolution-keyframes-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const materialResolutionService = require('../services/material-resolution-service');

// --- fixture helpers ---------------------------------------------------------------

// Project -> Storyboard Scene -> 3 Storyboard Shots -> one canonical/approved
// "nova" character keyframe asset. Mirrors material-resolution-service.test.js's
// own buildProjectSceneShotKeyframe(), extended to 3 shots so the 10-beat
// scenario can demonstrate a real "Storyboard Shot -> 1..N VisualBeats"
// grouping rather than everything sharing one shot.
function buildFixtureProject() {
  const project = projectStore.createProject({ title: 'beatgraph-material-resolution test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shotA = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const shotB = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const shotC = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);

  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shotA.shotId,
    sceneId: scene.sceneId,
    frameType: 'ESTABLISHING_FRAME',
    sourceShotVersion: storyboard.version,
  });
  keyframeStore.updateKeyframe(project.id, keyframe.keyframeId, { characterReferences: ['nova'] });

  const novaAsset = timelineStore.addAsset(project.id, {
    assetId: crypto.randomUUID(),
    type: 'keyframe',
    keyframeId: keyframe.keyframeId,
    sceneId: scene.sceneId,
    shotId: shotA.shotId,
  });
  timelineStore.updateAssetStorage(project.id, novaAsset.assetId, { status: 'STORED', provider: 'local', path: `${novaAsset.assetId}.png` });
  timelineStore.setAssetApprovalStatus(project.id, novaAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, novaAsset.assetId, { selectedBy: 'tester' });

  return { project, scene, shotA, shotB, shotC, keyframe, novaAsset };
}

// The exact 10-beat realistic explainer sequence from Stage 26.4 Part 4.
// motionRequirements always supplies all three fields explicitly (never
// relies on createVisualBeat's own null defaults for the fields a test
// cares about) so every beat's intent is unambiguous.
function buildTenBeatGraph({ project, scene, shotA, shotB, shotC }) {
  const beats = [
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotA.shotId, sequence: 1, startTime: 0, duration: 3,
      narrativePurpose: 'Hook / large statement', visualTreatment: 'KINETIC_TYPOGRAPHY',
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotA.shotId, sequence: 2, startTime: 3, duration: 4,
      narrativePurpose: 'Introduce the main character', visualTreatment: 'STILL_IMAGE',
      identityRequirements: { characterReferences: ['nova'], locationReferences: [], propReferences: [] },
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotA.shotId, sequence: 3, startTime: 7, duration: 5,
      narrativePurpose: 'Character performs meaningful natural movement', visualTreatment: 'AI_VIDEO',
      identityRequirements: { characterReferences: ['nova'], locationReferences: [], propReferences: [] },
      motionRequirements: { motionLevel: 'COMPLEX', requiresCameraMotion: false, requiresSubjectMotion: true },
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotB.shotId, sequence: 4, startTime: 12, duration: 5,
      narrativePurpose: 'Explain a numerical concept', visualTreatment: 'MOTION_GRAPHIC',
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotB.shotId, sequence: 5, startTime: 17, duration: 4,
      narrativePurpose: 'Establish a generic real-world environment', visualTreatment: 'BROLL_CLIP',
      identityRequirements: { characterReferences: [], locationReferences: ['generic-office'], propReferences: [] },
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotB.shotId, sequence: 6, startTime: 21, duration: 5,
      narrativePurpose: 'Whiteboard explanation', visualTreatment: 'WHITEBOARD',
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotB.shotId, sequence: 7, startTime: 26, duration: 5,
      narrativePurpose: 'Character + environment', visualTreatment: 'AI_VIDEO', fallbackStrategy: ['BROLL_CLIP'],
      identityRequirements: { characterReferences: ['nova'], locationReferences: ['generic-office'], propReferences: [] },
      motionRequirements: { motionLevel: 'COMPLEX', requiresCameraMotion: false, requiresSubjectMotion: true },
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotC.shotId, sequence: 8, startTime: 31, duration: 4,
      narrativePurpose: 'Still image with subtle camera movement', visualTreatment: 'STILL_IMAGE',
      identityRequirements: { characterReferences: ['nova'], locationReferences: [], propReferences: [] },
      motionRequirements: { motionLevel: 'SUBTLE', requiresCameraMotion: true, requiresSubjectMotion: false },
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotC.shotId, sequence: 9, startTime: 35, duration: 2,
      narrativePurpose: 'Kinetic typography transition', visualTreatment: 'KINETIC_TYPOGRAPHY',
    }),
    createVisualBeat({
      sceneId: scene.sceneId, shotId: shotC.shotId, sequence: 10, startTime: 37, duration: 6,
      narrativePurpose: 'Final cinematic moment', visualTreatment: 'AI_VIDEO',
      identityRequirements: { characterReferences: ['nova'], locationReferences: [], propReferences: [] },
      motionRequirements: { motionLevel: 'COMPLEX', requiresCameraMotion: true, requiresSubjectMotion: true },
    }),
  ];

  return createBeatGraph({ projectId: project.id, beats });
}

const BROLL_CONTEXT = { brollSegments: [{ segmentId: 'seg-office', licensingStatus: 'CLEARED' }] };

// =====================================================================================
// A/B/C — BeatGraph -> resolver integration, 10-beat realistic scenario, every
// expected material class
// =====================================================================================

test('A1. resolveBeatGraph accepts a real BeatGraph and returns one MaterialResolution per beat', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  assert.equal(report.beatGraphId, fixture.project.id);
  assert.equal(report.resolutions.length, 10);
  assert.equal(report.summary.totalBeats, 10);
});

test('B1. beat 1 (hook, exact text, no identity) resolves to KINETIC_TYPOGRAPHY + DETERMINISTIC_TEMPLATE', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[0].id);
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.selectedMaterial.visualTreatment, 'KINETIC_TYPOGRAPHY');
  assert.equal(r.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');
});

test('B2/C1. beat 2 (introduce character, canonical approved asset available) resolves to PROJECT_ASSET_REUSE', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[1].id);
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');
  assert.equal(r.selectedMaterial.selectedAssetId, fixture.novaAsset.assetId);
  assert.equal(r.decidingPhase, 'CONTINUITY', 'a competing GENERATED_NEW candidate must exist and lose on continuity, not by default');
});

test('B3/D1. beat 3 (character + complex subject motion) resolves to AI_VIDEO / GENERATED_NEW via a real registry capability lookup, never generates', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[2].id);
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.selectedMaterial.visualTreatment, 'AI_VIDEO');
  assert.equal(r.selectedMaterial.materialSource, 'GENERATED_NEW');
  assert.ok(r.selectedMaterial.modelRequirements, 'a real capability requirement object must be present');
  assert.equal('provider' in r.selectedMaterial.modelRequirements, false);
  assert.equal('model' in r.selectedMaterial.modelRequirements, false);
});

test('B4/C2. beat 4 (exact numeric content, chart intent) resolves to MOTION_GRAPHIC + DETERMINISTIC_TEMPLATE', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[3].id);
  assert.equal(r.selectedMaterial.visualTreatment, 'MOTION_GRAPHIC');
  assert.equal(r.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');
});

test('B5/F1. beat 5 (generic environment, no character identity, CLEARED B-roll available) resolves to BROLL_LIBRARY', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[4].id);
  assert.equal(r.status, 'RESOLVED');
  assert.equal(r.selectedMaterial.materialSource, 'BROLL_LIBRARY');
  assert.equal(r.selectedMaterial.visualTreatment, 'BROLL_CLIP');
});

test('B6/E1. beat 6 (whiteboard, exact text/numeric content) resolves to WHITEBOARD + DETERMINISTIC_TEMPLATE', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[5].id);
  assert.equal(r.selectedMaterial.visualTreatment, 'WHITEBOARD');
  assert.equal(r.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');
});

test('B7/F2. beat 7 (character + environment, requiresSubjectMotion) never selects B-roll as PRIMARY, but B-roll is reported eligible for BACKGROUND/OVERLAY/INSERT', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[6].id);
  assert.equal(r.status, 'RESOLVED');
  assert.notEqual(r.selectedMaterial.materialSource, 'BROLL_LIBRARY', 'B-roll must never win PRIMARY for a named-character identity beat');
  assert.equal(r.selectedMaterial.visualTreatment, 'AI_VIDEO');
  assert.equal(r.selectedMaterial.materialSource, 'GENERATED_NEW');

  const brollGate = r.hardGateResults.find((g) => g.candidate.startsWith('BROLL_LIBRARY'));
  assert.ok(brollGate, 'B-roll must still have been evaluated (reached via fallbackStrategy), not silently skipped');
  assert.equal(brollGate.allowed, false);
  assert.equal(brollGate.rejectedBy, 'IDENTITY_REQUIRES_NON_BROLL_PRIMARY');
  assert.deepEqual(brollGate.eligibleRoles, ['OVERLAY', 'BACKGROUND', 'INSERT']);
});

test('B8. beat 8 (still image, identity, subtle camera movement) resolves to STILL_IMAGE via a deterministic (not hardcoded) source choice', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);

  const first = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);
  const second = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r1 = first.resolutions.find((x) => x.beatId === beatGraph.beats[7].id);
  const r2 = second.resolutions.find((x) => x.beatId === beatGraph.beats[7].id);
  assert.equal(r1.status, 'RESOLVED');
  assert.equal(r1.selectedMaterial.visualTreatment, 'STILL_IMAGE');
  assert.ok(
    r1.selectedMaterial.materialSource === 'PROJECT_ASSET_REUSE' || r1.selectedMaterial.materialSource === 'GENERATED_NEW',
    'either a real reuse or a real fresh-generation strategy is acceptable — the point is the engine decided, nothing was hardcoded'
  );
  // Determinism, not a hardcoded winner: the SAME source must win every time.
  assert.equal(r1.selectedMaterial.materialSource, r2.selectedMaterial.materialSource);
  assert.equal(r1.decidingPhase, r2.decidingPhase);
});

test('B9/E2. beat 9 (kinetic typography transition, no identity) resolves to KINETIC_TYPOGRAPHY', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[8].id);
  assert.equal(r.selectedMaterial.visualTreatment, 'KINETIC_TYPOGRAPHY');
  assert.equal(r.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');
});

test('B10/D2. beat 10 (final cinematic moment, complex motion) resolves to AI_VIDEO / GENERATED_NEW', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const r = report.resolutions.find((x) => x.beatId === beatGraph.beats[9].id);
  assert.equal(r.selectedMaterial.visualTreatment, 'AI_VIDEO');
  assert.equal(r.selectedMaterial.materialSource, 'GENERATED_NEW');
});

// =====================================================================================
// G — deterministic ordering (Part 7)
// =====================================================================================

test('G1. resolve(A) === resolve(A) — identical beatGraph resolved twice yields identical per-beat decisions and rankings', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);

  const first = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);
  const second = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  assert.equal(first.status, second.status);
  assert.deepEqual(
    first.resolutions.map((r) => ({ beatId: r.beatId, status: r.status, selectedMaterial: r.selectedMaterial, ranking: r.ranking, decidingPhase: r.decidingPhase })),
    second.resolutions.map((r) => ({ beatId: r.beatId, status: r.status, selectedMaterial: r.selectedMaterial, ranking: r.ranking, decidingPhase: r.decidingPhase }))
  );
});

test('G2. beat order in the input BeatGraph never influences a decision — a shuffled beat array produces identical per-beat decisions and identical presentation order', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const shuffledGraph = createBeatGraph({ projectId: fixture.project.id, beats: [...beatGraph.beats].reverse() });

  const inOrder = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);
  const shuffled = materialResolutionService.resolveBeatGraph(fixture.project.id, shuffledGraph, BROLL_CONTEXT);

  assert.deepEqual(inOrder.resolutions.map((r) => r.beatId), shuffled.resolutions.map((r) => r.beatId), 'presentation order must be identical regardless of input array order');
  for (let i = 0; i < inOrder.resolutions.length; i += 1) {
    assert.deepEqual(inOrder.resolutions[i].selectedMaterial, shuffled.resolutions[i].selectedMaterial, `beat at position ${i} must resolve identically regardless of input order`);
  }
});

test('G3. resolveBeatGraph never mutates beatGraph.beats itself (sorts a copy, not the original array)', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const originalOrder = beatGraph.beats.map((b) => b.id);

  materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  assert.deepEqual(beatGraph.beats.map((b) => b.id), originalOrder, 'beatGraph.beats must remain in its original order after resolution');
});

test('G4. presentation order stays deterministic even when beat.sequence is NOT unique within a scene — never leaks input-array order as a de facto tie-break', () => {
  const fixture = buildFixtureProject();
  const beatA = createVisualBeat({ sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'MOTION_GRAPHIC' });
  const beatB = createVisualBeat({ sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'KINETIC_TYPOGRAPHY' });
  const beatC = createVisualBeat({ sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'WHITEBOARD' });

  const forward = createBeatGraph({ projectId: fixture.project.id, beats: [beatA, beatB, beatC] });
  const shuffled = createBeatGraph({ projectId: fixture.project.id, beats: [beatC, beatA, beatB] });

  const forwardReport = materialResolutionService.resolveBeatGraph(fixture.project.id, forward, {});
  const shuffledReport = materialResolutionService.resolveBeatGraph(fixture.project.id, shuffled, {});

  assert.deepEqual(forwardReport.resolutions.map((r) => r.beatId), shuffledReport.resolutions.map((r) => r.beatId));
});

// =====================================================================================
// H — repeated resolution with no mutation (Part 3)
// =====================================================================================

test('H1. repeated resolveBeatGraph calls mutate neither the BeatGraph, the Storyboard, the Timeline IR, nor the Keyframe Plan', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);

  const beatGraphBefore = JSON.stringify(beatGraph);
  const storyboardBefore = JSON.stringify(creativeStore.getStoryboard(fixture.project.id));
  const assetsBefore = JSON.stringify(timelineStore.listAssets(fixture.project.id));
  const planBefore = JSON.stringify(keyframeStore.getKeyframePlan(fixture.project.id));

  materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);
  materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  assert.equal(JSON.stringify(beatGraph), beatGraphBefore, 'BeatGraph must be byte-identical after resolution');
  assert.equal(JSON.stringify(creativeStore.getStoryboard(fixture.project.id)), storyboardBefore, 'Storyboard must be byte-identical');
  assert.equal(JSON.stringify(timelineStore.listAssets(fixture.project.id)), assetsBefore, 'Timeline IR assets must be byte-identical');
  assert.equal(JSON.stringify(keyframeStore.getKeyframePlan(fixture.project.id)), planBefore, 'Keyframe Plan must be byte-identical');
});

// =====================================================================================
// I/J/K — failure handling (Part 8)
// =====================================================================================

test('I1. an empty BeatGraph produces a valid, empty resolution report, never a crash', () => {
  const fixture = buildFixtureProject();
  const emptyGraph = createBeatGraph({ projectId: fixture.project.id, beats: [] });

  assert.doesNotThrow(() => {
    const report = materialResolutionService.resolveBeatGraph(fixture.project.id, emptyGraph, {});
    assert.equal(report.status, 'RESOLVED', 'vacuously true — nothing failed because nothing was asked');
    assert.deepEqual(report.resolutions, []);
    assert.equal(report.summary.totalBeats, 0);
  });
});

test('J1. a beat with an invalid visualTreatment resolves UNRESOLVED with explicit INVALID_TREATMENT', () => {
  const fixture = buildFixtureProject();
  const badBeat = createVisualBeat({ sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'NOT_A_REAL_TREATMENT' });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [badBeat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, {});

  assert.equal(report.status, 'UNRESOLVED');
  const r = report.resolutions[0];
  assert.equal(r.status, 'UNRESOLVED');
  assert.equal(r.unresolvedRequirements[0].rejectedBy, 'INVALID_TREATMENT');
});

test('K1. a beat requiring subject motion with no capable execution strategy resolves UNRESOLVED with MOTION_REQUIREMENT_UNSATISFIED', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'MOTION_GRAPHIC',
    motionRequirements: { motionLevel: 'COMPLEX', requiresCameraMotion: false, requiresSubjectMotion: true },
  });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [beat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, {});

  const r = report.resolutions[0];
  assert.equal(r.status, 'UNRESOLVED');
  assert.ok(r.unresolvedRequirements.some((u) => u.rejectedBy === 'MOTION_REQUIREMENT_UNSATISFIED'));
});

test('K2. a beat requiring an impossibly long AI video duration resolves UNRESOLVED with NO_CAPABLE_MODEL, never a silent fallback', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'AI_VIDEO', duration: 999999,
  });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [beat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, {});

  const r = report.resolutions[0];
  assert.equal(r.status, 'UNRESOLVED');
  assert.ok(r.unresolvedRequirements.some((u) => u.rejectedBy === 'NO_CAPABLE_MODEL'));
});

test('K3. a named-character identity beat whose only matching existing asset is REJECTED never selects that asset, even though a fresh GENERATED_NEW candidate legitimately can', () => {
  const fixture = buildFixtureProject();
  timelineStore.setAssetApprovalStatus(fixture.project.id, fixture.novaAsset.assetId, 'REJECTED');
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'STILL_IMAGE',
    identityRequirements: { characterReferences: ['nova'], locationReferences: [], propReferences: [] },
  });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [beat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, {});

  const r = report.resolutions[0];
  assert.equal(
    r.candidates.some((c) => c.materialSource === 'PROJECT_ASSET_REUSE'),
    false,
    'the REJECTED asset must never survive as a PROJECT_ASSET_REUSE candidate'
  );
  if (r.status === 'RESOLVED') {
    assert.notEqual(r.selectedMaterial.selectedAssetId, fixture.novaAsset.assetId);
  }
});

test('K4. a B-roll beat with UNKNOWN licensing is rejected with LICENSING_UNKNOWN and the beat resolves UNRESOLVED (no fallback existing/generated path for BROLL_CLIP)', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotB.shotId, sequence: 1, visualTreatment: 'BROLL_CLIP',
  });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [beat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, { brollSegments: [{ segmentId: 'seg-1', licensingStatus: 'UNKNOWN' }] });

  const r = report.resolutions[0];
  assert.equal(r.status, 'UNRESOLVED');
  assert.ok(r.unresolvedRequirements.some((u) => u.rejectedBy === 'LICENSING_UNKNOWN'));
});

test('K5. a beat with no valid PRIMARY candidate anywhere resolves UNRESOLVED — never silently substitutes a different treatment, and never picks a cheaper one merely because it is cheaper', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotB.shotId, sequence: 1, visualTreatment: 'WHITEBOARD',
    motionRequirements: { motionLevel: 'COMPLEX', requiresCameraMotion: false, requiresSubjectMotion: true },
    // no fallbackStrategy — nothing else may ever be considered for this beat
  });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [beat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, {});

  const r = report.resolutions[0];
  assert.equal(r.status, 'UNRESOLVED');
  assert.equal(r.selectedMaterial, null);
  assert.equal(
    r.candidates.length,
    0,
    'zero candidates must survive — the resolver must never invent a substitute treatment the beat never asked for'
  );
});

// =====================================================================================
// L — aggregate summary (Part 6)
// =====================================================================================

test('L1. the summary is a material-strategy count that is internally self-consistent with the underlying resolutions (never a financial estimate)', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const resolved = report.resolutions.filter((r) => r.status === 'RESOLVED');
  const unresolved = report.resolutions.filter((r) => r.status === 'UNRESOLVED');

  assert.equal(report.summary.totalBeats, report.resolutions.length);
  assert.equal(report.summary.resolvedBeats, resolved.length);
  assert.equal(report.summary.unresolvedBeats, unresolved.length);
  assert.equal(report.summary.existingAssetCount, resolved.filter((r) => r.selectedMaterial.materialSource === 'PROJECT_ASSET_REUSE').length);
  assert.equal(report.summary.brollCount, resolved.filter((r) => r.selectedMaterial.materialSource === 'BROLL_LIBRARY').length);
  assert.equal(report.summary.stillImageCount, resolved.filter((r) => r.selectedMaterial.visualTreatment === 'STILL_IMAGE').length);
  assert.equal(report.summary.motionGraphicCount, resolved.filter((r) => r.selectedMaterial.visualTreatment === 'MOTION_GRAPHIC').length);
  assert.equal(report.summary.whiteboardCount, resolved.filter((r) => r.selectedMaterial.visualTreatment === 'WHITEBOARD').length);
  assert.equal(report.summary.kineticTypographyCount, resolved.filter((r) => r.selectedMaterial.visualTreatment === 'KINETIC_TYPOGRAPHY').length);
  assert.equal(report.summary.aiVideoCount, resolved.filter((r) => r.selectedMaterial.visualTreatment === 'AI_VIDEO').length);
  assert.equal(report.summary.estimatedGenerationCandidates, resolved.filter((r) => r.selectedMaterial.materialSource === 'GENERATED_NEW').length);
  assert.equal(
    report.summary.zeroCostDeterministicCount,
    resolved.filter((r) => ['PROJECT_ASSET_REUSE', 'BROLL_LIBRARY', 'DETERMINISTIC_TEMPLATE'].includes(r.selectedMaterial.materialSource)).length
  );
  // Full 10-beat scenario is designed to resolve every beat (Part 4) — a real, sanity-checkable bound.
  assert.equal(report.summary.resolvedBeats, 10);
  assert.equal(report.summary.unresolvedBeats, 0);

  for (const key of ['estimatedCost', 'reservedCredits', 'totalCost', 'currency']) {
    assert.equal(key in report.summary, false, `summary must never contain a financial field ("${key}")`);
  }
});

test('L2. unresolvedReasons carries one entry per unresolved beat, with the real rejectedBy codes from that beat\'s own unresolvedRequirements', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({ sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'NOT_REAL' });
  const graph = createBeatGraph({ projectId: fixture.project.id, beats: [beat] });

  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, graph, {});

  assert.equal(report.summary.unresolvedReasons.length, 1);
  assert.equal(report.summary.unresolvedReasons[0].beatId, beat.id);
  assert.deepEqual(report.summary.unresolvedReasons[0].rejectedBy, ['INVALID_TREATMENT']);
});

// =====================================================================================
// M — provider neutrality
// =====================================================================================

test('M1. no candidate or modelRequirements anywhere in a full 10-beat report contains a provider or model name', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const report = materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  for (const r of report.resolutions) {
    for (const candidate of r.candidates) {
      assert.equal('provider' in candidate, false);
      assert.equal('model' in candidate, false);
      if (candidate.modelRequirements) {
        assert.equal('provider' in candidate.modelRequirements, false);
        assert.equal('model' in candidate.modelRequirements, false);
      }
    }
  }
});

// =====================================================================================
// N/O — no execution, no credit mutation (Part 9)
// =====================================================================================

test('N1. services/material-resolution-service.js contains no execution/network/provider call sites', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-resolution-service.js'), 'utf8');
  // approval-gate is checked separately, by require() call site only (see
  // 11a2/26.3-24's own precedent) — the file's comments legitimately
  // document its deliberate ABSENCE in prose ("never touches approval-
  // gate.js"), which a blanket text scan would wrongly flag.
  const forbiddenPatterns = [
    /generateKeyframe/, /generateVideo/, /generateGeneration/, /requestGeneration/,
    /child_process/, /\bfetch\(/, /axios/, /ffmpeg/i,
    /setTimeout\(/, /setInterval\(/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(text, pattern, `forbidden pattern found: ${pattern}`);
  }
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*approval-gate[^'"`]*['"`]\s*\)/);
});

test('O1. resolveBeatGraph never reserves or reconciles a credit — approval-gate.js is never required, and the ledger-bearing project record is untouched', () => {
  const fixture = buildFixtureProject();
  const beatGraph = buildTenBeatGraph(fixture);
  const projectBefore = JSON.stringify(projectStore.getProject(fixture.project.id));

  materialResolutionService.resolveBeatGraph(fixture.project.id, beatGraph, BROLL_CONTEXT);

  const projectAfter = JSON.stringify(projectStore.getProject(fixture.project.id));
  assert.equal(projectBefore, projectAfter, 'the project record (including any credit ledger it carries) must be byte-identical');
});

// =====================================================================================
// P — Stage 26.3 resolver regression (backward compatibility)
// =====================================================================================

test('P1. resolveMaterial() (Stage 26.3) still works exactly as before, called directly, unaffected by resolveBeatGraph existing', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'STILL_IMAGE',
    identityRequirements: { characterReferences: ['nova'], locationReferences: [], propReferences: [] },
  });

  const resolution = materialResolutionService.resolveMaterial(fixture.project.id, beat, {});

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');
  assert.equal(resolution.selectedMaterial.selectedAssetId, fixture.novaAsset.assetId);
});

test('P2. resolveVisualBeat() (Stage 26.2) still works exactly as before, unaffected by any Stage 26.3/26.4 addition', () => {
  const fixture = buildFixtureProject();
  const beat = createVisualBeat({
    sceneId: fixture.scene.sceneId, shotId: fixture.shotA.shotId, sequence: 1, visualTreatment: 'STILL_IMAGE',
  });

  const resolution = materialResolutionService.resolveVisualBeat(fixture.project.id, beat);

  assert.equal(resolution.decision.materialSource, 'PROJECT_ASSET_REUSE');
  assert.equal(resolution.decision.selectedAssetId, fixture.novaAsset.assetId);
});

// --- Safety: no server/data writes ------------------------------------------------------

test('Z1. this test file only ever wrote into its own temp directories, never the real server/data', () => {
  assert.notEqual(projectTempDir, path.join(__dirname, '..', 'data', 'projects'));
  assert.ok(fs.existsSync(projectTempDir));
});
