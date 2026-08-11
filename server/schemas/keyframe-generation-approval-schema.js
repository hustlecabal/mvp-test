// keyframe-generation-approval-schema.js
//
// Stage 13B, Part 5 — KEYFRAME_GENERATION_APPROVAL. Deliberately NOT the
// same object as a project's own `approvals` (services/approval-gate.js):
// approving a project's video-generation batch, a storyboard, a keyframe
// plan, or a prompt package is NOT sufficient authorization to actually
// generate a keyframe image. This is its own, separate, explicit approval
// that must reference exactly which prompt package version it authorizes.
//
// Same shape/spirit as approval-gate.js's defaultApprovals() (status enum,
// the Stage 8.1 "unknown cost requires explicit acknowledgement" fields),
// deliberately mirrored rather than reusing that object directly, because
// it is scoped to one keyframe + one prompt package version, not a whole
// project.

const KEYFRAME_GENERATION_APPROVAL_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function createKeyframeGenerationApproval(overrides = {}) {
  const base = {
    projectId: null,
    keyframeId: null,
    promptPackageId: null,
    promptPackageVersion: null,
    status: 'NONE',
    estimatedCost: null,
    reason: null,
    requestedBy: null,
    requestedAt: null,
    approvedBy: null,
    approvedAt: null,
    decidedAt: null,
    // Part 6 — same UNKNOWN_COST_POLICY concept as approval-gate.js's own
    // approvals object, scoped to this keyframe generation only.
    unknownCostAcknowledged: false,
    unknownCostAcknowledgedBy: null,
    unknownCostAcknowledgedAt: null,
  };
  return withDefaults(base, overrides);
}

module.exports = {
  KEYFRAME_GENERATION_APPROVAL_STATUSES,
  createKeyframeGenerationApproval,
};
