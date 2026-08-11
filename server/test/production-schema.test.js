// Tests for services/../schemas/production-schema.js — the shapes of
// projects, scenes, shots, assets, and generation requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/production-schema');

test('createBlankProject includes both Creative IR and Timeline IR fields', () => {
  const project = schema.createBlankProject({ title: 'Nokia Story', topic: 'x' });

  // Creative IR
  assert.equal(project.audience, '');
  assert.equal(project.tone, '');
  assert.equal(project.creativeMode, '');
  assert.deepEqual(project.research, {});
  assert.deepEqual(project.creativeDirection, {});
  assert.deepEqual(project.story, {});
  assert.deepEqual(project.script, {});
  assert.deepEqual(project.characters, []);
  assert.deepEqual(project.locations, []);
  assert.deepEqual(project.visualBible, {});

  // Timeline IR
  assert.deepEqual(project.scenes, []);
  assert.deepEqual(project.shots, []);
  assert.deepEqual(project.assets, []);
  assert.deepEqual(project.audio, []);
  assert.deepEqual(project.transitions, []);
  assert.deepEqual(project.outputSettings, {});
  assert.deepEqual(project.generations, []);
});

test('createBlankProject accepts optional audience, tone, and creativeMode', () => {
  const project = schema.createBlankProject({
    title: 'x',
    topic: 'y',
    audience: 'young professionals',
    tone: 'nostalgic',
    creativeMode: 'documentary',
  });

  assert.equal(project.audience, 'young professionals');
  assert.equal(project.tone, 'nostalgic');
  assert.equal(project.creativeMode, 'documentary');
});

test('createScene fills in a fresh id and sensible defaults', () => {
  const scene = schema.createScene({ title: 'Opening scene' });
  assert.ok(scene.sceneId);
  assert.equal(scene.title, 'Opening scene');
  assert.equal(scene.order, null);
});

test('createShot has every documented field, unpopulated fields stay null/empty', () => {
  const sceneId = schema.createScene().sceneId;
  const shot = schema.createShot({ sceneId, narrativePurpose: 'establish the setting' });

  assert.ok(shot.shotId);
  assert.equal(shot.sceneId, sceneId);
  assert.equal(shot.narrativePurpose, 'establish the setting');
  assert.equal(shot.startTime, null);
  assert.equal(shot.duration, null);
  assert.deepEqual(shot.characters, []);
  assert.deepEqual(shot.locations, []);
  assert.equal(shot.composition, null);
  assert.equal(shot.camera, null);
  assert.equal(shot.keyframePrompt, null);
  assert.equal(shot.motionPrompt, null);
  assert.deepEqual(shot.mustPreserve, []);
  assert.deepEqual(shot.mustChange, []);
  assert.equal(shot.keyframeAssetId, null);
  assert.equal(shot.videoAssetId, null);
  assert.equal(shot.generationId, null);
  assert.equal(shot.status, 'PLANNED');
  assert.equal(shot.approvalStatus, 'NONE');
});

test('createGenerationRequest is provider-agnostic and never invents a model id', () => {
  const request = schema.createGenerationRequest({ provider: 'evolink', task: 'keyframe_generation' });

  assert.ok(request.generationId);
  assert.equal(request.provider, 'evolink');
  assert.equal(request.model, null); // no model id guessed
  assert.equal(request.task, 'keyframe_generation');
  assert.deepEqual(request.references, []);
  assert.deepEqual(request.parameters, {});
  assert.equal(request.status, 'PENDING');
});

test('createGenerationRequest works the same for a completely different provider', () => {
  const request = schema.createGenerationRequest({ provider: 'longcat', task: 'motion_generation' });
  assert.equal(request.provider, 'longcat');
  assert.equal(request.task, 'motion_generation');
});

test('createAsset is traceable to project, scene, shot, prompt, provider, model, and generation', () => {
  const asset = schema.createAsset({
    projectId: 'proj-1',
    type: 'keyframe',
    sceneId: 'scene-1',
    shotId: 'shot-1',
    prompt: 'a lone lighthouse at dusk',
    provider: 'evolink',
    model: 'PLACEHOLDER_MODEL_ID',
    generationId: 'gen-1',
  });

  assert.ok(asset.assetId);
  assert.equal(asset.projectId, 'proj-1');
  assert.equal(asset.sceneId, 'scene-1');
  assert.equal(asset.shotId, 'shot-1');
  assert.equal(asset.prompt, 'a lone lighthouse at dusk');
  assert.equal(asset.provider, 'evolink');
  assert.equal(asset.model, 'PLACEHOLDER_MODEL_ID');
  assert.equal(asset.generationId, 'gen-1');
  assert.equal(asset.parentAssetId, null);
  assert.equal(asset.version, 1);
  assert.equal(asset.approvalStatus, 'NONE');
  assert.equal(asset.url, null);
  assert.deepEqual(asset.references, []);
});

test('createNextAssetVersion never mutates the original asset', () => {
  const original = schema.createAsset({ prompt: 'v1 prompt', provider: 'evolink' });
  original.approvalStatus = 'APPROVED'; // simulate an approved asset

  const snapshotBefore = JSON.stringify(original);
  const next = schema.createNextAssetVersion(original, { prompt: 'v2 prompt' });

  assert.equal(JSON.stringify(original), snapshotBefore, 'original asset object must be untouched');
  assert.notEqual(next.assetId, original.assetId, 'a new version gets a new id');
  assert.equal(next.parentAssetId, original.assetId);
  assert.equal(next.version, 2);
  assert.equal(next.prompt, 'v2 prompt');
});

test('createNextAssetVersion cannot be tricked into skipping the version chain', () => {
  const original = schema.createAsset();
  // Even if a caller tries to override parentAssetId/version directly,
  // the real lineage always wins.
  const next = schema.createNextAssetVersion(original, { parentAssetId: 'someone-else', version: 99 });

  assert.equal(next.parentAssetId, original.assetId);
  assert.equal(next.version, 2);
});

test('createNextAssetVersion requires a real previous asset', () => {
  assert.throws(() => schema.createNextAssetVersion(null));
  assert.throws(() => schema.createNextAssetVersion({}));
});

test('createGenerationJob distinguishes estimatedCost, reservedCost, and actualCost, all defaulting to null', () => {
  const job = schema.createGenerationJob({
    projectId: 'proj-1',
    shotId: 'shot-1',
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'x',
  });

  assert.ok(job.id);
  assert.equal(job.status, 'REQUESTED');
  assert.equal(job.providerTaskId, null);
  assert.equal(job.estimatedCost, null);
  assert.equal(job.reservedCost, null);
  assert.equal(job.actualCost, null);
  assert.equal(job.result, null);
  assert.equal(job.assetId, null);
  assert.equal(job.error, null);
  assert.equal(job.lastPollError, null);
  assert.ok(job.createdAt);
  assert.equal(job.submittedAt, null);
  assert.equal(job.completedAt, null);
});
