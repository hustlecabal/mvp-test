// operator-queue-schema.js
//
// Stage 14 — the OPERATOR QUEUE. Defines the shape of one queue item: a
// computed summary of everything an operator needs to decide what to do
// next for one keyframe (or, for a shot with no keyframes planned yet,
// what to do next for that shot), WITHOUT opening several unrelated
// records first.
//
// Same rules as every other schema in this project: a plain object
// factory, no I/O, no provider knowledge, every field defaults to
// null/[] so partial data is always valid. Unlike every other schema
// here, a queue item is NEVER persisted — services/operator-queue-
// service.js computes it fresh on every read from the records those
// other schemas already define (creative-schema.js, keyframe-schema.js,
// keyframe-prompt-schema.js, keyframe-generation-approval-schema.js,
// keyframe-handoff-schema.js, production-schema.js's Asset). This file
// only describes the SHAPE of that computed summary — see
// docs/architecture/operator-queue.md for why compute-on-read was
// chosen over persisting the queue.

// Part 2 — the full category vocabulary, and nothing else. Every
// category maps to exactly one concrete next action (see
// services/operator-queue-service.js's CATEGORY_ACTIONS) — no category
// exists here that doesn't correspond to a real operator action.
const QUEUE_CATEGORIES = [
  'NEEDS_KEYFRAME_PLAN',
  'NEEDS_PROMPT_PACKAGE',
  'NEEDS_APPROVAL',
  'READY_FOR_HANDOFF',
  'HANDOFF_IN_PROGRESS',
  'IMAGE_RETURNED',
  'NEEDS_ASSET_REVIEW',
  'READY_FOR_CANONICAL_SELECTION',
  'COMPLETE',
  'BLOCKED',
];

// Part 9's UI filter set: ALL / NEEDS ATTENTION / BLOCKED / IN PROGRESS /
// COMPLETE. `status` is a coarser grouping DERIVED from `category` (see
// operator-queue-service.js's STATUS_FOR_CATEGORY) — it exists so the
// frontend can filter without knowing every category's meaning.
const QUEUE_STATUSES = ['NEEDS_ATTENTION', 'BLOCKED', 'IN_PROGRESS', 'COMPLETE'];

// Part 4 — 1 (highest) through 9 (lowest). Deliberately a plain integer,
// not its own enum: priority is a computed ordering key, not a state.
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 9;

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Part 1 — one queue item. `queueItemId` is deliberately the keyframeId
// itself (or, for a NEEDS_KEYFRAME_PLAN placeholder representing a shot
// with no keyframes yet, the shotId) — NOT a freshly generated random id.
// The queue is compute-on-read (Part 3): recomputing it for the same
// project state must produce the same items with the same ids, so a
// frontend can safely re-fetch and diff. A random id per computation
// would defeat that.
function createQueueItem(overrides = {}) {
  const base = {
    queueItemId: null,
    projectId: null,
    sceneId: null,
    shotId: null,
    keyframeId: null, // null only for a NEEDS_KEYFRAME_PLAN shot-level item

    priority: MAX_PRIORITY,
    category: null,
    status: null,
    blockingReason: null,
    nextAction: null,

    // Display convenience only — resolved NAMES/short labels, never the
    // full Scene/Shot/Character/Location record (Part 1: "do not
    // duplicate large creative artifacts").
    sceneName: null,
    shotName: null,
    character: null,
    location: null,

    keyframeType: null,

    promptPackageId: null,
    promptPackageVersion: null, // the LIVE package's current version (or null — no package built yet)
    promptPackageStatus: null, // 'CURRENT' | 'STALE' | null (no package yet)

    skillId: null,

    referenceCount: 0,
    approvedReferenceCount: 0,

    handoffId: null,
    handoffStatus: null,
    handoffPromptPackageVersion: null, // Part 14 — the version the handoff itself is frozen to

    assetCount: 0,
    approvedAssetCount: 0,
    canonicalAssetId: null,
    canonicalAssetApprovalStatus: null,

    createdAt: null,
    updatedAt: null,
  };
  return withDefaults(base, overrides);
}

module.exports = {
  QUEUE_CATEGORIES,
  QUEUE_STATUSES,
  MIN_PRIORITY,
  MAX_PRIORITY,
  createQueueItem,
};
