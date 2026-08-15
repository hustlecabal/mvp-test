// visual-beat-schema.js
//
// Stage 26.1 — the VISUAL BEAT layer (see
// docs/architecture/stage-26-visual-production-director-investigation.md,
// Part 4). Defines the shape of a VisualBeat: the production-facing unit
// beneath a storyboard shot — Scene -> Shot -> 1..N VisualBeats, mirroring
// exactly how a shot already fans out into 1..N keyframes in
// schemas/keyframe-schema.js. A VisualBeat is the next link in that same
// chain, one step closer to the eventual render — not a competing concept.
//
// Same rules as every other schema file in this codebase: plain object
// factories only, no file I/O, no provider knowledge, every field
// defaults to null/''/[]/{} so partial data is always valid, nothing here
// invents information.
//
// PROVIDER NEUTRALITY (same discipline schemas/video-prompt-schema.js
// documents and enforces for itself): this file describes creative INTENT
// and STRUCTURE only — camera motion, subject motion, composition,
// treatment, material source. It never contains a provider's own field
// names, a model id, or a literal provider name. Which provider/model
// actually generates a beat's material is a future Material Resolution
// Engine's concern (a later stage), never this file's.
//
// MULTI-MATERIAL (Stage 26.1's explicit architectural refinement): a
// VisualBeat is NOT constrained to exactly one asset. A single narrative
// beat ("person walks into an office") may need several structured
// material components layered/sequenced together — existing B-roll for
// the walk, a generated video for a close-up, a deterministic motion
// graphic for a stat callout, kinetic typography for a caption.
// `materials` is that ordered list. A beat with exactly one material is
// simply the common case of this same structure, not a separate "simple
// beat" shape. HOW multiple materials actually get composited on a
// timeline (layering, transform, blend) is deliberately left to a later
// Timeline Compiler stage — this schema only records WHAT the materials
// are and their role/order among each other, never HOW to render them
// together.

const crypto = require('crypto');

// Same helper as every other schema file: applies overrides but skips
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

// Fields every versioned artifact in this codebase shares (same shape as
// schemas/creative-schema.js's versionFields — duplicated here rather than
// imported, matching this codebase's convention that every schema file
// stays self-contained with no cross-schema-file requires).
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
// Two independent axes (Stage 26 investigation, Part 4.3) — deliberately
// NOT collapsed into one flat enum. VISUAL_TREATMENT answers "what does
// the viewer experience"; MATERIAL_SOURCE answers "where did it come
// from." A still image can equally be an existing project asset, a fresh
// generation, or a frame pulled from B-roll; collapsing both questions
// into one enum would force either a combinatorial explosion of values
// or premature commitment before a beat is even resolved.
// ---------------------------------------------------------------------------
const VISUAL_TREATMENTS = [
  'STILL_IMAGE', // one static frame; may get camera motion (Ken Burns) at
                  // render time, never at generation time
  'AI_VIDEO', // an AI-generated clip with genuine subject/camera motion
  'BROLL_CLIP', // a trimmed segment of licensed/stock footage
  'MOTION_GRAPHIC', // deterministically rendered data-driven visual
  'KINETIC_TYPOGRAPHY', // deterministically rendered animated text
  'WHITEBOARD', // Stage 26.3 — deterministically rendered progressive-drawing/
                 // sketch-reveal/handwriting treatment (docs/architecture/
                 // stage-26.2-visual-production-master-spec.md, Part 11). A
                 // first-class treatment, never an alias of MOTION_GRAPHIC —
                 // it pairs with materialSource DETERMINISTIC_TEMPLATE exactly
                 // like MOTION_GRAPHIC/KINETIC_TYPOGRAPHY do, but is its own
                 // value so a future dedicated whiteboard renderer (canvas
                 // drawing order, handwriting, canvas-camera movement) has
                 // somewhere unambiguous to hang off of. No renderer exists
                 // yet — this is the decision-layer vocabulary only.
  'HYBRID', // 2+ of the above composited/sequenced within ONE beat — a
             // beat-level composition descriptor only. A single material
             // component's own `visualTreatment` (see createMaterialComponent
             // below) is never 'HYBRID' — that value only ever describes the
             // beat's overall shape once it has more than one material.
];

const MATERIAL_SOURCES = [
  'PROJECT_ASSET_REUSE', // an already-APPROVED asset from this project
  'GENERATED_NEW', // a fresh provider call for this beat specifically
  'BROLL_LIBRARY', // pulled from an ingested B-roll index
  'DETERMINISTIC_TEMPLATE', // rendered by a template/graphics engine, no
                              // AI/licensing involved
];

// The Material Resolution Engine's primary hard-gate signal (Stage 26
// investigation, Part 6.1): whether a still image can possibly be
// adequate for a beat at all.
const MOTION_LEVELS = ['NONE', 'SUBTLE', 'MODERATE', 'COMPLEX'];

const COST_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
const QUALITY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];

// Only meaningful for a material whose materialSource is 'BROLL_LIBRARY'.
// UNKNOWN is a hard fail for production use (Stage 26 investigation, Part
// 7.1) — enforced by a later resolver/service, never by this schema file,
// which only ever describes shape, not policy.
const LICENSING_STATUSES = ['CLEARED', 'RESTRICTED', 'UNKNOWN'];

// Layering/sequencing role for a material component within a beat that
// has more than one. A beat with a single material typically leaves this
// at the default 'PRIMARY'.
const MATERIAL_ROLES = ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT'];

// Deliberately its own small, separate enum — NOT the project state
// machine (schemas/state-machine.js), NOT the storyboard shot planning
// statuses (SHOT_PLANNING_STATUSES in creative-schema.js), and NOT the
// keyframe planning statuses (KEYFRAME_STATUSES in keyframe-schema.js).
// This tracks beat-level production progress only; nothing in this file
// moves a beat through this enum automatically.
const BEAT_STATUSES = ['PLANNED', 'RESOLVING', 'RESOLVED', 'APPROVED', 'PLACED', 'STALE'];

// ---------------------------------------------------------------------------
// A material component's generation intent — only meaningful when its
// parent material's materialSource is 'GENERATED_NEW'. Mirrors
// video-prompt-schema.js's createVideoCreativeSpecification field names
// exactly (camera/subjectMotion/environmentMotion/composition/lighting)
// for the same reason that file documents: describes creative INTENT
// only, never a provider's own field names or a literal prompt string.
// ---------------------------------------------------------------------------
function createGenerationRequirement(overrides = {}) {
  const base = {
    motionLevel: null, // one of MOTION_LEVELS
    camera: null,
    subjectMotion: null,
    environmentMotion: null,
    composition: null,
    lighting: null,
    colour: null,
  };
  return withDefaults(base, overrides);
}

// Reference Visual Bible entities BY ID — never duplicate their
// description — exactly the same pattern keyframe.characterReferences/
// locationReferences/propReferences and shot.characterReferences/
// locationReferences/propReferences already use.
function createIdentityRequirements(overrides = {}) {
  const base = {
    characterReferences: [],
    locationReferences: [],
    propReferences: [],
  };
  return withDefaults(base, overrides);
}

// The slice of narration/VO text a beat (or, once resolved, its
// PRIMARY material) covers. A plain structured sub-object, not its own
// top-level schema entity — kept minimal per Stage 26.1's explicit "don't
// overcomplicate" instruction; a beat with no narration (b-roll/music-only)
// simply leaves this null.
function createNarrationSegment(overrides = {}) {
  const base = {
    text: null,
    scriptRefId: null, // which script/paragraph/line this reads, once a
                         // script schema exists — a plain id reference now
    startOffset: null, // seconds into the beat's own narration, if partial
    endOffset: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// One structured material component within a beat's `materials` list.
// This is the Stage 26.1 refinement: a beat is not "one asset," it is
// "1..N of these," each independently sourced and shaped.
// ---------------------------------------------------------------------------
function createMaterialComponent(overrides = {}) {
  const base = {
    materialId: crypto.randomUUID(),
    materialSource: null, // one of MATERIAL_SOURCES — required once resolved
    visualTreatment: null, // one of VISUAL_TREATMENTS, excluding 'HYBRID'
                             // (see the VISUAL_TREATMENTS comment above)
    assetId: null, // the resolved Asset id, once a future Material
                     // Resolution Engine has picked one — null until then
    generationRequirement: null, // createGenerationRequirement(), or null
                                    // when materialSource !== 'GENERATED_NEW'
    duration: null, // this component's own slice of the beat's duration
    role: 'PRIMARY', // one of MATERIAL_ROLES
    order: 0, // layering/sequencing order among this beat's own materials
    licensingStatus: null, // one of LICENSING_STATUSES — only meaningful
                             // when materialSource === 'BROLL_LIBRARY'
    identityRequirements: createIdentityRequirements(),
    continuityRequirements: [],
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 1 — a single visual beat: the production-facing unit beneath a
// storyboard shot.
// ---------------------------------------------------------------------------
function createVisualBeat(overrides = {}) {
  const base = {
    // --- identity ---
    id: crypto.randomUUID(),
    projectId: null,
    sceneId: null, // required once placed — every beat belongs to a scene
    shotId: null, // optional — a beat MAY exist without a storyboard shot
                    // (e.g. a pure transition/title-card beat between scenes)
    sequence: null, // integer order within the scene

    // --- timing ---
    startTime: null, // seconds from video start; null until placed
    duration: null, // seconds

    // --- narrative ---
    narrativePurpose: '', // mirrors production-schema.js's existing
                            // shot.narrativePurpose field name exactly
    narrationSegment: null, // createNarrationSegment(), or null
    visualIntent: '', // WHAT must be communicated visually — higher-level
                        // than a literal description; every candidate
                        // material is scored against this by a future
                        // Material Resolution Engine, never a treatment
                        // choice itself

    // --- treatment (see the two-axis comment above) ---
    visualTreatment: null, // one of VISUAL_TREATMENTS — the beat's OVERALL
                             // treatment; 'HYBRID' once materials.length > 1
                             // with genuinely different treatments

    motionRequirements: {
      motionLevel: null, // one of MOTION_LEVELS — the resolver's primary
                           // hard gate
      requiresCameraMotion: null,
      requiresSubjectMotion: null,
    },

    // --- creative direction — same field names as
    // video-prompt-schema.js's createVideoCreativeSpecification, for the
    // same continuity reason documented at the top of this file ---
    composition: null,
    camera: null,
    subjectMotion: null,
    environmentMotion: null,
    lighting: null,
    colour: null,
    pacing: null,

    // --- identity/continuity/style ---
    identityRequirements: createIdentityRequirements(),
    continuityRequirements: [], // same field name/shape as
                                  // shot.continuityRequirements /
                                  // keyframe.continuityRequirements
    styleRequirements: null, // deviation from the project's Master
                               // Creative Spec, if any; null means
                               // "inherit as-is"

    transition: null, // same field name as shot.transition

    // --- audio/graphics — references only, not inline data. Both are a
    // future stage's concern (AudioEvent / MotionGraphicSpec schemas
    // don't exist yet); kept as fields now so a beat/material has
    // somewhere to point once they do. ---
    audioEvents: [], // audioEventId values, once that schema exists
    graphics: null, // a MotionGraphicSpec id, once that schema exists

    // --- resolution policy inputs, read by a future Material Resolution
    // Engine ---
    costPriority: 'MEDIUM', // one of COST_PRIORITIES
    qualityPriority: 'MEDIUM', // one of QUALITY_PRIORITIES
    fallbackStrategy: [], // ordered list of acceptable VISUAL_TREATMENTS
                            // values if the preferred one is unavailable
                            // or fails; an empty list means "flag for
                            // human review rather than substitute anything"

    // --- multi-material (Stage 26.1's explicit refinement — see the file
    // header) ---
    materials: [], // ordered list of createMaterialComponent()

    // --- resolved material (filled in once a future resolver runs) ---
    resolvedAssetId: null, // convenience — the PRIMARY material's own
                             // resolved assetId, kept in sync by whatever
                             // future service resolves materials
    resolutionScore: null, // the winning candidate's factor breakdown,
                             // for audit — a future resolver's concern
    resolutionAlternatives: [], // the next-best candidates considered

    status: 'PLANNED', // one of BEAT_STATUSES
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  VISUAL_TREATMENTS,
  MATERIAL_SOURCES,
  MOTION_LEVELS,
  COST_PRIORITIES,
  QUALITY_PRIORITIES,
  LICENSING_STATUSES,
  MATERIAL_ROLES,
  BEAT_STATUSES,
  createGenerationRequirement,
  createIdentityRequirements,
  createNarrationSegment,
  createMaterialComponent,
  createVisualBeat,
};
