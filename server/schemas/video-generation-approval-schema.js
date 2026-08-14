// video-generation-approval-schema.js
//
// Stage 22B-Part-3 — VIDEO_GENERATION_APPROVAL. Mirrors
// schemas/keyframe-generation-approval-schema.js's shape and spirit
// (status enum, the Stage 8.1 "unknown cost requires explicit
// acknowledgement" fields) but is bound to the video-specific inputs a
// VideoPromptPackage carries: not just a prompt package version, but also
// the exact canonical keyframe asset, provider, and model the human
// approved. Approving a project's video-generation batch, a storyboard, a
// keyframe plan, a keyframe prompt package, or even a keyframe generation
// approval is NOT sufficient authorization to generate a video — this is
// its own, separate, explicit approval.
//
// KNOWN QUIRK, DELIBERATELY NOT REPEATED HERE: keyframe-generation-
// approval-store.js's decideApproval() never sets `approvedAt` — only
// `decidedAt` and `approvedBy` are ever written, so `approvedAt` stays
// null forever on every keyframe generation approval that has ever
// existed. That is established behavior for that store and is left
// exactly as-is (changing it would be an unrelated, silent semantics
// change to a different subsystem). This NEW store is not bound by that
// precedent: its own decideApproval() DOES set `approvedAt` on approval,
// so a caller of THIS store can rely on it.
//
// STALENESS BINDING (Part 3): an approval only ever authorizes generating
// the EXACT combination it was granted for. It binds to
// videoPromptPackageId + videoPromptPackageVersion + canonicalKeyframeAssetId
// + provider + model all at once — if the live package rebuilds to a new
// version, the canonical keyframe asset changes, or a different
// provider/model is requested, the approval no longer matches and
// services/video-generation-service.js's canGenerateVideo() refuses to
// treat it as authorization (see that file's binding checks, steps 7-13).

const VIDEO_GENERATION_APPROVAL_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function createVideoGenerationApproval(overrides = {}) {
  const base = {
    projectId: null,
    sceneId: null,
    shotId: null,
    keyframeId: null,

    // Part 3 — the exact binding. All five must still match at generation
    // time for this approval to authorize anything.
    videoPromptPackageId: null,
    videoPromptPackageVersion: null,
    canonicalKeyframeAssetId: null,
    provider: null,
    model: null,

    // Part 3 — recorded for traceability, never re-validated against the
    // model registry by this schema itself (that's the service's job at
    // build/generate time) — this is a snapshot of what was true when the
    // approval was requested.
    executionParameters: null,

    status: 'NONE',
    estimatedCost: null,
    reason: null,

    requestedBy: null,
    requestedAt: null,
    approvedBy: null,
    approvedAt: null,
    decidedAt: null,

    // Part 6/13 — same UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL policy as
    // approval-gate.js's own approvals object and keyframe-generation-
    // approval-schema.js, scoped to this video generation only.
    unknownCostAcknowledged: false,
    unknownCostAcknowledgedBy: null,
    unknownCostAcknowledgedAt: null,

    history: [],
  };
  return withDefaults(base, overrides);
}

module.exports = {
  VIDEO_GENERATION_APPROVAL_STATUSES,
  createVideoGenerationApproval,
};
