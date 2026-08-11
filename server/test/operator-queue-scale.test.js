// Tests for Stage 14, Part 13/15/16/20 — the queue at realistic scale:
// multiple scenes, multiple keyframes per shot, and 10/50/100+ keyframes
// in one project. Also measures (and reports, per Part 20) buildProjectQueue's
// wall-clock time at each scale — this file does NOT assert a specific
// performance threshold (Part 20: "do not optimise prematurely"), it only
// prints the measurement and asserts the queue stays CORRECT at scale
// (right item count, still deterministic, still fast enough to be
// obviously fine for an MVP — a generous upper bound only, not a
// micro-benchmark assertion).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-approvals-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqx-handoffs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const handoffService = require('../services/keyframe-handoff-service');
const keyframeGenerationService = require('../services/keyframe-generation-service');
const oq = require('../services/operator-queue-service');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

function approve(projectId, keyframeId, pkg) {
  approvalStore.requestApproval(projectId, keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost: 2 });
  approvalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: 'tester' });
}

// Builds a project with `sceneCount` scenes, `shotsPerScene` shots each,
// and one keyframe per shot (so total keyframes = sceneCount *
// shotsPerScene). A configurable fraction is taken all the way to
// COMPLETE; the rest just get a built prompt package — enough variety to
// exercise every branch of decideCategory() without every keyframe
// needing the full (slower) handoff+ingest+approve+canonical lifecycle.
//
// Every scene/shot/keyframe is created FIRST, before any package is
// built — otherwise each package's sourceShotVersion/
// sourceKeyframePlanVersion would be pinned to the storyboard/plan
// version AT THE TIME IT WAS BUILT, and since every later
// addStoryboardShot()/createKeyframe() call bumps those versions further,
// only the very LAST package built would still compare CURRENT against
// the final storyboard/plan — an artifact of incremental fixture-
// building, not a queue behavior under test here (staleness itself is
// covered by test 5 in operator-queue-service.test.js).
function buildScaledProject({ sceneCount, shotsPerScene, completeEvery = 10 }) {
  const project = projectStore.createProject({ title: `scale test ${sceneCount}x${shotsPerScene}`, topic: 'x' });

  const shots = [];
  for (let s = 0; s < sceneCount; s += 1) {
    const scene = creativeStore.addStoryboardScene(project.id, { title: `Scene ${s}`, order: s });
    for (let sh = 0; sh < shotsPerScene; sh += 1) {
      const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: `Shot ${s}.${sh}`, order: sh });
      shots.push({ scene, shot });
    }
  }

  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframes = shots.map(({ scene, shot }) =>
    keyframeStore.createKeyframe(project.id, {
      shotId: shot.shotId,
      sceneId: scene.sceneId,
      frameType: 'DETAIL_FRAME',
      sourceShotVersion: storyboard.version,
      order: 0,
    })
  );

  let keyframeIndex = 0;
  for (const kf of keyframes) {
    const pkg = kfp.buildKeyframePromptPackage(project.id, kf.keyframeId);

    // (index + 1), not index — otherwise index 0 always matches "% N ===
    // 0" regardless of N, silently completing the very first keyframe
    // even when the caller asked for nothing to complete (e.g. test 16
    // passing a completeEvery larger than the whole fixture).
    if ((keyframeIndex + 1) % completeEvery === 0) {
      approve(project.id, kf.keyframeId, pkg);
      const handoff = handoffService.createHandoff(project.id, kf.keyframeId, { createdBy: 'x' });
      const ingested = handoffService.ingestHandoffAsset(handoff.handoff.handoffId, PNG_BYTES, { completedBy: 'x' });
      keyframeGenerationService.approveGeneratedKeyframe(project.id, kf.keyframeId, ingested.asset.assetId, { approvedBy: 'x' });
      keyframeStore.selectCanonicalKeyframeAsset(project.id, kf.keyframeId, ingested.asset.assetId, { selectedBy: 'x' });
    }
    keyframeIndex += 1;
  }
  return { project, totalKeyframes: keyframeIndex };
}

// --- 15. multiple keyframes -----------------------------------------------------------

test('15. a project with 10 keyframes across 1 scene produces exactly 10 queue items, correctly categorized', () => {
  const { project, totalKeyframes } = buildScaledProject({ sceneCount: 1, shotsPerScene: 10, completeEvery: 3 });
  const items = oq.buildProjectQueue(project.id);
  assert.equal(items.length, totalKeyframes);
  assert.equal(items.filter((i) => i.category === 'COMPLETE').length, Math.floor(totalKeyframes / 3));
});

// --- 16. multiple scenes --------------------------------------------------------------

test('16. a project with multiple scenes groups/sorts correctly by scene then shot position', () => {
  const { project } = buildScaledProject({ sceneCount: 3, shotsPerScene: 2, completeEvery: 100 });
  const items = oq.buildProjectQueue(project.id);
  assert.equal(items.length, 6);
  // All items share the same category/priority here (none completed), so
  // the ordering falls through to scene/shot position — verify it is
  // monotonic in the scene/shot `order` fields we assigned.
  const sceneNames = items.map((i) => i.sceneName);
  assert.deepEqual(sceneNames, ['Scene 0', 'Scene 0', 'Scene 1', 'Scene 1', 'Scene 2', 'Scene 2'], 'grouped consecutively by scene position, then shot position, since every item shares the same priority');
});

// --- Part 13/20 — 10 / 50 / 100+ keyframes, correctness + timing ----------------------

for (const n of [10, 50, 100]) {
  test(`Part 13/20: buildProjectQueue is correct and fast at ${n} keyframes`, () => {
    const { project, totalKeyframes } = buildScaledProject({ sceneCount: Math.max(1, Math.round(n / 10)), shotsPerScene: 10, completeEvery: 7 });
    assert.equal(totalKeyframes, n);

    const start = process.hrtime.bigint();
    const items = oq.buildProjectQueue(project.id);
    const summary = oq.getQueueSummary(project.id);
    const readiness = oq.getShotReadiness(project.id);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.equal(items.length, n);
    assert.equal(summary.totalKeyframes, n);
    assert.ok(readiness.length > 0);

    // Generous upper bound only (Part 20: measure and report, don't
    // micro-optimize) — this is not a performance target, just a sanity
    // ceiling so a real N+1 regression would fail CI instead of silently
    // shipping. See docs/architecture/operator-queue.md's "Scaling
    // observations" for the actual measured numbers.
    assert.ok(elapsedMs < 5000, `buildProjectQueue+summary+readiness at ${n} keyframes took ${elapsedMs.toFixed(1)}ms — investigate before shipping`);

    console.log(`[Stage 14 Part 20] ${n} keyframes: buildProjectQueue+getQueueSummary+getShotReadiness took ${elapsedMs.toFixed(2)}ms`);
  });
}

test('100+ keyframes: queue remains fully deterministic (same input, same output) at scale', () => {
  const { project } = buildScaledProject({ sceneCount: 11, shotsPerScene: 10, completeEvery: 9 });
  const first = oq.buildProjectQueue(project.id);
  const second = oq.buildProjectQueue(project.id);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 100);
});
