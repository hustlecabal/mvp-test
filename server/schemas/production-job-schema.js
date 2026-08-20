// production-job-schema.js
//
// P0-ORCH — the ProductionJob shape, produced and persisted by
// services/production-orchestrator-service.js. Represents the lifecycle of
// turning ONE approved CreativeBlueprint's current Storyboard into ONE
// final assembled video, through the existing, unmodified production
// primitives (BeatGraph derivation, Material Resolution/Execution,
// rendering, narration/voice/Whisper, Timeline Compilation, Assembly).
//
// This is a REAL, PERSISTED record — unlike every *-result-schema.js
// computed-snapshot in this codebase (RenderResult, ExecutionResult,
// MaterialResolution, TimelineCompilationResult, AssemblyResult), a
// ProductionJob is the one thing in this pipeline that genuinely needs to
// survive across calls: it is what makes "one operator entry point drives
// the whole chain" possible instead of a human re-invoking each stage by
// hand. It stores REFERENCES to those other services' own real, persisted
// outputs (asset ids, render artifact paths, the final assembly path) —
// never a second copy of a project's Storyboard/BeatGraph content that
// could drift out of sync with the real one.
//
// NOT A NEW STATE MACHINE FOR THE PROJECT: schemas/state-machine.js's
// project-level states (DRAFT/IN_PROGRESS/...) are untouched by this file
// and this file's own status values are never written back onto a project
// record. A ProductionJob describes ONE production run, not the project's
// overall lifecycle.

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

// Sequential, one-directional lifecycle — mirrors the real call sequence
// services/production-orchestrator-service.js drives (itself mirroring the
// exact stage order test/video-assembly-pipeline.test.js's GOLDEN VIDEO
// proof already exercises by hand). FAILED and ESCALATED are the only
// non-terminal-success exits; both are terminal for THIS run — a caller
// fixes the underlying issue (e.g. approves a pending generation) and
// starts a NEW production run, exactly like a CreativeBlueprint REJECT is
// terminal and a new draft is required, never resurrected in place.
const PRODUCTION_JOB_STATUSES = [
  'REQUESTED',
  'DERIVING_BEATS',
  'RESOLVING_MATERIALS',
  'EXECUTING_MATERIALS',
  'RENDERING',
  'GENERATING_NARRATION',
  'COMPILING_TIMELINE',
  'ASSEMBLING',
  'QC',
  'COMPLETE',
  'FAILED',
  'ESCALATED',
];

// Which stage a FAILED/ESCALATED job stopped at — used by
// get_production_status / resumeProduction to know exactly where to
// pick back up, and by a human reading the job to know what actually
// went wrong without re-deriving it from diagnostics prose.
const PRODUCTION_FAILURE_STAGES = [
  'APPROVAL_BOUNDARY',
  'STORYBOARD',
  'BEATGRAPH',
  'MATERIAL_RESOLUTION',
  'MATERIAL_EXECUTION',
  'RENDERING',
  'NARRATION',
  'TIMELINE_COMPILATION',
  'ASSEMBLY',
  'QC',
];

function createProductionDiagnostic(overrides = {}) {
  const base = {
    code: null,
    stage: null, // one of PRODUCTION_FAILURE_STAGES, or null for a job-level diagnostic
    beatId: null,
    message: '',
  };
  return withDefaults(base, overrides);
}

// One beat that reached MATERIAL_EXECUTION but resolved to a GENERATED_NEW
// material with no already-approved asset yet (services/material-executors/
// generated-new-executor.js's own NO_APPROVED_GENERATION_EXISTS outcome).
// The orchestrator never triggers paid generation itself (see that file's
// own header for why) — it records exactly which beat needs which existing,
// human-operated Pipeline A step next, and continues assembling every OTHER
// beat it can.
function createProductionEscalation(overrides = {}) {
  const base = {
    beatId: null,
    reason: '', // the exact next-step text generated-new-executor.js's own NEXT_STEP_BY_TREATMENT already provides
  };
  return withDefaults(base, overrides);
}

// One beat's real, persisted per-stage artifacts — the resumability
// checkpoint (Part 17). Only ever grows more fields as a beat progresses
// further through the pipeline; never rewritten backwards.
function createBeatProgress(overrides = {}) {
  const base = {
    beatId: null,
    resolution: null, // MaterialResolution (schemas/material-resolution-schema.js) — cheap to recompute, kept for provenance/inspection
    execution: null, // ExecutionResult (schemas/material-execution-schema.js)
    render: null, // RenderResult (schemas/render-result-schema.js) — the expensive one (real Chrome+FFmpeg); presence means "do not re-render"
    narrationDirection: null, // NarrationDirection (schemas/narration-schema.js), only for a beat with a narrationSegment.text
    audioEvent: null, // AudioEvent (schemas/audio-schema.js) — the other expensive one (real espeak-ng+faster-whisper); presence means "do not re-narrate"
    escalation: null, // createProductionEscalation() shape, set instead of execution/render when generation is required
  };
  return withDefaults(base, overrides);
}

function createProductionJob(overrides = {}) {
  const { diagnostics, escalations, beatProgress, ...rest } = overrides;
  const base = {
    productionJobId: crypto.randomUUID(),
    projectId: null,
    blueprintId: null, // the exact APPROVED CreativeBlueprint this run was authorized against (control-plane-service.js's own validated anchor)
    gateResultId: null, // the exact ACCEPTED/OVERRIDDEN PreProductionGateResult this run was authorized against
    storyboardBlueprintId: null, // Storyboard.blueprintId at REQUESTED time — a staleness anchor, same discipline pre-production-gate-service.js's own isGateResultStale already established for its own blueprintUpdatedAt
    outputDir: null, // caller-supplied, exactly like render-service.js/video-assembly-service.js's own outputDir discipline — never defaulted or persisted elsewhere
    status: 'REQUESTED', // one of PRODUCTION_JOB_STATUSES
    failureStage: null, // one of PRODUCTION_FAILURE_STAGES, set only when status is FAILED/ESCALATED
    // Derivation context (treatments/narrationSegments/narrativeRoles/
    // visualBible) — the SAME explicit, caller-supplied shape
    // beat-graph-derivation-service.js's own deriveBeatGraph() already
    // accepts. Persisted so a crash-resume never needs the caller to
    // re-supply it identically, and so deriveBeatGraph() is only ever
    // called once per job (Part 18 idempotency).
    derivationContext: null,
    materialOptions: null, // { [beatId]: options } — see production-orchestrator-service.js's own header for why this is separate from derivationContext
    beatGraph: null, // schemas/beat-graph-schema.js's createBeatGraph() output — re-derived once, then updated in place by narration-timing-service.js's applyNarrationTiming() once real audio timing exists
    beatProgress: Array.isArray(beatProgress) ? beatProgress.map((b) => createBeatProgress(b)) : [],
    escalations: Array.isArray(escalations) ? escalations.map((e) => createProductionEscalation(e)) : [],
    timelineCompilation: null, // TimelineCompilationResult (schemas/timeline-compilation-schema.js)
    assemblyResult: null, // AssemblyResult (schemas/assembly-result-schema.js) — the final artifact
    captionResult: null, // CaptionTrackResult (schemas/caption-schema.js) — P0-TEMPORAL: a sidecar SRT/caption export derived from this SAME run's real narration AudioEvents; NEVER gates COMPLETE/QC and never re-renders the final MP4 (see production-orchestrator-service.js's own caption step)
    qc: null, // { passed: boolean, checks: [{ code, passed, message }] } — see production-orchestrator-service.js's runAutomaticQc()
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createProductionDiagnostic(d)) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  PRODUCTION_JOB_STATUSES,
  PRODUCTION_FAILURE_STAGES,
  createProductionDiagnostic,
  createProductionEscalation,
  createBeatProgress,
  createProductionJob,
};
