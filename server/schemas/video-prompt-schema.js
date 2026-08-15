// video-prompt-schema.js
//
// Stage 22B-Part-2 — the VIDEO PROMPT PACKAGING layer. Defines the shape
// of a VideoPromptPackage: the final structured specification a FUTURE
// video-generation stage could consume for one shot's approved canonical
// keyframe. Same rules as schemas/keyframe-prompt-schema.js: plain object
// factories only, no file I/O, no provider knowledge, every field
// defaults to null/[] so partial data is always valid, nothing here
// invents information.
//
// A VideoPromptPackage is deliberately NOT a duplicate of a
// KeyframePromptPackage — it does not re-derive identity/wardrobe/
// environment locks (those describe how to GENERATE an image; a video
// package describes how to ANIMATE an already-approved one). It carries
// forward only what's still relevant: the canonical keyframe asset itself
// (the video's primary input), the subject/continuity/negativeConstraints
// already resolved for that keyframe's own prompt package, and a new,
// video-specific creative/execution specification.
//
// PROVIDER NEUTRALITY: creativeSpecification below describes creative
// INTENT only (camera movement, subject/environment motion, composition,
// pacing) — never a provider's own field names (no "image_urls", no
// "Seedance prompt"). executionParameters is the explicit, narrow set of
// technical knobs (duration/resolution/aspectRatio/fps) a provider mapper
// will translate later. Provider-specific translation belongs in a future
// video-generation-service.js + provider mapper, never here.
//
// See docs/architecture/video-prompt-package.md and
// services/video-prompt-service.js for how these get populated.

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

// Same CURRENT/STALE vocabulary and meaning as
// keyframe-prompt-schema.js's PACKAGE_STATUSES — CURRENT means the
// package still matches the storyboard/keyframe-plan versions AND the
// exact canonical keyframe asset it was built from; STALE means one of
// those has since changed. No automatic transitions exist — see
// video-prompt-service.js.
const VIDEO_PACKAGE_STATUSES = ['CURRENT', 'STALE'];

// Mirrors keyframe-prompt-schema.js's PROMPT_SECTION_KEYS pattern: a
// fixed, individually-inspectable breakdown of the derived prompt, scoped
// to what a VIDEO specification actually needs (no IDENTITY/WARDROBE
// sections — those are the image package's job, already baked into the
// canonical keyframe asset itself).
const VIDEO_PROMPT_SECTION_KEYS = ['SUBJECT', 'ACTION', 'CAMERA_MOTION', 'SUBJECT_MOTION', 'ENVIRONMENT_MOTION', 'COMPOSITION', 'LIGHTING', 'PACING', 'CONTINUITY', 'NEGATIVE_CONSTRAINTS'];

function createVideoPromptSections(overrides = {}) {
  const base = {};
  for (const key of VIDEO_PROMPT_SECTION_KEYS) base[key] = null;
  return withDefaults(base, overrides);
}

// Part 5 — creative INTENT only. Never a provider field name. Every field
// defaults to null: this project's existing storyboard/keyframe schemas
// have no dedicated field for most of these yet, so a caller supplies
// them explicitly at build time (see video-prompt-service.js) rather than
// this file inventing a value to look complete.
function createVideoCreativeSpecification(overrides = {}) {
  const base = {
    camera: null, // camera movement description (e.g. "slow dolly-in")
    subjectMotion: null, // what the subject(s) do across the shot
    environmentMotion: null, // what the environment/background does (wind, crowd, particles, ...)
    composition: null,
    lighting: null,
    pacing: null, // e.g. "slow build", "sharp cut on action"
    continuity: [], // carried forward from the canonical keyframe's own KeyframePromptPackage, never re-invented
    negativeConstraints: [],
  };
  return withDefaults(base, overrides);
}

// Part 5 — the explicit, narrow set of technical execution knobs a
// provider mapper will translate later. Deliberately separate from
// creativeSpecification above. Every field stays null unless the caller
// explicitly supplies it — never guessed to satisfy the schema.
function createVideoExecutionParameters(overrides = {}) {
  const base = {
    duration: null, // seconds
    resolution: null, // e.g. "720p", "1080p", "4K" — informational; see `quality` for the field EvoLink's mapper actually reads
    aspectRatio: null, // e.g. "16:9"
    fps: null,
    // Stage 22B cost-optimisation fix: providers/evolink/evolink-mapper.js
    // reads `parameters.quality` (EvoLink's own video field name), never
    // `parameters.resolution` — that mismatch meant an explicitly-requested
    // resolution silently never reached the real request. Additive: no
    // existing field renamed or removed, every caller that never sets this
    // still gets `quality: null`, same as before.
    quality: null, // EvoLink's own video resolution enum, e.g. "480p"/"720p"/"1080p"
  };
  return withDefaults(base, overrides);
}

// Part 6 — one entry describing a reference asset the canonical
// keyframe's own image-generation lineage was built from (character/
// location/prop reference, carried forward for traceability only — never
// re-uploaded, never re-resolved to a URL here). Same shape as a
// KeyframePromptPackage's existingReferenceAssets entries.
function createVideoReferenceLineageEntry(overrides = {}) {
  const base = {
    assetId: null,
    role: null,
    roleType: null,
    canonical: false,
  };
  return withDefaults(base, overrides);
}

// Part 7 — recorded, never re-derived silently. A future
// video-generation-service.js reads these three fields to decide whether
// a model is eligible to actually be used — this package never makes
// that call itself, it only records what the registry said was true at
// build time.
function createModelVerificationSnapshot(overrides = {}) {
  const base = {
    verificationStatus: null,
    productionReady: null,
    requestSchemaVerified: null,
  };
  return withDefaults(base, overrides);
}

// Part 1/4 — the package itself.
function createVideoPromptPackage(overrides = {}) {
  const base = {
    packageId: crypto.randomUUID(),
    projectId: null,
    sceneId: null,
    shotId: null,
    keyframeId: null,
    version: 1,

    // Part 11 — staleness sources: the storyboard/keyframe-plan versions
    // this package was built against, plus the EXACT canonical keyframe
    // asset id it resolved at build time. Live status recomputation
    // (video-prompt-service.js's attachLiveVideoPackageStatus) compares
    // all three against current state on every read.
    sourceShotVersion: null,
    sourceKeyframePlanVersion: null,
    sourceCanonicalKeyframeAssetId: null,

    // Part 4 — the exact, explicitly-selected, APPROVED keyframe asset
    // that serves as this video's primary input. Never chosen
    // automatically by this package — see video-prompt-service.js's
    // resolveCanonicalKeyframeInput.
    canonicalKeyframeAssetId: null,

    // Traceability back to the image-generation package that produced
    // the canonical keyframe asset, so a human/future service can see
    // exactly which image specification/version this video is animating.
    sourceKeyframePromptPackageId: null,
    sourceKeyframePromptPackageVersion: null,

    // Part 6 — reference lineage carried forward from the canonical
    // keyframe's own image package, informational only.
    referenceLineage: [],

    // Part 7 — explicit provider/model selection. Never defaulted, never
    // auto-selected. See video-prompt-service.js's model validation.
    provider: null,
    model: null,
    modelVerification: createModelVerificationSnapshot(),

    // Part 3/9 — creative source-of-truth fields carried forward from the
    // canonical keyframe's own resolved package (subject, atmosphere),
    // plus this package's own video-specific fields.
    subject: null,
    atmosphere: null,
    creativeSpecification: createVideoCreativeSpecification(),
    executionParameters: createVideoExecutionParameters(),

    // Part 2/12 — DERIVED. videoPromptSections is the structured
    // breakdown; prompt is its deterministic composition. Neither is
    // ever hand-authored here, and neither is ever the source of truth
    // for anything above.
    prompt: null,
    videoPromptSections: createVideoPromptSections(),

    status: 'CURRENT',
    warnings: [],
    generatedAt: new Date().toISOString(),

    // Part 10 — lightweight versioning, same pattern as
    // keyframe-prompt-schema.js.
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    changeNote: null,
    history: [],
  };
  return withDefaults(base, overrides);
}

module.exports = {
  VIDEO_PACKAGE_STATUSES,
  VIDEO_PROMPT_SECTION_KEYS,
  createVideoPromptSections,
  createVideoCreativeSpecification,
  createVideoExecutionParameters,
  createVideoReferenceLineageEntry,
  createModelVerificationSnapshot,
  createVideoPromptPackage,
};
