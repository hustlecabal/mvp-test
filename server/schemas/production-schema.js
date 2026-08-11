// production-schema.js
//
// This file defines the SHAPE of everything the video factory works with:
// a project (Creative IR), scenes/shots/assets/generation requests
// (Timeline IR), and how assets link back to their sources (lineage).
//
// It does NOT read or write files, and it does NOT know about EvoLink or
// any other provider by name. It only builds plain JS objects with sane
// defaults. Nothing here is ever required to be fully filled in — every
// field defaults to null, '', {} or [] so partial data is always valid.

const crypto = require('crypto');

// Kinds of assets the system knows about. This list is descriptive, not
// enforced — new types can show up without changing this file.
const ASSET_TYPES = ['character_reference', 'location_reference', 'keyframe', 'video'];

// Applies overrides on top of a set of defaults, but skips any override
// whose value is undefined. A plain { ...base, ...overrides } would let an
// explicit `{ audience: undefined }` wipe out the default '' — and since
// JSON.stringify drops undefined properties entirely, the field would
// silently vanish from the saved file instead of staying an empty string.
function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Creative IR — the "what is this video about, and creatively how" layer.
// Each field here is meant to be owned by a different creative skill (e.g.
// research, creative direction, story, script, visual bible), so a skill
// can fill in its own section without needing to touch, understand, or
// overwrite anyone else's.
// ---------------------------------------------------------------------------
function createCreativeIR(overrides = {}) {
  const base = {
    audience: '',
    tone: '',
    creativeMode: '',
    research: {},
    creativeDirection: {},
    story: {},
    script: {},
    characters: [],
    locations: [],
    visualBible: {},
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Timeline / Production IR — the "how does this actually get assembled
// into a video" layer: scenes, shots, assets, audio, transitions, and
// output settings.
// ---------------------------------------------------------------------------
function createTimelineIR(overrides = {}) {
  const base = {
    scenes: [],
    shots: [],
    assets: [],
    audio: [],
    transitions: [],
    outputSettings: {},
    generations: [],
  };
  return withDefaults(base, overrides);
}

function createScene(overrides = {}) {
  const base = {
    sceneId: crypto.randomUUID(),
    title: '',
    order: null,
    description: '',
  };
  return withDefaults(base, overrides);
}

// A shot links back to its scene via sceneId rather than being nested
// inside it, so project.shots stays one flat, easy-to-scan list.
function createShot(overrides = {}) {
  const base = {
    shotId: crypto.randomUUID(),
    sceneId: null,
    startTime: null,
    duration: null,
    narrativePurpose: '',
    characters: [],
    locations: [],
    composition: null,
    camera: null,
    subjectAction: '',
    environmentAction: '',
    audio: null,
    screenText: null,
    references: [],
    keyframePrompt: null,
    motionPrompt: null,
    mustPreserve: [],
    mustChange: [],
    keyframeAssetId: null,
    videoAssetId: null,
    generationId: null,
    status: 'PLANNED',
    approvalStatus: 'NONE',
  };
  return withDefaults(base, overrides);
}

// A provider-agnostic request to generate something. "provider" and
// "model" are plain strings, deliberately left blank by default —
// filling in a real model id happens later, against verified provider
// docs, never guessed here.
function createGenerationRequest(overrides = {}) {
  const base = {
    generationId: crypto.randomUUID(),
    provider: null,
    model: null,
    task: null,
    references: [],
    prompt: null,
    parameters: {},
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

// An asset record traces one generated (or referenced) piece of media back
// to the project, scene, shot, whatever it was derived from, and what made
// it. Every asset is version 1 the first time it's created.
function createAsset(overrides = {}) {
  const base = {
    assetId: crypto.randomUUID(),
    projectId: null,
    type: null, // see ASSET_TYPES
    sceneId: null,
    shotId: null,
    parentAssetId: null,
    version: 1,
    prompt: null,
    provider: null,
    model: null,
    generationId: null,
    approvalStatus: 'NONE',
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

// Creates a new asset that supersedes an existing one, WITHOUT ever
// mutating the original. This is how "don't overwrite approved assets" is
// enforced: there simply is no function anywhere that edits an asset in
// place. Wanting a changed version always means calling this, which
// produces a brand-new asset linked back to the old one via parentAssetId.
function createNextAssetVersion(previousAsset, overrides = {}) {
  if (!previousAsset || !previousAsset.assetId) {
    throw new Error('previousAsset (an existing asset object) is required');
  }
  return createAsset(
    withDefaults(
      {
        projectId: previousAsset.projectId,
        type: previousAsset.type,
        sceneId: previousAsset.sceneId,
        shotId: previousAsset.shotId,
        prompt: previousAsset.prompt,
        provider: previousAsset.provider,
        model: previousAsset.model,
        generationId: previousAsset.generationId,
      },
      {
        ...overrides,
        // Always correct, regardless of what's in overrides: a "next
        // version" can never point anywhere but back at previousAsset,
        // and can never reuse its version number.
        parentAssetId: previousAsset.assetId,
        version: previousAsset.version + 1,
      }
    )
  );
}

// ---------------------------------------------------------------------------
// The full blank project: project identity plus the Creative IR and
// Timeline IR layers, plus the approval/budget gate fields from Stage 3.
// ---------------------------------------------------------------------------
function createBlankProject(overrides = {}) {
  const { title, topic, audience, tone, creativeMode, ...rest } = overrides;
  const now = new Date().toISOString();

  return withDefaults(
    {
      id: crypto.randomUUID(),
      title: title || '',
      topic: topic || '',
      status: 'PLANNING',
      createdAt: now,
      updatedAt: now,
      ...createCreativeIR({ audience, tone, creativeMode }),
      ...createTimelineIR(),
      approvals: {},
      creditLedger: {},
    },
    rest
  );
}

module.exports = {
  ASSET_TYPES,
  createCreativeIR,
  createTimelineIR,
  createScene,
  createShot,
  createGenerationRequest,
  createAsset,
  createNextAssetVersion,
  createBlankProject,
};
