// keyframe-execution-result-schema.js
//
// Stage 13C, Part 5 — the normalized KeyframeExecutionResult contract:
// what comes back from ANY keyframe execution path (today, only the
// local fixture path — see services/keyframe-execution-bridge-service.js
// and docs/architecture/keyframe-execution-bridge.md), whether that path
// is a real provider, a real human running a skill's prompt in an
// external UI, or a local fixture proving the pipeline. Same rules as
// every other schema in this project: plain object factory only, no I/O,
// no provider knowledge, every field defaults to null so partial data is
// always valid, and nothing here invents a value (a URL, a cost, a
// provider name) that its source didn't actually provide.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// BLOCKED — a safety check (approval/stale/budget/etc.) failed; nothing
//   was ever attempted.
// IN_PROGRESS — an identical execution was already in flight and this
//   result is a snapshot of it (Stage 13B's duplicate-protection path).
// COMPLETED — execution produced an artifact.
// FAILED — execution was attempted but did not produce an artifact.
const EXECUTION_STATUSES = ['BLOCKED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'];

function createKeyframeExecutionResult(overrides = {}) {
  const base = {
    executionId: crypto.randomUUID(),
    keyframeId: null,
    packageId: null,
    packageVersion: null,
    status: 'BLOCKED',
    provider: null,
    model: null,
    skillId: null,
    artifactType: null,
    artifactPath: null,
    artifactUrl: null,
    metadata: {},
    warnings: [],
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  EXECUTION_STATUSES,
  createKeyframeExecutionResult,
};
