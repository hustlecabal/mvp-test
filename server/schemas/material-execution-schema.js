// material-execution-schema.js
//
// Stage 26.5A — the ExecutionResult shape, produced by
// services/material-execution-service.js's executeMaterial(). Same rules as
// every other schema file in this codebase: plain object factories only, no
// file I/O, no provider knowledge, every field defaults to null/[]/'' so
// partial data is always valid, nothing here invents information.
//
// This is a COMPUTED SNAPSHOT, not an edited creative artifact — the same
// discipline schemas/material-resolution-schema.js already established for
// MaterialResolution: no versionFields()/history, regenerated fresh on every
// call, no new store.
//
// LAYERING: Material Resolution (schemas/material-resolution-schema.js)
// decides WHAT should represent a beat — a materialSource/visualTreatment
// pair. This schema describes HOW that decision gets turned into a
// deterministic, structured render specification. It never contains a
// provider name, a model name, or a cost estimate — execution here means
// "compute the render spec," never "call a provider" or "spend a credit."

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

const EXECUTION_STATUSES = ['COMPLETED', 'FAILED'];

// The five deterministic, zero/near-zero-cost executors Stage 26.5A proves.
// Deliberately its own vocabulary, not a re-use of VISUAL_TREATMENTS or
// MATERIAL_SOURCES: PROJECT_ASSET_REUSE maps onto a materialSource value,
// but STILL_IMAGE_MOTION/KINETIC_TYPOGRAPHY/MOTION_GRAPHIC/WHITEBOARD map
// onto visualTreatment values — an ExecutorType is the ROUTING key
// services/material-execution-service.js derives from a resolved
// candidate's (materialSource, visualTreatment) pair, not a straight alias
// of either existing enum (see that service's own resolveExecutorType()
// comment for the exact derivation rule).
const EXECUTOR_TYPES = ['PROJECT_ASSET_REUSE', 'STILL_IMAGE_MOTION', 'KINETIC_TYPOGRAPHY', 'MOTION_GRAPHIC', 'WHITEBOARD'];

// One structured diagnostic entry — same {code, message} shape used
// throughout this stage's executors, never a bare string, so a caller can
// branch on `code` without parsing prose.
function createDiagnostic(overrides = {}) {
  const base = {
    code: null,
    message: '',
  };
  return withDefaults(base, overrides);
}

function createExecutionResult(overrides = {}) {
  const base = {
    executionId: crypto.randomUUID(),
    beatId: null,
    materialId: null, // the resolved candidate's own id (MaterialResolution's
                        // selectedMaterial.candidate) — links this result
                        // back to the exact resolution decision it executed
    executorType: null, // one of EXECUTOR_TYPES
    status: null, // one of EXECUTION_STATUSES
    duration: null, // seconds — the render spec's own duration, echoed here
                      // for convenience; the single source of truth is
                      // always renderSpec itself
    renderSpec: null, // executor-specific structured spec — see each
                        // executor module's own header comment for its
                        // exact shape; null when status: FAILED
    sourceAssetIds: [], // existing Asset ids this execution READS (never
                          // mutates) — empty for executors that reference no
                          // existing asset (KINETIC_TYPOGRAPHY/
                          // MOTION_GRAPHIC/WHITEBOARD today)
    diagnostics: [], // createDiagnostic() entries — populated on FAILED,
                       // may also carry non-fatal notes on COMPLETED
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  EXECUTION_STATUSES,
  EXECUTOR_TYPES,
  createDiagnostic,
  createExecutionResult,
};
