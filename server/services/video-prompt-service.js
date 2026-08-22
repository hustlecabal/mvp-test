// video-prompt-service.js
//
// Stage 22B-Part-2 — the VIDEO PROMPT PACKAGING layer. Converts an
// approved canonical keyframe asset + its own already-resolved
// KeyframePromptPackage + explicit human-supplied video creative/
// execution parameters + an explicit provider/model selection into a
// VideoPromptPackage (schemas/video-prompt-schema.js): the final
// structured specification a FUTURE video-generation stage could
// consume.
//
// THIS FILE NEVER CALLS A PROVIDER, NEVER EXECUTES A SKILL, NEVER
// CREATES A GENERATION JOB, NEVER CREATES AN APPROVAL, AND NEVER SPENDS
// A CREDIT. It has no import of, or path to, providers/evolink/*,
// services/generation-service.js, services/keyframe-generation-service.js,
// services/approval-gate.js, or services/keyframe-generation-approval-store.js.
// It only reads existing keyframe-planning data (services/keyframe-store.js),
// the keyframe's own already-built image prompt package
// (services/keyframe-prompt-service.js, read-only), storyboard/creative
// data (services/creative-store.js), production Timeline IR assets
// (services/timeline-store.js, read-only — asset.approvalStatus is only
// ever READ here, never written), and the model capability registry
// (services/generation-model-registry.js, read-only, advisory), then
// writes ONE new kind of planning data: video prompt packages. The
// `prompt` field on every package is a deterministic, no-LLM,
// no-network composition of `videoPromptSections` — see
// composeVideoPromptSections()/composeVideoPrompt() below. See
// docs/architecture/video-prompt-package.md.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const keyframeStore = require('./keyframe-store');
const keyframePromptService = require('./keyframe-prompt-service');
const generationModelRegistry = require('./generation-model-registry');
const beatGraphDerivationService = require('./beat-graph-derivation-service');
const {
  VIDEO_PROMPT_SECTION_KEYS,
  createVideoPromptPackage,
  createVideoPromptSections,
  createVideoCreativeSpecification,
  createVideoExecutionParameters,
  createVideoReferenceLineageEntry,
  createModelVerificationSnapshot,
} = require('../schemas/video-prompt-schema');

// Overridable for tests, same pattern as KEYFRAME_PROMPT_DATA_DIR.
const VIDEO_PROMPT_DATA_DIR = process.env.VIDEO_PROMPT_DATA_DIR
  ? path.resolve(process.env.VIDEO_PROMPT_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'video-prompt-packages');

fs.mkdirSync(VIDEO_PROMPT_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(VIDEO_PROMPT_DATA_DIR, `${projectId}.json`);
}

function loadRecord(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveRecord(record) {
  fs.writeFileSync(fileFor(record.projectId), JSON.stringify(record, null, 2));
}

function ensureRecord(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let record = loadRecord(projectId);
  if (!record) {
    record = { projectId, packages: [] };
    saveRecord(record);
  }
  return record;
}

// ===========================================================================
// Part 4 — canonical keyframe resolution. The single place that decides
// whether a keyframe has a valid video input. Never chooses "the newest"
// or "the first" asset — only ever reads the keyframe's own explicitly
// human-selected canonicalAssetId (services/keyframe-store.js's
// selectCanonicalKeyframeAsset, Stage 13E), and only accepts it if it is
// currently APPROVED. Returns a structured diagnostic on every failure
// path, never throws, never silently substitutes another asset.
// ===========================================================================

function resolveCanonicalKeyframeInput(projectId, keyframeId) {
  const canonical = keyframeStore.getCanonicalKeyframeAsset(projectId, keyframeId);
  if (!canonical) {
    return { ok: false, code: 'PROJECT_OR_KEYFRAME_NOT_FOUND', reason: `No project "${projectId}" / keyframe "${keyframeId}" found.` };
  }
  if (!canonical.canonicalAssetId) {
    return {
      ok: false,
      code: 'NO_CANONICAL_ASSET_SELECTED',
      reason: `Keyframe "${keyframeId}" has no explicitly-selected canonical asset. Select one via select_canonical_keyframe_asset before building a video prompt package — this is never inferred automatically.`,
    };
  }
  if (!canonical.asset) {
    return {
      ok: false,
      code: 'CANONICAL_ASSET_NOT_FOUND',
      reason: `Keyframe "${keyframeId}"'s canonical asset "${canonical.canonicalAssetId}" no longer exists.`,
    };
  }
  if (canonical.asset.approvalStatus !== 'APPROVED') {
    return {
      ok: false,
      code: 'CANONICAL_ASSET_NOT_APPROVED',
      reason: `Keyframe "${keyframeId}"'s canonical asset "${canonical.canonicalAssetId}" is not APPROVED (status: ${canonical.asset.approvalStatus}). Only an approved asset may back a video prompt package.`,
    };
  }
  return { ok: true, canonicalAssetId: canonical.canonicalAssetId, asset: canonical.asset };
}

// ===========================================================================
// Part 7/8 — explicit provider/model validation via the read-only model
// capability registry. Never selects a model, never prefers one provider
// over another, never falls back. A catalogue-only/unverified model is
// still allowed to back a package (its true status is simply recorded —
// see Part 7's "do not silently promote a model"); ONLY an unknown
// provider/model pair, or one confirmed incapable of the requested video
// workflow, blocks package creation outright.
//
// The registry models "image-to-video" (a single starting frame) and
// "reference-to-video" (multiple simultaneous reference images, our
// canonical keyframe being one of them) as DISTINCT capabilities — a
// reference-to-video model does not also claim imageToVideo: true (see
// e.g. seedance-2.0-*-reference-to-video in generation-model-registry.js).
// So the actual requirement depends on what THIS package needs:
// requiresReferenceImages: false -> must support plain image-to-video;
// requiresReferenceImages: true  -> must support reference-to-video
// specifically (imageToVideo is not required in that case).
// ===========================================================================

function validateVideoModelSelection(provider, model, { requiresReferenceImages = false } = {}) {
  if (!provider || !model) {
    return { ok: false, code: 'PROVIDER_MODEL_REQUIRED', reason: 'provider and model must be explicitly supplied — neither is ever defaulted or inferred.' };
  }

  const entry = generationModelRegistry.getModel(provider, model);
  if (!entry) {
    return { ok: false, code: 'UNKNOWN_MODEL', reason: `No registry entry for provider "${provider}" model "${model}". Add it to the capability registry before selecting it.` };
  }

  const requirements = requiresReferenceImages ? { modality: 'video', referenceImages: true } : { modality: 'video', imageToVideo: true };

  const capable = generationModelRegistry.isModelCapable(provider, model, requirements);
  if (!capable) {
    const reasons = [];
    if (requiresReferenceImages) {
      reasons.push(`referenceImages is ${entry.capabilities.referenceImages === false ? 'confirmed unsupported' : 'unknown'} for this model, but this package requires reference-image conditioning.`);
    } else {
      reasons.push(`imageToVideo is ${entry.capabilities.imageToVideo === false ? 'confirmed unsupported' : 'unknown'} for this model.`);
    }
    return {
      ok: false,
      code: 'MODEL_CAPABILITY_UNSUPPORTED',
      reason: `Model "${provider}/${model}" does not support this video package's requirements. ${reasons.join(' ')}`.trim(),
    };
  }

  return {
    ok: true,
    entry,
    verification: createModelVerificationSnapshot({
      verificationStatus: entry.verificationStatus,
      productionReady: entry.productionReady,
      requestSchemaVerified: entry.requestSchemaVerified,
    }),
  };
}

// ===========================================================================
// Part 2/12 — video prompt sections + deterministic composition. No LLM
// call, no external API — plain string templating over already-resolved
// fields, same discipline as keyframe-prompt-service.js's
// composePromptSections/composePrompt.
// ===========================================================================

function composeVideoPromptSections({ subject, actionText, creativeSpecification }) {
  const sections = createVideoPromptSections();

  sections.SUBJECT = subject || null;
  sections.ACTION = actionText || null;
  sections.CAMERA_MOTION = creativeSpecification.camera || null;
  sections.SUBJECT_MOTION = creativeSpecification.subjectMotion || null;
  sections.ENVIRONMENT_MOTION = creativeSpecification.environmentMotion || null;
  sections.COMPOSITION = creativeSpecification.composition || null;
  sections.LIGHTING = creativeSpecification.lighting || null;
  sections.PACING = creativeSpecification.pacing || null;
  sections.CONTINUITY = creativeSpecification.continuity.length > 0 ? creativeSpecification.continuity.join('; ') : null;
  sections.NEGATIVE_CONSTRAINTS = creativeSpecification.negativeConstraints.length > 0 ? `Avoid: ${creativeSpecification.negativeConstraints.join('; ')}` : null;

  return sections;
}

// Human-readable composition of videoPromptSections into one `prompt`
// string. Sections with no resolved content are omitted, never rendered
// as "SUBJECT:\nnull". Deliberately model-agnostic — this is creative
// intent text, never a provider's own field name or prompt convention.
function composeVideoPrompt(videoPromptSections) {
  const blocks = [];
  for (const key of VIDEO_PROMPT_SECTION_KEYS) {
    const value = videoPromptSections[key];
    if (value) blocks.push(`${key.replace(/_/g, ' ')}:\n${value}`);
  }
  return blocks.join('\n\n');
}

// ===========================================================================
// Part 6 — reference lineage, carried forward informationally from the
// canonical keyframe's own already-built image prompt package. Never
// re-resolves a URL, never uploads anything, never makes a network call.
// ===========================================================================

function buildReferenceLineage(sourceKeyframePromptPackage) {
  if (!sourceKeyframePromptPackage || !Array.isArray(sourceKeyframePromptPackage.existingReferenceAssets)) return [];
  return sourceKeyframePromptPackage.existingReferenceAssets.map((ref) =>
    createVideoReferenceLineageEntry({
      assetId: ref.assetId,
      role: ref.role,
      roleType: ref.roleType,
      canonical: ref.canonical || false,
    })
  );
}

// ===========================================================================
// Part 11/13 — stale detection + versioning helpers, mirroring
// keyframe-prompt-service.js's attachLiveStatus/applyVersionedUpdate.
// ===========================================================================

// liveVersions (optional): { storyboardVersion, keyframePlanVersion } — lets
// a caller listing many packages at once fetch these ONCE, same
// performance reasoning as keyframe-prompt-service.js's attachLiveStatus.
// The canonical keyframe asset id is always re-read fresh per package
// (cheap — one keyframe lookup), since it is the most likely thing to
// change independently of a storyboard/plan version bump.
function attachLiveVideoPackageStatus(projectId, pkg, liveVersions) {
  const currentStoryboardVersion = liveVersions ? liveVersions.storyboardVersion : (creativeStore.getStoryboard(projectId) || {}).version ?? null;
  const currentKeyframePlanVersion = liveVersions ? liveVersions.keyframePlanVersion : keyframeStore.getKeyframePlanVersion(projectId);
  const currentKeyframe = keyframeStore.getKeyframe(projectId, pkg.keyframeId);
  const currentCanonicalAssetId = currentKeyframe ? currentKeyframe.canonicalAssetId : null;

  const shotChanged = pkg.sourceShotVersion != null && currentStoryboardVersion != null && pkg.sourceShotVersion !== currentStoryboardVersion;
  const planChanged =
    pkg.sourceKeyframePlanVersion != null && currentKeyframePlanVersion != null && pkg.sourceKeyframePlanVersion !== currentKeyframePlanVersion;
  const canonicalAssetChanged = pkg.sourceCanonicalKeyframeAssetId != null && pkg.sourceCanonicalKeyframeAssetId !== currentCanonicalAssetId;

  const staleWarning = 'Source creative direction, keyframe plan, or canonical keyframe asset changed after this package was created.';

  if (!shotChanged && !planChanged && !canonicalAssetChanged) {
    return { ...pkg, status: 'CURRENT', warnings: pkg.warnings.filter((w) => w !== staleWarning) };
  }

  const warnings = pkg.warnings.includes(staleWarning) ? pkg.warnings : [...pkg.warnings, staleWarning];
  return { ...pkg, status: 'STALE', warnings };
}

const PROTECTED_FIELDS = new Set(['packageId', 'projectId', 'keyframeId', 'shotId', 'sceneId', 'version', 'history']);

function applyVersionedUpdate(pkg, updates, { updatedBy, changeNote } = {}) {
  pkg.history = pkg.history || [];
  pkg.history.push({ version: pkg.version, updatedAt: pkg.updatedAt, updatedBy: pkg.updatedBy, changeNote: pkg.changeNote });

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && !PROTECTED_FIELDS.has(key)) pkg[key] = value;
  }

  pkg.version += 1;
  pkg.updatedAt = new Date().toISOString();
  pkg.updatedBy = updatedBy || null;
  pkg.changeNote = changeNote || null;
  return pkg;
}

// P1 CINEMA DIRECTOR BRIDGE — VisualBeat already carries per-shot
// subjectMotion/environmentMotion/pacing (schemas/visual-beat-schema.js —
// same field names as this file's own createVideoCreativeSpecification,
// by deliberate design), but nothing here ever read them: a caller had to
// retype the same creative decision by hand via `creativeSpecInput` every
// time, or it silently stayed null. Fixed by deriving the shot's own beat
// (VisualBeat.id === shot.shotId — beat-graph-derivation-service.js's own
// identity convention) via the EXISTING, unmodified deriveBeatGraph() —
// the same on-demand derivation visual-world-tools.js and pre-production-
// gate-service.js already use, never a new persisted beat store. Pure,
// synchronous, no store writes; safe to call inline. Returns null (never
// throws) for any storyboard/derivation problem — this is a best-effort
// creative-intent source, not a new hard requirement.
function resolveMatchingBeat(storyboard, shotId) {
  if (!storyboard || !shotId) return null;
  let derivation;
  try {
    derivation = beatGraphDerivationService.deriveBeatGraph(storyboard);
  } catch {
    return null;
  }
  if (!derivation || !derivation.beatGraph || !Array.isArray(derivation.beatGraph.beats)) return null;
  return derivation.beatGraph.beats.find((b) => b.id === shotId) || null;
}

// A malformed VisualBeat field (wrong type — e.g. a number/object instead
// of free text) must degrade to "not supplied", never get stringified
// into the prompt as-is (`[object Object]`) and never crash.
function beatCreativeText(beat, field) {
  if (!beat) return null;
  const value = beat[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// ===========================================================================
// Part 3/4/5/6/7 — resolves every source and produces the full set of
// fields a VideoPromptPackage needs, WITHOUT persisting anything. Kept
// separate from buildVideoPromptPackage so it stays easy to test in
// isolation, mirroring keyframe-prompt-service.js's resolvePackageFields.
//
// Returns { ok: false, code, reason } on any structural failure (missing
// project/keyframe/shot, no valid canonical keyframe asset, unknown or
// incapable model) — NEVER throws, NEVER silently substitutes a
// different asset or model. Returns { ok: true, fields } on success.
// ===========================================================================

// `options.beatGraph` (optional) — when supplied, used directly instead of
// re-deriving one from the live Storyboard via deriveBeatGraph(). Same
// "explicit input, else the real default" idiom already used by
// `creativeSpecification`/`executionParameters` on this same function —
// not a new pattern. Exists so a caller that already holds a freshly-
// derived (or, in a future stage, richer) BeatGraph never pays for a
// second derivation, and so this exact resolution logic stays testable
// with a real, directly-constructed VisualBeat without needing
// beat-graph-derivation-service.js itself to change.
function resolveVideoPackageFields(projectId, keyframeId, options = {}) {
  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) {
    return { ok: false, code: 'PROJECT_OR_KEYFRAME_NOT_FOUND', reason: `No keyframe found with id "${keyframeId}" in project "${projectId}".` };
  }

  const canonicalResolution = resolveCanonicalKeyframeInput(projectId, keyframeId);
  if (!canonicalResolution.ok) return canonicalResolution;

  const { provider, model, requiresReferenceImages = false, creativeSpecification: creativeSpecInput = {}, executionParameters: executionParamsInput = {}, beatGraph: beatGraphOverride } = options;
  const modelValidation = validateVideoModelSelection(provider, model, { requiresReferenceImages });
  if (!modelValidation.ok) return modelValidation;

  const storyboard = creativeStore.getStoryboard(projectId);
  const shot = storyboard ? storyboard.shots.find((s) => s.shotId === keyframe.shotId) : null;
  const beat = beatGraphOverride
    ? (Array.isArray(beatGraphOverride.beats) ? beatGraphOverride.beats.find((b) => b.id === keyframe.shotId) : null) || null
    : resolveMatchingBeat(storyboard, keyframe.shotId);
  const keyframePlan = keyframeStore.getKeyframePlan(projectId);
  const sourceKeyframePromptPackage = keyframePromptService.getKeyframePromptPackage(projectId, keyframeId);

  const warnings = [];
  if (!sourceKeyframePromptPackage) {
    warnings.push(`No image KeyframePromptPackage exists for keyframe "${keyframeId}" — subject/continuity/negativeConstraints/referenceLineage could not be carried forward and remain unresolved.`);
  }

  const subject = (sourceKeyframePromptPackage && sourceKeyframePromptPackage.subject) || keyframe.subject || null;
  const atmosphere = (sourceKeyframePromptPackage && sourceKeyframePromptPackage.atmosphere) || null;
  const continuity = (sourceKeyframePromptPackage && sourceKeyframePromptPackage.continuityRequirements) || [];
  const negativeConstraints = (sourceKeyframePromptPackage && sourceKeyframePromptPackage.negativeConstraints) || [];
  const referenceLineage = buildReferenceLineage(sourceKeyframePromptPackage);

  // P1 Cinema Director bridge — explicit creativeSpecInput always wins
  // (never silently overridden); the shot's own VisualBeat is the next
  // fallback (a real per-shot creative decision, when one exists); null
  // only when neither source has anything, exactly like before this fix.
  const creativeSpecification = createVideoCreativeSpecification({
    camera: creativeSpecInput.camera ?? keyframe.camera ?? null,
    subjectMotion: creativeSpecInput.subjectMotion ?? beatCreativeText(beat, 'subjectMotion'),
    environmentMotion: creativeSpecInput.environmentMotion ?? beatCreativeText(beat, 'environmentMotion'),
    composition: creativeSpecInput.composition ?? keyframe.composition ?? null,
    lighting: creativeSpecInput.lighting ?? keyframe.lighting ?? null,
    pacing: creativeSpecInput.pacing ?? beatCreativeText(beat, 'pacing'),
    continuity,
    negativeConstraints,
  });

  const executionParameters = createVideoExecutionParameters({
    duration: executionParamsInput.duration ?? null,
    resolution: executionParamsInput.resolution ?? null,
    aspectRatio: executionParamsInput.aspectRatio ?? null,
    fps: executionParamsInput.fps ?? null,
    quality: executionParamsInput.quality ?? null,
  });

  const actionText = keyframe.visualDescription || (shot && (shot.action || shot.movement || shot.visualDescription)) || null;

  const videoPromptSections = composeVideoPromptSections({ subject, actionText, creativeSpecification });

  return {
    ok: true,
    fields: {
      projectId,
      sceneId: keyframe.sceneId,
      shotId: keyframe.shotId,
      keyframeId,
      sourceShotVersion: storyboard ? storyboard.version : null,
      sourceKeyframePlanVersion: keyframePlan ? keyframePlan.version : null,
      sourceCanonicalKeyframeAssetId: canonicalResolution.canonicalAssetId,
      canonicalKeyframeAssetId: canonicalResolution.canonicalAssetId,
      sourceKeyframePromptPackageId: sourceKeyframePromptPackage ? sourceKeyframePromptPackage.packageId : null,
      sourceKeyframePromptPackageVersion: sourceKeyframePromptPackage ? sourceKeyframePromptPackage.version : null,
      referenceLineage,
      provider,
      model,
      modelVerification: modelValidation.verification,
      subject,
      atmosphere,
      creativeSpecification,
      executionParameters,
      prompt: composeVideoPrompt(videoPromptSections),
      videoPromptSections,
      status: 'CURRENT',
      warnings,
      generatedAt: new Date().toISOString(),
    },
  };
}

// ===========================================================================
// Part 10/13 — the public build/get/list functions. Building or rebuilding
// a package is planning data only: it NEVER creates a generation job,
// approval, or asset, and NEVER touches the project's credit ledger or
// any keyframe/asset approval state.
// ===========================================================================

// Build (create on first call) or rebuild (version-bump on every call
// after that) the video prompt package for one keyframe. Returns
// { ok: true, package } or { ok: false, code, reason }. NEVER throws for
// an ordinary structural/capability failure.
function buildVideoPromptPackage(projectId, keyframeId, options = {}) {
  const record = ensureRecord(projectId);
  if (!record) {
    return { ok: false, code: 'PROJECT_OR_KEYFRAME_NOT_FOUND', reason: `No project found with id "${projectId}".` };
  }

  const resolution = resolveVideoPackageFields(projectId, keyframeId, options);
  if (!resolution.ok) return resolution;

  const { fields } = resolution;
  const { updatedBy, changeNote } = options;

  const existingIndex = record.packages.findIndex((p) => p.keyframeId === keyframeId);
  if (existingIndex === -1) {
    const pkg = createVideoPromptPackage({ ...fields, updatedBy: updatedBy || null, changeNote: changeNote || null });
    record.packages.push(pkg);
    saveRecord(record);
    return { ok: true, package: attachLiveVideoPackageStatus(projectId, pkg) };
  }

  const pkg = record.packages[existingIndex];
  applyVersionedUpdate(pkg, fields, { updatedBy, changeNote: changeNote || 'Rebuilt from current source material' });
  saveRecord(record);
  return { ok: true, package: attachLiveVideoPackageStatus(projectId, pkg) };
}

function getVideoPromptPackage(projectId, keyframeId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  const pkg = record.packages.find((p) => p.keyframeId === keyframeId);
  if (!pkg) return null;
  return attachLiveVideoPackageStatus(projectId, pkg);
}

function listVideoPromptPackages(projectId, { shotId, sceneId, status } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const storyboard = creativeStore.getStoryboard(projectId);
  const liveVersions = { storyboardVersion: storyboard ? storyboard.version : null, keyframePlanVersion: keyframeStore.getKeyframePlanVersion(projectId) };

  let packages = record.packages.map((p) => attachLiveVideoPackageStatus(projectId, p, liveVersions));
  if (shotId) packages = packages.filter((p) => p.shotId === shotId);
  if (sceneId) packages = packages.filter((p) => p.sceneId === sceneId);
  if (status) packages = packages.filter((p) => p.status === status);
  return packages;
}

module.exports = {
  VIDEO_PROMPT_DATA_DIR,
  buildVideoPromptPackage,
  getVideoPromptPackage,
  listVideoPromptPackages,
  // exported for focused unit testing
  resolveVideoPackageFields,
  resolveCanonicalKeyframeInput,
  validateVideoModelSelection,
  composeVideoPromptSections,
  composeVideoPrompt,
  resolveMatchingBeat,
  beatCreativeText,
};
