// keyframe-prompt-schema.js
//
// Stage 13A — the KEYFRAME PROMPT PACKAGING layer. Defines the shape of a
// KeyframePromptPackage: the final structured specification a FUTURE
// image-generation stage could consume for one planned keyframe. Same
// rules as schemas/keyframe-schema.js and schemas/creative-schema.js:
// plain object factories only, no file I/O, no provider knowledge, every
// field defaults to null/[] so partial data is always valid, nothing here
// invents information.
//
// THE `prompt` FIELD IS DERIVED. The structured fields (identityLock,
// wardrobeLock, environmentLock, composition, camera, lighting, ...)
// remain the source of truth — `prompt` is only ever a deterministic
// composition of `promptSections`, built by
// services/keyframe-prompt-service.js. Nothing in this file (or that
// service) calls a provider, executes a skill, or generates media.
//
// See docs/architecture/keyframe-prompt-packaging.md and
// services/keyframe-prompt-service.js for how these get populated.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// Part 2 — the fixed set of prompt sections a derived prompt is composed
// from. Each is stored individually (never one opaque blob) so a human can
// inspect exactly which structured input produced which sentence.
const PROMPT_SECTION_KEYS = [
  'SUBJECT',
  'IDENTITY',
  'WARDROBE',
  'ENVIRONMENT',
  'ACTION',
  'COMPOSITION',
  'CAMERA',
  'LIGHTING',
  'COLOUR',
  'ATMOSPHERE',
  'CONTINUITY',
  'NEGATIVE_CONSTRAINTS',
];

function createPromptSections(overrides = {}) {
  const base = {};
  for (const key of PROMPT_SECTION_KEYS) base[key] = null;
  return withDefaults(base, overrides);
}

// Part 12 — CURRENT means the package still matches the storyboard/
// keyframe-plan versions it was built from; STALE means either has since
// changed. No automatic transitions exist — see keyframe-prompt-service.js.
const PACKAGE_STATUSES = ['CURRENT', 'STALE'];

// Stage 16, Part 2 — the minimum additive vocabulary needed to distinguish
// WHAT an existingReferenceAssets entry is a reference FOR. This does not
// replace or restructure `role` (the existing free-text label like
// "character:Aria", set by keyframe-prompt-service.js's
// resolveExistingReferenceAssets) — it adds one new, optional,
// machine-checkable field alongside it. A reference entry (or a whole
// package) built before this field existed simply has `roleType: undefined`
// on its entries; every reader treats that the same as 'OTHER', never as an
// error — see evolink-image-mapper.js and image-generation-executor.js.
const REFERENCE_ROLE_TYPES = ['CHARACTER', 'ENVIRONMENT', 'WARDROBE', 'PROP', 'STYLE', 'OTHER'];

// Part 4 — one character's identity lock: what must never change about
// them, carried forward from the Visual Bible verbatim (never invented).
function createIdentityLockEntry(overrides = {}) {
  const base = {
    characterId: null,
    name: null,
    facialCharacteristics: null,
    bodyCharacteristics: null,
    hair: null,
    skinDescription: null,
    behaviour: null,
    identityConstraints: null,
    continuityNotes: null,
  };
  return withDefaults(base, overrides);
}

// Part 5 — one character's wardrobe lock. `wardrobeOverride` is set only
// when the shot itself records a deliberate wardrobe change (Part 5: "do
// not silently replace the Visual Bible wardrobe" — the base `wardrobe`
// field always stays the Visual Bible's own value; a shot-specific change
// is recorded ADDITIONALLY, never in place of it).
function createWardrobeLockEntry(overrides = {}) {
  const base = {
    characterId: null,
    name: null,
    wardrobe: null,
    accessories: [],
    continuityNotes: null,
    wardrobeOverride: null,
  };
  return withDefaults(base, overrides);
}

// Part 6 — one location's environment lock, carried forward from the
// Visual Bible's persistent rules for that location.
function createEnvironmentLockEntry(overrides = {}) {
  const base = {
    locationId: null,
    name: null,
    architecture: null,
    geography: null,
    materials: null,
    colourPalette: null,
    lighting: null,
    atmosphere: null,
    recurringElements: [],
    continuityConstraints: null,
  };
  return withDefaults(base, overrides);
}

// Part 1 — the package itself.
function createKeyframePromptPackage(overrides = {}) {
  const base = {
    packageId: crypto.randomUUID(),
    projectId: null,
    keyframeId: null,
    shotId: null,
    sceneId: null,
    version: 1,
    sourceShotVersion: null,
    sourceKeyframePlanVersion: null,
    purpose: null,
    frameType: null,
    subject: null,
    characterReferences: [],
    locationReferences: [],
    propReferences: [],
    // Part 7 — approved assets already satisfying a reference requirement.
    existingReferenceAssets: [],
    // Part 4/5/6 — arrays: a shot can reference more than one character or
    // location, so each lock is its own array of per-entity entries.
    identityLock: [],
    wardrobeLock: [],
    environmentLock: [],
    composition: null,
    camera: null,
    framing: null,
    lens: null,
    movementIntent: null,
    lighting: null,
    colour: null,
    atmosphere: null,
    continuityRequirements: [],
    negativeConstraints: [],
    // Part 2/10 — DERIVED. promptSections is the structured breakdown;
    // prompt is its deterministic composition. Neither is ever hand-authored
    // here, and neither is ever the source of truth for anything above.
    prompt: null,
    promptSections: createPromptSections(),
    // Part 11 — recorded only, never executed.
    recommendedSkill: null,
    recommendationReason: null,
    status: 'CURRENT',
    warnings: [],
    generatedAt: new Date().toISOString(),
    // Part 13 — lightweight versioning, same pattern as creative-store.js.
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    changeNote: null,
    history: [],
  };
  return withDefaults(base, overrides);
}

module.exports = {
  PROMPT_SECTION_KEYS,
  PACKAGE_STATUSES,
  REFERENCE_ROLE_TYPES,
  createPromptSections,
  createIdentityLockEntry,
  createWardrobeLockEntry,
  createEnvironmentLockEntry,
  createKeyframePromptPackage,
};
