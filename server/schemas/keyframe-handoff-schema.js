// keyframe-handoff-schema.js
//
// Stage 13D, Part 1 — the EXECUTION HANDOFF record. Stage 13C found that
// none of the installed image skills (banana-pro-director-2.0, cinema-
// worldbuilder-pro-2.0) can be executed programmatically — the real
// execution step is a HUMAN, operating Higgsfield's own UI. A handoff is
// the frozen, persistent instruction package that hands that human
// everything they need (the prompt, the references, which skill to
// follow) and records what came back. It never generates anything
// itself — see services/keyframe-handoff-service.js.
//
// Same rules as every other schema in this project: plain object factory
// only, no I/O, no provider knowledge, every field defaults to null/[] so
// partial data is always valid, nothing here invents information.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Part 1 says "suggested statuses" include RETURNED, but also "do not
// add statuses unless the workflow actually requires them." The actual
// ingestion endpoint this stage builds (Part 6,
// POST /handoffs/:handoffId/asset) is ATOMIC — one request both receives
// the image bytes AND archives them — so there is never a real moment
// where a handoff sits in a "the human came back with a file, but it
// isn't ingested yet" state distinct from INGESTED itself. RETURNED is
// therefore deliberately omitted: nothing in this stage's concrete
// workflow would ever set or read it.
const HANDOFF_STATUSES = ['READY', 'IN_PROGRESS', 'INGESTED', 'CANCELLED'];

function createKeyframeHandoff(overrides = {}) {
  const base = {
    handoffId: crypto.randomUUID(),
    projectId: null,
    keyframeId: null,
    shotId: null,
    sceneId: null,

    // Part 2 — frozen at creation time. Never re-resolved from a later
    // (possibly rebuilt) prompt package, even if one exists by the time
    // this handoff is read again.
    promptPackageId: null,
    promptPackageVersion: null,
    skillId: null,
    skillName: null,

    status: 'READY',
    createdAt: new Date().toISOString(),
    createdBy: null,

    // Part 3 — the frozen instruction content, captured once at creation.
    instructions: null,
    requiredReferences: [],
    optionalReferences: [],
    outputRequirements: null,
    returnInstructions: null,

    // Part 6 — filled in only once an image is actually ingested.
    completedAt: null,
    completedBy: null,
    assetId: null,

    notes: null,

    // Lightweight versioning, same pattern as every other store in this
    // project (creative-store.js, keyframe-store.js, ...).
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    changeNote: null,
    history: [],
  };
  return withDefaults(base, overrides);
}

module.exports = {
  HANDOFF_STATUSES,
  createKeyframeHandoff,
};
