// render-service.js
//
// Stage 26.8A — Deterministic Visual Rendering, the top-level entry point.
// Consumes an already-COMPLETED ExecutionResult (Stage 26.5A/26.5B's
// Material Execution — services/material-execution-service.js) and turns
// its `renderSpec` into an actual visual artifact via the appropriate
// renderer (services/renderers/*, looked up through services/renderer-
// registry.js). Mirrors material-execution-service.js's exact layering
// discipline and its exact "never throws, never crashes" contract.
//
// LAYERING, restated because it is the one rule this whole stage exists to
// enforce: Material Resolution decides WHAT should represent a beat.
// Material Execution decides HOW to describe it as a deterministic
// renderSpec. THIS file decides how to turn that renderSpec into an actual
// visual artifact — it re-decides nothing upstream: no re-resolution, no
// re-execution, no provider call, no creative decision of any kind. It
// only routes an already-decided, already-verbatim renderSpec to the
// renderer that knows how to draw it.
//
// No new state machine, no new queue, no automatic retry, no automatic
// substitution of a different renderer on failure, no timeline assembly —
// a failure is reported, structured, and stops there. `outputDir` is
// always caller-supplied (see services/renderers/svg-utils.js's
// writeSvgFile header) — this file never picks or persists a default
// location itself, so no second asset-storage system is introduced here.

const registry = require('./renderer-registry');
const { createRenderResult, createRenderDiagnostic } = require('../schemas/render-result-schema');

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: executionResult && executionResult.renderSpec ? executionResult.renderSpec.type : null,
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

// Public entry point.
//   projectId — scopes any store reads a renderer performs (read-only)
//   executionResult — a Stage 26.5A/26.5B ExecutionResult (services/
//     material-execution-service.js's executeMaterial() output)
//   outputDir — REQUIRED absolute path a renderer writes its artifact
//     into; this function never defaults or persists it
function renderMaterial(projectId, executionResult, outputDir) {
  if (!executionResult || executionResult.status !== 'COMPLETED' || !executionResult.renderSpec) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'executionResult.status must be COMPLETED with a renderSpec — nothing to render');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }

  const rendererType = executionResult.renderSpec.type;
  const renderer = registry.getRenderer(rendererType);
  if (!renderer) {
    return fail(executionResult, 'UNSUPPORTED_RENDER_TYPE', `renderSpec.type "${rendererType}" has no registered renderer`);
  }

  try {
    return renderer.render({ projectId, executionResult, outputDir });
  } catch (error) {
    // A renderer must never crash the service — any thrown error becomes a
    // structured FAILED result instead, the same discipline material-
    // execution-service.js already established for executors.
    return fail(executionResult, 'RENDERER_THREW', `renderer "${rendererType}" threw: ${error && error.message ? error.message : String(error)}`);
  }
}

module.exports = { renderMaterial };
