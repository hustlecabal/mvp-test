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

module.exports = {
  MATERIAL_SOURCES,
  TREATMENT_TO_ASSET_TYPES,
  evaluateEligibility,
  scoreCandidate,
  resolveVisualBeat,
  toTimelineShotFields,
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
