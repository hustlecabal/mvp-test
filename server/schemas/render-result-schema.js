// render-result-schema.js
//
// Stage 26.8A — the RenderResult shape, produced by
// services/render-service.js's renderMaterial(). Same rules as every other
// schema file in this codebase: plain object factories only, no file I/O,
// no provider knowledge, every field defaults to null/[]/'' so partial
// data is always valid, nothing here invents information.
//
// This is a COMPUTED SNAPSHOT — the same discipline
// schemas/material-execution-schema.js's ExecutionResult and schemas/
// timeline-compilation-schema.js's TimelineCompilationResult already
// established: no versionFields()/history, regenerated fresh every call.
//
// LAYERING, restated because it is the one rule this stage exists to
// enforce: Material Resolution decides WHAT should represent a beat.
// Material Execution decides HOW to describe it as a deterministic
// renderSpec. THIS schema/service decides how to turn that renderSpec into
// an actual visual artifact — never re-deciding WHAT or HOW, only
// executing the already-decided renderSpec. No provider name, no model
// name, no cost field — rendering here is deterministic local
// infrastructure, never a provider call.

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

const RENDER_STATUSES = ['COMPLETED', 'FAILED'];

// One entry per services/renderers/* module — keyed by the exact
// renderSpec.type string value each Stage 26.5A/26.5B executor already
// produces (see services/renderer-registry.js's own header for why this,
// not executorType, is the routing key).
const RENDERER_TYPES = ['ASSET_PLACEMENT', 'STILL_IMAGE_MOTION', 'KINETIC_TYPOGRAPHY', 'MOTION_GRAPHIC', 'WHITEBOARD', 'BROLL_CLIP'];

// Formats an actual renderer in this stage can genuinely produce. Never
// 'MP4'/'JPEG' etc. speculatively — only values a real renderer module
// below actually writes.
const RENDER_ARTIFACT_FORMATS = ['SVG'];

function createRenderDiagnostic(overrides = {}) {
  const base = {
    code: null,
    message: '',
  };
  return withDefaults(base, overrides);
}

// The actual produced artifact — null when status: FAILED. `path` is an
// absolute filesystem path under the caller-supplied output directory
// (services/render-service.js never picks or persists this location
// itself — see that file's own header for why no second asset-storage
// system is introduced this stage).
function createRenderArtifact(overrides = {}) {
  const base = {
    format: null, // one of RENDER_ARTIFACT_FORMATS
    path: null,
    width: null,
    height: null,
    duration: null, // seconds — only meaningful for an animated artifact; null for a static one
    frameCount: null, // only meaningful for a frame-sequence artifact — null for every renderer this stage produces (all are single SVG documents, animated via SMIL where applicable, never a frame sequence)
  };
  return withDefaults(base, overrides);
}

function createRenderResult(overrides = {}) {
  const base = {
    renderId: crypto.randomUUID(),
    rendererType: null, // one of RENDERER_TYPES
    // --- provenance: traces back through every prior stage ---
    beatId: null,
    materialId: null, // the resolved candidate id (ExecutionResult.materialId)
    executionId: null, // which ExecutionResult this was rendered from
    status: null, // one of RENDER_STATUSES
    artifact: null, // createRenderArtifact(), null when FAILED
    diagnostics: [], // createRenderDiagnostic() entries
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  RENDER_STATUSES,
  RENDERER_TYPES,
  RENDER_ARTIFACT_FORMATS,
  createRenderDiagnostic,
  createRenderArtifact,
  createRenderResult,
};
