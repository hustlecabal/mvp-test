// assembly-result-schema.js
//
// P0-3B — the AssemblyResult shape, produced by
// services/video-assembly-service.js's assembleTimeline(). Same rules as
// every other schema file in this codebase: plain object factories only,
// no file I/O, no provider knowledge, every field defaults to null/[]/''
// so partial data is always valid, nothing here invents information.
//
// This is a COMPUTED SNAPSHOT — the same discipline schemas/render-result-
// schema.js's RenderResult and schemas/timeline-compilation-schema.js's
// TimelineCompilationResult already established: no versionFields()/
// history, regenerated fresh every call, never persisted by this file or
// by video-assembly-service.js itself.
//
// NO "FinalVideo" HIERARCHY (Part 2's explicit instruction): the produced
// MP4 is described here the exact same way schemas/render-result-schema.js
// already describes a rendered artifact — a plain { format, path, width,
// height, duration } record, here extended with `fps` since a full
// assembled video (unlike one renderer's own single artifact) is the first
// place frame rate becomes a real, load-bearing, whole-timeline decision
// (Part 6). This is NOT a new schemas/production-schema.js Asset — nothing
// in this stage calls timelineStore.addAsset() to register the result as a
// persisted project Asset (that would be a "publish to project" decision
// deliberately left to the caller, exactly like services/render-service.js
// never persists its own artifact.path either). videoSources[]/narration
// instead carry plain ASSET REFERENCES (assetId strings) back into the
// project's own existing Asset records — "reference", never a duplicate.

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

const ASSEMBLY_STATUSES = ['COMPLETED', 'FAILED'];

function createAssemblyDiagnostic(overrides = {}) {
  const base = {
    code: null,
    message: '',
    shotId: null,
    beatId: null,
  };
  return withDefaults(base, overrides);
}

// Mirrors schemas/render-result-schema.js's createRenderArtifact shape
// exactly, plus `fps` — see file header for why no new hierarchy.
function createAssemblyArtifact(overrides = {}) {
  const base = {
    format: null, // always 'MP4' once status: COMPLETED
    path: null, // absolute path under the caller-supplied outputDir — never persisted/picked by this file
    width: null,
    height: null,
    fps: null,
    duration: null, // seconds — the ACTUAL, ffprobe-measured output duration (Part 12), never the expected/target one
  };
  return withDefaults(base, overrides);
}

// One compiled PRIMARY shot's lineage (Part 13): Final video -> assembled
// shot -> executionId -> materialId -> beatId -> sourceAssetId.
function createShotProvenanceEntry(overrides = {}) {
  const base = {
    shotId: null,
    beatId: null,
    materialId: null,
    executionId: null,
    renderId: null,
    sourceAssetId: null, // the render artifact's originating Asset, when the renderSpec names one (ASSET_PLACEMENT/STILL_IMAGE_MOTION/BROLL_CLIP) — null for a renderSpec with no single source asset (e.g. MOTION_GRAPHIC/KINETIC_TYPOGRAPHY)
    startTime: null, // the TimelineIR-authoritative placement actually used (Part 4)
    duration: null,
  };
  return withDefaults(base, overrides);
}

// Narration lineage (Part 13): Final video -> AudioEvent -> sourceAssetId
// -> scriptRefId -> beatId.
function createNarrationProvenanceEntry(overrides = {}) {
  const base = {
    audioEventId: null,
    sourceAssetId: null,
    scriptRefId: null,
    beatId: null,
    startTime: null,
    duration: null,
  };
  return withDefaults(base, overrides);
}

function createAssemblyProvenance(overrides = {}) {
  const { shots, narration, ...rest } = overrides;
  const base = {
    shots: Array.isArray(shots) ? shots.map((s) => createShotProvenanceEntry(s)) : [],
    narration: Array.isArray(narration) ? narration.map((n) => createNarrationProvenanceEntry(n)) : [],
  };
  return withDefaults(base, rest);
}

function createAssemblyResult(overrides = {}) {
  const { artifact, provenance, diagnostics, videoSources, narrationSources, ...rest } = overrides;
  const base = {
    assemblyId: crypto.randomUUID(),
    projectId: null,
    status: null, // one of ASSEMBLY_STATUSES
    expectedDuration: null, // seconds — computed from TimelineIR before assembly ran (Part 12)
    artifact: artifact !== undefined ? (artifact === null ? null : createAssemblyArtifact(artifact)) : null,
    videoSources: Array.isArray(videoSources) ? videoSources : [], // sourceAssetId strings — "video asset/reference" (Part 2)
    narrationSources: Array.isArray(narrationSources) ? narrationSources : [], // sourceAssetId strings — "audio asset/reference" (Part 2)
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    provenance: provenance !== undefined ? (provenance === null ? null : createAssemblyProvenance(provenance)) : createAssemblyProvenance(),
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  ASSEMBLY_STATUSES,
  createAssemblyDiagnostic,
  createAssemblyArtifact,
  createShotProvenanceEntry,
  createNarrationProvenanceEntry,
  createAssemblyProvenance,
  createAssemblyResult,
};
