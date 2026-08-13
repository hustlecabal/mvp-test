// generation-model-registry.js — Stage 22B-Part-1.
//
// A capabilities-only, provider-agnostic catalogue of every image/video
// generation model this project has investigated, sourced entirely from
// docs/architecture/generation-model-registry.md (Stage 22B-Part-0). This
// file NEVER makes an HTTP request, NEVER imports a provider adapter or
// HTTP client, NEVER creates a generation job, and NEVER selects a model
// on a caller's behalf. It only answers read-only questions about what
// exists and what it can do.
//
// Relationship to providers/evolink/evolink-models.js: that file remains
// "the ONLY place EvoLink model identifiers are allowed to appear as
// literal strings" for models it already knows about (Seedance 2.5,
// GPT Image 2, Nano Banana Pro) — this registry derives requestSchemaVerified
// and docsUrl from it directly for exactly those 7 overlapping model IDs,
// rather than duplicating those two facts in a second place. For every
// other catalogue model (Seedance 1.0/1.5/2.0, Krea 2 Turbo, Wan Image,
// Wan 2.6, Grok Imagine Video, Kling 3.0, Sora 2, Seedream 5.0 Lite,
// Nano Banana 2 non-Pro, EvoLink's Veo 3.1 resale, and every Google
// direct model), no such file exists yet, so this registry is their only
// home today — forcing them all into evolink-models.js's narrower
// "verified enough to build a request" scope would be the "unnecessary
// coupling" Stage 22B-Part-0 Section J explicitly warned against.
//
// CAPABILITY VALUE SEMANTICS (Part 5 of the Stage 22B-Part-1 instructions):
//   true  = confirmed present, sourced from an opened official page
//   false = confirmed ABSENT for this specific model/modality — an active,
//           sourced finding (e.g. Krea 2 Turbo confirmed to have zero
//           reference-image support), never a default
//   null  = not verified, OR not applicable to this model's modality
//           (e.g. `audio` on a pure image model). null and false are
//           deliberately different: false is a sourced negative, null is
//           "we don't know" or "the question doesn't apply here." Never
//           collapse the two, and never treat null as true.
//
// VERIFICATION TIERS (must match docs/architecture/generation-model-registry.md
// exactly — see that document's investigation for the sourcing behind every
// entry below):
//   CATALOGUE_AVAILABLE     — listed with a price on evolink.ai/models (or
//                             named in Google's own model list), nothing
//                             about its request shape or capabilities
//                             independently confirmed.
//   CAPABILITY_VERIFIED     — capabilities confirmed against some official
//                             page, but not a full OpenAPI spec, or only
//                             read via a summarized fetch.
//   REQUEST_SCHEMA_VERIFIED — a full OpenAPI spec (or, for Google, the
//                             model's own dedicated docs page) was opened
//                             and its request/response fields confirmed.
//   SAFE_FOR_PRODUCTION     — REQUEST_SCHEMA_VERIFIED AND the investigation
//                             found no capability gap that would silently
//                             break this project's architecture. Only ever
//                             assigned where the investigation document
//                             explicitly says so — never re-derived here.
//
// productionReady is a pure function of verificationStatus in this file:
// true if and only if verificationStatus === 'SAFE_FOR_PRODUCTION'. This is
// intentional — it is the one invariant every consumer (and every test in
// this stage) can rely on without re-reading the whole record.

const EVOLINK_MODELS = require('../providers/evolink/evolink-models');

const VERIFICATION_STATUSES = ['CATALOGUE_AVAILABLE', 'CAPABILITY_VERIFIED', 'REQUEST_SCHEMA_VERIFIED', 'SAFE_FOR_PRODUCTION'];

// Small helper: builds the two fields this registry derives from
// evolink-models.js for the 7 model IDs that already exist there, instead
// of re-typing requestSchemaVerified/docsUrl a second time. Returns null if
// the key isn't in evolink-models.js at all (every other entry in this file
// sets these two fields directly).
function fromEvolinkModels(key) {
  const entry = EVOLINK_MODELS[key];
  if (!entry) return null;
  return { requestSchemaVerified: entry.requestSchemaVerified, docsUrl: entry.docsUrl };
}

function record(overrides) {
  const base = {
    provider: null,
    model: null,
    modelIdConfirmed: true, // false only for entries whose exact ID string the investigation could not confirm (see docs)
    modality: null,
    displayName: null,
    verificationStatus: null,
    capabilities: {
      textToImage: null,
      imageToImage: null,
      textToVideo: null,
      imageToVideo: null,
      referenceImages: null,
      maxReferenceImages: null,
      firstFrame: null,
      lastFrame: null,
      audio: null,
      durations: null, // { minSeconds, maxSeconds } | null
      resolutions: null, // string[] | null
      aspectRatios: null, // string[] | null
    },
    pricing: { unit: null, startingPrice: null, currency: null, priceKnown: false },
    requestSchemaVerified: false,
    docsUrl: null,
    notes: null,
  };
  const merged = {
    ...base,
    ...overrides,
    capabilities: { ...base.capabilities, ...(overrides.capabilities || {}) },
    pricing: { ...base.pricing, ...(overrides.pricing || {}) },
  };
  merged.productionReady = merged.verificationStatus === 'SAFE_FOR_PRODUCTION';
  return merged;
}

function priced(unit, startingPrice) {
  return { unit, startingPrice, currency: 'USD', priceKnown: startingPrice != null };
}

// ---------------------------------------------------------------------------
// EvoLink — Video
// ---------------------------------------------------------------------------

const seedance20Shared = {
  audio: true,
  durations: { minSeconds: 4, maxSeconds: 15 },
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
};

function seedance20Tier(tier, resolutions, pricePerSecond) {
  const prefix = tier ? `seedance-2.0-${tier}-` : 'seedance-2.0-';
  const displaySuffix = tier ? ` ${tier[0].toUpperCase()}${tier.slice(1)}` : ' (Standard)';
  const docsUrl = 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.0/seedance-2.0-overview';
  return [
    record({
      provider: 'evolink',
      model: `${prefix}text-to-video`,
      modality: 'video',
      displayName: `Seedance 2.0${displaySuffix} (Text-to-Video)`,
      verificationStatus: 'REQUEST_SCHEMA_VERIFIED',
      capabilities: {
        ...seedance20Shared,
        textToVideo: true,
        imageToVideo: false,
        referenceImages: false,
        maxReferenceImages: 0,
        firstFrame: false,
        lastFrame: false,
        resolutions,
      },
      pricing: priced('per_second', pricePerSecond),
      requestSchemaVerified: true,
      docsUrl,
    }),
    record({
      provider: 'evolink',
      model: `${prefix}image-to-video`,
      modality: 'video',
      displayName: `Seedance 2.0${displaySuffix} (Image-to-Video)`,
      verificationStatus: 'REQUEST_SCHEMA_VERIFIED',
      capabilities: {
        ...seedance20Shared,
        textToVideo: false,
        imageToVideo: true,
        referenceImages: false,
        maxReferenceImages: 0,
        firstFrame: true,
        lastFrame: true,
        resolutions,
      },
      pricing: priced('per_second', pricePerSecond),
      requestSchemaVerified: true,
      docsUrl,
    }),
    record({
      provider: 'evolink',
      model: `${prefix}reference-to-video`,
      modality: 'video',
      displayName: `Seedance 2.0${displaySuffix} (Reference-to-Video)`,
      verificationStatus: 'REQUEST_SCHEMA_VERIFIED',
      capabilities: {
        ...seedance20Shared,
        textToVideo: false,
        imageToVideo: false,
        referenceImages: true,
        maxReferenceImages: 9,
        firstFrame: true,
        lastFrame: true,
        resolutions,
      },
      pricing: priced('per_second', pricePerSecond),
      requestSchemaVerified: true,
      docsUrl,
      notes: 'Reference-to-video accepts 0-9 images; first/last-frame assignment documented specifically for the 1-2-image case.',
    }),
  ];
}

const evolinkVideoModels = [
  record({
    provider: 'evolink',
    model: 'seedance-1.0-pro-fast',
    modality: 'video',
    displayName: 'Seedance 1.0 Pro Fast',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_second', 0.006),
    notes: 'Cheapest EvoLink video line item found; capabilities not independently confirmed against any dedicated page.',
  }),
  record({
    provider: 'evolink',
    model: 'seedance-1.5-pro',
    modality: 'video',
    displayName: 'Seedance 1.5 Pro',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_second', 0.013),
  }),
  ...seedance20Tier('mini', ['480p', '720p'], 0.011),
  ...seedance20Tier('fast', ['480p', '720p'], null), // catalogue did not show a separate Fast price row
  ...seedance20Tier(null, ['480p', '720p', '1080p'], 0.033),
  record({
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    modality: 'video',
    displayName: 'Seedance 2.5 (Text-to-Video)',
    verificationStatus: 'REQUEST_SCHEMA_VERIFIED',
    capabilities: { textToVideo: true, imageToVideo: false, referenceImages: false, maxReferenceImages: 0 },
    pricing: priced('per_second', null),
    ...fromEvolinkModels('seedance-2.5-text-to-video'),
    notes: 'This is the exact model used for the real smoke-test project generation (Stage 6).',
  }),
  record({
    provider: 'evolink',
    model: 'seedance-2.5-image-to-video',
    modality: 'video',
    displayName: 'Seedance 2.5 (Image-to-Video)',
    verificationStatus: 'REQUEST_SCHEMA_VERIFIED',
    capabilities: { textToVideo: false, imageToVideo: true, referenceImages: false, maxReferenceImages: 0 },
    pricing: priced('per_second', null),
    ...fromEvolinkModels('seedance-2.5-image-to-video'),
  }),
  record({
    provider: 'evolink',
    model: 'seedance-2.5-reference-to-video',
    modality: 'video',
    displayName: 'Seedance 2.5 (Reference-to-Video)',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    ...fromEvolinkModels('seedance-2.5-reference-to-video'),
    notes: 'Model ID confirmed to exist; request schema explicitly not yet verified in evolink-models.js.',
  }),
  record({
    provider: 'evolink',
    model: 'seedance-2.5-video-edit',
    modality: 'video',
    displayName: 'Seedance 2.5 (Video Edit)',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    ...fromEvolinkModels('seedance-2.5-video-edit'),
  }),
  record({
    provider: 'evolink',
    model: 'seedance-2.5-video-extend',
    modality: 'video',
    displayName: 'Seedance 2.5 (Video Extend)',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    ...fromEvolinkModels('seedance-2.5-video-extend'),
  }),
  record({
    provider: 'evolink',
    model: 'grok-imagine-video',
    modelIdConfirmed: false,
    modality: 'video',
    displayName: 'Grok Imagine Video',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_second', 0.02),
    notes: 'Exact API model-ID string not independently confirmed; this is a catalogue-name-derived placeholder.',
  }),
  record({
    provider: 'evolink',
    model: 'wan-2.5-video',
    modelIdConfirmed: false,
    modality: 'video',
    displayName: 'Wan 2.5 (Video)',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_second', 0.038),
    notes: 'Only the Wan 2.5 IMAGE model ID (wan2.5-image-to-image) was independently confirmed; this video variant\'s exact ID was not.',
  }),
  record({
    provider: 'evolink',
    model: 'wan-2.6-video',
    modelIdConfirmed: false,
    modality: 'video',
    displayName: 'Wan 2.6',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      referenceImages: true,
      maxReferenceImages: 3,
      audio: true,
      durations: { minSeconds: 2, maxSeconds: 15 },
      resolutions: ['1080p'],
    },
    pricing: priced('per_second', 0.075),
    notes: 'Capability detail from a secondary/blog source, not a full OpenAPI spec. Reference video (not image) inputs, 2-30s/100MB constraints documented but not modeled here as a separate field.',
  }),
  record({
    provider: 'evolink',
    model: 'kling-3.0',
    modelIdConfirmed: false,
    modality: 'video',
    displayName: 'Kling 3.0',
    verificationStatus: 'CAPABILITY_VERIFIED',
    pricing: priced('per_second', 0.08),
    notes: 'Catalogue price $0.080/s vs. a separately-quoted Motion Control sub-product at $0.1134/s — unresolved conflict, may be different endpoints. No base t2v/i2v capability confirmed independently.',
  }),
  record({
    provider: 'evolink',
    model: 'sora-2',
    modelIdConfirmed: false,
    modality: 'video',
    displayName: 'Sora 2',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_second', 0.085),
  }),
  record({
    provider: 'evolink',
    model: 'veo-3.1-resale',
    modelIdConfirmed: false,
    modality: 'video',
    displayName: 'Veo 3.1 (EvoLink resale, Fast/Pro variants)',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_video', 0.318),
    notes: 'Catalogue shows one combined line item covering "Fast and Pro variants"; EvoLink\'s own distinct model-ID strings for each were not found (contrast with Google\'s own direct IDs, which are known — see the google entries below).',
  }),
];

// ---------------------------------------------------------------------------
// EvoLink — Image
// ---------------------------------------------------------------------------

const evolinkImageModels = [
  record({
    provider: 'evolink',
    model: 'krea-2-turbo',
    modality: 'image',
    displayName: 'Raphael Krea 2 Turbo',
    verificationStatus: 'REQUEST_SCHEMA_VERIFIED',
    capabilities: {
      textToImage: true,
      imageToImage: false,
      referenceImages: false,
      maxReferenceImages: 0,
      resolutions: ['1K', '2K'],
      aspectRatios: ['1:1', '4:3', '3:4', '5:4', '4:5', '2:3', '3:2', '9:16', '16:9', '1:2', '2:1'],
    },
    pricing: priced('per_image', 0.0067),
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/krea/krea-2-turbo-image-generate',
    notes: 'CONFIRMED NOT production-safe for this project: text-to-image only, zero reference-image support of any kind — incompatible with the canonical-reference architecture. Schema-verified and disqualified are independent facts here.',
  }),
  record({
    provider: 'evolink',
    model: 'gpt-image-2',
    modality: 'image',
    displayName: 'GPT Image 2',
    verificationStatus: 'SAFE_FOR_PRODUCTION',
    capabilities: { textToImage: true, imageToImage: true, referenceImages: true, maxReferenceImages: 16 },
    pricing: priced('per_image', 0.015),
    ...fromEvolinkModels('gpt-image-2'),
    notes: 'Cheapest verified, reference-capable image model in this registry. Already proven in this codebase since Stage 15/16.',
  }),
  record({
    provider: 'evolink',
    model: 'wan2.5-image-to-image',
    modality: 'image',
    displayName: 'Wan Image (2.5, Image-to-Image)',
    verificationStatus: 'SAFE_FOR_PRODUCTION',
    capabilities: { textToImage: null, imageToImage: true, referenceImages: true, maxReferenceImages: 2, resolutions: ['384px-5000px range'] },
    pricing: priced('per_image', 0.023),
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/wan2.5/wan2.5-image-to-image',
  }),
  record({
    provider: 'evolink',
    model: 'seedream-5.0-lite',
    modelIdConfirmed: false,
    modality: 'image',
    displayName: 'Seedream 5.0 Lite',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_image', 0.028),
    notes: 'Exact API model-ID string not confirmed (pattern likely doubao-seedream-5.0-lite by analogy with the confirmed doubao-seedream-5.0-pro, but this was never independently opened).',
  }),
  record({
    provider: 'evolink',
    model: 'gemini-3.1-flash-image',
    modality: 'image',
    displayName: 'Nano Banana 2 (via EvoLink)',
    verificationStatus: 'CATALOGUE_AVAILABLE',
    pricing: priced('per_image', 0.036),
    notes: 'Distinct from Nano Banana PRO (gemini-3-pro-image-preview), which IS already verified below. This non-Pro tier has no dedicated EvoLink spec page opened yet.',
  }),
  record({
    provider: 'evolink',
    model: 'gemini-3-pro-image-preview',
    modality: 'image',
    displayName: 'Nano Banana Pro (via EvoLink)',
    verificationStatus: 'SAFE_FOR_PRODUCTION',
    capabilities: { textToImage: true, imageToImage: true, referenceImages: true, maxReferenceImages: 5, resolutions: ['1K', '2K', '4K'] },
    pricing: priced('per_image', 0.046),
    ...fromEvolinkModels('gemini-3-pro-image-preview'),
    notes: 'Proven in Stages 16-21 with 9 real generations. Notably cheaper via EvoLink resale ($0.046/img) than Google\'s own direct list price ($0.134/img).',
  }),
];

// ---------------------------------------------------------------------------
// Google — carried forward from Stage 22A (docs/integrations/google-provider-investigation.md).
// Not re-verified this session. No Google provider adapter exists yet, so
// requestSchemaVerified is false for every entry regardless of how well the
// capability itself is documented.
// ---------------------------------------------------------------------------

const googleModels = [
  record({
    provider: 'google',
    model: 'gemini-3.1-flash-lite-image',
    modality: 'image',
    displayName: 'Nano Banana 2 Lite',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: { textToImage: true, imageToImage: true, referenceImages: true, maxReferenceImages: 14, resolutions: ['1K'] },
    pricing: priced('per_image', 0.0336),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
  }),
  record({
    provider: 'google',
    model: 'gemini-3.1-flash-image',
    modality: 'image',
    displayName: 'Nano Banana 2',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: { textToImage: true, imageToImage: true, referenceImages: true, maxReferenceImages: 10, resolutions: ['0.5K', '1K', '2K', '4K'] },
    pricing: priced('per_image', 0.067),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
  }),
  record({
    provider: 'google',
    model: 'gemini-3-pro-image',
    modelIdConfirmed: false,
    modality: 'image',
    displayName: 'Nano Banana Pro (Google direct)',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: { textToImage: true, imageToImage: true, referenceImages: true, maxReferenceImages: 6, resolutions: ['1K', '2K', '4K'] },
    pricing: priced('per_image', 0.134),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
    notes: 'Model ID conflict unresolved between "gemini-3-pro-image" and "gemini-3-pro-image-preview" (Stage 22A Known Unknown L1) — do not treat either as confirmed-correct without a live models.list() check.',
  }),
  record({
    provider: 'google',
    model: 'veo-3.1-generate-preview',
    modality: 'video',
    displayName: 'Veo 3.1',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      referenceImages: true,
      maxReferenceImages: 3,
      firstFrame: true,
      lastFrame: true,
      audio: true,
      durations: { minSeconds: 4, maxSeconds: 8 },
      resolutions: ['720p', '1080p', '4K'],
      aspectRatios: ['16:9', '9:16'],
    },
    pricing: priced('per_second', 0.4),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/veo',
    notes: 'Preview status, 10 RPM cap (Stage 22A). Reference-image ("ingredients to video") mechanism confirmed but never tested live against our canonical-reference assets.',
  }),
  record({
    provider: 'google',
    model: 'veo-3.1-fast-generate-preview',
    modality: 'video',
    displayName: 'Veo 3.1 Fast',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      referenceImages: true,
      maxReferenceImages: 3,
      firstFrame: true,
      lastFrame: true,
      audio: true,
      durations: { minSeconds: 4, maxSeconds: 8 },
      resolutions: ['720p', '1080p', '4K'],
      aspectRatios: ['16:9', '9:16'],
    },
    pricing: priced('per_second', null), // Stage 22A found a conflict ($0.10/0.12/0.30 vs a flat $0.15) — left unknown rather than guessing
    docsUrl: 'https://ai.google.dev/gemini-api/docs/veo',
    notes: 'Pricing conflict unresolved (Stage 22A Known Unknown L5) — startingPrice deliberately left null.',
  }),
  record({
    provider: 'google',
    model: 'veo-3.1-lite-generate-preview',
    modality: 'video',
    displayName: 'Veo 3.1 Lite',
    verificationStatus: 'CAPABILITY_VERIFIED',
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      referenceImages: null, // not specifically confirmed for the Lite tier
      firstFrame: null,
      lastFrame: null,
      audio: true,
      resolutions: ['720p', '1080p'], // confirmed NOT 4K
      aspectRatios: ['16:9', '9:16'],
    },
    pricing: priced('per_second', 0.05),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models/veo-3.1-lite-generate-preview',
  }),
];

const GENERATION_MODEL_REGISTRY = [...evolinkVideoModels, ...evolinkImageModels, ...googleModels];

for (const entry of GENERATION_MODEL_REGISTRY) {
  if (!VERIFICATION_STATUSES.includes(entry.verificationStatus)) {
    throw new Error(`Invalid verificationStatus "${entry.verificationStatus}" for ${entry.provider}/${entry.model}`);
  }
}

// ---------------------------------------------------------------------------
// Read-only query API. Nothing below this line performs I/O, mutates any
// store, or calls a provider. See docs/architecture/generation-model-registry.md
// for the full behavioral contract.
// ---------------------------------------------------------------------------

// Every query function below returns a deep clone, never a live reference
// into GENERATION_MODEL_REGISTRY — a caller mutating a returned record (or
// an array of them) must NEVER be able to corrupt this module's own source
// of truth for the next caller.
function clone(value) {
  return value === null ? null : structuredClone(value);
}

function listModels({ provider, modality, productionReadyOnly, verificationStatus } = {}) {
  return GENERATION_MODEL_REGISTRY.filter((m) => {
    if (provider && m.provider !== provider) return false;
    if (modality && m.modality !== modality) return false;
    if (productionReadyOnly && !m.productionReady) return false;
    if (verificationStatus && m.verificationStatus !== verificationStatus) return false;
    return true;
  }).map(clone);
}

function getModel(provider, model) {
  const found = GENERATION_MODEL_REGISTRY.find((m) => m.provider === provider && m.model === model);
  return found ? clone(found) : null;
}

// Requirement semantics (Part 5/6 of the Stage 22B-Part-1 instructions):
//   - a requirement field that is omitted places no constraint on that field
//   - requirement `true`  -> capability value must be EXACTLY true
//                            (false and null both fail — unknown never
//                            satisfies a positive requirement)
//   - requirement `false` -> capability value must NOT be true (false or
//                            null both pass — "not confirmed true" is a
//                            weaker, safer claim than "confirmed absent",
//                            and this function never invents the latter)
//   - `min*` numeric requirements require a known numeric capability value
//     that is >= the requirement; null/undefined never satisfies a minimum
//   - `resolution`/`aspectRatio` requirements require the model's own
//     (known) array to include that exact value
//   - `minDurationSeconds`/`maxDurationSeconds` require the model's known
//     duration range to cover the requested value
function satisfiesBooleanRequirement(capabilityValue, requiredValue) {
  if (requiredValue === undefined) return true;
  if (requiredValue === true) return capabilityValue === true;
  // requiredValue === false
  return capabilityValue !== true;
}

const BOOLEAN_CAPABILITY_FIELDS = ['textToImage', 'imageToImage', 'textToVideo', 'imageToVideo', 'referenceImages', 'firstFrame', 'lastFrame', 'audio'];

function modelSatisfies(entry, requirements = {}) {
  if (requirements.provider && entry.provider !== requirements.provider) return false;
  if (requirements.modality && entry.modality !== requirements.modality) return false;

  for (const field of BOOLEAN_CAPABILITY_FIELDS) {
    if (!satisfiesBooleanRequirement(entry.capabilities[field], requirements[field])) return false;
  }

  if (requirements.minReferenceImages !== undefined) {
    const max = entry.capabilities.maxReferenceImages;
    if (typeof max !== 'number' || max < requirements.minReferenceImages) return false;
  }

  if (requirements.resolution !== undefined) {
    const resolutions = entry.capabilities.resolutions;
    if (!Array.isArray(resolutions) || !resolutions.includes(requirements.resolution)) return false;
  }

  if (requirements.aspectRatio !== undefined) {
    const ratios = entry.capabilities.aspectRatios;
    if (!Array.isArray(ratios) || !ratios.includes(requirements.aspectRatio)) return false;
  }

  if (requirements.minDurationSeconds !== undefined || requirements.maxDurationSeconds !== undefined) {
    const durations = entry.capabilities.durations;
    if (!durations || typeof durations.minSeconds !== 'number' || typeof durations.maxSeconds !== 'number') return false;
    if (requirements.minDurationSeconds !== undefined && durations.maxSeconds < requirements.minDurationSeconds) return false;
    if (requirements.maxDurationSeconds !== undefined && durations.minSeconds > requirements.maxDurationSeconds) return false;
  }

  if (requirements.verificationStatus && entry.verificationStatus !== requirements.verificationStatus) return false;
  if (requirements.productionReadyOnly && !entry.productionReady) return false;

  return true;
}

// Read-only. Never executes, never submits, never selects on the caller's
// behalf — returns every matching record for a human/caller to choose
// among. Deterministic ordering: registry insertion order (stable, since
// GENERATION_MODEL_REGISTRY is a fixed array built once at module load).
function findModelsSatisfying(requirements = {}) {
  return GENERATION_MODEL_REGISTRY.filter((entry) => modelSatisfies(entry, requirements)).map(clone);
}

// Read-only. Sorts findModelsSatisfying()'s results by pricing.startingPrice
// ascending. Models with unknown pricing (priceKnown: false) are NEVER
// treated as free (never sorted as if price 0) — they are placed AFTER
// every priced candidate, in registry order, each still carrying its own
// explicit priceKnown: false so a caller can never mistake "unknown" for
// "cheapest." Returns [] if nothing matches. Never executes or selects
// anything — the caller decides what, if anything, to do with the result.
function cheapestSatisfying(requirements = {}) {
  const matches = findModelsSatisfying(requirements);
  const priced_ = matches.filter((m) => m.pricing.priceKnown);
  const unpriced = matches.filter((m) => !m.pricing.priceKnown);
  priced_.sort((a, b) => a.pricing.startingPrice - b.pricing.startingPrice);
  return [...priced_, ...unpriced];
}

function isModelCapable(provider, model, requirements = {}) {
  const entry = getModel(provider, model);
  if (!entry) return false;
  return modelSatisfies(entry, { ...requirements, provider: undefined }); // provider already pinned by getModel
}

// Structured, non-throwing diagnostics for an explicit provider+model
// choice against a set of requirements. Never executes generation — this
// is the validation step a future video-generation-service.js would call
// BEFORE submitting anything, exactly like keyframe-generation-service.js's
// existing runSafetyChecks() pattern.
function validateModelSelection({ provider, model, requirements = {} } = {}) {
  const reasons = [];
  const warnings = [];

  const entry = getModel(provider, model);
  if (!entry) {
    return { allowed: false, provider, model, reasons: [`No registry entry for provider "${provider}" model "${model}".`], warnings };
  }

  if (!entry.modelIdConfirmed) {
    warnings.push('This model\'s exact API identifier string has not been independently confirmed against an official source.');
  }

  if (!entry.requestSchemaVerified) {
    reasons.push(`Model "${model}" is not requestSchemaVerified — its request/response shape has not been independently confirmed, so no mapper is allowed to build a request for it yet.`);
  }

  if (!entry.productionReady) {
    reasons.push(`Model "${model}" is not marked productionReady (verificationStatus: ${entry.verificationStatus}).`);
  }

  const unknownRequiredFields = [];
  for (const field of BOOLEAN_CAPABILITY_FIELDS) {
    if (requirements[field] === true && entry.capabilities[field] === null) {
      unknownRequiredFields.push(field);
    }
  }
  if (unknownRequiredFields.length > 0) {
    reasons.push(`Required capability unknown (never assumed true) for: ${unknownRequiredFields.join(', ')}.`);
  }

  if (!modelSatisfies(entry, requirements)) {
    reasons.push('Model does not satisfy the requested capability requirements.');
  }

  return {
    allowed: reasons.length === 0,
    provider,
    model,
    reasons,
    warnings,
  };
}

module.exports = {
  VERIFICATION_STATUSES,
  GENERATION_MODEL_REGISTRY,
  listModels,
  getModel,
  findModelsSatisfying,
  cheapestSatisfying,
  isModelCapable,
  validateModelSelection,
};
