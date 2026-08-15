// broll-schema.js
//
// Stage 26.5B, Part 2 — the BRollSegment record shape: an asset-library
// entry that associates an EXISTING Asset (schemas/production-schema.js,
// whose bytes are already handled by services/asset-storage.js) with
// B-roll-specific descriptive/licensing/usage metadata. Same rules as every
// other schema file in this codebase: plain object factories only, no file
// I/O, no provider knowledge, no runtime enum validation (policy belongs to
// a later service, not this file — this file only describes shape), every
// field defaults to null/[]/'' so partial data is always valid.
//
// This is a genuinely NEW persisted artifact (a project's B-roll library),
// but it does NOT duplicate the underlying binary or its storage location:
// it references an existing Asset by assetId only. The relationship is:
//
//   BRollSegment --assetId--> Asset (production-schema.js)
//                                --storage--> services/asset-storage.js
//
// There is no second asset-storage abstraction here, and no `path`/`url`/
// `storage` field on this schema — that information lives exactly once, on
// the Asset it references.
//
// LICENSING VOCABULARY: deliberately NOT 'CLEARED'. The Stage 26.5B Part 1
// audit (before this file existed) confirmed that no persisted project data
// anywhere depends on the literal 'CLEARED' — it exists only in source code
// (services/material-resolution-service.js's pre-existing
// context.brollSegments consumption, and schemas/visual-beat-schema.js's
// separate, already-shipped MaterialComponent-level LICENSING_STATUSES
// constant). This schema's LICENSING_STATUSES is intentionally a different,
// richer vocabulary (adds REJECTED, gives RESTRICTED an explicit
// "conditionally eligible" meaning) for the NEW BRollSegment record type
// this file defines. Reconciling the OLDER 'CLEARED' check in
// material-resolution-service.js belongs to the later Material Resolution
// integration part, not this one — this file does not touch that literal.

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

// Where the underlying Asset's bytes originally came from. Provider-neutral
// on purpose — B-roll is an asset-library concern, never a generation-
// provider concern. Only the values already justified by the existing
// architecture are defined here.
const SOURCE_TYPES = ['LOCAL_UPLOAD', 'LIBRARY_IMPORT', 'EXTERNAL_REFERENCE'];

// Canonical licensing vocabulary for a BRollSegment (see file header for why
// this is not 'CLEARED'). Eligibility POLICY belongs to a later resolution/
// service stage — this file only represents the state:
//   LICENSED   — eligible
//   UNKNOWN    — hard fail for material resolution
//   RESTRICTED — potentially eligible only when a future resolution context
//                explicitly permits restricted material
//   REJECTED   — never eligible
const LICENSING_STATUSES = ['LICENSED', 'UNKNOWN', 'RESTRICTED', 'REJECTED'];

// Reuses the exact MATERIAL_ROLES vocabulary schemas/visual-beat-schema.js
// already defines for a beat's material components — never a new role set.
const MATERIAL_ROLES = ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT'];

// A BRollSegment record's own lifecycle — separate from the underlying
// Asset's own storage.status (NOT_ARCHIVED/STORED/FAILED, defined on the
// Asset itself). This describes whether the B-ROLL RECORD is usable, not
// whether its bytes exist.
const BROLL_STATUSES = ['ACTIVE', 'ARCHIVED'];

function createBrollSource(overrides = {}) {
  const base = {
    type: null, // one of SOURCE_TYPES
    provider: null, // free text (e.g. 'human') — never a generation provider name
    originalReference: null, // free text describing where this came from — never invented
    importedAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

// Every field may be null — the Stage 26.5B Part 1 audit confirmed no media
// metadata extraction (ffprobe/ffmpeg/dimension or duration detection)
// exists anywhere in this repository, and this stage does not add one.
// Unknown metadata is represented as null, never guessed or defaulted to a
// plausible-looking value.
function createBrollMedia(overrides = {}) {
  const base = {
    duration: null,
    width: null,
    height: null,
    fps: null,
    aspectRatio: null,
    mimeType: null,
    fileSize: null,
  };
  return withDefaults(base, overrides);
}

// Explicit, human/deterministic metadata only — no embeddings, no vectors,
// no semantic search, no LLM classification, no automatic/ML tagging. Those
// belong to a possible future stage, not this one.
function createBrollDescriptiveMetadata(overrides = {}) {
  const base = {
    title: '',
    description: '',
    tags: [],
    subjects: [],
    environments: [],
    actions: [],
    mood: '',
    visualStyle: '',
  };
  return withDefaults(base, overrides);
}

function createBrollLicensing(overrides = {}) {
  const base = {
    status: null, // one of LICENSING_STATUSES
    source: '', // free text describing where the license/permission comes from
    attribution: '', // free text, a required credit line if any
    restrictions: [], // free-text restriction descriptions, only meaningful when status === 'RESTRICTED'
  };
  return withDefaults(base, overrides);
}

function createBrollUsage(overrides = {}) {
  const base = {
    eligibleRoles: [], // MATERIAL_ROLES values this segment is usable for — empty until a later stage assigns them, never assumed
    allowedTreatments: ['BROLL_CLIP'], // visualTreatment values this segment may satisfy — B-roll only ever satisfies BROLL_CLIP
  };
  return withDefaults(base, overrides);
}

// The BRollSegment record itself. References an EXISTING Asset by assetId
// only — see file header for why there is no path/url/storage field here.
function createBrollSegment(overrides = {}) {
  const { source, media, descriptiveMetadata, licensing, usage, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    assetId: null, // the existing Asset this B-roll record describes — never a new binary
    source: createBrollSource(source),
    media: createBrollMedia(media),
    descriptiveMetadata: createBrollDescriptiveMetadata(descriptiveMetadata),
    licensing: createBrollLicensing(licensing),
    usage: createBrollUsage(usage),
    status: 'ACTIVE', // one of BROLL_STATUSES
    createdAt: new Date().toISOString(),
    // Stage 26.5B, Part 3 — pre-declared exactly like
    // production-schema.js's defaultAssetStorage() pre-declares archivedAt
    // before an asset is ever archived. Stay null until
    // services/broll-library-service.js's archiveBrollSegment() sets them;
    // never populated at creation time.
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
  };
  return withDefaults(base, rest);
}

module.exports = {
  SOURCE_TYPES,
  LICENSING_STATUSES,
  MATERIAL_ROLES,
  BROLL_STATUSES,
  createBrollSource,
  createBrollMedia,
  createBrollDescriptiveMetadata,
  createBrollLicensing,
  createBrollUsage,
  createBrollSegment,
};
