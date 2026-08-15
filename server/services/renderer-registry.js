// renderer-registry.js
//
// Stage 26.8A — a small, deterministic lookup from renderSpec.type (see
// schemas/render-result-schema.js's RENDERER_TYPES) to the module that
// implements it (services/renderers/*). Mirrors services/material-
// executor-registry.js's exact convention and its exact scope discipline:
// this file does NOT choose a renderer by inspecting anything other than
// renderSpec.type itself (no natural-language matching, no guessing from
// beat content) — it only resolves a renderer for a renderSpec Material
// Execution already produced. See services/render-service.js for the
// caller that actually invokes the renderer this file hands back.
//
// Routing key is renderSpec.type, NOT executorType — every Stage 26.5A/
// 26.5B executor's renderSpec.type string already exactly matches one of
// these 6 names (confirmed during this stage's audit), so no separate
// mapping table is needed the way material-execution-service.js's
// resolveExecutorType() needs one for (materialSource, visualTreatment).

const RENDERERS = require('./renderers');
const { RENDERER_TYPES } = require('../schemas/render-result-schema');

// Returns the renderer module ({ render }) for a given renderSpec.type, or
// null if unregistered. Never throws.
function getRenderer(rendererType) {
  return RENDERERS[rendererType] || null;
}

function listRendererTypes() {
  return [...RENDERER_TYPES];
}

module.exports = { getRenderer, listRendererTypes, RENDERER_TYPES };
