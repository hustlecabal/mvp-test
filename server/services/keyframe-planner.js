// keyframe-planner.js
//
// Stage 12 — deterministic keyframe requirement analysis. Given a single
// storyboard shot, works out which visual reference frames (Part 2's
// FRAME_TYPES) it plausibly needs, whether an existing APPROVED asset
// already satisfies that need, and whether a keyframe has already been
// planned for it. Every rule below is a plain structural/keyword check —
// no LLM call, no fuzzy matching, nothing non-deterministic.
//
// THIS FILE NEVER CALLS A PROVIDER, NEVER CREATES A GENERATION JOB, AND
// NEVER SPENDS A CREDIT. It has no import of, or path to, providers/
// evolink/*, services/generation-service.js, or services/approval-gate.js.
// It only reads creative-planning data (services/creative-store.js) and
// production Timeline IR assets (services/timeline-store.js, read-only —
// asset.approvalStatus is only ever READ here, never written) to recommend
// what a human might want to plan next. See
// docs/architecture/keyframe-intelligence.md.

const creativeStore = require('./creative-store');
const timelineStore = require('./timeline-store');
const keyframeStore = require('./keyframe-store');
const skillRegistry = require('./skill-registry');

// Part 10 — action/movement keyword vocabularies. Plain, readable regexes;
// no attempt to be exhaustive or clever, matched case-insensitively against
// a shot's own `action`/`movement` text.
// \w* (no trailing \b) so inflected forms match too ("walks", "running",
// "fighting") — the leading \b still stops these from matching inside an
// unrelated longer word (e.g. "run" inside "brunch").
const ACTION_KEYWORDS =
  /\b(fight|battle|strike|jump|leap|fall|throw|struggle|charge|collide|explode|grapple|clash|attack|punch|kick|duel|combat)\w*/i;

const MOVEMENT_KEYWORDS =
  /\b(walk|run|move|travel|approach|cross|climb|enter|exit|chase|ascend|descend|arrive|journey|flee|advance|retreat)\w*/i;

// Part 6 — transitions that don't imply a dedicated bridging frame.
const TRIVIAL_TRANSITIONS = new Set(['', 'cut', 'none', 'hard cut']);

// Part 12 — static, deterministic skill-recommendation lookup, one entry
// per frame type. Reasons are drawn from the audited skills' own
// documented grammar (services/skill-registry.js), not invented.
const SKILL_BY_FRAME_TYPE = {
  CHARACTER_REFERENCE: {
    skillId: 'banana-pro-director-2.0',
    reason: 'Character identity/face-lock reference image (Mode 0).',
  },
  WORLD_REFERENCE: {
    skillId: 'banana-pro-director-2.0',
    reason: 'Environment/world reference plate (Mode 3).',
  },
  ESTABLISHING_FRAME: {
    skillId: 'cinema-worldbuilder-pro-2.0',
    reason: 'Scene-opening establishing shot (Frame Map grammar).',
  },
  COMPOSITION_FRAME: {
    skillId: 'cinema-worldbuilder-pro-2.0',
    reason: 'Character-and-location composition frame (Subject Lock grammar).',
  },
  ACTION_FRAME: {
    skillId: 'cinema-worldbuilder-pro-2.0',
    reason: 'Mid-action frame (M3 Action grammar).',
  },
  FIRST_FRAME: {
    skillId: 'cinema-worldbuilder-pro-2.0',
    reason: 'Start-of-movement frame (First/Last Frame grammar).',
  },
  LAST_FRAME: {
    skillId: 'cinema-worldbuilder-pro-2.0',
    reason: 'End-of-movement frame (First/Last Frame grammar).',
  },
  TRANSITION_FRAME: {
    skillId: 'cinema-worldbuilder-pro-2.0',
    reason: 'Cross-shot bridging frame (Cross-Frame Rules grammar).',
  },
  DETAIL_FRAME: {
    skillId: 'banana-pro-director-2.0',
    reason: 'Prop/detail close-up reference (Mode 3 detail shots).',
  },
};

function skillRecommendationFor(frameType) {
  const entry = SKILL_BY_FRAME_TYPE[frameType];
  if (!entry) return { recommendedSkill: null, recommendationReason: null, skillExecutable: false, skillStatus: 'no recommendation' };
  const skill = skillRegistry.getSkill(entry.skillId);
  return {
    recommendedSkill: entry.skillId,
    recommendationReason: entry.reason,
    skillExecutable: Boolean(skill && skill.adapter),
    skillStatus: skill && skill.adapter ? 'adapter available' : 'future keyframe/reference-image stage',
  };
}

function recommendationEntry(frameType, extra = {}) {
  return { frameType, purpose: null, subject: null, characterId: null, locationId: null, ...skillRecommendationFor(frameType), ...extra };
}

// Part 7 — is this entity's requirement already satisfied by an existing
// APPROVED asset? Reuses the referenceAssets array Stage 11A already put
// on Character/Location records, and Stage 9B's asset.approvalStatus.
function approvedReferenceAsset(entity) {
  if (!entity || !Array.isArray(entity.referenceAssets)) return null;
  for (const assetId of entity.referenceAssets) {
    const found = timelineStore.findAssetById(assetId);
    if (found && found.asset.approvalStatus === 'APPROVED') {
      return found.asset;
    }
  }
  return null;
}

// Finds an existing keyframe (any status, including REJECTED — a human's
// prior decision is respected, not re-recommended) among `pool` whose
// `entityField` array already references `entityId`.
function findExistingForEntity(pool, entityField, entityId) {
  return pool.find((k) => Array.isArray(k[entityField]) && k[entityField].includes(entityId));
}

function isFirstShotInScene(storyboard, shot) {
  const sceneShots = storyboard.shots
    .map((s, index) => ({ s, index }))
    .filter((entry) => entry.s.sceneId === shot.sceneId);
  sceneShots.sort((a, b) => {
    const ao = a.s.order == null ? Infinity : a.s.order;
    const bo = b.s.order == null ? Infinity : b.s.order;
    if (ao !== bo) return ao - bo;
    return a.index - b.index;
  });
  return sceneShots.length > 0 && sceneShots[0].s.shotId === shot.shotId;
}

// Part 6/8/9/10 — the main analysis. Returns null if the project, its
// storyboard, or the shot itself doesn't exist. Never writes anything —
// every keyframe-store.js call here is a read (listKeyframes).
function analyzeShotKeyframes(projectId, shotId) {
  const storyboard = creativeStore.getStoryboard(projectId);
  if (!storyboard) return null;

  const shot = storyboard.shots.find((s) => s.shotId === shotId);
  if (!shot) return null;

  const visualBible = creativeStore.getVisualBible(projectId) || { characters: [], locations: [] };
  const characters = visualBible.characters || [];
  const locations = visualBible.locations || [];

  const recommendations = [];
  const reused = [];
  const existing = [];

  function considerEntityFrame(frameType, entityIdField, entityId, entity, subjectLabel) {
    const existingPool = keyframeStore.listKeyframes(projectId, { shotId, frameType }) || [];
    const existingKeyframe = findExistingForEntity(existingPool, entityIdField, entityId);
    if (existingKeyframe) {
      existing.push({
        frameType,
        [entityIdField.replace('References', 'Id')]: entityId,
        subject: subjectLabel,
        keyframeId: existingKeyframe.keyframeId,
        status: existingKeyframe.status,
        reason: `A ${frameType} keyframe already exists for this shot and entity.`,
      });
      return;
    }

    const approvedAsset = approvedReferenceAsset(entity);
    if (approvedAsset) {
      reused.push({
        frameType,
        [entityIdField.replace('References', 'Id')]: entityId,
        subject: subjectLabel,
        assetId: approvedAsset.assetId,
        reason: 'Satisfied by an existing APPROVED reference asset — no new keyframe needed.',
      });
      return;
    }

    recommendations.push(
      recommendationEntry(frameType, {
        purpose: `Establish a locked reference for "${subjectLabel || entityId}".`,
        subject: subjectLabel,
        [entityIdField.replace('References', 'Id')]: entityId,
      })
    );
  }

  // Part 8 — CHARACTER_REFERENCE, one candidate per character on this shot.
  for (const characterId of shot.characterReferences || []) {
    const character = characters.find((c) => c.characterId === characterId) || null;
    considerEntityFrame('CHARACTER_REFERENCE', 'characterReferences', characterId, character, character ? character.name : null);
  }

  // Part 9 — WORLD_REFERENCE, one candidate per location on this shot.
  for (const locationId of shot.locationReferences || []) {
    const location = locations.find((l) => l.locationId === locationId) || null;
    considerEntityFrame('WORLD_REFERENCE', 'locationReferences', locationId, location, location ? location.name : null);
  }

  // Shot-scoped (non-entity) frame types: each is either "already planned"
  // (existing) or "net-new recommendation" — there's no per-entity asset
  // reuse check for these, since they aren't tied to a single Visual Bible
  // entity.
  function considerShotFrame(frameType, purpose) {
    const existingPool = keyframeStore.listKeyframes(projectId, { shotId, frameType }) || [];
    if (existingPool.length > 0) {
      existing.push({
        frameType,
        keyframeId: existingPool[0].keyframeId,
        status: existingPool[0].status,
        reason: `A ${frameType} keyframe already exists for this shot.`,
      });
      return;
    }
    recommendations.push(recommendationEntry(frameType, { purpose }));
  }

  if (isFirstShotInScene(storyboard, shot)) {
    considerShotFrame('ESTABLISHING_FRAME', 'First shot of its scene — establish the setting before the action begins.');
  }

  if ((shot.characterReferences || []).length > 0 && (shot.locationReferences || []).length > 0) {
    considerShotFrame('COMPOSITION_FRAME', 'Shot combines characters and a location — lock their spatial composition.');
  }

  if (shot.action && ACTION_KEYWORDS.test(shot.action)) {
    considerShotFrame('ACTION_FRAME', `Shot action ("${shot.action}") implies a mid-action beat worth locking visually.`);
  }

  const movementText = [shot.movement, shot.action].filter(Boolean).join(' ');
  if (movementText && MOVEMENT_KEYWORDS.test(movementText)) {
    considerShotFrame('FIRST_FRAME', `Start of movement: ${movementText}.`);
    considerShotFrame('LAST_FRAME', `End of movement: ${movementText} — destination/end state reached.`);
  }

  if (shot.transition && !TRIVIAL_TRANSITIONS.has(shot.transition.trim().toLowerCase())) {
    considerShotFrame('TRANSITION_FRAME', `Shot has a non-trivial transition ("${shot.transition}") that may need a bridging frame.`);
  }

  if ((shot.propReferences || []).length > 0) {
    considerShotFrame('DETAIL_FRAME', 'Shot references one or more props — a detail close-up may be worth locking.');
  }

  return {
    projectId,
    sceneId: shot.sceneId,
    shotId,
    sourceShotVersion: storyboard.version,
    recommendations,
    reused,
    existing,
    summary: {
      totalRequired: recommendations.length + reused.length + existing.length,
      reusable: reused.length,
      newRecommended: recommendations.length,
      alreadyPlanned: existing.length,
    },
  };
}

module.exports = { analyzeShotKeyframes };
