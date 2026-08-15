// material-execution-service.js
//
// Stage 26.5A — Material Execution. Consumes an already-resolved
// MaterialResolution (Stage 26.3/26.4's Material Resolution Engine — see
// services/material-resolution-service.js) and turns its `selectedMaterial`
// decision into a deterministic render specification via the appropriate
// executor (services/material-executors/*, looked up through
// services/material-executor-registry.js).
//
// LAYERING, restated because it is the one rule this whole stage exists to
// enforce: Material Resolution decides WHAT should represent a beat.
// Material Execution decides HOW to actually produce that representation.
// This file contains NO gating/scoring/ranking logic of its own — it never
// re-decides what material a beat should use, it only routes an
// already-decided material to the executor that knows how to turn it into
// a render spec.
//
// No new state machine, no new queue, no automatic retry, no automatic
// substitution of a different material on failure — a failure is reported,
// structured, and stops there, exactly as instructed.

const registry = require('./material-executor-registry');
const { createExecutionResult, createDiagnostic } = require('../schemas/material-execution-schema');

// Deterministic routing rule from a resolved candidate's (materialSource,
// visualTreatment) pair to an EXECUTOR_TYPE. NOT a ranking or a choice among
// alternatives — Material Resolution already made that choice; this is a
// fixed structural lookup over its OUTPUT.
//
//   visualTreatment STILL_IMAGE          -> STILL_IMAGE_MOTION (regardless
//     of materialSource — a still is a still whether reused or freshly
//     generated; the camera-motion instructions are the same either way,
//     per docs/architecture/stage-26.2-visual-production-master-spec.md,
//     Part 12.1 — though GENERATED_NEW without a concrete asset yet still
//     fails structurally inside the executor itself, since AI image
//     generation is out of this stage's scope)
//   visualTreatment KINETIC_TYPOGRAPHY   -> KINETIC_TYPOGRAPHY
//   visualTreatment MOTION_GRAPHIC       -> MOTION_GRAPHIC
//   visualTreatment WHITEBOARD           -> WHITEBOARD
//   materialSource PROJECT_ASSET_REUSE   -> PROJECT_ASSET_REUSE (every other
//     treatment reached via existing-asset reuse — e.g. AI_VIDEO/BROLL_CLIP
//     treatments satisfied by an already-existing video asset: just placed,
//     no motion synthesis needed, it is already a video)
//   everything else (GENERATED_NEW AI_VIDEO, BROLL_LIBRARY BROLL_CLIP, ...)
//     -> null, unsupported this stage — AI video generation and B-roll
//     ingestion are explicitly out of Stage 26.5A's scope
function resolveExecutorType(selectedMaterial) {
  if (!selectedMaterial) return null;
  if (selectedMaterial.visualTreatment === 'STILL_IMAGE') return 'STILL_IMAGE_MOTION';
  if (selectedMaterial.visualTreatment === 'KINETIC_TYPOGRAPHY') return 'KINETIC_TYPOGRAPHY';
  if (selectedMaterial.visualTreatment === 'MOTION_GRAPHIC') return 'MOTION_GRAPHIC';
  if (selectedMaterial.visualTreatment === 'WHITEBOARD') return 'WHITEBOARD';
  if (selectedMaterial.materialSource === 'PROJECT_ASSET_REUSE') return 'PROJECT_ASSET_REUSE';
  return null;
}

function fail(beat, materialResolution, code, message) {
  return createExecutionResult({
    beatId: beat ? beat.id : materialResolution ? materialResolution.beatId : null,
    materialId: materialResolution && materialResolution.selectedMaterial ? materialResolution.selectedMaterial.candidate : null,
    executorType: null,
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds: [],
    diagnostics: [createDiagnostic({ code, message })],
  });
}

// Public entry point.
//   projectId — scopes any store reads an executor performs (read-only)
//   beat — the VisualBeat this materialResolution was computed for
//   materialResolution — a Stage 26.3/26.4 MaterialResolution
//     (services/material-resolution-service.js's resolveMaterial() output)
//   options — executor-specific parameters, passed straight through (see
//     each executor module's own header comment for its accepted shape)
function executeMaterial(projectId, beat, materialResolution, options = {}) {
  if (!materialResolution || materialResolution.status !== 'RESOLVED' || !materialResolution.selectedMaterial) {
    return fail(beat, materialResolution, 'UNRESOLVED_MATERIAL', 'materialResolution.status must be RESOLVED with a selectedMaterial — nothing to execute');
  }

  const { selectedMaterial } = materialResolution;
  const executorType = resolveExecutorType(selectedMaterial);
  if (!executorType) {
    return fail(
      beat,
      materialResolution,
      'UNSUPPORTED_MATERIAL',
      `no Stage 26.5A executor exists for materialSource "${selectedMaterial.materialSource}" + visualTreatment "${selectedMaterial.visualTreatment}" — out of scope this stage`
    );
  }

  const executor = registry.getExecutor(executorType);
  if (!executor) {
    return fail(beat, materialResolution, 'NO_EXECUTOR_REGISTERED', `executorType "${executorType}" resolved but has no registered executor`);
  }

  try {
    const result = executor.execute({ projectId, beat, selectedMaterial, options });
    // Defensive, not a silent override: every executor already sets these
    // itself — this only fills a gap if one didn't, never changes a value
    // an executor explicitly set.
    if (result.beatId === null && beat) result.beatId = beat.id;
    if (result.materialId === null && selectedMaterial) result.materialId = selectedMaterial.candidate;
    return result;
  } catch (error) {
    // An executor must never crash the service — any thrown error becomes
    // a structured FAILED result instead, same "never let one bad input
    // take down the caller" discipline every other service in this
    // codebase already follows.
    return fail(beat, materialResolution, 'EXECUTOR_THREW', `executor "${executorType}" threw: ${error && error.message ? error.message : String(error)}`);
  }
}

module.exports = { executeMaterial, resolveExecutorType };
