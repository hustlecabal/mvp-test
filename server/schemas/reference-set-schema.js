// reference-set-schema.js
//
// INT-1E, Part 2/3 — the smallest useful concept for grouping already-
// ingested ReferenceVideos (INT-1A) for cross-video comparison. A
// ReferenceSet NEVER duplicates a video's binary, transcript, or
// measurements — it only ever holds a list of REAL, existing ReferenceVideo
// ids (validated by services/reference-set-service.js against
// services/reference-video-store.js before being added; this schema file
// itself performs no validation, matching every other schema file's "shape
// only, no I/O" rule). Membership is always EXPLICIT (Part 2's own
// instruction): there is no field anywhere in this file through which
// membership could be inferred from a filename, folder, or timestamp —
// only ever from an ADD_VIDEO call recorded here.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const REFERENCE_SET_STATUSES = ['ACTIVE', 'ARCHIVED'];

// Part 17 — human curation of an individual member. PENDING is the
// default the moment a video is added; a human later APPROVEs or REJECTs
// it for inclusion in pattern extraction (services/cross-video-pattern-
// service.js only ever aggregates APPROVED and PENDING members — never
// REJECTED ones — see that file's own header).
const MEMBER_CURATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

function createReferenceSetMember(overrides = {}) {
  const base = {
    referenceVideoId: null,
    addedAt: new Date().toISOString(),
    addedBy: null,
    curationStatus: 'PENDING', // one of MEMBER_CURATION_STATUSES
    label: null, // Part 17's own "LABEL" action — free-text human tag, e.g. "finance-explainer"
    curatedBy: null,
    curatedAt: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// The ReferenceSet itself.
// ---------------------------------------------------------------------------
function createReferenceSet(overrides = {}) {
  const { members, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    name: '',
    description: '',
    // Part 2 — free-text intended-homogeneity criteria the human who
    // created the set is asserting (e.g. "short finance-explainer style
    // videos"). Never verified by this file — services/cross-video-
    // pattern-service.js's own homogeneity check (Part 4) is the only
    // thing that independently tests real metadata; `criteria` is the
    // human's stated INTENT, not a fact.
    criteria: '',
    members: Array.isArray(members) ? members.map((m) => createReferenceSetMember(m)) : [],
    status: 'ACTIVE', // one of REFERENCE_SET_STATUSES
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  REFERENCE_SET_STATUSES,
  MEMBER_CURATION_STATUSES,
  createReferenceSetMember,
  createReferenceSet,
};
