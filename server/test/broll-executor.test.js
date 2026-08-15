// Tests for services/material-executors/broll-executor.js — deterministic
// BROLL_CLIP render specs from an ALREADY-SELECTED B-roll material. This
// executor never searches/ranks/selects a B-roll segment itself — every
// test here hands it a pre-built CandidateResult, exactly like
// project-asset-reuse-executor.test.js does for PROJECT_ASSET_REUSE. See
// test/broll-execution-integration.test.js for the real
// resolveMaterial() -> executeMaterial() end-to-end proof.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-executor-projects-'));
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-executor-library-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const brollLibraryService = require('../services/broll-library-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createCandidateResult } = require('../schemas/material-resolution-schema');
const executor = require('../services/material-executors/broll-executor');

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.mp4` });
  return timelineStore.getAsset(projectId, asset.assetId);
}

// A real project + a real, ACTIVE, LICENSED B-roll segment referencing a
// real, STORED video asset — the "everything is exactly as Material
// Resolution would have left it" baseline every test starts from.
function setup(licensingStatus = 'LICENSED', mediaOverrides = {}) {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const result = brollLibraryService.registerBrollSegment(project.id, {
    assetId: asset.assetId,
    source: { type: 'LOCAL_UPLOAD' },
    licensing: { status: licensingStatus },
    media: mediaOverrides,
  });
  assert.equal(result.ok, true, `fixture setup failed: ${result.reason}`);
  return { project, asset, segment: result.segment };
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'BROLL_CLIP', ...overrides });
}

// Builds a CandidateResult exactly as services/material-resolution-
// service.js's real BROLL_LIBRARY block would (see brollSegment lineage
// shape there), but directly — this file exercises the EXECUTOR alone.
function candidate(segment, assetId, overrides = {}) {
  return createCandidateResult({
    candidate: `BROLL_LIBRARY+BROLL_CLIP:${segment.id}`,
    materialSource: 'BROLL_LIBRARY',
    visualTreatment: 'BROLL_CLIP',
    selectedAssetId: assetId,
    eligibleRoles: ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT'],
    brollSegment: {
      segmentId: segment.id,
      assetId: segment.assetId,
      licensing: segment.licensing,
      source: segment.source,
      media: segment.media,
      descriptiveMetadata: segment.descriptiveMetadata,
      usage: segment.usage,
    },
    ...overrides,
  });
}

// --- BR1 — valid execution -------------------------------------------------------------------

test('BR1. a valid ACTIVE/LICENSED segment referencing a STORED video asset produces a COMPLETED BROLL_CLIP render spec with explicit deterministic defaults', () => {
  const { project, asset, segment } = setup();
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(segment, asset.assetId) });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'BROLL_CLIP');
  assert.equal(result.beatId, b.id);
  assert.equal(result.duration, 5);
  assert.deepEqual(result.sourceAssetIds, [asset.assetId]);
  assert.equal(result.diagnostics.length, 0);

  const spec = result.renderSpec;
  assert.equal(spec.type, 'BROLL_CLIP');
  assert.equal(spec.sourceAssetId, asset.assetId);
  assert.equal(spec.brollSegmentId, segment.id);
  assert.equal(spec.startTime, 0);
  assert.equal(spec.duration, 5);
  assert.equal(spec.trimIn, 0, 'trimIn defaults to 0');
  assert.equal(spec.trimOut, 5, 'trimOut derives from duration * playbackRate when media duration is unknown');
  assert.equal(spec.playbackRate, 1, 'playbackRate defaults to 1');
  assert.equal(spec.fit, 'COVER', 'fit defaults to COVER');
  assert.equal(spec.audioPolicy, 'MUTE', 'audioPolicy defaults to MUTE');
  assert.equal(spec.transform, null);
  assert.deepEqual(spec.position, { x: 0, y: 0 });
  assert.equal(spec.scale, 1);
  assert.equal(spec.opacity, 1);
  assert.equal(spec.role, 'PRIMARY');
});

// --- BR2 — missing B-roll segment -------------------------------------------------------------------

test('BR2. a B-roll segment id that does not exist in the library fails with SEGMENT_NOT_FOUND', () => {
  const { project, asset, segment } = setup();
  const b = beat();

  const fakeCandidate = candidate(segment, asset.assetId, { brollSegment: { segmentId: crypto.randomUUID(), assetId: asset.assetId, licensing: { status: 'LICENSED' } } });
  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: fakeCandidate });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.renderSpec, null);
  assert.equal(result.diagnostics[0].code, 'SEGMENT_NOT_FOUND');
});

// --- BR3 — archived B-roll -------------------------------------------------------------------

test('BR3. an ARCHIVED B-roll segment fails with SEGMENT_NOT_ACTIVE', () => {
  const { project, asset, segment } = setup();
  brollLibraryService.archiveBrollSegment(project.id, segment.id);
  const b = beat();

  const result = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(segment, asset.assetId) });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'SEGMENT_NOT_ACTIVE');
});

// --- BR4/BR5/BR6 — non-LICENSED licensing -------------------------------------------------------------------

test('BR4. UNKNOWN licensing fails with SEGMENT_NOT_LICENSED', () => {
  const { project, asset, segment } = setup('UNKNOWN');
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'SEGMENT_NOT_LICENSED');
});

test('BR5. RESTRICTED licensing fails with SEGMENT_NOT_LICENSED — the executor never grants a permission Material Resolution did not', () => {
  const { project, asset, segment } = setup('RESTRICTED');
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'SEGMENT_NOT_LICENSED');
});

test('BR6. REJECTED licensing fails with SEGMENT_NOT_LICENSED', () => {
  const { project, asset, segment } = setup('REJECTED');
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'SEGMENT_NOT_LICENSED');
});

// --- BR7/BR8/BR9 — Asset-level defensive checks -------------------------------------------------------------------

test('BR7. a selectedAssetId that does not exist fails with ASSET_NOT_FOUND', () => {
  const { project, segment } = setup();
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, crypto.randomUUID()) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_NOT_FOUND');
});

test('BR8. a selectedAssetId pointing at a non-video asset fails with ASSET_WRONG_TYPE', () => {
  const { project, segment } = setup();
  const keyframeAsset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, keyframeAsset.assetId, { status: 'STORED' });

  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, keyframeAsset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_WRONG_TYPE');
});

test('BR9. a video asset that is not STORED fails with ASSET_NOT_USABLE', () => {
  const { project, segment } = setup();
  const unstoredAsset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' }); // storage.status defaults to NOT_ARCHIVED

  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, unstoredAsset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_NOT_USABLE');
});

// --- BR10/BR11 — missing required candidate fields -------------------------------------------------------------------

test('BR10. a missing selectedAssetId fails with MISSING_ASSET_ID rather than throwing', () => {
  const { project, segment } = setup();
  assert.doesNotThrow(() => {
    const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, null) });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'MISSING_ASSET_ID');
  });
});

test('BR11. a missing brollSegment (or missing segmentId) fails with MISSING_SEGMENT_ID rather than throwing — this is exactly what happens to a Stage 26.3 legacy fixture candidate', () => {
  const { project, asset, segment } = setup();
  assert.doesNotThrow(() => {
    const noLineage = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId, { brollSegment: null }) });
    assert.equal(noLineage.status, 'FAILED');
    assert.equal(noLineage.diagnostics[0].code, 'MISSING_SEGMENT_ID');

    const noSegmentId = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId, { brollSegment: { assetId: asset.assetId } }) });
    assert.equal(noSegmentId.status, 'FAILED');
    assert.equal(noSegmentId.diagnostics[0].code, 'MISSING_SEGMENT_ID');
  });
});

// --- BR12 — wrong materialSource/visualTreatment -------------------------------------------------------------------

test('BR12. a candidate whose materialSource or visualTreatment is not BROLL_LIBRARY/BROLL_CLIP fails with INVALID_MATERIAL, never throws', () => {
  const { project, asset, segment } = setup();

  const wrongSource = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId, { materialSource: 'PROJECT_ASSET_REUSE' }) });
  assert.equal(wrongSource.diagnostics[0].code, 'INVALID_MATERIAL');

  const wrongTreatment = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId, { visualTreatment: 'AI_VIDEO' }) });
  assert.equal(wrongTreatment.diagnostics[0].code, 'INVALID_MATERIAL');

  assert.doesNotThrow(() => executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: null }));
  assert.equal(executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: null }).diagnostics[0].code, 'INVALID_MATERIAL');
});

// --- BR13 — invalid timing -------------------------------------------------------------------

test('BR13. invalid timing (negative startTime, zero/negative duration) fails structurally', () => {
  const { project, asset, segment } = setup();

  const negativeStart = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { startTime: -1, duration: 3 } });
  assert.equal(negativeStart.diagnostics[0].code, 'INVALID_START_TIME');

  const zeroDuration = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { startTime: 0, duration: 0 } });
  assert.equal(zeroDuration.diagnostics[0].code, 'INVALID_DURATION');
});

// --- BR14 — invalid playbackRate -------------------------------------------------------------------

test('BR14. a zero or negative playbackRate fails with INVALID_PLAYBACK_RATE', () => {
  const { project, asset, segment } = setup();
  const zero = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { playbackRate: 0 } });
  assert.equal(zero.diagnostics[0].code, 'INVALID_PLAYBACK_RATE');
  const negative = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { playbackRate: -1 } });
  assert.equal(negative.diagnostics[0].code, 'INVALID_PLAYBACK_RATE');
});

// --- BR15/BR16 — invalid trim -------------------------------------------------------------------

test('BR15. a negative trimIn fails with INVALID_TRIM_IN', () => {
  const { project, asset, segment } = setup();
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { trimIn: -0.5 } });
  assert.equal(result.diagnostics[0].code, 'INVALID_TRIM_IN');
});

test('BR16. an explicit trimOut at or before trimIn fails with INVALID_TRIM_OUT', () => {
  const { project, asset, segment } = setup();
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { trimIn: 2, trimOut: 2 } });
  assert.equal(result.diagnostics[0].code, 'INVALID_TRIM_OUT');
});

// --- BR17 — trim exceeds known media duration -------------------------------------------------------------------

test('BR17. an explicit trimOut beyond a KNOWN media duration fails with TRIM_EXCEEDS_KNOWN_DURATION', () => {
  const { project, asset, segment } = setup('LICENSED', { duration: 10 });
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { trimIn: 0, trimOut: 15 } });
  assert.equal(result.diagnostics[0].code, 'TRIM_EXCEEDS_KNOWN_DURATION');
});

test('BR17b. the derived default trimOut (duration * playbackRate) is ALSO validated against a known media duration', () => {
  const { project, asset, segment } = setup('LICENSED', { duration: 3 });
  const result = executor.execute({ projectId: project.id, beat: beat({ duration: 10 }), selectedMaterial: candidate(segment, asset.assetId) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'TRIM_EXCEEDS_KNOWN_DURATION');
});

// --- BR18/BR20 — trimFromEnd -------------------------------------------------------------------

test('BR18. trimFromEnd with an UNKNOWN media duration fails safely with UNKNOWN_MEDIA_DURATION, never guesses', () => {
  const { project, asset, segment } = setup(); // media.duration stays null (unknown) by default
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { trimFromEnd: true } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'UNKNOWN_MEDIA_DURATION');
});

test('BR19. trimFromEnd with a KNOWN media duration derives trimOut = that known duration', () => {
  const { project, asset, segment } = setup('LICENSED', { duration: 8 });
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { trimFromEnd: true, trimIn: 1 } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.trimOut, 8);
  assert.equal(result.renderSpec.trimIn, 1);
});

test('BR20. trimFromEnd where trimIn leaves no room before the known duration fails with IMPOSSIBLE_TRIM', () => {
  const { project, asset, segment } = setup('LICENSED', { duration: 5 });
  const result = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { trimFromEnd: true, trimIn: 5 } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'IMPOSSIBLE_TRIM');
});

// --- BR21 — unknown duration does not block a default (non trim-dependent) execution -------------------------------------------------------------------

test('BR21. unknown media duration never blocks an ordinary execution that does not depend on it (no trimOut/trimFromEnd requested)', () => {
  const { project, asset, segment } = setup(); // media.duration null
  const result = executor.execute({ projectId: project.id, beat: beat({ duration: 4 }), selectedMaterial: candidate(segment, asset.assetId) });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.trimOut, 4);
});

// --- BR22 — determinism -------------------------------------------------------------------

test('BR22. deterministic output — identical input produces an identical render spec across repeated calls', () => {
  const { project, asset, segment } = setup();
  const b = beat();
  const options = { startTime: 1, duration: 3, trimIn: 0.5, playbackRate: 1.5, fit: 'CONTAIN', audioPolicy: 'KEEP', position: { x: 0.2, y: 0.1 }, scale: 1.1 };

  const first = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(segment, asset.assetId), options });
  const second = executor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate(segment, asset.assetId), options });

  assert.deepEqual(first.renderSpec, second.renderSpec);
  assert.equal(first.executorType, second.executorType);
  assert.deepEqual(first.sourceAssetIds, second.sourceAssetIds);
  assert.deepEqual(first.diagnostics, second.diagnostics);
});

// --- BR23 — no mutation -------------------------------------------------------------------

test('BR23. execution never mutates the referenced Asset or the B-roll segment record', () => {
  const { project, asset, segment } = setup();
  const beforeAsset = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  const beforeSegment = JSON.stringify(brollLibraryService.getBrollSegment(project.id, segment.id));

  executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { scale: 3, trimIn: 1 } });
  executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId) });

  assert.equal(JSON.stringify(timelineStore.getAsset(project.id, asset.assetId)), beforeAsset);
  assert.equal(JSON.stringify(brollLibraryService.getBrollSegment(project.id, segment.id)), beforeSegment);
});

// --- BR24 — no provider/network -------------------------------------------------------------------

test('BR24. no provider/network calls — services/material-executors/broll-executor.js requires only timeline-store, broll-library-service, and the execution schema', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executors', 'broll-executor.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../timeline-store', '../broll-library-service', '../../schemas/material-execution-schema'].sort());
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

// --- BR25 — explicit fit/audioPolicy honored, invalid values fall back to defaults -------------------------------------------------------------------

test('BR25. an explicit valid fit/audioPolicy is honored exactly; an invalid value falls back to the deterministic default rather than being silently passed through', () => {
  const { project, asset, segment } = setup();

  const explicit = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { fit: 'FILL', audioPolicy: 'DUCK' } });
  assert.equal(explicit.renderSpec.fit, 'FILL');
  assert.equal(explicit.renderSpec.audioPolicy, 'DUCK');

  const invalid = executor.execute({ projectId: project.id, beat: beat(), selectedMaterial: candidate(segment, asset.assetId), options: { fit: 'STRETCH_WEIRDLY', audioPolicy: 'BLAST' } });
  assert.equal(invalid.renderSpec.fit, 'COVER');
  assert.equal(invalid.renderSpec.audioPolicy, 'MUTE');
});
