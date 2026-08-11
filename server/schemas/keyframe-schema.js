// keyframe-schema.js
//
// Stage 12 — the KEYFRAME INTELLIGENCE layer. Defines the shape of a
// single Keyframe (one recommended/planned visual reference tied to a
// storyboard shot) and a project's Keyframe Plan (the collection of all
// of them). Same rules as schemas/creative-schema.js: plain object
// factories only, no file I/O, no provider knowledge, every field
// defaults to null/[] so partial data is always valid, nothing here
// invents information.
//
// See docs/architecture/keyframe-intelligence.md and
// services/keyframe-planner.js for how these get populated.

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

// Part 2 — a controlled, extensible frame-type vocabulary. Adding a new
// type later just means appending to this array; nothing else assumes a
// fixed length.
const FRAME_TYPES = [
  'CHARACTER_REFERENCE',
  'WORLD_REFERENCE',
  'ESTABLISHING_FRAME',
  'COMPOSITION_FRAME',
  'ACTION_FRAME',
  'FIRST_FRAME',
  'LAST_FRAME',
  'TRANSITION_FRAME',
  'DETAIL_FRAME',
];

// Part 3 — keyframe PLANNING statuses. Deliberately separate from (and
// not wired to) the existing production state machine
// (schemas/state-machine.js) or the Stage 11A storyboard shot planning
// statuses (SHOT_PLANNING_STATUSES in schemas/creative-schema.js). No
// automatic transitions exist between these — every status change is a
// deliberate, human-driven update_keyframe call.
const KEYFRAME_STATUSES = ['DRAFT', 'PLANNED', 'READY_FOR_GENERATION', 'GENERATED', 'APPROVED', 'REJECTED'];

// Part 1 — a single keyframe: one recommended/planned visual reference
// for a specific storyboard shot.
function createKeyframe(overrides = {}) {
  const base = {
    keyframeId: crypto.randomUUID(),
    projectId: null,
    sceneId: null,
    shotId: null,
    order: null,
    purpose: null,
    frameType: null, // one of FRAME_TYPES
    subject: null,
    visualDescription: null,
    composition: null,
    camera: null,
    framing: null,
    lens: null,
    movementIntent: null,
    lighting: null,
    colour: null,
    // Part 8/9 — character/location consistency: reference Visual Bible
    // entities BY ID rather than duplicating their description. Only
    // shot-specific deviations (pose, expression, shot-specific wardrobe
    // notes, etc.) belong in this keyframe's own fields above; the
    // Visual Bible remains the source of truth for the entity itself.
    characterReferences: [],
    locationReferences: [],
    propReferences: [],
    referenceAssets: [],
    continuityRequirements: [],
    // Part 11 — DERIVED, never the source of truth. The structured
    // fields above are authoritative; this is a future convenience
    // representation, not something this stage generates automatically.
    promptDraft: null,
    // Part 17 — stale detection. Storyboard shots aren't independently
    // versioned (only the whole storyboard is — see
    // schemas/creative-schema.js's createStoryboard), so this records
    // the STORYBOARD's version at the moment this keyframe was created/
    // last confirmed against it. services/keyframe-store.js compares
    // this to the storyboard's CURRENT version on every read to compute
    // (never persist) a `stale` flag.
    sourceShotVersion: null,
    status: 'DRAFT',
    notes: null,
    // Part 12 — recorded only, never executed. See
    // services/keyframe-planner.js for how these get filled in.
    recommendedSkill: null,
    recommendationReason: null,
  };
  return withDefaults(base, overrides);
}

// Part 4 — a project's whole Keyframe Plan. Lightweight versioning
// consistent with services/creative-store.js: version/updatedAt/
// updatedBy/changeNote plus a metadata-only history (no Git-like
// branching/snapshots).
function createKeyframePlan(overrides = {}) {
  const base = {
    projectId: null,
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    changeNote: null,
    history: [],
    keyframes: [],
  };
  return withDefaults(base, overrides);
}

module.exports = {
  FRAME_TYPES,
  KEYFRAME_STATUSES,
  createKeyframe,
  createKeyframePlan,
};
