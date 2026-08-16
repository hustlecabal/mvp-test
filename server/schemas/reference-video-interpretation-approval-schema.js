// reference-video-interpretation-approval-schema.js
//
// INT-1D, Part 18 — INTERPRETATION_APPROVAL. Mirrors schemas/keyframe-
// generation-approval-schema.js's exact shape/spirit (Part 17's "reuse an
// existing abstraction" instruction, applied here): deliberately NOT the
// same object as a project's own `approvals` (services/approval-gate.js)
// — approving a project for image/video generation is not authorization
// to spend on an LLM interpretation call. Scoped to one (referenceVideo,
// question) pair, never a whole project.

const INTERPRETATION_APPROVAL_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function createInterpretationApproval(overrides = {}) {
  const base = {
    projectId: null,
    referenceVideoId: null,
    questionId: null,
    status: 'NONE',
    estimatedCost: null, // USD, from reference-video-interpretation-model-registry.js's estimateCostUsd(); null means unknown, never free
    reason: null,
    requestedBy: null,
    requestedAt: null,
    approvedBy: null,
    approvedAt: null,
    decidedAt: null,
    // Same UNKNOWN_COST_POLICY concept as approval-gate.js's own approvals
    // object, scoped to this interpretation call only.
    unknownCostAcknowledged: false,
    unknownCostAcknowledgedBy: null,
    unknownCostAcknowledgedAt: null,
  };
  return withDefaults(base, overrides);
}

module.exports = { INTERPRETATION_APPROVAL_STATUSES, createInterpretationApproval };
