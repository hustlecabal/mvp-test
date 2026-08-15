// beat-graph-schema.js
//
// Stage 26.1 — the BEAT GRAPH layer (see
// docs/architecture/stage-26-visual-production-director-investigation.md,
// Part 5, and schemas/visual-beat-schema.js for VisualBeat itself).
//
// Structure: a flat array of beats plus a flat array of lightweight
// dependency/continuity edges — the same convention every other artifact
// in this codebase already uses (Storyboard's scenes[]+shots[], each shot
// referencing sceneId rather than nesting; Timeline IR's scenes[]+shots[];
// project.assets referencing shotId/keyframeId rather than nesting). This
// is a deliberate, repeated pattern: a flat array with foreign-key
// references makes staleness detection, versioning, and "find every X for
// this Y" queries trivial single-pass filters instead of tree walks.
//
// This is NOT a general-purpose graph engine. `edges` is a small, typed
// adjacency list for the specific relationships a beat graph needs to
// express (continuity, ordering dependency, fallback alternates,
// cross-scene transitions) — never a node/edge database, matching this
// codebase's established "lightweight versioning, not Git-like" restraint
// (see creative-schema.js's versionFields comment for the same principle
// applied to history tracking).
//
// Same rules as every other schema file: plain object factories only, no
// file I/O, no provider knowledge, every field defaults to null/[] so
// partial data is always valid, nothing here invents information.

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

// Four edge kinds cover everything a beat graph needs to express (Stage 26
// investigation, Part 5.1):
//   CONTINUITY    — both beats must render with the same identity/
//                    wardrobe/environment state
//   DEPENDS_ON    — `toBeatId` cannot be resolved/placed until
//                    `fromBeatId` is resolved
//   ALTERNATE_OF  — `toBeatId` is a fallback candidate for `fromBeatId`,
//                    not a second beat that ever lands on the timeline
//                    itself unless the first one fails
//   TRANSITIONS_TO — an explicit transition relationship beyond a single
//                    beat's own `transition` field, for cross-scene
//                    transitions that need to know both sides
const BEAT_EDGE_KINDS = ['CONTINUITY', 'DEPENDS_ON', 'ALTERNATE_OF', 'TRANSITIONS_TO'];

function createBeatEdge(overrides = {}) {
  const base = {
    edgeId: crypto.randomUUID(),
    fromBeatId: null,
    toBeatId: null,
    kind: null, // one of BEAT_EDGE_KINDS
    note: null,
  };
  return withDefaults(base, overrides);
}

// A project's whole Beat Graph. `beats` is a flat array of VisualBeat
// (schemas/visual-beat-schema.js's createVisualBeat) — each already
// carries its own sceneId/shotId/sequence, so "beats grouped into scenes"
// is just a filter+sort over this one array, no nesting required.
function createBeatGraph(overrides = {}) {
  const base = {
    projectId: null,
    beats: [],
    edges: [],
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  BEAT_EDGE_KINDS,
  createBeatEdge,
  createBeatGraph,
};
