// Stage 26.6, Part 2 — the required integration proof:
//
//   VisualBeat -> real resolveMaterial() -> real executeMaterial()
//   -> compileTimeline()
//
// Neither the resolutions nor the executions are fabricated: every one
// comes from the real Stage 26.3/26.4/26.5A/26.5B services, exactly as
// production code would produce them. Proves the compiler consumes the
// ACTUAL contracts those stages produce — never a duplicated/fabricated
// representation — across all six executor types the real pipeline can
// currently produce: PROJECT_ASSET_REUSE (via AI_VIDEO and STILL_IMAGE),
// KINETIC_TYPOGRAPHY, MOTION_GRAPHIC, WHITEBOARD, and BROLL_CLIP.
//
// Two disposable projects are used (not one) — see the B-roll fixture's
// own comment below for exactly why: TREATMENT_TO_ASSET_TYPES maps BOTH
// AI_VIDEO and BROLL_CLIP to the same underlying asset type ('video'), so
// a project holding both an AI_VIDEO-reuse asset AND a B-roll-registered
// asset would let each treatment's PROJECT_ASSET_REUSE resolution see the
// OTHER beat's video asset too — a real, pre-existing resolver interaction
// (Stage 26.5B Part 4/5 already established and tested this), not
// something to "fix" here. Splitting into two projects isolates each
// executor-type proof cleanly while still exercising the real pipeline
// throughout.
//
// This test produces structured Timeline IR data only. No FFmpeg, no
// HyperFrames, no rendering, no MP4 — "the system knows exactly what
// should appear when."

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-timeline-compiler-proof-projects-'));
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-timeline-compiler-proof-broll-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const brollLibraryService = require('../services/broll-library-service');
const materialResolutionService = require('../services/material-resolution-service');
const executionService = require('../services/material-execution-service');
const { compileTimeline } = require('../services/timeline-compiler-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

function makeStoredAsset(projectId, type) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.bin` });
  timelineStore.setAssetApprovalStatus(projectId, asset.assetId, 'APPROVED');
  return timelineStore.getAsset(projectId, asset.assetId);
}

function resolveAndExecute(projectId, beat, options = {}) {
  const resolution = materialResolutionService.resolveMaterial(projectId, beat, {});
  assert.equal(resolution.status, 'RESOLVED', `beat ${beat.visualTreatment} must genuinely resolve`);
  const execution = executionService.executeMaterial(projectId, beat, resolution, options);
  assert.equal(execution.status, 'COMPLETED', `beat ${beat.visualTreatment} must genuinely execute — diagnostics: ${JSON.stringify(execution.diagnostics)}`);
  return { resolution, execution };
}

test('Stage 26.6 Part 2 — real pipeline proof: VisualBeat -> resolveMaterial() -> executeMaterial() -> compileTimeline() for five executor types in one project', () => {
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.6 DISPOSABLE PROOF', topic: 'timeline compiler proof' });

  const keyframeAsset = makeStoredAsset(project.id, 'keyframe');
  const videoAsset = makeStoredAsset(project.id, 'video');

  function beat(overrides) {
    return createVisualBeat({ sceneId: 's1', shotId: 'sh1', ...overrides });
  }

  const beats = {
    stillImage: beat({ sequence: 1, startTime: 0, duration: 5, visualTreatment: 'STILL_IMAGE' }),
    aiVideo: beat({ sequence: 2, startTime: 5, duration: 4, visualTreatment: 'AI_VIDEO' }),
    kinetic: beat({ sequence: 3, startTime: 9, duration: 3, visualTreatment: 'KINETIC_TYPOGRAPHY' }),
    motionGraphic: beat({ sequence: 4, startTime: 12, duration: 4, visualTreatment: 'MOTION_GRAPHIC' }),
    whiteboard: beat({ sequence: 5, startTime: 16, duration: 3.2, visualTreatment: 'WHITEBOARD' }),
  };

  const executionOptions = {
    [beats.kinetic.id]: { text: 'THE PROBLEM', sequencing: 'WORD_BY_WORD' },
    [beats.motionGraphic.id]: { elements: [{ kind: 'TEXT', label: '$10,000' }, { kind: 'PROGRESS_BAR', props: { value: 0.7 } }] },
    [beats.whiteboard.id]: {
      elements: [
        { kind: 'OBJECT', content: 'wallet', drawDuration: 0.6 },
        { kind: 'TEXT', content: '£100', drawDuration: 0.4 },
        { kind: 'ARROW', drawDuration: 0.5 },
        { kind: 'TEXT', content: '£80', drawDuration: 0.4 },
        { kind: 'EMPHASIS', content: '£80', drawDuration: 0.3, holdDuration: 0.6 },
      ],
    },
  };

  const beatGraph = createBeatGraph({ projectId: project.id, beats: Object.values(beats) });

  const resolutions = [];
  const executions = [];
  for (const b of Object.values(beats)) {
    const { resolution, execution } = resolveAndExecute(project.id, b, executionOptions[b.id] || {});
    resolutions.push(resolution);
    executions.push(execution);
  }

  const result = compileTimeline(beatGraph, resolutions, executions, { projectId: project.id });

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 5);
  assert.deepEqual(result.diagnostics.filter((d) => !['TIMING_INFERRED', 'TIMELINE_GAP'].includes(d.code)), [], 'no real failure diagnostics for a fully valid graph');

  const byBeatId = Object.fromEntries(result.shots.map((s) => [s.beatId, s]));

  for (const [key, b] of Object.entries(beats)) {
    const shot = byBeatId[b.id];
    const resolution = resolutions.find((r) => r.beatId === b.id);
    const execution = executions.find((e) => e.beatId === b.id);

    assert.ok(shot, `beat ${key} (${b.visualTreatment}) must have produced a compiled Shot`);
    assert.equal(shot.beatId, b.id, `${key}: beatId provenance`);
    assert.equal(shot.materialId, resolution.selectedMaterial.candidate, `${key}: materialId provenance`);
    assert.equal(shot.executionId, execution.executionId, `${key}: executionId provenance`);
    assert.equal(shot.duration, execution.duration, `${key}: duration must come from the execution`);
    assert.equal(shot.startTime, b.startTime, `${key}: startTime must resolve to the beat's own explicit startTime`);
    assert.equal(shot.layer, 'PRIMARY', `${key}: every beat here is a single-material PRIMARY beat`);
    assert.deepEqual(shot.renderSpec, execution.renderSpec, `${key}: renderSpec must be carried forward verbatim`);
  }

  assert.equal(byBeatId[beats.stillImage.id].materialId.startsWith('PROJECT_ASSET_REUSE+STILL_IMAGE'), true);
  assert.equal(byBeatId[beats.stillImage.id].keyframeAssetId, keyframeAsset.assetId);
  assert.equal(byBeatId[beats.aiVideo.id].materialId.startsWith('PROJECT_ASSET_REUSE+AI_VIDEO'), true);
  assert.equal(byBeatId[beats.aiVideo.id].videoAssetId, videoAsset.assetId);
  assert.equal(byBeatId[beats.kinetic.id].materialId.startsWith('DETERMINISTIC_TEMPLATE+KINETIC_TYPOGRAPHY'), true);
  assert.equal(byBeatId[beats.motionGraphic.id].materialId.startsWith('DETERMINISTIC_TEMPLATE+MOTION_GRAPHIC'), true);
  assert.equal(byBeatId[beats.whiteboard.id].materialId.startsWith('DETERMINISTIC_TEMPLATE+WHITEBOARD'), true);

  // --- no gaps expected: beats were laid out back-to-back explicitly ---
  assert.equal(result.diagnostics.some((d) => d.code === 'TIMELINE_GAP'), false);
  // --- no timing was inferred: every beat had an explicit startTime ---
  assert.equal(result.diagnostics.some((d) => d.code === 'TIMING_INFERRED'), false);

  // --- purity: repeating compileTimeline() with the SAME real inputs is fully deterministic ---
  const again = compileTimeline(beatGraph, resolutions, executions, { projectId: project.id });
  const strip = (shots) => shots.map(({ shotId, ...rest }) => rest).sort((a, b) => String(a.beatId).localeCompare(String(b.beatId)));
  assert.deepEqual(strip(result.shots), strip(again.shots));

  // --- no mutation of the underlying Asset/project data by the compiler ---
  assert.equal(timelineStore.getAsset(project.id, keyframeAsset.assetId).approvalStatus, 'APPROVED');
  assert.equal(timelineStore.getAsset(project.id, videoAsset.assetId).approvalStatus, 'APPROVED');
  assert.equal(timelineStore.listAssets(project.id).length, 2);
});

test('Stage 26.6 Part 2 — real pipeline proof: BROLL_CLIP, in its own isolated project (see file header)', () => {
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.6 BROLL PROOF', topic: 'timeline compiler broll proof' });

  const brollAsset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(project.id, brollAsset.assetId, { status: 'STORED', provider: 'local', path: `${brollAsset.assetId}.mp4` });
  // Isolates this asset from PROJECT_ASSET_REUSE only — B-roll registration/
  // eligibility never reads approvalStatus (see broll-library-service.js).
  timelineStore.setAssetApprovalStatus(project.id, brollAsset.assetId, 'REJECTED');

  const registration = brollLibraryService.registerBrollSegment(project.id, {
    assetId: brollAsset.assetId,
    source: { type: 'LOCAL_UPLOAD', originalReference: 'city-street.mp4' },
    licensing: { status: 'LICENSED' },
  });
  assert.equal(registration.ok, true);

  const brollBeat = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'BROLL_CLIP' });
  const beatGraph = createBeatGraph({ projectId: project.id, beats: [brollBeat] });

  const { resolution, execution } = resolveAndExecute(project.id, brollBeat);
  assert.equal(resolution.selectedMaterial.materialSource, 'BROLL_LIBRARY');

  const result = compileTimeline(beatGraph, [resolution], [execution], { projectId: project.id });

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 1);
  const shot = result.shots[0];

  assert.equal(shot.beatId, brollBeat.id);
  assert.equal(shot.materialId, resolution.selectedMaterial.candidate);
  assert.equal(shot.materialId.startsWith('BROLL_LIBRARY+BROLL_CLIP'), true);
  assert.equal(shot.executionId, execution.executionId);
  assert.equal(shot.startTime, 0);
  assert.equal(shot.duration, execution.duration);
  assert.equal(shot.layer, 'PRIMARY');
  assert.deepEqual(shot.renderSpec, execution.renderSpec);
  assert.equal(shot.renderSpec.type, 'BROLL_CLIP');
  assert.equal(shot.renderSpec.brollSegmentId, registration.segment.id);
  assert.equal(shot.videoAssetId, brollAsset.assetId);

  // --- no mutation of Asset/B-roll data by the compiler ---
  assert.equal(brollLibraryService.getBrollSegment(project.id, registration.segment.id).status, 'ACTIVE');
  assert.equal(timelineStore.getAsset(project.id, brollAsset.assetId).approvalStatus, 'REJECTED');
  assert.equal(brollLibraryService.listBrollSegments(project.id).length, 1);

  // --- no real project data was touched — this project only ever lived in the temp dirs above ---
  assert.notEqual(projectTempDir, path.join(__dirname, '..', 'data', 'projects'));
  assert.notEqual(brollTempDir, path.join(__dirname, '..', 'data', 'broll'));
});
