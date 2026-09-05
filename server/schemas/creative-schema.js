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

// ---------------------------------------------------------------------------
// CREATIVE PRODUCTION CONTRACT (milestone 2) — additive extension of this
// same file's Storyboard/Visual Bible family, not a second parallel model.
// See docs/architecture/creative-production-contract.md for the Phase 0
// audit that grounds every decision below in the actual pre-existing
// objects (Character/Location/Prop/VisualBible/Storyboard/StoryboardShot)
// rather than inventing a parallel one.
//
// CONTRACT_VERSION exists only to let a future consumer tell "does this
// Storyboard/Character/Location/Prop predate Sequence/NarrativeBeat/
// GenerationUnit/state-timeline support" — every new field below defaults
// to null/[]/false, so no migration is required: a version-1.0.0 record
// loaded through these same factories is still valid, just with empty
// values for the new fields.
// ---------------------------------------------------------------------------
const CONTRACT_VERSION = '2.0.0';

// Section 2 — the one hard, provider-agnostic production invariant this
// milestone adds. A stricter ceiling than any one skill's own limit (e.g.
// cinema-director's own prompts cap at 15s) — deliberately so: this is OUR
// policy for how large an atomic AI motion-generation request may be,
// independent of what any given provider currently allows. Enforced in
// services/creative-production-contract-validator.js, never thrown from
// this factory file — same "schema stores, service validates" convention
// every other enum/invariant in this codebase already follows.
const MAX_GENERATION_UNIT_DURATION_SECONDS = 10;
const PREFERRED_GENERATION_UNIT_DURATION_RANGE = { minSeconds: 3, maxSeconds: 8 };

// Section 6 — GENERATION METHOD. Describes WHAT production technique a
// GenerationUnit needs; provider/model selection (HOW) stays entirely in
// services/generation-model-registry.js, which this schema never imports
// (same "no schema file imports another schema or service file" rule
// documented at createStoryboardShot.visualTreatment below). Deliberately
// overlaps with schemas/material-resolution-schema.js's MATERIAL_SOURCES
// (PROJECT_ASSET_REUSE/BROLL_LIBRARY/STOCK_MEDIA/GENERATED_NEW) rather than
// duplicating a competing vocabulary — EXISTING_FOOTAGE and BROLL below are
// this schema's own names for material-resolution's PROJECT_ASSET_REUSE
// and BROLL_LIBRARY outcomes, used when a GenerationUnit's material comes
// from there instead of a fresh generation call.
const GENERATION_METHODS = [
  'IMAGE_TO_VIDEO',
  'TEXT_TO_VIDEO',
  'ANIMATED_STILL',
  'EXISTING_FOOTAGE',
  'BROLL',
  'MOTION_GRAPHICS',
  'CHARACTER_PERFORMANCE',
  'ENVIRONMENTAL_PLATE',
];

// Section 5 — END FRAME STRATEGY.
const CONTINUATION_STRATEGIES = ['GENERATED_END_FRAME', 'EXTRACTED_FINAL_FRAME', 'STATE_ONLY'];

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

    // Section 10 — CHARACTER STATE TIMELINE. Identity (everything above)
    // stays a single stable record, exactly as it already was — this is
    // purely additive. Persistent identity vs. changing state is
    // represented as a TIMELINE of scene-keyed, DELTA-ONLY snapshots:
    // {sceneId, order, state: createCharacterState(...)}, where a null
    // field in a given snapshot means "unchanged since the last snapshot
    // that set it" — never "reset to nothing." A snapshot only sets the
    // fields that actually changed in that scene (e.g. Scene 7 sets only
    // physicalState; Scene 9 sets only wardrobeId and physicalState),
    // avoiding the "restate everything every scene" duplication the
    // milestone explicitly warns against. services/creative-production-
    // contract-validator.js's resolveCharacterStateAtScene() folds the
    // timeline forward (last-set-wins per field) to answer "what is this
    // character's actual state as of scene N" — the fold-forward is what
    // guarantees changes are never silently lost.
    stateTimeline: [],
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
    // Section 11 — same delta-only, fold-forward timeline as Character's
    // stateTimeline above (see that field's comment for the full
    // rationale), scoped to createLocationState fields (time of day,
    // lighting, weather, environmental state).
    stateTimeline: [],
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
    // Section 11 — same delta-only, fold-forward timeline pattern, scoped
    // to createPropState fields (position, holder, physical state).
    stateTimeline: [],
    ...canonicalReferenceFields(),
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// FRAME STATE CONTRACT (Section 4). One small, reusable structure per
// subject kind, describing the relevant visual state AT A GENERATION
// BOUNDARY — never a universal object every field must be filled for every
// use. A CharacterState with only `position` and `props` set (everything
// else null) is a perfectly valid, minimal use. Reused identically inside
// GenerationUnit.startState/endState (Section 3) — never duplicated per
// caller.
// ---------------------------------------------------------------------------
function createCharacterState(overrides = {}) {
  const base = {
    characterId: null,
    position: null,
    orientation: null,
    pose: null,
    facialExpression: null,
    emotionalState: null,
    physicalState: null,
    wardrobeId: null, // a short label/id for the outfit build in effect (e.g. "outfit_01") — resolved against Character.referenceAssets/canonicalReferenceHistory for the actual asset, never re-describing the wardrobe here
    accessories: [],
    heldProps: [], // propId values from the Visual Bible
  };
  return withDefaults(base, overrides);
}

function createLocationState(overrides = {}) {
  const base = {
    locationId: null,
    timeOfDay: null,
    lightingState: null,
    weather: null,
    environmentalState: null,
  };
  return withDefaults(base, overrides);
}

function createPropState(overrides = {}) {
  const base = {
    propId: null,
    position: null,
    holderCharacterId: null, // null = unheld/placed in the scene
    physicalState: null,
  };
  return withDefaults(base, overrides);
}

function createCameraState(overrides = {}) {
  const base = {
    framing: null,
    position: null,
    height: null,
    fovOrLens: null,
    orientation: null,
    movementState: null,
  };
  return withDefaults(base, overrides);
}

// One generation boundary's full state — a thin envelope over the four
// state kinds above. Every list defaults empty: a boundary that only cares
// about one character's expression sets characterStates=[thatState] and
// leaves the rest empty, never fabricating placeholder entries for
// characters/locations/props not relevant at this boundary.
function createFrameState(overrides = {}) {
  const base = {
    characterStates: [], // createCharacterState records
    locationState: null, // one createLocationState record — a boundary has exactly one active location
    propStates: [], // createPropState records
    cameraState: null, // one createCameraState record
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// GENERATION UNIT (Section 1/2/3/5/6) — the smallest atomic AI motion-
// generation request. Sits BELOW StoryboardShot (a director-designed
// continuous camera idea, which may need one or several of these) and
// feeds INTO a production-schema.js GenerationJob one-to-one once real
// production begins (out of scope for this milestone — see the OpenMontage
// boundary / next-milestone notes). duration_seconds is never validated
// here (see MAX_GENERATION_UNIT_DURATION_SECONDS's own comment) — that is
// services/creative-production-contract-validator.js's job.
// ---------------------------------------------------------------------------
function createGenerationUnit(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    shotId: null,
    order: null, // position of this unit within its parent shot, starting at 1
    durationSeconds: null,
    generationMethod: null, // one of GENERATION_METHODS — documented, not enforced (see file-wide convention)
    continuationStrategy: null, // one of CONTINUATION_STRATEGIES

    startState: null, // a createFrameState record
    startFrameAssetId: null, // set when continuationStrategy implies a real starting frame asset

    endState: null, // a createFrameState record
    endFrameAssetId: null, // set only for GENERATED_END_FRAME or once EXTRACTED_FINAL_FRAME has run

    // Section 3 — sequential continuity. Set when this unit continues
    // directly from another unit's approved end state/frame (e.g. Shot
    // 04.02's Unit B continuing from Unit A). null for a unit that opens
    // its own shot fresh.
    continuesFromGenerationUnitId: null,

    promptDraft: null, // mirrors StoryboardShot.promptDraft's own "not the source of truth" contract
    generationJobId: null, // set once real production begins (production-schema.js createGenerationJob) — out of scope this milestone
    resultAssetId: null, // the produced video Asset, once one exists

    status: 'NOT_STARTED', // NOT_STARTED | IN_PROGRESS | READY | COMPLETE | FAILED
    stale: false, // Section 16 — invalidation marker, never auto-deleted, see validator
    staleReason: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// NARRATIVE BEAT (Section 8) — promoted from StoryboardShot's own bare
// `narrativeBeat` string field (kept below, unchanged, for backward
// compatibility) into a real, ordered, linkable object. Deliberately NOT
// the same object as story-structure-schema.js's StoryBeatPlan — that
// family belongs to the separate Editorial Spine (Strategy -> Idea ->
// Package -> StoryArgument), which this milestone does not touch. A
// NarrativeBeat here may be authored directly, or (in a future milestone,
// out of scope now) derived from a StoryArgument's own beats — the id
// spaces are never merged.
// ---------------------------------------------------------------------------
function createNarrativeBeat(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    sceneId: null,
    order: null,
    scriptRefId: null, // same unenforced join convention as narration-schema.js/audio-schema.js's own scriptRefId
    narrativePurpose: null,
    actionOrChange: null,
    characterIds: [], // characterId values from the Visual Bible; must be a subset of the parent Scene's own cast (validator-enforced)
    audioRelationship: null, // free-text pointer to what's said/heard during this beat — not a duplicate audio timeline, see file header
    shotIds: [], // StoryboardShot ids covering this beat — many-to-many, never forced 1:1 (Section 8)
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// SEQUENCE (Section 9) — groups scenes into a meaningful narrative
// movement. No suitable existing equivalent was found in this repository
// (Phase 0 audit) — genuinely new, and deliberately thin.
// ---------------------------------------------------------------------------
function createSequence(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    title: null,
    order: null,
    narrativePurpose: null,
    sceneIds: [],
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

    // Section 12 — VISUAL SYSTEM. Audit finding: this file's own
    // world/camera/composition/lighting/colour/textureMaterials/atmosphere
    // fields already cover most of what a "Visual System" is — genre,
    // photographic language, colour philosophy, lighting philosophy, and
    // atmosphere/texture language. Rather than introduce a competing
    // VisualSystem object (and a second place to keep those in sync), the
    // handful of genuinely missing sub-languages are added here, additive,
    // as this same file's existing free-text-rule-field convention (one
    // named field per concern, no invented sub-structure):
    genre: null, // visual genre (Section 12's first bullet — the one field with no existing home)
    lensLanguage: null,
    cameraMovementLanguage: null,
    depthOfFieldLanguage: null,
    grain: null, // texture/grain, distinct from textureMaterials (surface materials in-world) above
    transitionLanguage: null,
    typography: null,

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

    // Section 7/9 — the AUTHORITATIVE cast/location/prop list for this
    // scene. A shot's own characterReferences/locationReferences/
    // propReferences (createStoryboardShot below) must be a SUBSET of
    // these (validator-enforced) — mirrors exactly the same rule this
    // milestone's Project Contract turn already established, now applied
    // to the real Storyboard family instead of the scratch-only one.
    locationId: null, // a single primary Location for the scene — a shot may still visually favor part of it via its own `location` free-text field
    characterIds: [],
    propIds: [],
    narrativeBeatIds: [], // createNarrativeBeat ids belonging to this scene, in order
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

    // ---------------------------------------------------------------------
    // P0-4A — Blueprint -> Storyboard contract (docs: the P0-4 forensic
    // audit + P0-4A specification, this stage). Two fields, deliberately
    // minimal — see that specification's Part 2 contract table for the
    // full source/destination/derivation-rule justification for each.
    // ---------------------------------------------------------------------

    // DIRECT_REFERENCE — Recommendation ids only (never statement/
    // rationale/action text), resolved through Storyboard.blueprintId ->
    // CreativeBlueprint.recommendationDecisions[]. Zero, one, or many per
    // shot; one recommendation may legitimately span many shots. HUMAN-
    // AUTHORED in P0-4A — no Blueprint -> Storyboard generator exists yet
    // (that is P0-4B, explicitly out of scope here) to populate this
    // automatically. An accepted recommendation whose id never appears in
    // ANY shot's recommendationIds is not itself a separate NOT_APPLICABLE
    // state — absence already carries that meaning; distinguishing
    // "deliberately not applicable" from "simply forgotten" is a future
    // validation-time judgment (a future STORYBOARD_GATE), not data this
    // schema stores.
    recommendationIds: [],

    // HUMAN_AUTHORED in P0-4A (STRUCTURED_DERIVATION-eligible in a future
    // stage — a future P0-4D could read this to build services/beat-graph-
    // derivation-service.js's own context.treatments map, never the other
    // way around). Value space is VISUAL_TREATMENTS (schemas/visual-beat-
    // schema.js) — documented here, not schema-enforced: no schema file in
    // this codebase ever requires another schema file (every schema file
    // imports only `crypto`; confirmed by inspection during this stage),
    // and every other enum-bearing field in this codebase's schema
    // factories (e.g. CreativeBlueprint.status, Recommendation.
    // recommendationType) follows the identical convention — the schema
    // stores an unconstrained value, and enum enforcement (where it
    // exists at all) lives at the MCP/REST/service boundary, never inside
    // a schema factory. This is INTENT ONLY: never a material assignment,
    // renderer choice, generated asset, or provider selection.
    visualTreatment: null,

    // Section 7/8 — SHOT EXPANSION, additive. REQUIRED CORE stays exactly
    // what it already was (sceneId, order, duration, purpose, action) —
    // everything below is OPTIONAL/DERIVED direction, per the milestone's
    // explicit "do not turn every possible creative property into a
    // mandatory field" instruction.
    narrativeBeatIds: [], // links to real NarrativeBeat records — narrativeBeat (string, above) stays as a legacy/free-text field, never removed
    characterStates: [], // createCharacterState records — this shot's OWN blocking/pose/expression per character, distinct from the Visual Bible's identity records characterReferences already points at
    blocking: null,
    atmosphere: null,
    emotionalIntent: null,
    transitionIn: null, // supersedes the single legacy `transition` field above where both directions matter; `transition` stays as a legacy/shorthand field
    transitionOut: null,
    continuityRequirementsResolved: null, // left null until a future validator pass checks the continuityRequirements[] above against actual GenerationUnit states — never fabricated true/false here

    // Section 1/7 — GENERATION UNIT link. A shot with targetDuration
    // (`duration` above) <= MAX_GENERATION_UNIT_DURATION_SECONDS needs
    // exactly one; a longer shot needs several, in order. Never forced to
    // exist at shot-creation time — empty until units are planned.
    generationUnitIds: [],

    // Section 16 — invalidation marker, additive, same pattern as
    // GenerationUnit's own stale/staleReason. Never auto-deleted.
    stale: false,
    staleReason: null,
  };
  return withDefaults(base, overrides);
}

function createStoryboard(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    sequenceIds: [], // createSequence ids, in order — empty for a short-form Storyboard with no need to group scenes
    scenes: [],
    shots: [],

    // P0-4A — DIRECT_REFERENCE to the approved CreativeBlueprint this
    // Storyboard was authored against (a plain id, never a content copy —
    // concept/corePromise/targetAudience/strategy text/evidence summaries
    // are never duplicated here; a consumer follows this id back to the
    // real CreativeBlueprint record for anything beyond the id itself).
    // null for a pre-existing Storyboard authored before this field
    // existed, or one not (yet) tied to any Blueprint — never fabricated.
    blueprintId: null,

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

  // Creative Production Contract (milestone 2) additions:
  CONTRACT_VERSION,
  MAX_GENERATION_UNIT_DURATION_SECONDS,
  PREFERRED_GENERATION_UNIT_DURATION_RANGE,
  GENERATION_METHODS,
  CONTINUATION_STRATEGIES,
  createCharacterState,
  createLocationState,
  createPropState,
  createCameraState,
  createFrameState,
  createGenerationUnit,
  createNarrativeBeat,
  createSequence,
};
