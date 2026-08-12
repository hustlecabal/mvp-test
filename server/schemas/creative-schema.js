// creative-schema.js
//
// Stage 11A — the CREATIVE INTELLIGENCE layer. This file defines the SHAPE
// of the structured creative-planning artifacts that will eventually sit
// BEFORE keyframes and video generation: Creative Brief, Master Creative
// Specification, Visual Bible (with Characters/Locations/Props), and
// Storyboard (Scenes/Shots). See docs/architecture/creative-intelligence.md.
//
// Same rules as schemas/production-schema.js, deliberately followed:
//   - plain JS object factories only — no file I/O, no provider knowledge
//   - every field defaults to null/''/[] so partial data is always valid
//   - nothing here invents information the user hasn't supplied
//
// This is a SEPARATE artifact family from schemas/production-schema.js's
// Timeline IR (project.scenes/project.shots, used for actual generation
// jobs). Storyboard scenes/shots here are the creative-planning layer —
// richer, purely descriptive, and never touched by the state machine or
// approval/budget gate. A future stage will define how a storyboard shot
// eventually maps to a Timeline IR shot; this stage only stores the
// creative decision, never acts on it.

const crypto = require('crypto');

// Same helper as production-schema.js: applies overrides but skips
// `undefined` values, so an explicit `{ field: undefined }` never wipes a
// default to nothing.
function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// Stage 19 — the entity-type vocabulary the Reference Library groups by.
// Deliberately the same spelling as Stage 16's REFERENCE_ROLE_TYPES
// CHARACTER/ENVIRONMENT/PROP values where they overlap (CHARACTER/PROP),
// though this is a separate list — ENVIRONMENT there is LOCATION here,
// matching this file's own createLocation()/locations array naming.
const REFERENCE_ENTITY_TYPES = ['CHARACTER', 'LOCATION', 'PROP'];

// Stage 19, Part 1/3 — the entity-level CANONICAL REFERENCE fields, added
// identically to createCharacter/createLocation/createProp below. Mirrors
// Stage 13E's keyframe.canonicalAssetId pattern exactly (same field
// names, same "explicit selection only, history never overwritten"
// contract) but scoped to a reusable Visual Bible entity instead of a
// single keyframe — see services/creative-store.js's
// selectCanonicalReferenceAsset(). Never set by this schema file itself;
// every field here defaults to null/[] like everything else in this file.
function canonicalReferenceFields(overrides = {}) {
  const base = {
    canonicalReferenceAssetId: null,
    canonicalReferenceSelectedAt: null,
    canonicalReferenceSelectedBy: null,
    canonicalReferenceChangeNote: null,
    // Every PREVIOUS canonical selection, preserved rather than
    // overwritten — {assetId, selectedAt, selectedBy, changeNote,
    // supersededAt}, same shape as keyframe-schema.js's
    // canonicalAssetHistory.
    canonicalReferenceHistory: [],
  };
  return withDefaults(base, overrides);
}

// Fields every versioned creative artifact shares. Lightweight versioning
// only (Part 9) — NOT Git-like: `history` holds metadata about past
// versions (version/updatedAt/updatedBy/changeNote), never a full content
// snapshot or branch/merge machinery. The artifact's own top-level fields
// ARE the current version — there is nothing else to look up.
function versionFields(overrides = {}) {
  const base = {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    changeNote: null,
    history: [],
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 1 — Creative Brief. The human-authored starting point: what this
// project is, for whom, and why. One per project.
// ---------------------------------------------------------------------------
function createCreativeBrief(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    title: null,
    concept: null,
    premise: null,
    objective: null,
    audience: null,
    tone: null,
    genre: null,
    format: null,
    targetDuration: null,
    visualDirection: null,
    narrativeApproach: null,
    keyMessage: null,
    constraints: [],
    references: [],
    creativeNotes: null,
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 2 — Master Creative Specification. A STRUCTURED representation of
// creative intent — deliberately not one giant prompt. This is the stable
// contract future specialist skills (Part 12) read from. `masterPrompt` is
// the derived text representation described in Part 13 — present as a
// field so it can be filled in later, but nothing in this stage generates
// it automatically.
// ---------------------------------------------------------------------------
function createMasterCreativeSpec(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    coreConcept: null,
    storyLogic: null,
    tone: null,
    pacing: null,
    visualLanguage: null,
    cinematography: null,
    lighting: null,
    colourLanguage: null,
    environmentRules: null,
    characterRules: null,
    wardrobeRules: null,
    cameraRules: null,
    motionRules: null,
    compositionRules: null,
    continuityRules: null,
    negativeConstraints: [],
    referenceStrategy: null,
    // Part 13: STRUCTURED SPEC -> MASTER PROMPT -> SHOT-SPECIFIC PROMPT.
    // The structured fields above are the source of truth; this is only a
    // derived representation, never auto-generated by this stage.
    masterPrompt: null,
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 4 — Character. Character consistency is a core project objective,
// so this is a stable identity record a shot can reference by id rather
// than re-describing the character every time.
// ---------------------------------------------------------------------------
function createCharacter(overrides = {}) {
  const base = {
    characterId: crypto.randomUUID(),
    name: null,
    role: null,
    description: null,
    facialCharacteristics: null,
    bodyCharacteristics: null,
    hair: null,
    skinDescription: null,
    wardrobe: null,
    accessories: [],
    recurringProps: [],
    behaviour: null,
    identityConstraints: null, // the "identity lock" — what must never change
    continuityNotes: null,
    referenceAssets: [], // asset ids, once reference images exist — none generated by this stage
    ...canonicalReferenceFields(),
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 5 — Location / world definition, reusable across many shots.
// ---------------------------------------------------------------------------
function createLocation(overrides = {}) {
  const base = {
    locationId: crypto.randomUUID(),
    name: null,
    description: null,
    architecture: null,
    geography: null,
    materials: null,
    colourPalette: null,
    lighting: null,
    atmosphere: null,
    recurringElements: [],
    continuityConstraints: null,
    referenceAssets: [],
    ...canonicalReferenceFields(),
  };
  return withDefaults(base, overrides);
}

// A recurring prop/object — the same "sensible structure" the task asks
// for locations, applied to important objects that show up across shots
// (Part 3's closing note). Small on purpose: props rarely need as much
// structure as a character or a location.
function createProp(overrides = {}) {
  const base = {
    propId: crypto.randomUUID(),
    name: null,
    description: null,
    continuityNotes: null,
    referenceAssets: [],
    ...canonicalReferenceFields(),
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 3 — Visual Bible. The persistent visual rules of the production.
// Characters/props/locations are structured arrays (Part 3's own example);
// the remaining sections are free-text rule fields — structured as their
// own named fields rather than one paragraph, per Part 3's instruction,
// without inventing sub-structure the task didn't ask for.
// ---------------------------------------------------------------------------
function createVisualBible(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    world: null,
    characters: [], // Character records (createCharacter)
    wardrobe: null, // general wardrobe rules, distinct from a specific character's own wardrobe field
    props: [], // Prop records (createProp)
    locations: [], // Location records (createLocation)
    architecture: null,
    lighting: null,
    colour: null,
    camera: null,
    composition: null,
    textureMaterials: null,
    atmosphere: null,
    continuityRules: null,
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 6/7 — Storyboard: scenes + shots, the creative-planning layer.
// Shots reference their scene via sceneId rather than nesting (same flat-
// array pattern schemas/production-schema.js's Timeline IR already uses),
// for the same reason: one flat, easy-to-scan list per storyboard.
// ---------------------------------------------------------------------------

// Part 7 — shot PLANNING status. Deliberately its own small, separate enum
// — NOT the project state machine (schemas/state-machine.js's PLANNING/
// GENERATION_REVIEW/CALIBRATION/... states) and NOT a Timeline IR shot's
// own `status`/`approvalStatus` fields. This tracks creative planning
// progress only; nothing in this stage moves a shot into generation, and
// nothing here changes the project state machine.
const SHOT_PLANNING_STATUSES = [
  'DRAFT',
  'PLANNED',
  'READY_FOR_KEYFRAME',
  'KEYFRAME_APPROVED',
  'READY_FOR_VIDEO',
  'GENERATED',
];

function createStoryboardScene(overrides = {}) {
  const base = {
    sceneId: crypto.randomUUID(),
    title: null,
    order: null,
    description: null,
    purpose: null,
  };
  return withDefaults(base, overrides);
}

function createStoryboardShot(overrides = {}) {
  const base = {
    shotId: crypto.randomUUID(),
    sceneId: null,
    order: null,
    duration: null,
    purpose: null,
    narrativeBeat: null,
    visualDescription: null,
    subject: null,
    location: null,
    action: null,
    camera: null,
    framing: null,
    lens: null,
    movement: null,
    lighting: null,
    soundNotes: null,
    transition: null,
    continuityRequirements: [],
    characterReferences: [], // characterId values from the Visual Bible
    locationReferences: [], // locationId values from the Visual Bible
    propReferences: [], // propId values from the Visual Bible
    referenceAssets: [],
    // Part 6: NOT the source of truth — a future derived/manually-drafted
    // representation of the structured fields above (see Part 13).
    promptDraft: null,
    status: 'DRAFT',
  };
  return withDefaults(base, overrides);
}

function createStoryboard(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    scenes: [],
    shots: [],
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  createCreativeBrief,
  createMasterCreativeSpec,
  createCharacter,
  createLocation,
  createProp,
  createVisualBible,
  createStoryboardScene,
  createStoryboardShot,
  createStoryboard,
  SHOT_PLANNING_STATUSES,
  REFERENCE_ENTITY_TYPES,
};
