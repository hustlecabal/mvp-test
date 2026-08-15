// material-resolution-service.js
//
// Stage 26.2 — the MATERIAL RESOLUTION layer (see
// docs/architecture/stage-26-visual-production-director-investigation.md,
// Part 6, and schemas/visual-beat-schema.js, Stage 26.1). Answers exactly
// one question: "what material should satisfy this VisualBeat?"
//
// This is deliberately NOT a generation service. It never calls a
// provider, never spends a credit, never creates a generation job, and
// never touches approval or canonical-asset state. It only READS the
// project's already-existing, already-approved-or-not assets (via the
// existing timeline-store.js / keyframe-store.js — no new store, per the
// architectural rules) and returns a deterministic, structured resolution
// plan describing which existing asset (if any) is the best fit, and why.
//
// Stage 26.2 implements exactly one materialSource:
// 'PROJECT_ASSET_REUSE' (Stage 26's investigation and this stage's own
// prompt both call this "EXISTING_ASSET" informally — the actual field
// value is schemas/visual-beat-schema.js's approved MATERIAL_SOURCES
// enum, unchanged). BROLL_LIBRARY, GENERATED_NEW, and
// DETERMINISTIC_TEMPLATE are explicitly NOT implemented here — see
// "FUTURE EXTENSION POINTS" at the bottom of this file.
//
// PROVIDER NEUTRALITY: this file never imports a provider adapter, never
// references a provider or model name, and never computes cost. It reads
// only project-scoped, already-persisted data.

const timelineStore = require('./timeline-store');
const keyframeStore = require('./keyframe-store');
const { MATERIAL_SOURCES, VISUAL_TREATMENTS } = require('../schemas/visual-beat-schema');
// Stage 26.3 — read-only capability/cost catalogue, consumed exactly the way
// generation-model-registry.js's own comments already document
// (findModelsSatisfying/cheapestSatisfying: "never executes, never submits,
// never selects on the caller's behalf"). This is NOT a provider or
// generation-execution import — it never spends a credit or calls a
// provider; see the "STAGE 26.3 — EXTENSIONS" block below for exactly how
// it is used (capability existence + cost-tier signal only, never a
// provider/model selection).
const generationModelRegistry = require('./generation-model-registry');
const { createMaterialResolution, createCandidateResult, createHardGateResult, createBeatGraphResolution, createResolutionSummary } = require('../schemas/material-resolution-schema');

// ---------------------------------------------------------------------------
// Which existing Asset `type` values (schemas/production-schema.js's
// ASSET_TYPES) can stand in for which VISUAL_TREATMENTS. Character/location
// reference images are raw INPUT material for generation, not finished
// beat content, so they are deliberately excluded as PRIMARY candidates —
// only 'keyframe' (a produced still image) and 'video' (a produced video)
// are eligible.
//
// MOTION_GRAPHIC, KINETIC_TYPOGRAPHY, and HYBRID have no corresponding
// Asset `type` today (no asset is ever created with type 'motion_graphic'
// — that type doesn't exist yet, see DETERMINISTIC_TEMPLATE below), so
// PROJECT_ASSET_REUSE can never satisfy them. This is intentional, not an
// oversight: those treatments belong to a future DETERMINISTIC_TEMPLATE
// resolver, not this one.
// ---------------------------------------------------------------------------
const TREATMENT_TO_ASSET_TYPES = {
  STILL_IMAGE: ['keyframe'],
  AI_VIDEO: ['video'],
  BROLL_CLIP: ['video'],
  MOTION_GRAPHIC: [],
  KINETIC_TYPOGRAPHY: [],
  HYBRID: [], // Stage 26.2 resolves a single, primary treatment only — see
               // "FUTURE EXTENSION POINTS"
};

// ---------------------------------------------------------------------------
// Eligibility gates (hard). A candidate that fails ANY gate is excluded
// from ranking entirely and reported in `rejectedCandidates` with the
// specific reason(s) it failed. Every gate here checks something the
// CURRENT data model actually stores — nothing is invented. See the
// "DIMENSIONS CURRENTLY UNAVAILABLE" comment near the bottom of this file
// for what a hard gate deliberately does NOT check yet, and why.
// ---------------------------------------------------------------------------
function evaluateEligibility(beat, asset, { sourceKeyframe } = {}) {
  const reasons = [];

  // Gate: asset is stored (a provider result URL alone, never archived,
  // is not safely reusable as beat material).
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    reasons.push(`asset storage status is "${storageStatus}", not STORED`);
  }

  // Gate: asset is not REJECTED. NONE and APPROVED both remain eligible —
  // mirrors the exact same rule creative-store.js's
  // selectCanonicalReferenceAsset already applies to canonical selection
  // (only REJECTED is ever a hard block), kept consistent here rather
  // than invented fresh.
  if (asset.approvalStatus === 'REJECTED') {
    reasons.push('asset has been REJECTED and cannot be reused');
  }

  // Gate: media type compatible with the beat's requested visualTreatment.
  const allowedTypes = TREATMENT_TO_ASSET_TYPES[beat.visualTreatment] || [];
  if (!allowedTypes.includes(asset.type)) {
    reasons.push(
      `asset type "${asset.type}" cannot satisfy visualTreatment "${beat.visualTreatment}" via PROJECT_ASSET_REUSE ` +
        `(eligible asset types: ${allowedTypes.length ? allowedTypes.join(', ') : 'none — this treatment has no existing-asset path yet'})`
    );
  }

  // Gate: identity requirements, where determinable. Only checkable for a
  // 'keyframe'-type asset whose originating keyframe record is still
  // found (asset.keyframeId -> keyframeStore.getKeyframe) — that keyframe
  // already carries its own characterReferences/locationReferences/
  // propReferences (schemas/keyframe-schema.js), so this is a direct,
  // already-persisted structural lookup, not a new inference. A 'video'
  // asset's identity lineage lives one hop further away (its
  // VideoPromptPackage's referenceLineage) and is deliberately NOT walked
  // in Stage 26.2 — see "DIMENSIONS CURRENTLY UNAVAILABLE" below.
  const hasIdentityRequirements =
    beat.identityRequirements &&
    (beat.identityRequirements.characterReferences.length > 0 ||
      beat.identityRequirements.locationReferences.length > 0 ||
      beat.identityRequirements.propReferences.length > 0);

  if (hasIdentityRequirements && asset.type === 'keyframe' && sourceKeyframe) {
    const missing = [];
    for (const characterId of beat.identityRequirements.characterReferences) {
      if (!sourceKeyframe.characterReferences.includes(characterId)) missing.push(`character ${characterId}`);
    }
    for (const locationId of beat.identityRequirements.locationReferences) {
      if (!sourceKeyframe.locationReferences.includes(locationId)) missing.push(`location ${locationId}`);
    }
    for (const propId of beat.identityRequirements.propReferences) {
      if (!sourceKeyframe.propReferences.includes(propId)) missing.push(`prop ${propId}`);
    }
    if (missing.length > 0) {
      reasons.push(`asset's originating keyframe does not reference required: ${missing.join(', ')}`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Deterministic ranking (Phase 2 — among gate-surviving candidates only).
// Every dimension below reads a field that already exists on Asset/
// Keyframe today. No embeddings, no multimodal call, no LLM — see
// "DIMENSIONS CURRENTLY UNAVAILABLE" for what is intentionally absent.
// ---------------------------------------------------------------------------
function scoreCandidate(beat, asset, { sourceKeyframe, canonicalAssetId } = {}) {
  const breakdown = {
    approvalStatus: 0,
    canonicalStatus: 0,
    identityCompatibility: 0,
    treatmentMatch: 0,
  };

  // Dimension: approval status. APPROVED is strictly preferred over NONE
  // (REJECTED never reaches this function — excluded at the gate above).
  if (asset.approvalStatus === 'APPROVED') breakdown.approvalStatus = 2;
  else if (asset.approvalStatus === 'NONE') breakdown.approvalStatus = 0;

  // Dimension: canonical status. Only meaningful for a 'keyframe' asset —
  // reuses keyframe-store.js's own getCanonicalKeyframeAsset, never a new
  // "canonical" concept.
  if (asset.type === 'keyframe' && canonicalAssetId && canonicalAssetId === asset.assetId) {
    breakdown.canonicalStatus = 2;
  }

  // Dimension: identity compatibility. Only scored (not just gated) when
  // the beat actually has identity requirements AND they were verifiable
  // (a keyframe asset with a resolvable source keyframe). A beat with NO
  // identity requirements scores neutral (nothing to satisfy or fail).
  const hasIdentityRequirements =
    beat.identityRequirements &&
    (beat.identityRequirements.characterReferences.length > 0 ||
      beat.identityRequirements.locationReferences.length > 0 ||
      beat.identityRequirements.propReferences.length > 0);
  if (!hasIdentityRequirements) {
    breakdown.identityCompatibility = 0.5; // neutral-positive: nothing required, nothing to fail
  } else if (asset.type === 'keyframe' && sourceKeyframe) {
    breakdown.identityCompatibility = 1; // gate above already proved full coverage, or this candidate
                                            // would have been rejected before reaching scoring
  } // else: unverifiable (e.g. a video asset) — stays 0, with a caveat
    // surfaced in diagnostics by the caller, never silently treated as a match

  // Dimension: treatment match strength. Every surviving candidate already
  // passed the hard media-type gate, so this is always the max value here
  // — kept as its own breakdown entry for auditability/future refinement
  // (e.g. once BROLL_CLIP and AI_VIDEO both map to 'video', a finer split
  // may be worth adding).
  breakdown.treatmentMatch = 1;

  const total = breakdown.approvalStatus + breakdown.canonicalStatus + breakdown.identityCompatibility + breakdown.treatmentMatch;
  return { total, breakdown };
}

// Recency is used only as a final tie-breaker among equally-scored
// candidates (newer createdAt wins) — never as its own weighted score
// component, so the numeric score itself stays fully explainable from the
// breakdown alone.
function compareCandidates(a, b) {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  const aTime = a.asset.createdAt ? Date.parse(a.asset.createdAt) : 0;
  const bTime = b.asset.createdAt ? Date.parse(b.asset.createdAt) : 0;
  return bTime - aTime;
}

// The maximum theoretically achievable score, used only to normalize a
// winning candidate's `confidence` into a bounded, comparable [0, 1]
// value — never used as a gate or a ranking input itself.
const MAX_POSSIBLE_SCORE = 2 /* approvalStatus */ + 2 /* canonicalStatus */ + 1 /* identityCompatibility */ + 1 /* treatmentMatch */;

// ---------------------------------------------------------------------------
// Public entry point. Pure/read-only: never creates, mutates, or deletes
// anything. Returns a structured resolution plan even when nothing
// qualifies — never throws for an ordinary "no eligible candidates" case.
// ---------------------------------------------------------------------------
function resolveVisualBeat(projectId, beat) {
  const diagnostics = [];

  if (!beat || !beat.id) {
    return {
      beatId: beat ? beat.id : null,
      decision: { materialSource: null, visualTreatment: beat ? beat.visualTreatment : null, selectedAssetId: null, confidence: null, reason: 'no beat supplied' },
      candidates: [],
      rejectedCandidates: [],
      diagnostics: ['a VisualBeat (with an id) is required'],
    };
  }

  if (!VISUAL_TREATMENTS.includes(beat.visualTreatment)) {
    return {
      beatId: beat.id,
      decision: { materialSource: null, visualTreatment: beat.visualTreatment, selectedAssetId: null, confidence: null, reason: 'beat.visualTreatment is not set to a recognized value' },
      candidates: [],
      rejectedCandidates: [],
      diagnostics: [`visualTreatment "${beat.visualTreatment}" is not one of ${VISUAL_TREATMENTS.join(', ')}`],
    };
  }

  const allowedAssetTypes = TREATMENT_TO_ASSET_TYPES[beat.visualTreatment] || [];
  if (allowedAssetTypes.length === 0) {
    diagnostics.push(
      `visualTreatment "${beat.visualTreatment}" has no PROJECT_ASSET_REUSE path today — it requires a DETERMINISTIC_TEMPLATE ` +
        `or GENERATED_NEW material source, neither implemented by this resolver (Stage 26.2 scope)`
    );
    return {
      beatId: beat.id,
      decision: { materialSource: null, visualTreatment: beat.visualTreatment, selectedAssetId: null, confidence: null, reason: 'no existing-asset path for this treatment' },
      candidates: [],
      rejectedCandidates: [],
      diagnostics,
    };
  }

  const allAssets = timelineStore.listAssets(projectId);
  if (allAssets === null) {
    return {
      beatId: beat.id,
      decision: { materialSource: null, visualTreatment: beat.visualTreatment, selectedAssetId: null, confidence: null, reason: 'project not found' },
      candidates: [],
      rejectedCandidates: [],
      diagnostics: [`no project found with id "${projectId}"`],
    };
  }

  // "asset belongs to the project" is structurally guaranteed here —
  // timelineStore.listAssets(projectId) can only ever return assets
  // already scoped to this project, so no separate ownership check is
  // needed (documented in the Stage 26.2 report, not silently skipped).
  //
  // Deliberately NOT pre-filtered to `allowedAssetTypes` here: every asset
  // is run through evaluateEligibility() below, whose own media-type gate
  // (see TREATMENT_TO_ASSET_TYPES above) is what excludes a wrong-type
  // asset. Pre-filtering first would silently drop those assets before
  // they were ever evaluated, so a wrong-type asset would vanish instead
  // of surfacing in `rejectedCandidates` with a specific reason — the
  // structured-diagnostics requirement this stage was built to satisfy.
  const candidates = [];
  const rejectedCandidates = [];

  for (const asset of allAssets) {
    const sourceKeyframe = asset.type === 'keyframe' && asset.keyframeId ? keyframeStore.getKeyframe(projectId, asset.keyframeId) : null;
    const eligibility = evaluateEligibility(beat, asset, { sourceKeyframe });

    if (!eligibility.eligible) {
      rejectedCandidates.push({ assetId: asset.assetId, type: asset.type, reasons: eligibility.reasons });
      continue;
    }

    let canonicalAssetId = null;
    if (asset.type === 'keyframe' && asset.keyframeId) {
      const canonical = keyframeStore.getCanonicalKeyframeAsset(projectId, asset.keyframeId);
      canonicalAssetId = canonical ? canonical.canonicalAssetId : null;
    }

    const hasIdentityRequirements =
      beat.identityRequirements &&
      (beat.identityRequirements.characterReferences.length > 0 ||
        beat.identityRequirements.locationReferences.length > 0 ||
        beat.identityRequirements.propReferences.length > 0);
    if (hasIdentityRequirements && asset.type === 'video') {
      diagnostics.push(
        `asset ${asset.assetId}: identity requirements could not be verified (video-asset identity lineage is not walked in Stage 26.2 — see FUTURE EXTENSION POINTS); ranked without an identity-compatibility bonus, not excluded`
      );
    }

    const score = scoreCandidate(beat, asset, { sourceKeyframe, canonicalAssetId });
    candidates.push({ asset, score, canonical: canonicalAssetId === asset.assetId });
  }

  candidates.sort(compareCandidates);

  if (candidates.length === 0) {
    diagnostics.push('no eligible existing asset found for this beat');
    return {
      beatId: beat.id,
      decision: { materialSource: null, visualTreatment: beat.visualTreatment, selectedAssetId: null, confidence: null, reason: 'no eligible candidates' },
      candidates: [],
      rejectedCandidates: rejectedCandidates.map((r) => ({ assetId: r.assetId, reasons: r.reasons })),
      diagnostics,
    };
  }

  const winner = candidates[0];
  const confidence = Math.min(1, Math.max(0, winner.score.total / MAX_POSSIBLE_SCORE));

  return {
    beatId: beat.id,
    decision: {
      materialSource: 'PROJECT_ASSET_REUSE',
      visualTreatment: beat.visualTreatment,
      selectedAssetId: winner.asset.assetId,
      confidence,
      reason:
        `existing ${winner.asset.type} asset ${winner.asset.assetId} satisfies "${beat.visualTreatment}"` +
        (winner.canonical ? ' (its keyframe\'s canonical selection)' : '') +
        (winner.asset.approvalStatus === 'APPROVED' ? ', approved' : ', unreviewed (NONE)'),
    },
    candidates: candidates.map((c) => ({
      assetId: c.asset.assetId,
      type: c.asset.type,
      approvalStatus: c.asset.approvalStatus,
      canonical: c.canonical,
      score: c.score.total,
      scoreBreakdown: c.score.breakdown,
    })),
    rejectedCandidates: rejectedCandidates.map((r) => ({ assetId: r.assetId, reasons: r.reasons })),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Timeline IR adapter — Part "TIMELINE INTEGRATION" of this stage's
// mandate. Converts a resolved beat into a plain, Shot-shaped object
// (schemas/production-schema.js's createShot fields) that the EXISTING
// timeline-store.js's addShot() can persist as-is. This function never
// calls addShot() itself and never persists anything — it is a pure
// mapping, so a caller decides when (or whether) to actually place it on
// the timeline. No new timeline schema is introduced; every field written
// here already exists on the legacy Shot record.
// ---------------------------------------------------------------------------
function toTimelineShotFields(beat, resolution) {
  if (!resolution || !resolution.decision || !resolution.decision.selectedAssetId) {
    throw new Error('toTimelineShotFields requires a resolution with a selected asset — call resolveVisualBeat first');
  }
  const { decision } = resolution;

  const fields = {
    sceneId: beat.sceneId,
    startTime: beat.startTime,
    duration: beat.duration,
    narrativePurpose: beat.narrativePurpose || '',
    composition: beat.composition,
    camera: beat.camera,
    subjectAction: beat.subjectMotion || '',
    environmentAction: beat.environmentMotion || '',
    // keyframeAssetId vs videoAssetId — the legacy Shot record already
    // distinguishes these by field name rather than a single generic
    // "assetId", so the adapter routes by the resolved asset's kind
    // (derivable from which VISUAL_TREATMENTS bucket it satisfied).
    keyframeAssetId: decision.visualTreatment === 'STILL_IMAGE' ? decision.selectedAssetId : null,
    videoAssetId: decision.visualTreatment === 'AI_VIDEO' || decision.visualTreatment === 'BROLL_CLIP' ? decision.selectedAssetId : null,
    // No new generation was performed — this shot's material came from
    // reuse, so it has no generation of its own to reference. The reused
    // asset's OWN prior generationId (if any) belongs to that asset's own
    // lineage, not to this shot.
    generationId: null,
  };
  return fields;
}

// =============================================================================
// STAGE 26.3 — EXTENSIONS. Everything above this line (TREATMENT_TO_ASSET_TYPES,
// evaluateEligibility, scoreCandidate, compareCandidates, MAX_POSSIBLE_SCORE,
// resolveVisualBeat, toTimelineShotFields) is UNCHANGED and remains fully
// backwards compatible — every existing caller/test keeps working exactly as
// before. resolveMaterial() below is a NEW, ADDITIONAL entry point that
// extends coverage from the single materialSource resolveVisualBeat()
// implements (PROJECT_ASSET_REUSE) to all four MATERIAL_SOURCES values, by
// CALLING resolveVisualBeat() internally rather than duplicating its logic.
//
// Ranking here is a strict, ORDERED-PHASE comparison
// (CREATIVE_FIT -> CONTINUITY -> REUSE -> COST -> COMPLEXITY), never a
// weighted sum — there is no totalScore anywhere in this file or in
// schemas/material-resolution-schema.js. Each phase is its own small,
// independently replaceable function (scoreCreativeFit/scoreContinuity/
// scoreReuse/scoreCost/scoreComplexity) specifically so the creative-
// quality/cost trade-off can be retuned later without redesigning the
// resolver or touching compareCandidates()'s own ordering logic.
// =============================================================================

// Deterministic-template-eligible treatments — structurally available on
// demand (no ingested library required, unlike BROLL_LIBRARY) because a
// deterministic renderer can always be constructed from the beat's own
// structured fields once one exists. No renderer is built this stage; these
// candidates describe a MATERIAL STRATEGY only (see the module-level comment
// at the top of this file).
const DETERMINISTIC_TREATMENTS = ['MOTION_GRAPHIC', 'KINETIC_TYPOGRAPHY', 'WHITEBOARD'];

// Same neutral-when-absent, verified-when-checkable convention as
// evaluateEligibility()'s own identity check above — duplicated here as a
// small standalone helper (rather than refactoring the existing, tested
// function) specifically to avoid any risk of altering resolveVisualBeat()'s
// already-tested behavior.
function hasIdentityOrContinuityRequirements(beat) {
  const idr = beat.identityRequirements;
  const hasIdentity = Boolean(
    idr && (idr.characterReferences.length > 0 || idr.locationReferences.length > 0 || idr.propReferences.length > 0)
  );
  const hasContinuity = Array.isArray(beat.continuityRequirements) && beat.continuityRequirements.length > 0;
  return hasIdentity || hasContinuity;
}

// The specific "identified subject" case correction #3 of the Stage 26.3
// design review calls out: B-roll cannot stand in for a NAMED character.
// locationReferences/propReferences alone do not trigger this — B-roll can
// plausibly represent a generic location/prop (scored low on continuity
// instead, never hard-gated — see scoreContinuity below).
function hasCharacterIdentity(beat) {
  return Boolean(beat.identityRequirements && beat.identityRequirements.characterReferences && beat.identityRequirements.characterReferences.length > 0);
}

// Whether `visualTreatment` is even a candidate worth generating for this
// beat: either it's the beat's own stated treatment, or the beat's author
// has explicitly listed it as an acceptable fallback. A candidate class
// whose treatment satisfies neither is simply never instantiated — not
// reported as a hard-gate rejection, exactly like the existing
// resolveVisualBeat()'s own "no existing-asset path for this treatment"
// short-circuit never enumerates irrelevant assets one by one.
function beatAllowsTreatment(beat, visualTreatment) {
  return beat.visualTreatment === visualTreatment || (Array.isArray(beat.fallbackStrategy) && beat.fallbackStrategy.includes(visualTreatment));
}

// Capability requirements only — schemas/generation-model-registry.js's own
// requirement shape (modality/textToImage/textToVideo/referenceImages/
// minDurationSeconds/...). NEVER a provider or model name (Stage 26.3
// requirement #7 / #6 of the design review) — provider/model selection is an
// explicit later, downstream concern.
function buildModelRequirements(beat, visualTreatment) {
  const requirements = { modality: visualTreatment === 'AI_VIDEO' ? 'video' : 'image' };
  if (visualTreatment === 'AI_VIDEO') {
    requirements.textToVideo = true;
  } else {
    requirements.textToImage = true;
  }
  if (hasIdentityOrContinuityRequirements(beat)) {
    requirements.referenceImages = true;
  }
  if (visualTreatment === 'AI_VIDEO' && typeof beat.duration === 'number') {
    requirements.minDurationSeconds = beat.duration;
  }
  return requirements;
}

// ---------------------------------------------------------------------------
// PHASE B — CREATIVE FIT. 2 = exact match to the beat's own stated
// visualTreatment (the Director's actual intent). 1 = reached only via
// beat.fallbackStrategy (an explicitly beat-author-approved substitute, not
// an invented one). Every candidate reaching this function already passed
// beatAllowsTreatment(), so 0 should not normally occur.
// ---------------------------------------------------------------------------
function scoreCreativeFit(beat, materialSource, visualTreatment) {
  if (visualTreatment === beat.visualTreatment) return 2;
  if (Array.isArray(beat.fallbackStrategy) && beat.fallbackStrategy.includes(visualTreatment)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// PHASE C — CONTINUITY. Prefers candidates that preserve identity/
// environment/visual continuity. For PROJECT_ASSET_REUSE, reuses the
// existing, untouched scoreCandidate() total EXACTLY as computed by
// resolveVisualBeat() — never recomputed here — rescaled from its native
// 0-6 range to a 0-2 range (divide by 3) purely so its MAGNITUDE is
// comparable to the other classes' 0-1-ish ranges; the relative ORDER a
// higher old score implies is preserved exactly, nothing about the old
// scorer's own logic changes.
// ---------------------------------------------------------------------------
function scoreContinuity(materialSource, { existingReuseScoreTotal, hasIdentityOrContinuityReqs } = {}) {
  if (materialSource === 'PROJECT_ASSET_REUSE') {
    return typeof existingReuseScoreTotal === 'number' ? existingReuseScoreTotal / 3 : 0;
  }
  if (!hasIdentityOrContinuityReqs) return 0.5; // neutral-positive: nothing required, nothing to fail
  if (materialSource === 'GENERATED_NEW') {
    // The EXISTING KeyframePromptPackage/VideoPromptPackage pipeline already
    // structurally binds a canonical, APPROVED reference asset before a
    // generation call is ever built (services/video-prompt-service.js,
    // services/keyframe-prompt-service.js) — a real, already-built
    // enforcement mechanism, not an assumption invented by this file.
    return 1;
  }
  if (materialSource === 'BROLL_LIBRARY') return 0; // location/prop-only survivor — unverifiable match
  return 0.5; // DETERMINISTIC_TEMPLATE with requirements present — coarse neutral
}

// ---------------------------------------------------------------------------
// PHASE D — REUSE. Prefers already-existing valid material over unnecessary
// new creation, independent of cost. Fixed ordinal, not derived from price.
// ---------------------------------------------------------------------------
const REUSE_ORDINAL = { PROJECT_ASSET_REUSE: 3, BROLL_LIBRARY: 2, DETERMINISTIC_TEMPLATE: 1, GENERATED_NEW: 0 };
function scoreReuse(materialSource) {
  return REUSE_ORDINAL[materialSource] ?? 0;
}

// ---------------------------------------------------------------------------
// PHASE E — COST. Tie-break only (consulted after creativeFit/continuity/
// reuse already tied) — never lets a cheap candidate compensate for failing
// an earlier phase, since candidates are compared lexicographically, not
// summed. Unknown/unpriced models are NEVER scored as free — reuses
// generation-model-registry.js's own "unknown price never treated as
// cheapest" discipline (cheapestSatisfying places unpriced entries last).
// ---------------------------------------------------------------------------
const GENERATED_NEW_COST_TIER_SCORE = { BUDGET: 1, STANDARD: 0.5, QUALITY: 0, OTHER: 0 };
function scoreCost(materialSource, { cheapestModel } = {}) {
  if (materialSource !== 'GENERATED_NEW') return 2; // zero-cost sources
  if (!cheapestModel || !cheapestModel.pricing.priceKnown) return 0;
  return GENERATED_NEW_COST_TIER_SCORE[cheapestModel.costTier] ?? 0;
}

// ---------------------------------------------------------------------------
// PHASE F — EXECUTION COMPLEXITY. Tie-break only, consulted last. A coarse,
// static, per-class placeholder — documented as such because no real
// renderer/generation pipeline exists yet to measure actual complexity
// (mirrors this file's own existing "DIMENSIONS CURRENTLY UNAVAILABLE"
// documentation discipline below).
// ---------------------------------------------------------------------------
function scoreComplexity(materialSource, visualTreatment) {
  if (materialSource === 'PROJECT_ASSET_REUSE') return 3;
  if (materialSource === 'DETERMINISTIC_TEMPLATE' || materialSource === 'BROLL_LIBRARY') return 2;
  if (materialSource === 'GENERATED_NEW' && visualTreatment === 'STILL_IMAGE') return 1;
  return 0; // GENERATED_NEW + AI_VIDEO — most complex/highest-risk path
}

const PHASE_ORDER = ['creativeFit', 'continuity', 'reuse', 'cost', 'complexity'];
const PHASE_KEY_TO_DECIDING_PHASE = {
  creativeFit: 'CREATIVE_FIT',
  continuity: 'CONTINUITY',
  reuse: 'REUSE',
  cost: 'COST',
  complexity: 'COMPLEXITY',
};

// Strict lexicographic comparison, NOT a weighted sum — each phase is only
// consulted when every phase before it is exactly tied. `candidate` (a
// unique string across the whole survivor list — see resolveMaterial()) is
// the final deterministic tie-break when every named phase ties; it is a
// stand-in for "CREATED_AT" in DECIDING_PHASES since non-PROJECT_ASSET_REUSE
// candidates describe a strategy, not a dated record, so there is no literal
// timestamp to break the tie with — documented here rather than silently
// assumed.
//
// Named compareMaterialCandidates (NOT compareCandidates) deliberately: this
// file already has its own compareCandidates() above, used internally by the
// existing, untouched resolveVisualBeat(). Function declarations in the same
// scope silently override one another in JS by source order — reusing the
// same name here would have SHADOWED the original and corrupted
// resolveVisualBeat()'s own PROJECT_ASSET_REUSE ranking, exactly the
// "existing tests must continue passing unchanged" backward-compatibility
// break this stage is required to avoid.
function compareMaterialCandidates(a, b) {
  for (const phase of PHASE_ORDER) {
    const diff = (b.phaseScores[phase] ?? 0) - (a.phaseScores[phase] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.candidate.localeCompare(b.candidate);
}

// ---------------------------------------------------------------------------
// Public entry point. Pure/read-only, exactly like resolveVisualBeat():
// never creates, mutates, or deletes anything, never calls a provider, never
// touches approval-gate.js or any approval store. Extends coverage to every
// MATERIAL_SOURCES value by calling the existing resolveVisualBeat()
// internally for PROJECT_ASSET_REUSE (never reimplementing it) and adding
// new, independent hard-gate + phase-scoring logic for the other three.
//
// `context.brollSegments` — an OPTIONAL, INJECTABLE array of plain
// BRollSegment-shaped fixtures ({ segmentId, licensingStatus, ... }), per
// Stage 26.3 requirement #9. Defaults to `[]`. No B-roll store or ingestion
// system exists — every real call today passes no context, so BROLL_LIBRARY
// always resolves to "no library exists yet" in production; the injectable
// parameter exists solely so the licensing/identity gate LOGIC is unit-
// testable against fixture data ahead of a future ingestion stage.
// ---------------------------------------------------------------------------
function resolveMaterial(projectId, beat, context = {}) {
  if (!beat || !beat.id) {
    return createMaterialResolution({
      beatId: beat ? beat.id : null,
      status: 'UNRESOLVED',
      warnings: ['a VisualBeat (with an id) is required'],
      unresolvedRequirements: [{ candidate: null, rejectedBy: 'INVALID_BEAT', reason: 'a VisualBeat (with an id) is required' }],
      rationale: 'no beat supplied',
    });
  }

  if (!VISUAL_TREATMENTS.includes(beat.visualTreatment)) {
    const reason = `visualTreatment "${beat.visualTreatment}" is not one of ${VISUAL_TREATMENTS.join(', ')}`;
    return createMaterialResolution({
      beatId: beat.id,
      status: 'UNRESOLVED',
      warnings: [reason],
      unresolvedRequirements: [{ candidate: null, rejectedBy: 'INVALID_TREATMENT', reason }],
      rationale: 'beat.visualTreatment is not set to a recognized value',
    });
  }

  // Same existence check resolveVisualBeat() itself performs — checked
  // independently here (rather than parsing that function's own diagnostic
  // strings) so this short-circuit is robust to unrelated wording changes.
  if (timelineStore.listAssets(projectId) === null) {
    const reason = `no project found with id "${projectId}"`;
    return createMaterialResolution({
      beatId: beat.id,
      status: 'UNRESOLVED',
      warnings: [reason],
      unresolvedRequirements: [{ candidate: null, rejectedBy: 'PROJECT_NOT_FOUND', reason }],
      rationale: 'project not found',
    });
  }

  const hardGateResults = [];
  const survivors = [];
  const warnings = [];

  const requiresSubjectMotion = Boolean(beat.motionRequirements && beat.motionRequirements.requiresSubjectMotion === true);
  const motionLevel = beat.motionRequirements ? beat.motionRequirements.motionLevel : null;
  const exactContentPrimary = DETERMINISTIC_TREATMENTS.includes(beat.visualTreatment);
  const identityOrContinuity = hasIdentityOrContinuityRequirements(beat);
  const characterIdentity = hasCharacterIdentity(beat);

  // --- PROJECT_ASSET_REUSE — delegate entirely to the existing, untouched resolver ---
  const existingReuse = resolveVisualBeat(projectId, beat);
  for (const diagnostic of existingReuse.diagnostics || []) warnings.push(diagnostic);

  if (existingReuse.decision && existingReuse.decision.selectedAssetId && existingReuse.candidates && existingReuse.candidates.length > 0) {
    const winner = existingReuse.candidates[0];
    const candidateId = `PROJECT_ASSET_REUSE+${beat.visualTreatment}`;

    const motionBlocked =
      (requiresSubjectMotion && (beat.visualTreatment === 'STILL_IMAGE' || DETERMINISTIC_TREATMENTS.includes(beat.visualTreatment))) ||
      (beat.visualTreatment === 'STILL_IMAGE' && ['MODERATE', 'COMPLEX'].includes(motionLevel));

    if (motionBlocked) {
      hardGateResults.push(
        createHardGateResult({
          candidate: candidateId,
          allowed: false,
          rejectedBy: 'MOTION_REQUIREMENT_UNSATISFIED',
          reason: `beat's motion requirements cannot be satisfied by ${beat.visualTreatment}`,
          eligibleRoles: [],
        })
      );
    } else {
      hardGateResults.push(createHardGateResult({ candidate: candidateId, allowed: true, eligibleRoles: ['PRIMARY'] }));
      survivors.push(
        createCandidateResult({
          candidate: candidateId,
          materialSource: 'PROJECT_ASSET_REUSE',
          visualTreatment: beat.visualTreatment,
          selectedAssetId: winner.assetId,
          eligibleRoles: ['PRIMARY'],
          phaseScores: {
            creativeFit: scoreCreativeFit(beat, 'PROJECT_ASSET_REUSE', beat.visualTreatment),
            continuity: scoreContinuity('PROJECT_ASSET_REUSE', { existingReuseScoreTotal: winner.score }),
            reuse: scoreReuse('PROJECT_ASSET_REUSE'),
            cost: scoreCost('PROJECT_ASSET_REUSE'),
            complexity: scoreComplexity('PROJECT_ASSET_REUSE', beat.visualTreatment),
          },
        })
      );
    }
  }

  // --- BROLL_LIBRARY — role-scoped (Stage 26.3 correction #3) ---
  if (beatAllowsTreatment(beat, 'BROLL_CLIP')) {
    const segments = Array.isArray(context.brollSegments) ? context.brollSegments : [];
    if (segments.length === 0) {
      hardGateResults.push(
        createHardGateResult({
          candidate: 'BROLL_LIBRARY+BROLL_CLIP',
          allowed: false,
          rejectedBy: 'NO_LIBRARY',
          reason: 'no B-roll library exists yet',
          eligibleRoles: [],
        })
      );
    } else {
      for (const segment of segments) {
        const segmentCandidateId = `BROLL_LIBRARY+BROLL_CLIP:${segment.segmentId || 'unknown'}`;

        if (segment.licensingStatus !== 'CLEARED') {
          hardGateResults.push(
            createHardGateResult({
              candidate: segmentCandidateId,
              allowed: false,
              rejectedBy: 'LICENSING_UNKNOWN',
              reason: `licensing status "${segment.licensingStatus}" is not CLEARED`,
              eligibleRoles: [],
            })
          );
          continue;
        }

        if (characterIdentity) {
          hardGateResults.push(
            createHardGateResult({
              candidate: segmentCandidateId,
              allowed: false,
              rejectedBy: 'IDENTITY_REQUIRES_NON_BROLL_PRIMARY',
              reason: "beat requires a specific character's identity, which B-roll cannot represent as PRIMARY material",
              eligibleRoles: ['OVERLAY', 'BACKGROUND', 'INSERT'],
            })
          );
          warnings.push(
            `B-roll segment "${segment.segmentId || 'unknown'}" could satisfy this beat as OVERLAY/BACKGROUND/INSERT material in a future HYBRID composition, but not as PRIMARY`
          );
          continue;
        }

        hardGateResults.push(createHardGateResult({ candidate: segmentCandidateId, allowed: true, eligibleRoles: ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT'] }));
        survivors.push(
          createCandidateResult({
            candidate: segmentCandidateId,
            materialSource: 'BROLL_LIBRARY',
            visualTreatment: 'BROLL_CLIP',
            eligibleRoles: ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT'],
            phaseScores: {
              creativeFit: scoreCreativeFit(beat, 'BROLL_LIBRARY', 'BROLL_CLIP'),
              continuity: scoreContinuity('BROLL_LIBRARY', { hasIdentityOrContinuityReqs: identityOrContinuity }),
              reuse: scoreReuse('BROLL_LIBRARY'),
              cost: scoreCost('BROLL_LIBRARY'),
              complexity: scoreComplexity('BROLL_LIBRARY'),
            },
          })
        );
      }
    }
  }

  // --- DETERMINISTIC_TEMPLATE — MOTION_GRAPHIC / KINETIC_TYPOGRAPHY / WHITEBOARD ---
  for (const treatment of DETERMINISTIC_TREATMENTS) {
    if (!beatAllowsTreatment(beat, treatment)) continue;
    const candidateId = `DETERMINISTIC_TEMPLATE+${treatment}`;

    if (requiresSubjectMotion) {
      hardGateResults.push(
        createHardGateResult({
          candidate: candidateId,
          allowed: false,
          rejectedBy: 'MOTION_REQUIREMENT_UNSATISFIED',
          reason: 'beat requires genuine subject motion, which a deterministic template cannot depict',
          eligibleRoles: [],
        })
      );
      continue;
    }

    hardGateResults.push(createHardGateResult({ candidate: candidateId, allowed: true, eligibleRoles: ['PRIMARY'] }));
    survivors.push(
      createCandidateResult({
        candidate: candidateId,
        materialSource: 'DETERMINISTIC_TEMPLATE',
        visualTreatment: treatment,
        eligibleRoles: ['PRIMARY'],
        phaseScores: {
          creativeFit: scoreCreativeFit(beat, 'DETERMINISTIC_TEMPLATE', treatment),
          continuity: scoreContinuity('DETERMINISTIC_TEMPLATE', { hasIdentityOrContinuityReqs: identityOrContinuity }),
          reuse: scoreReuse('DETERMINISTIC_TEMPLATE'),
          cost: scoreCost('DETERMINISTIC_TEMPLATE'),
          complexity: scoreComplexity('DETERMINISTIC_TEMPLATE', treatment),
        },
      })
    );
  }

  // --- GENERATED_NEW — STILL_IMAGE / AI_VIDEO ---
  for (const treatment of ['STILL_IMAGE', 'AI_VIDEO']) {
    if (!beatAllowsTreatment(beat, treatment)) continue;
    const candidateId = `GENERATED_NEW+${treatment}`;

    // Exact on-screen content (numbers/exact text) — AI generation can never
    // guarantee it (docs/architecture/stage-26.2-visual-production-master-
    // spec.md, Part 10.1). Only reachable here when the beat's PRIMARY
    // treatment IS a deterministic one and this treatment is being
    // considered solely via fallbackStrategy.
    if (exactContentPrimary && treatment !== beat.visualTreatment) {
      hardGateResults.push(
        createHardGateResult({
          candidate: candidateId,
          allowed: false,
          rejectedBy: 'EXACT_CONTENT_REQUIRES_DETERMINISTIC',
          reason: 'beat requires exact on-screen content; AI generation cannot guarantee it',
          eligibleRoles: [],
        })
      );
      continue;
    }

    if (requiresSubjectMotion && treatment === 'STILL_IMAGE') {
      hardGateResults.push(
        createHardGateResult({
          candidate: candidateId,
          allowed: false,
          rejectedBy: 'MOTION_REQUIREMENT_UNSATISFIED',
          reason: 'beat requires genuine subject motion, which a still image cannot depict',
          eligibleRoles: [],
        })
      );
      continue;
    }

    if (treatment === 'STILL_IMAGE' && ['MODERATE', 'COMPLEX'].includes(motionLevel)) {
      hardGateResults.push(
        createHardGateResult({
          candidate: candidateId,
          allowed: false,
          rejectedBy: 'MOTION_REQUIREMENT_UNSATISFIED',
          reason: 'a still image cannot satisfy a moderate/complex motion requirement',
          eligibleRoles: [],
        })
      );
      continue;
    }

    const modelRequirements = buildModelRequirements(beat, treatment);
    const capableModels = generationModelRegistry.findModelsSatisfying(modelRequirements);
    if (capableModels.length === 0) {
      hardGateResults.push(
        createHardGateResult({
          candidate: candidateId,
          allowed: false,
          rejectedBy: 'NO_CAPABLE_MODEL',
          reason: 'no registry model satisfies the derived capability requirements',
          eligibleRoles: [],
        })
      );
      continue;
    }

    const cheapestModel = generationModelRegistry.cheapestSatisfying(modelRequirements)[0];
    hardGateResults.push(createHardGateResult({ candidate: candidateId, allowed: true, eligibleRoles: ['PRIMARY'] }));
    survivors.push(
      createCandidateResult({
        candidate: candidateId,
        materialSource: 'GENERATED_NEW',
        visualTreatment: treatment,
        modelRequirements,
        eligibleRoles: ['PRIMARY'],
        phaseScores: {
          creativeFit: scoreCreativeFit(beat, 'GENERATED_NEW', treatment),
          continuity: scoreContinuity('GENERATED_NEW', { hasIdentityOrContinuityReqs: identityOrContinuity }),
          reuse: scoreReuse('GENERATED_NEW'),
          cost: scoreCost('GENERATED_NEW', { cheapestModel }),
          complexity: scoreComplexity('GENERATED_NEW', treatment),
        },
      })
    );
  }

  survivors.sort(compareMaterialCandidates);

  if (survivors.length === 0) {
    return createMaterialResolution({
      beatId: beat.id,
      status: 'UNRESOLVED',
      hardGateResults,
      warnings,
      unresolvedRequirements: hardGateResults
        .filter((g) => !g.allowed)
        .map((g) => ({ candidate: g.candidate, rejectedBy: g.rejectedBy, reason: g.reason })),
      rationale: 'no candidate satisfied every hard requirement for this beat',
    });
  }

  const winner = survivors[0];
  const runnerUp = survivors[1];
  let decidingPhase = 'SOLE_SURVIVOR';
  if (runnerUp) {
    const differingPhase = PHASE_ORDER.find((phase) => winner.phaseScores[phase] !== runnerUp.phaseScores[phase]);
    decidingPhase = differingPhase ? PHASE_KEY_TO_DECIDING_PHASE[differingPhase] : 'CREATED_AT';
  }

  return createMaterialResolution({
    beatId: beat.id,
    status: 'RESOLVED',
    selectedMaterial: winner,
    decidingPhase,
    candidates: survivors,
    hardGateResults,
    ranking: survivors.map((c) => c.candidate),
    warnings,
    rationale: `selected ${winner.materialSource} (${winner.visualTreatment}) — decided at ${decidingPhase}`,
  });
}

// =============================================================================
// STAGE 26.4 — BEATGRAPH INTEGRATION. The only new surface this stage adds:
// resolveBeatGraph() calls the Stage 26.3 resolveMaterial() once per beat and
// aggregates the results. It does not gate, score, or rank anything itself —
// every actual decision still comes from resolveMaterial(). Read-only with
// respect to the BeatGraph (schemas/beat-graph-schema.js) exactly like
// resolveMaterial() is read-only with respect to the project's stores: beats
// are only ever iterated and sorted into a NEW array for deterministic
// presentation order, never mutated, and beatGraph.beats itself is never
// written to (see resolveBeatGraph's own comment below for the copy-before-
// sort discipline this requires).
// =============================================================================

// Counts a resolved beat's selectedMaterial into the aggregate summary.
// Material-strategy counts only, per Stage 26.4's explicit instruction —
// never a financial estimate, never a credit amount.
function tallyResolvedBeat(summary, candidate) {
  if (candidate.materialSource === 'PROJECT_ASSET_REUSE') summary.existingAssetCount += 1;
  if (candidate.materialSource === 'BROLL_LIBRARY') summary.brollCount += 1;
  if (candidate.visualTreatment === 'STILL_IMAGE') summary.stillImageCount += 1;
  if (candidate.visualTreatment === 'MOTION_GRAPHIC') summary.motionGraphicCount += 1;
  if (candidate.visualTreatment === 'WHITEBOARD') summary.whiteboardCount += 1;
  if (candidate.visualTreatment === 'KINETIC_TYPOGRAPHY') summary.kineticTypographyCount += 1;
  if (candidate.visualTreatment === 'AI_VIDEO') summary.aiVideoCount += 1;
  if (candidate.materialSource === 'GENERATED_NEW') summary.estimatedGenerationCandidates += 1;
  if (['PROJECT_ASSET_REUSE', 'BROLL_LIBRARY', 'DETERMINISTIC_TEMPLATE'].includes(candidate.materialSource)) {
    summary.zeroCostDeterministicCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Public entry point. Pure/read-only with respect to EVERY input it
// touches — BeatGraph, VisualBeat, Storyboard, Timeline IR, Keyframe Plan,
// Asset Store — exactly like resolveMaterial() already is (it never calls
// approval-gate.js or any approval store either). Never creates, mutates,
// or deletes anything; never calls a provider; never spends a credit.
//
// `context` — the SAME injectable context resolveMaterial() accepts
// (`context.brollSegments`, Stage 26.3), passed straight through to every
// beat's own resolution — one B-roll fixture set for the whole graph.
// ---------------------------------------------------------------------------
function resolveBeatGraph(projectId, beatGraph, context = {}) {
  const beatGraphId = beatGraph && beatGraph.projectId ? beatGraph.projectId : null;

  if (!beatGraph || !Array.isArray(beatGraph.beats)) {
    return createBeatGraphResolution({
      beatGraphId,
      status: 'UNRESOLVED',
      resolutions: [],
      summary: createResolutionSummary(),
    });
  }

  // Deterministic PRESENTATION order only (Stage 26.4 Part 7) — sorts a NEW
  // array, never beatGraph.beats itself, so the input BeatGraph is never
  // mutated. sequence/sceneId are read here purely to order the report;
  // resolveMaterial() below never receives or consults this ordering, so it
  // cannot influence which candidate wins for any individual beat.
  // `id` is the final tie-break specifically so presentation order stays
  // fully deterministic (Part 7) even for malformed input where `sequence`
  // isn't unique within a scene — never relying on Array.sort's stability
  // (which would silently let the INPUT array's own order leak through as
  // a de facto tie-break, exactly the "beat order influences the result"
  // failure mode this stage exists to rule out).
  const orderedBeats = [...beatGraph.beats].sort((a, b) => {
    const sceneCompare = String(a.sceneId).localeCompare(String(b.sceneId));
    if (sceneCompare !== 0) return sceneCompare;
    const sequenceCompare = (a.sequence ?? 0) - (b.sequence ?? 0);
    if (sequenceCompare !== 0) return sequenceCompare;
    return String(a.id).localeCompare(String(b.id));
  });

  const resolutions = orderedBeats.map((beat) => resolveMaterial(projectId, beat, context));

  const summary = createResolutionSummary({ totalBeats: resolutions.length });
  for (const resolution of resolutions) {
    if (resolution.status === 'RESOLVED') {
      summary.resolvedBeats += 1;
      tallyResolvedBeat(summary, resolution.selectedMaterial);
    } else {
      summary.unresolvedBeats += 1;
      summary.unresolvedReasons.push({
        beatId: resolution.beatId,
        rejectedBy: resolution.unresolvedRequirements.map((r) => r.rejectedBy),
      });
    }
  }

  const status =
    resolutions.length === 0 || summary.unresolvedBeats === 0
      ? 'RESOLVED'
      : summary.resolvedBeats === 0
        ? 'UNRESOLVED'
        : 'PARTIAL';

  return createBeatGraphResolution({ beatGraphId, status, resolutions, summary });
}

module.exports = {
  MATERIAL_SOURCES,
  TREATMENT_TO_ASSET_TYPES,
  evaluateEligibility,
  scoreCandidate,
  resolveVisualBeat,
  toTimelineShotFields,
  // Stage 26.3 extensions
  DETERMINISTIC_TREATMENTS,
  buildModelRequirements,
  scoreCreativeFit,
  scoreContinuity,
  scoreReuse,
  scoreCost,
  scoreComplexity,
  compareCandidates,
  compareMaterialCandidates,
  resolveMaterial,
  // Stage 26.4 extension
  resolveBeatGraph,
};

// ---------------------------------------------------------------------------
// DIMENSIONS CURRENTLY UNAVAILABLE (documented per this stage's explicit
// instruction, not silently omitted):
//
// - semantic / narrative relevance — no embeddings, no visual-description
//   field exists on Asset; would require a multimodal call, out of scope.
// - continuity (matching a beat's continuityRequirements against a
//   candidate) — no persisted BeatGraph store/service exists yet to look
//   up neighboring beats' own resolved assets against; continuityRequirements
//   is read and could inform a future dimension once that store exists.
// - duration compatibility — schemas/production-schema.js's Asset record
//   has no duration field at all (images have none; even a 'video' asset
//   stores no duration of its own). Not checked; not gated.
// - resolution / aspect ratio compatibility — Asset has no resolution or
//   aspectRatio field. Not checked; not gated.
// - identity compatibility for 'video' assets — a video's identity
//   lineage lives in its VideoPromptPackage's referenceLineage
//   (services/video-prompt-service.js's getVideoPromptPackage), one hop
//   further than a keyframe's own characterReferences. Deliberately not
//   walked this stage to keep the resolver's read surface narrow; a clean
//   extension point (see FUTURE EXTENSION POINTS in the Stage 26.2 report).
// - licensing — not a meaningful concept for PROJECT_ASSET_REUSE (a
//   project's own asset isn't third-party licensed material); this
//   dimension only becomes relevant once BROLL_LIBRARY exists.
// ---------------------------------------------------------------------------
