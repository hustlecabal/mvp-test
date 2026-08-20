// creative-brain-approval-schema.js
//
// CREATIVE BRAIN — CREATIVE_BRAIN_APPROVAL. Mirrors schemas/reference-
// video-interpretation-approval-schema.js's exact shape/spirit, scoped
// differently: ONE approval per (referenceSetId's own recommendationSetId)
// rather than per (video, question) — because at the moment a Creative
// Brain generation is requested there is no Blueprint yet to key against
// (this stage's sign-off: "CreativeBlueprint remains the canonical
// creative object — no parallel Creative Brain Output abstraction", so
// this approval is never itself the Blueprint or a stand-in for one). A
// RecommendationSet already exists and is real, so it is the natural key
// — the same "key by an already-real entity" discipline the
// interpretation approval store already established.

const CREATIVE_BRAIN_APPROVAL_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function createCreativeBrainApproval(overrides = {}) {
  const base = {
    projectId: null,
    recommendationSetId: null,
    status: 'NONE',
    estimatedCost: null, // USD, from creative-brain-model-registry.js's estimateCostUsd(); null means unknown, never free
    reason: null,
    requestedBy: null,
    requestedAt: null,
    approvedBy: null,
    approvedAt: null,
    decidedAt: null,
    unknownCostAcknowledged: false,
    unknownCostAcknowledgedBy: null,
    unknownCostAcknowledgedAt: null,
  };
  return withDefaults(base, overrides);
}

module.exports = { CREATIVE_BRAIN_APPROVAL_STATUSES, createCreativeBrainApproval };
