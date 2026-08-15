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

// Stage 19, Part 5 — an ADDITIVE per-item field distinguishing the
// readiness of the character/location references this keyframe depends
// on, independent of the keyframe's own generation-lifecycle `category`
// above. Deliberately not a new top-level category or priority change —
// see services/operator-queue-service.js's computeReferenceStatus().
//   NO_REFERENCE_NEEDED   — this keyframe has no character/location scope
//   MISSING                — a scoped entity has no reference asset at all
//   REVIEW_REQUIRED        — every scoped entity's references are still NONE (unreviewed candidates only)
//   AVAILABLE               — at least one scoped entity resolves to an approved (non-canonical) reference
//   CANONICAL_AVAILABLE    — every scoped entity that has a resolvable reference resolves via its CANONICAL selection
const REFERENCE_STATUSES = ['NO_REFERENCE_NEEDED', 'MISSING', 'REVIEW_REQUIRED', 'AVAILABLE', 'CANONICAL_AVAILABLE'];

// Stage 22B-Part-3, Part 17 — an ADDITIVE per-item field reporting the
// video-generation lifecycle for this keyframe, independent of the
// keyframe's own image-generation `category`/`priority` above. Exactly
// the same additive pattern as REFERENCE_STATUSES: never a new top-level
// category, never a priority change, computed only from data that already
// exists elsewhere (services/video-prompt-service.js,
// services/video-generation-approval-store.js, services/generation-
// store.js, services/timeline-store.js) — see
// services/operator-queue-service.js's computeVideoStatus().
//   NOT_APPLICABLE            — no canonical APPROVED image asset yet, so
//                                there is nothing to animate (the image
//                                pipeline itself is not COMPLETE)
//   NEEDS_VIDEO_PACKAGE       — image is COMPLETE but no CURRENT video
//                                prompt package exists yet
//   VIDEO_READY_FOR_APPROVAL  — a CURRENT video prompt package exists but
//                                no matching APPROVED generation approval
//   VIDEO_READY_FOR_GENERATION — an APPROVED approval exists and matches
//                                the current package/canonical asset/
//                                provider/model (canGenerateVideo-eligible,
//                                modulo budget)
//   VIDEO_IN_PROGRESS         — an active (REQUESTED/SUBMITTED/PROCESSING)
//                                video generation job exists
//   VIDEO_RETURNED            — a completed video asset exists that has
//                                not yet been reviewed (approvalStatus NONE)
//   VIDEO_APPROVED            — a completed video asset exists and has
//                                been APPROVED — one of the video track's
//                                two terminal states
//   VIDEO_REJECTED            — Stage 23. every video asset for this
//                                keyframe that has ever completed is
//                                REJECTED (none NONE/APPROVED/in-flight) —
//                                the video track's other terminal state.
//                                Never deletes anything: a human can still
//                                rebuild the package/re-approve/regenerate
//                                to try again, exactly like a rejected
//                                keyframe image.
const VIDEO_STATUSES = [
  'NOT_APPLICABLE',
  'NEEDS_VIDEO_PACKAGE',
  'VIDEO_READY_FOR_APPROVAL',
  'VIDEO_READY_FOR_GENERATION',
  'VIDEO_IN_PROGRESS',
  'VIDEO_RETURNED',
  'VIDEO_APPROVED',
  'VIDEO_REJECTED',
];

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

    // Stage 19, Part 5 — see REFERENCE_STATUSES above.
    referenceStatus: 'NO_REFERENCE_NEEDED',

    // Stage 22B-Part-3, Part 17 — see VIDEO_STATUSES above.
    videoStatus: 'NOT_APPLICABLE',
    videoPromptPackageId: null,
    videoPromptPackageVersion: null,
    videoPromptPackageStatus: null, // 'CURRENT' | 'STALE' | null (no video package yet)
    videoGenerationApprovalStatus: null, // 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | null
    videoAssetId: null,
    videoAssetApprovalStatus: null,

    createdAt: null,
    updatedAt: null,
  };
  return withDefaults(base, overrides);
}

module.exports = {
  QUEUE_CATEGORIES,
  QUEUE_STATUSES,
  REFERENCE_STATUSES,
  VIDEO_STATUSES,
  MIN_PRIORITY,
  MAX_PRIORITY,
  createQueueItem,
};
