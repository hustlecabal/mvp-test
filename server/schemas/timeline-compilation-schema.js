// timeline-compilation-schema.js
//
// Stage 26.6, Part 2 — the TimelineCompilationResult shape, produced by
// services/timeline-compiler-service.js's compileTimeline(). Same rules as
// every other schema file: plain object factories only, no file I/O, no
// provider knowledge, every field defaults to null/[]/'' so partial data is
// always valid, nothing here invents information.
//
// This is a COMPUTED SNAPSHOT — the same discipline
// schemas/material-resolution-schema.js and schemas/material-execution-
// schema.js already established: no versionFields()/history, regenerated
// fresh every call, never persisted by this file or by
// timeline-compiler-service.js itself (persistence is a later, separate,
// explicit operation — see that service's own header comment).
//
// `shots` entries are NOT a new schema — they are ordinary
// schemas/production-schema.js Shot records (createShot()), carrying five
// additive fields (layer/renderSpec/beatId/materialId/executionId). This
// file never defines its own competing "Shot"/"TimelineEvent" shape — see
// Stage 26.6 Part 1's audit for why that would be a second timeline
// system.
//
// `transitions` entries ARE newly shaped here — schemas/production-
// schema.js's createTimelineIR() already declares a `transitions: []`
// array, but nothing before this stage ever defined what one ENTRY in it
// looks like. createCompiledTransition() below is that first shape,
// deliberately mirroring schemas/beat-graph-schema.js's own BeatEdge shape
// almost exactly (fromBeatId/toBeatId/kind/note) — not a second timeline
// concept, just this stage populating an already-declared, previously-
// unshaped field for the first time.

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

const TIMELINE_COMPILATION_STATUSES = ['COMPILED', 'PARTIAL', 'FAILED'];

// Structured diagnostic — same {code, message} shape
// schemas/material-execution-schema.js's createDiagnostic already uses,
// duplicated here (not imported) per this codebase's established
// self-contained-schema-file convention (see schemas/visual-beat-
// schema.js's own header comment for the same rule). `beatId`/`materialId`
// are additive on top of that shape, letting a diagnostic point at exactly
// which beat/material it concerns when relevant — null when a diagnostic
// is graph-wide (e.g. INVALID_BEAT_GRAPH) rather than beat-specific.
function createCompilationDiagnostic(overrides = {}) {
  const base = {
    code: null,
    message: '',
    beatId: null,
    materialId: null,
  };
  return withDefaults(base, overrides);
}

// The first-ever shape for one entry of TimelineIR's existing
// `transitions[]` array (see file header). Deliberately minimal — a
// transition is a relationship between two beats, not a rendering
// instruction (no easing/duration/style here; that belongs to a future
// render-stage concern once one exists, per the Stage 26.6 Part 1 audit's
// own "no policy invented this stage" discipline).
function createCompiledTransition(overrides = {}) {
  const base = {
    fromBeatId: null,
    toBeatId: null,
    kind: null, // schemas/beat-graph-schema.js's BEAT_EDGE_KINDS — always
                 // 'TRANSITIONS_TO' as produced by this stage's compiler
    note: null,
  };
  return withDefaults(base, overrides);
}

function createTimelineCompilationResult(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    projectId: null, // informational only — never required for compilation itself
    status: null, // one of TIMELINE_COMPILATION_STATUSES
    shots: [], // production-schema.js Shot records, see file header
    transitions: [], // createCompiledTransition() entries
    diagnostics: [], // createCompilationDiagnostic() entries
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  TIMELINE_COMPILATION_STATUSES,
  createCompilationDiagnostic,
  createCompiledTransition,
  createTimelineCompilationResult,
};
