// visual-world-service.js
//
// VISUAL WORLD — the missing translation layer between a real
// CreativeBlueprint's written-only creative decisions
// (visualSpecification/continuityRequirements — populated by the Creative
// Brain, read by NOTHING until this file) and the two real, already-built
// execution paths this codebase has (forensic finding, this stage):
//
//   Pipeline A (real generation): Storyboard -> Keyframe ->
//     KeyframePromptPackage -> keyframe-generation-service.js -> EvoLink.
//     Approval-gated, budget-gated, tested. THE ONLY PATH THAT CAN
//     ACTUALLY TRIGGER GENERATED_NEW (STILL_IMAGE/AI_VIDEO) GENERATION.
//
//   Pipeline B (deterministic rendering): Storyboard -> VisualBeat
//     (beat-graph-derivation-service.js) -> material-resolution-service.js
//     -> material-execution-service.js -> real local renderers
//     (whiteboard/motion-graphic/kinetic-typography — genuine SVG output,
//     HyperFrames for BROLL_CLIP). GENERATED_NEW's own executor
//     (generated-new-executor.js) is a structural dead-end here — it can
//     only DISCOVER an asset Pipeline A already produced, never trigger
//     generation itself.
//
// THIS FILE IS NOT A THIRD PIPELINE (Part 39 STOP condition #4). It never
// calls a provider, never renders anything, never touches
// material-resolution-service.js/material-execution-service.js's own
// logic. It only:
//
//   1. Builds a provider-neutral MaterialSpecification per shot
//      (schemas/material-specification-schema.js) from
//      CreativeBlueprint.visualSpecification + VisualBible +
//      continuityRequirements, merged with (never overriding) whatever
//      the Storyboard shot itself already specifies more precisely
//      (Part 14 — shot-level always wins).
//   2. For GENERATED_NEW-eligible treatments (STILL_IMAGE/AI_VIDEO):
//      fills BLANK Keyframe fields from that MaterialSpecification, so
//      Pipeline A's own, UNMODIFIED build_keyframe_prompt_package
//      (services/keyframe-prompt-service.js's composePromptSections())
//      produces a real, specific prompt instead of an empty one — never
//      overwrites a field a human already set.
//   3. For DETERMINISTIC treatments (MOTION_GRAPHIC/KINETIC_TYPOGRAPHY/
//      WHITEBOARD): compiles the exact `options` shape each executor
//      already accepts (material-executors/*.js), feeding
//      production-orchestrator-service.js's existing, UNMODIFIED
//      `materialOptions` input — WHITEBOARD specifically driven by REAL
//      Whisper/caption word timing when available (Part 24/31), never a
//      second timing authority.
//
// Everything downstream of this file is exactly what already existed
// before this stage.

const creativeStore = require('./creative-store');
const creativeBlueprintStore = require('./creative-blueprint-store');
const keyframeStore = require('./keyframe-store');
const { createMaterialSpecification, createMaterialReference } = require('../schemas/material-specification-schema');
const { REFERENCE_ENTITY_TYPES } = require('../schemas/creative-blueprint-schema');

const DETERMINISTIC_TREATMENTS = ['MOTION_GRAPHIC', 'KINETIC_TYPOGRAPHY', 'WHITEBOARD'];
const GENERATED_NEW_TREATMENTS = ['STILL_IMAGE', 'AI_VIDEO'];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = nonEmpty(v);
    if (s) return s;
  }
  return null;
}

function findEntity(visualBible, entityType, entityId) {
  if (!visualBible) return null;
  const arrayField = entityType === 'CHARACTER' ? 'characters' : entityType === 'LOCATION' ? 'locations' : entityType === 'PROP' ? 'props' : null;
  const idField = entityType === 'CHARACTER' ? 'characterId' : entityType === 'LOCATION' ? 'locationId' : entityType === 'PROP' ? 'propId' : null;
  if (!arrayField) return null;
  return (visualBible[arrayField] || []).find((e) => e[idField] === entityId) || null;
}

// Part 4/6 — VisualBible entity description text, treatment-agnostic. Used
// only as SUBJECT/ENVIRONMENT colour for the MaterialSpecification — never
// duplicated as a second source of truth (the entity id is what's stored
// on references[], this text is derived fresh every call).
function describeEntity(entityType, entity) {
  if (!entity) return null;
  if (entityType === 'CHARACTER') return firstNonEmpty(entity.description, entity.facialCharacteristics);
  if (entityType === 'LOCATION') return firstNonEmpty(entity.description, entity.architecture);
  if (entityType === 'PROP') return entity.description;
  return null;
}

// Part 11 — the canonical, provider-neutral MaterialSpecification for ONE
// Storyboard shot. `shot` and `visualBible`/`blueprint` are real, already-
// persisted records (never constructed here). Pure — makes no store call,
// never mutates its inputs.
function buildMaterialSpecification(projectId, shot, { blueprint = null, visualBible = null } = {}) {
  const spec = blueprint ? blueprint.visualSpecification : null;
  const treatment = shot.visualTreatment || null;

  // Part 14 — shot-level fields ALWAYS win over blueprint-level
  // visualSpecification when both exist; blueprint fields are the
  // whole-video default, never a forced override of a more specific
  // per-shot decision the Storyboard already made.
  const composition = firstNonEmpty(shot.composition, spec && spec.composition);
  const camera = firstNonEmpty(shot.camera, spec && spec.cameraLanguage);
  const lighting = firstNonEmpty(shot.lighting, spec && spec.lighting);
  const palette = spec ? spec.palette : null;
  const texture = spec ? spec.texture : null;
  const environmentalTreatment = spec ? spec.environmentalTreatment : null;

  const references = [];
  const entityDescriptions = [];
  for (const req of shot.continuityRequirements || []) {
    if (!REFERENCE_ENTITY_TYPES.includes(req.entityType)) continue;
    const entity = findEntity(visualBible, req.entityType, req.entityId);
    const canonical = entity && entity.canonicalReferenceAssetId ? entity.canonicalReferenceAssetId : null;
    references.push(createMaterialReference({ entityType: req.entityType, entityId: req.entityId, assetId: canonical, role: req.requirement || null }));
    const description = describeEntity(req.entityType, entity);
    if (description) entityDescriptions.push(description);
  }

  const subject = firstNonEmpty(shot.subject, shot.visualDescription, entityDescriptions.join('; '), shot.purpose);
  const action = firstNonEmpty(shot.action, shot.narrativeBeat);
  const environment = firstNonEmpty(environmentalTreatment, shot.location);

  const negativeConstraints = [];
  if (spec && nonEmpty(spec.negativeConstraints)) negativeConstraints.push(spec.negativeConstraints);

  return createMaterialSpecification({
    projectId,
    creativeBlueprintId: blueprint ? blueprint.id : null,
    shotId: shot.shotId,
    materialType: GENERATED_NEW_TREATMENTS.includes(treatment) ? (treatment === 'AI_VIDEO' ? 'VIDEO' : 'IMAGE') : DETERMINISTIC_TREATMENTS.includes(treatment) ? 'DETERMINISTIC_RENDER' : null,
    treatment,
    shotPurpose: firstNonEmpty(shot.purpose, shot.narrativeBeat),
    subject: subject || '',
    action: action || '',
    environment: environment || '',
    composition: composition || '',
    camera: camera || '',
    lighting: lighting || '',
    palette: palette || '',
    texture: texture || '',
    continuity: references.map((r) => r.role).filter(Boolean).join('; '),
    references,
    negativeConstraints,
    temporalIntent: null,
  });
}

// Part 2/6 — fills BLANK Keyframe fields only, from a MaterialSpecification
// already built for this shot. Never overwrites a field a human (or an
// earlier call) already set — this is additive population, not a rewrite.
// The updated Keyframe then flows through services/keyframe-prompt-
// service.js's OWN, UNMODIFIED composePromptSections() exactly as if a
// human had typed these fields in by hand.
function populateKeyframeFromMaterialSpecification(projectId, keyframeId, materialSpec, { updatedBy = 'visual-world-service' } = {}) {
  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) return null;

  const fill = (current, value) => (nonEmpty(current) ? current : value || null);
  const updates = {
    subject: fill(keyframe.subject, materialSpec.subject),
    visualDescription: fill(keyframe.visualDescription, materialSpec.subject),
    composition: fill(keyframe.composition, materialSpec.composition),
    camera: fill(keyframe.camera, materialSpec.camera),
    lighting: fill(keyframe.lighting, materialSpec.lighting),
    colour: fill(keyframe.colour, materialSpec.palette),
  };

  const existingCharacterRefs = new Set(keyframe.characterReferences || []);
  const existingLocationRefs = new Set(keyframe.locationReferences || []);
  const existingPropRefs = new Set(keyframe.propReferences || []);
  for (const ref of materialSpec.references) {
    if (ref.entityType === 'CHARACTER') existingCharacterRefs.add(ref.entityId);
    if (ref.entityType === 'LOCATION') existingLocationRefs.add(ref.entityId);
    if (ref.entityType === 'PROP') existingPropRefs.add(ref.entityId);
  }
  updates.characterReferences = [...existingCharacterRefs];
  updates.locationReferences = [...existingLocationRefs];
  updates.propReferences = [...existingPropRefs];

  return keyframeStore.updateKeyframe(projectId, keyframeId, updates, { updatedBy, changeNote: 'Visual World: populated blank fields from CreativeBlueprint.visualSpecification' });
}

// --- DETERMINISTIC TREATMENT COMPILATION (Part 6-9) -------------------

// A single, honest fallback element spanning the whole beat — used
// whenever no finer real signal (real word timing, structured content) is
// available. Never fabricates per-word timing; degrades to phrase-level.
function wholeBeatTextElement(text, duration) {
  return { kind: 'TEXT', content: text, drawDuration: duration, holdDuration: 0 };
}

// Part 7/24/31 — WHITEBOARD. When real CaptionSegments overlapping this
// beat's real, measured [startTime, startTime+duration) window are
// supplied, each becomes its own progressively-revealed TEXT element with
// REAL drawStartOffset/drawDuration derived from those segments' own
// absolute timeline seconds (schemas/caption-schema.js's own real,
// Whisper-measured timing — never a second timing authority, never
// invented). Falls back to one whole-beat element, honestly, when no real
// timing is available for this beat (e.g. a beat with no narration).
function compileWhiteboardOptions(materialSpec, beat, { captionSegments = [] } = {}) {
  const duration = beat && typeof beat.duration === 'number' ? beat.duration : null;
  if (!duration) return null;

  const beatStart = typeof beat.startTime === 'number' ? beat.startTime : null;
  const overlapping = beatStart !== null
    ? captionSegments.filter((s) => typeof s.startTime === 'number' && typeof s.endTime === 'number' && s.startTime < beatStart + duration && s.endTime > beatStart)
    : [];

  let elements;
  if (overlapping.length > 0) {
    elements = overlapping.map((seg) => {
      const relativeStart = Math.max(0, seg.startTime - beatStart);
      const relativeEnd = Math.min(duration, seg.endTime - beatStart);
      return { kind: 'TEXT', content: seg.text, drawStartOffset: relativeStart, drawDuration: Math.max(0.1, relativeEnd - relativeStart), holdDuration: 0 };
    });
  } else {
    const text = materialSpec.subject || materialSpec.shotPurpose || 'Untitled';
    elements = [wholeBeatTextElement(text, duration)];
  }

  return { elements, duration, canvas: { width: 1920, height: 1080 } };
}

// Part 8 — KINETIC_TYPOGRAPHY. The executor requires `options.text`
// explicitly (VisualBeat has no dedicated on-screen-text field — a
// documented, real gap, not silently worked around). Visual World supplies
// it from the MaterialSpecification's own subject/purpose text — never
// beat.narrationSegment.text, which is narration/VO, not necessarily the
// same as on-screen caption text.
function compileKineticTypographyOptions(materialSpec, beat) {
  const duration = beat && typeof beat.duration === 'number' ? beat.duration : null;
  if (!duration) return null;
  const text = materialSpec.subject || materialSpec.shotPurpose;
  if (!text) return null;
  return { text, duration, sequencing: 'WORD_BY_WORD', alignment: 'CENTER' };
}

// Part 9 — MOTION_GRAPHIC. Reuses the existing closed primitive set
// (never inventing a new taxonomy — Part 9's explicit hard rule). Without
// a real structuredData source (documented gap — VisualBeat has none yet),
// the only honest, non-fabricated compilation is a single TEXT primitive
// carrying the MaterialSpecification's own real subject/purpose text.
function compileMotionGraphicOptions(materialSpec, beat) {
  const duration = beat && typeof beat.duration === 'number' ? beat.duration : null;
  if (!duration) return null;
  const text = materialSpec.subject || materialSpec.shotPurpose;
  if (!text) return null;
  return { duration, elements: [{ kind: 'TEXT', position: { x: 0.5, y: 0.5 }, label: text }] };
}

function compileDeterministicOptions(materialSpec, beat, context = {}) {
  if (materialSpec.treatment === 'WHITEBOARD') return compileWhiteboardOptions(materialSpec, beat, context);
  if (materialSpec.treatment === 'KINETIC_TYPOGRAPHY') return compileKineticTypographyOptions(materialSpec, beat);
  if (materialSpec.treatment === 'MOTION_GRAPHIC') return compileMotionGraphicOptions(materialSpec, beat);
  return null;
}

// Part 6-9/16 — builds the exact `{[beatId]: options}` map
// production-orchestrator-service.js's startProduction()/resumeProduction()
// ALREADY accepts verbatim as `job.materialOptions` (no modification to
// that file). Only DETERMINISTIC_TREATMENTS beats get an entry —
// GENERATED_NEW/BROLL_CLIP beats need no compiled options here (their own
// executors read the resolved asset directly).
function buildMaterialOptionsForBeatGraph(projectId, beatGraph, blueprint, { captionSegments = [] } = {}) {
  const storyboard = creativeStore.getStoryboard(projectId);
  const shotsById = new Map((storyboard ? storyboard.shots : []).map((s) => [s.shotId, s]));
  const visualBible = creativeStore.getVisualBible(projectId);

  const materialOptions = {};
  for (const beat of beatGraph.beats) {
    if (!DETERMINISTIC_TREATMENTS.includes(beat.visualTreatment)) continue;
    const shot = shotsById.get(beat.shotId);
    if (!shot) continue;
    const materialSpec = buildMaterialSpecification(projectId, shot, { blueprint, visualBible });
    const options = compileDeterministicOptions(materialSpec, beat, { captionSegments });
    if (options) materialOptions[beat.id] = options;
  }
  return materialOptions;
}

module.exports = {
  DETERMINISTIC_TREATMENTS,
  GENERATED_NEW_TREATMENTS,
  buildMaterialSpecification,
  populateKeyframeFromMaterialSpecification,
  compileDeterministicOptions,
  buildMaterialOptionsForBeatGraph,
};
