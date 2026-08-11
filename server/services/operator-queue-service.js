// operator-queue-service.js
//
// Stage 14 — the OPERATOR QUEUE engine. Answers, for a human producing
// many keyframes across a project: what needs my attention, what should
// I do next, and why? It creates no new state machine, no new approval
// system, no new asset system, and no new prompt system — it only reads
// records that already exist (services/creative-store.js,
// services/keyframe-store.js, services/keyframe-prompt-service.js,
// services/keyframe-generation-approval-store.js,
// services/keyframe-handoff-service.js, services/timeline-store.js,
// services/approval-gate.js) and derives a queue item per keyframe (plus
// one per shot that has no keyframes planned yet).
//
// COMPUTE-ON-READ: nothing here is ever persisted. Every call re-derives
// the queue from the current state of those stores, so it can never go
// stale the way a cached/materialized queue could — see
// docs/architecture/operator-queue.md for the full reasoning.
//
// THIS FILE NEVER MUTATES ANYTHING. Every function below is read-only —
// no store's write path is ever called from here. It also never calls a
// provider, EvoLink, or the network; nothing in this file could spend a
// credit even in principle, because it never calls generateKeyframe,
// requestGeneration, or any handoff-mutating function.

const projectStore = require('./project-store');
const gate = require('./approval-gate');
const creativeStore = require('./creative-store');
const keyframeStore = require('./keyframe-store');
const keyframePromptService = require('./keyframe-prompt-service');
const keyframeGenerationApprovalStore = require('./keyframe-generation-approval-store');
const keyframeHandoffService = require('./keyframe-handoff-service');
const timelineStore = require('./timeline-store');
const { createQueueItem } = require('../schemas/operator-queue-schema');

// Same "in-flight" vocabulary Stage 13E's concurrency guard uses
// (services/keyframe-handoff-service.js) — reused by name, not
// reimplemented, so this file can never disagree with the store about
// what counts as an active handoff.
const ACTIVE_HANDOFF_STATUSES = ['READY', 'IN_PROGRESS'];

// ---------------------------------------------------------------------------
// Part 2/6 — the category -> (priority, status, next action) table. This is
// the ONE place that decides what a category means; buildKeyframeQueueItem
// only ever picks a category name, never invents priority/status/action
// text inline. Keeping this as one flat table (rather than scattering
// priority numbers through the category-decision logic) is what makes the
// queue's ordering rule easy to audit: same category, same priority,
// always — see docs/architecture/operator-queue.md's "Priority rules"
// section for the reasoning behind this exact ordering.
//
// Priority: 1 = highest (needs a human right now), 9 = lowest (nothing to
// do). BLOCKED sits at 1 because a human-intervention condition (today:
// only a project budget overage — Part 17) can silently stall every other
// category behind it; a returned-but-unreviewed image is next (a human
// already did their part externally and is waiting), then an approved
// candidate awaiting a canonical decision, then the approval/handoff/
// planning steps in the order a keyframe actually moves through them.
// ---------------------------------------------------------------------------
const CATEGORY_INFO = {
  BLOCKED: { priority: 1, status: 'BLOCKED', nextAction: 'Resolve blocking condition' },
  NEEDS_ASSET_REVIEW: { priority: 2, status: 'NEEDS_ATTENTION', nextAction: 'Approve or reject asset' },
  IMAGE_RETURNED: { priority: 2, status: 'NEEDS_ATTENTION', nextAction: 'Review returned image' },
  READY_FOR_CANONICAL_SELECTION: { priority: 3, status: 'NEEDS_ATTENTION', nextAction: 'Select canonical asset' },
  NEEDS_APPROVAL: { priority: 4, status: 'NEEDS_ATTENTION', nextAction: 'Approve keyframe generation' },
  READY_FOR_HANDOFF: { priority: 5, status: 'NEEDS_ATTENTION', nextAction: 'Create human handoff' },
  NEEDS_PROMPT_PACKAGE: { priority: 6, status: 'NEEDS_ATTENTION', nextAction: 'Build prompt package' },
  NEEDS_KEYFRAME_PLAN: { priority: 7, status: 'NEEDS_ATTENTION', nextAction: 'Analyze keyframes' },
  HANDOFF_IN_PROGRESS: { priority: 8, status: 'IN_PROGRESS', nextAction: 'Open handoff' },
  COMPLETE: { priority: 9, status: 'COMPLETE', nextAction: null },
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// One-pass indexing helpers — every one of these takes an array already
// fetched with ONE store call and turns it into an O(1)-lookup Map, so
// buildProjectQueue never re-reads a file per keyframe (Part 13).
// ---------------------------------------------------------------------------

function indexByKeyframeId(records) {
  const map = new Map();
  for (const record of records) {
    if (!record.keyframeId) continue;
    const list = map.get(record.keyframeId) || [];
    list.push(record);
    map.set(record.keyframeId, list);
  }
  return map;
}

function indexById(records, idField) {
  const map = new Map();
  for (const record of records) map.set(record[idField], record);
  return map;
}

// Sorting key for a scene/shot/keyframe: prefer its own `order` field
// (what a human actually arranged the storyboard/plan into); fall back to
// its id only when `order` was never set, so ordering is still fully
// deterministic even for unordered data.
function positionKey(record) {
  if (!record) return [1, ''];
  if (record.order != null) return [0, record.order];
  return [1, record.keyframeId || record.shotId || record.sceneId || ''];
}

function comparePosition(a, b) {
  const [aTier, aKey] = positionKey(a);
  const [bTier, bKey] = positionKey(b);
  if (aTier !== bTier) return aTier - bTier;
  if (typeof aKey === 'number' && typeof bKey === 'number') return aKey - bKey;
  return String(aKey).localeCompare(String(bKey));
}

// Picks the single most relevant handoff for a keyframe: the ACTIVE one if
// there is one (Stage 13E guarantees at most one), otherwise the most
// recently created historical one, so a keyframe with no active handoff
// but a past INGESTED/CANCELLED attempt still reports its last outcome.
function mostRelevantHandoff(handoffsForKeyframe) {
  if (!handoffsForKeyframe || handoffsForKeyframe.length === 0) return null;
  const active = handoffsForKeyframe.find((h) => ACTIVE_HANDOFF_STATUSES.includes(h.status));
  if (active) return active;
  return [...handoffsForKeyframe].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
}

function resolveEntityName(map, id) {
  if (!id) return null;
  const entity = map.get(id);
  return entity ? entity.name : null;
}

// ---------------------------------------------------------------------------
// Part 2/6/14/15/16/17 — the category decision. Evaluated top-to-bottom;
// the first matching condition wins. See docs/architecture/operator-
// queue.md for the full worked-through reasoning behind this exact order
// (in short: an unreviewed asset is the most urgent signal because a
// human already did external work and is waiting; COMPLETE is checked
// next because Part 16 states it unconditionally; then the earlier
// production steps in the order a keyframe actually moves through them).
// ---------------------------------------------------------------------------
function decideCategory({ pkg, approval, activeHandoff, canonicalAsset, unreviewedAsset, approvedAssets, budgetBlocked, budgetBlockedReason }) {
  if (unreviewedAsset) {
    // Part 16: an INGESTED handoff's asset needs review. Part 2 also
    // names IMAGE_RETURNED for the same underlying signal — this file
    // resolves the two by PROVENANCE: an asset that came back through a
    // human handoff is NEEDS_ASSET_REVIEW (Part 16's literal instruction);
    // one that came back through the Stage 13B/13C generation path
    // (asset.generationId set, no handoffId) is IMAGE_RETURNED. Both are
    // priority 2 — see CATEGORY_INFO — so this choice never affects
    // ordering, only which exact category name is reported.
    const category = unreviewedAsset.handoffId ? 'NEEDS_ASSET_REVIEW' : 'IMAGE_RETURNED';
    return { category, blockingReason: 'Returned asset has not been reviewed.' };
  }

  if (canonicalAsset && canonicalAsset.approvalStatus === 'APPROVED') {
    // Part 16, stated unconditionally: a canonical APPROVED asset means
    // this keyframe is COMPLETE, full stop — even if some other, newer
    // handoff is separately in progress (see decideCategory's docstring
    // above; that in-progress attempt still surfaces on ITS OWN, via
    // `unreviewedAsset` once it's ingested, or `activeHandoff` for a
    // different keyframe's own item — never by un-completing this one).
    return { category: 'COMPLETE', blockingReason: null };
  }

  if (approvedAssets.length > 0) {
    return { category: 'READY_FOR_CANONICAL_SELECTION', blockingReason: 'Canonical asset has not been selected.' };
  }

  if (activeHandoff) {
    return { category: 'HANDOFF_IN_PROGRESS', blockingReason: 'An active handoff already exists.' };
  }

  const packageIsCurrentAndApprovalMatches =
    pkg &&
    pkg.status === 'CURRENT' &&
    approval &&
    approval.status === 'APPROVED' &&
    approval.promptPackageId === pkg.packageId &&
    approval.promptPackageVersion === pkg.version;

  if (packageIsCurrentAndApprovalMatches) {
    if (budgetBlocked) {
      // Part 17 — budget-blocked is surfaced ONLY for categories that
      // represent committing to the next production step (about to
      // create a handoff or act on an approval); it never touches a
      // category that requires no spend at all (planning, review,
      // canonical selection). See docs/architecture/operator-queue.md.
      return { category: 'BLOCKED', blockingReason: budgetBlockedReason };
    }
    return { category: 'READY_FOR_HANDOFF', blockingReason: null };
  }

  if (pkg && pkg.status === 'CURRENT') {
    if (budgetBlocked) {
      return { category: 'BLOCKED', blockingReason: budgetBlockedReason };
    }
    let reason = 'Keyframe generation approval is missing.';
    if (approval && approval.status === 'PENDING') reason = 'Keyframe generation approval is pending a decision.';
    else if (approval && approval.status === 'REJECTED') reason = 'Keyframe generation approval was rejected.';
    else if (approval && approval.status === 'APPROVED') reason = 'Keyframe generation approval does not match the current prompt package version.';
    return { category: 'NEEDS_APPROVAL', blockingReason: reason };
  }

  return {
    category: 'NEEDS_PROMPT_PACKAGE',
    blockingReason: pkg ? 'Prompt package is stale.' : 'Keyframe has no current prompt package.',
  };
}

function buildKeyframeQueueItem({ project, keyframe, scene, shot, pkg, approval, handoffsForKeyframe, assetsForKeyframe, characterById, locationById, assetById, budgetBlocked, budgetBlockedReason }) {
  const activeHandoff = handoffsForKeyframe.find((h) => ACTIVE_HANDOFF_STATUSES.includes(h.status)) || null;
  const relevantHandoff = mostRelevantHandoff(handoffsForKeyframe);

  const canonicalAsset = keyframe.canonicalAssetId ? assetsForKeyframe.find((a) => a.assetId === keyframe.canonicalAssetId) || null : null;
  const unreviewedAsset = assetsForKeyframe.find((a) => a.approvalStatus === 'NONE') || null;
  const approvedAssets = assetsForKeyframe.filter((a) => a.approvalStatus === 'APPROVED');

  const { category, blockingReason } = decideCategory({
    pkg,
    approval,
    activeHandoff,
    canonicalAsset,
    unreviewedAsset,
    approvedAssets,
    budgetBlocked,
    budgetBlockedReason,
  });

  const info = CATEGORY_INFO[category];

  // Part 1's `updatedAt` — the most recent moment ANYTHING about this
  // keyframe's production state changed, computed (never stored) from
  // whichever of these records exists. `createdAt` uses the prompt
  // package's own generation time as the earliest known production
  // signal — the keyframe record itself carries no timestamp of its own
  // (see schemas/keyframe-schema.js), so a keyframe with no package yet
  // honestly reports createdAt: null rather than inventing one.
  const timestamps = [
    pkg ? pkg.updatedAt : null,
    approval ? approval.decidedAt || approval.requestedAt : null,
    relevantHandoff ? relevantHandoff.updatedAt : null,
    ...assetsForKeyframe.map((a) => a.createdAt),
  ].filter(Boolean);
  const updatedAt = timestamps.length ? timestamps.sort().at(-1) : null;

  return createQueueItem({
    queueItemId: keyframe.keyframeId,
    projectId: project.id,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,

    priority: info.priority,
    category,
    status: info.status,
    blockingReason,
    nextAction: info.nextAction,

    sceneName: scene ? scene.title || scene.sceneId : null,
    shotName: shot ? shot.purpose || shot.shotId : null,
    character: resolveEntityName(characterById, keyframe.characterReferences ? keyframe.characterReferences[0] : null),
    location: resolveEntityName(locationById, keyframe.locationReferences ? keyframe.locationReferences[0] : null),

    keyframeType: keyframe.frameType,

    promptPackageId: pkg ? pkg.packageId : null,
    promptPackageVersion: pkg ? pkg.version : null,
    promptPackageStatus: pkg ? pkg.status : null,

    skillId: (pkg && pkg.recommendedSkill) || keyframe.recommendedSkill || null,

    referenceCount: pkg ? (pkg.existingReferenceAssets || []).length : 0,
    approvedReferenceCount: pkg
      ? (pkg.existingReferenceAssets || []).filter((ref) => {
          const asset = assetById.get(ref.assetId);
          return asset && asset.approvalStatus === 'APPROVED';
        }).length
      : 0,

    handoffId: relevantHandoff ? relevantHandoff.handoffId : null,
    handoffStatus: relevantHandoff ? relevantHandoff.status : null,
    handoffPromptPackageVersion: relevantHandoff ? relevantHandoff.promptPackageVersion : null,

    assetCount: assetsForKeyframe.length,
    approvedAssetCount: approvedAssets.length,
    canonicalAssetId: keyframe.canonicalAssetId || null,
    canonicalAssetApprovalStatus: canonicalAsset ? canonicalAsset.approvalStatus : null,

    createdAt: pkg ? pkg.generatedAt : null,
    updatedAt,
  });
}

// Part 2 — a shot with NO keyframes planned yet. keyframeId stays null;
// the concrete next action is the same analyze_shot_keyframes read-only
// tool the Keyframe Plan workspace already uses (services/keyframe-
// planner.js) — this file never calls it, only points at it.
function buildShotPlaceholderItem({ project, scene, shot }) {
  const info = CATEGORY_INFO.NEEDS_KEYFRAME_PLAN;
  return createQueueItem({
    queueItemId: shot.shotId,
    projectId: project.id,
    sceneId: shot.sceneId,
    shotId: shot.shotId,
    keyframeId: null,

    priority: info.priority,
    category: 'NEEDS_KEYFRAME_PLAN',
    status: info.status,
    blockingReason: 'This shot has no planned keyframes yet.',
    nextAction: info.nextAction,

    sceneName: scene ? scene.title || scene.sceneId : null,
    shotName: shot.purpose || shot.shotId,
    keyframeType: null,
    createdAt: null,
    updatedAt: null,
  });
}

// ---------------------------------------------------------------------------
// Part 3/13 — the public entry point. Exactly ONE read of each underlying
// store, regardless of keyframe count (see the module doc comment and
// docs/architecture/operator-queue.md's "Scaling observations").
// ---------------------------------------------------------------------------
function buildProjectQueue(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) return null;
  gate.ensureShape(project); // never persisted — read-only shape guarantee, same as every other budget read in this codebase

  const creative = creativeStore.getCreativeRecord(projectId) || {};
  const storyboard = creative.storyboard || { scenes: [], shots: [] };
  const visualBible = creative.visualBible || { characters: [], locations: [] };

  const keyframes = keyframeStore.listKeyframes(projectId) || [];
  const packages = keyframePromptService.listKeyframePromptPackages(projectId) || [];
  const approvalsByKeyframe = keyframeGenerationApprovalStore.listApprovals(projectId) || {};
  const handoffs = keyframeHandoffService.listHandoffs(projectId) || [];
  const assets = timelineStore.listAssets(projectId) || [];

  const packageByKeyframe = indexById(packages, 'keyframeId');
  const handoffsByKeyframe = indexByKeyframeId(handoffs);
  const assetsByKeyframe = indexByKeyframeId(assets);
  const assetById = indexById(assets, 'assetId');
  const characterById = indexById(visualBible.characters || [], 'characterId');
  const locationById = indexById(visualBible.locations || [], 'locationId');
  const sceneById = indexById(storyboard.scenes || [], 'sceneId');
  const shotById = indexById(storyboard.shots || [], 'shotId');

  const budgetBlocked = project.creditLedger.blocked;
  const budgetBlockedReason = project.creditLedger.blockedReason;

  const items = [];

  const shotsWithKeyframes = new Set(keyframes.map((k) => k.shotId));
  for (const shot of storyboard.shots || []) {
    if (!shotsWithKeyframes.has(shot.shotId)) {
      items.push(buildShotPlaceholderItem({ project, scene: sceneById.get(shot.sceneId), shot }));
    }
  }

  for (const keyframe of keyframes) {
    items.push(
      buildKeyframeQueueItem({
        project,
        keyframe,
        scene: sceneById.get(keyframe.sceneId),
        shot: shotById.get(keyframe.shotId),
        pkg: packageByKeyframe.get(keyframe.keyframeId) || null,
        approval: approvalsByKeyframe[keyframe.keyframeId] || null,
        handoffsForKeyframe: handoffsByKeyframe.get(keyframe.keyframeId) || [],
        assetsForKeyframe: assetsByKeyframe.get(keyframe.keyframeId) || [],
        characterById,
        locationById,
        assetById,
        budgetBlocked,
        budgetBlockedReason,
      })
    );
  }

  // Part 4 — deterministic ordering: priority first (what needs a human
  // most urgently), then scene/shot/keyframe position (Part 9's "sort by
  // Scene, Shot"). Same project state always produces this same order.
  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const sceneCompare = comparePosition(sceneById.get(a.sceneId), sceneById.get(b.sceneId));
    if (sceneCompare !== 0) return sceneCompare;
    const shotCompare = comparePosition(shotById.get(a.shotId), shotById.get(b.shotId));
    if (shotCompare !== 0) return shotCompare;
    return String(a.keyframeId || a.shotId).localeCompare(String(b.keyframeId || b.shotId));
  });

  return items;
}

// Part 5 — the single highest-priority actionable item, or
// { nextAction: null } if the queue is empty or everything is COMPLETE.
// Never invents work: COMPLETE items are never returned as "the next
// action" (their own nextAction is already null).
function getNextAction(projectId) {
  const items = buildProjectQueue(projectId);
  if (items === null) return null;

  const actionable = items.find((item) => item.category !== 'COMPLETE');
  if (!actionable) return { nextAction: null };

  return {
    queueItemId: actionable.queueItemId,
    projectId: actionable.projectId,
    sceneId: actionable.sceneId,
    shotId: actionable.shotId,
    keyframeId: actionable.keyframeId,
    sceneName: actionable.sceneName,
    shotName: actionable.shotName,
    category: actionable.category,
    nextAction: actionable.nextAction,
    blockingReason: actionable.blockingReason,
    priority: actionable.priority,
  };
}

// Part 11 — the project-level rollup. completionPercentage is computed
// ONLY from canonical + APPROVED keyframes (never "an image exists") —
// this is exactly why Stage 13E's canonical-asset work was a prerequisite
// for this stage (see the Stage 13D architecture audit).
function getQueueSummary(projectId) {
  const items = buildProjectQueue(projectId);
  if (items === null) return null;

  const keyframeItems = items.filter((item) => item.keyframeId !== null);
  const totalKeyframes = keyframeItems.length;
  const complete = keyframeItems.filter((item) => item.category === 'COMPLETE').length;
  const needsAttention = items.filter((item) => item.status === 'NEEDS_ATTENTION').length;
  const blocked = items.filter((item) => item.status === 'BLOCKED').length;
  const inProgress = items.filter((item) => item.status === 'IN_PROGRESS').length;
  const needsApproval = items.filter((item) => item.category === 'NEEDS_APPROVAL').length;
  const readyForHandoff = items.filter((item) => item.category === 'READY_FOR_HANDOFF').length;
  const assetsAwaitingReview = items.filter((item) => item.category === 'NEEDS_ASSET_REVIEW' || item.category === 'IMAGE_RETURNED').length;

  return {
    totalKeyframes,
    complete,
    needsAttention,
    blocked,
    inProgress,
    needsApproval,
    readyForHandoff,
    assetsAwaitingReview,
    completionPercentage: totalKeyframes > 0 ? round2((complete / totalKeyframes) * 100) : 0,
  };
}

// Part 12 — read-only shot-level readiness. Reuses the exact same
// per-keyframe COMPLETE determination buildProjectQueue already computed
// — never a second definition of "complete." Never starts, prepares, or
// even references video generation; `readyForVideo` is only ever read by
// a human deciding whether to move on, not acted on by this file.
function getShotReadiness(projectId) {
  const items = buildProjectQueue(projectId);
  if (items === null) return null;

  const byShot = new Map();
  for (const item of items) {
    if (!item.shotId) continue;
    const list = byShot.get(item.shotId) || [];
    list.push(item);
    byShot.set(item.shotId, list);
  }

  const result = [];
  for (const [shotId, shotItems] of byShot.entries()) {
    const keyframeItems = shotItems.filter((item) => item.keyframeId !== null);
    const keyframesRequired = keyframeItems.length;
    const keyframesComplete = keyframeItems.filter((item) => item.category === 'COMPLETE').length;
    result.push({
      shotId,
      sceneId: shotItems[0].sceneId,
      keyframesRequired,
      keyframesComplete,
      keyframesMissing: keyframesRequired - keyframesComplete,
      readyForVideo: keyframesRequired > 0 && keyframesComplete === keyframesRequired,
    });
  }
  return result;
}

module.exports = {
  CATEGORY_INFO,
  buildProjectQueue,
  getNextAction,
  getQueueSummary,
  getShotReadiness,
};
