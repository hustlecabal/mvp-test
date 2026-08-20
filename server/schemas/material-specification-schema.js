// material-specification-schema.js
//
// VISUAL WORLD, Part 11 — the canonical, PROVIDER-NEUTRAL intermediate
// representation between a CreativeBlueprint's creative decisions and any
// treatment-specific executor. Mirrors this codebase's own established
// "provider-neutral shape, one translator per provider" discipline
// (services/reference-video/acquisition-provider-interface.js's
// SourceResolution, services/image-generation-executor.js's
// NormalizedImageRequest) — nothing downstream of this shape ever knows
// which provider (EvoLink, a local deterministic renderer) will
// ultimately consume it.
//
// THIS FILE NEVER GENERATES ANYTHING. It only shapes the record;
// services/visual-world-service.js builds one per shot from
// CreativeBlueprint.visualSpecification + VisualBible + the Storyboard
// shot/VisualBeat itself, and existing, UNMODIFIED downstream consumers
// (composePromptSections()/composeVideoPromptSections() for GENERATED_NEW
// treatments, the deterministic renderers' own executors for
// MOTION_GRAPHIC/KINETIC_TYPOGRAPHY/WHITEBOARD) each read only the
// dimensions relevant to their own treatment (Part 5 — treatments are
// NOT interchangeable, there is no universal prompt template here).

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const MATERIAL_TYPES = ['IMAGE', 'VIDEO', 'DETERMINISTIC_RENDER'];

function createMaterialReference(overrides = {}) {
  const base = {
    entityType: null, // one of REFERENCE_ENTITY_TYPES ('CHARACTER'|'LOCATION'|'PROP'), or null for a non-entity reference
    entityId: null,
    assetId: null, // the canonical/approved reference asset actually resolved, or null if none available yet
    role: null, // free text — why this reference matters for this shot
  };
  return withDefaults(base, overrides);
}

// One shot's worth of provider-neutral visual intent. Every free-text
// field here is DERIVED — from CreativeBlueprint.visualSpecification
// (the shared, whole-video visual language) merged with anything the
// Storyboard shot/VisualBeat itself already specifies more specifically
// (shot-level always wins over blueprint-level — Part 14's own
// "storyboard explicitly changes it" escape hatch) — never invented.
function createMaterialSpecification(overrides = {}) {
  const { references, negativeConstraints, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    creativeBlueprintId: null, // provenance — Part 29 precedent from Creative Brain
    shotId: null,
    beatId: null,
    materialType: null, // one of MATERIAL_TYPES
    treatment: null, // one of VISUAL_TREATMENTS (schemas/visual-beat-schema.js) — never invented here
    shotPurpose: '',
    subject: '',
    action: '',
    environment: '',
    composition: '',
    camera: '',
    lighting: '',
    palette: '',
    texture: '',
    continuity: '', // human-readable summary; the real, structured continuity data stays on references[]/entity ids, never duplicated as prose-only
    references: Array.isArray(references) ? references.map((r) => createMaterialReference(r)) : [],
    negativeConstraints: Array.isArray(negativeConstraints) ? [...negativeConstraints] : [],
    temporalIntent: null, // { startTime, duration } — the shot's own real timing, when known; null if not yet resolved
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  MATERIAL_TYPES,
  createMaterialReference,
  createMaterialSpecification,
};
