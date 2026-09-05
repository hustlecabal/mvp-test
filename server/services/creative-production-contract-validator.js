// creative-production-contract-validator.js
//
// STRUCTURAL VALIDATION for the Creative Production Contract (Sections 15,
// 16, 17 of the milestone) — deterministic, schema-provable checks only.
// This is explicitly NOT Creative QA (Section 18: identity drift, wardrobe
// drift, bad camera movement, weak audio/visual relationship, ...) — those
// require subjective judgment this file never attempts. See
// creative-qa-interface.js for that contract's formal (unimplemented) shape.
//
// Every check here is a pure function over plain objects built by
// schemas/creative-schema.js — no file I/O, no provider calls, matching
// this codebase's established schema/service separation.
//
// CONTINUITY GRAPH (Section 15): deliberately NOT a separate graph
// database. The Phase 0 audit found that every dependency this milestone
// needs to answer ("what does this shot depend on", "what does this
// generation unit inherit", "what goes stale if X changes") is already
// expressible by walking the existing stable-id references
// (characterId/locationId/propId/sceneId/shotId/generationUnitId) that
// schemas/creative-schema.js's objects already carry. deriveContinuityGraph
// below is that walk, exposed as one small, testable, pure function.

const { MAX_GENERATION_UNIT_DURATION_SECONDS, GENERATION_METHODS, CONTINUATION_STRATEGIES } = require('../schemas/creative-schema');

function diag(code, message, objectType, objectId) {
  return { code, message, objectType, objectId: objectId || null };
}

// ---------------------------------------------------------------------------
// Section 2 — the hard duration invariant.
// ---------------------------------------------------------------------------
function validateGenerationUnitDuration(unit) {
  const diagnostics = [];
  if (unit.durationSeconds === null || unit.durationSeconds === undefined) {
    return diagnostics; // not yet planned — nothing to validate yet
  }
  if (typeof unit.durationSeconds !== 'number' || unit.durationSeconds <= 0) {
    diagnostics.push(diag('INVALID_DURATION', `GenerationUnit ${unit.id} durationSeconds must be a positive number`, 'GenerationUnit', unit.id));
  } else if (unit.durationSeconds > MAX_GENERATION_UNIT_DURATION_SECONDS) {
    diagnostics.push(
      diag(
        'GENERATION_UNIT_DURATION_EXCEEDS_MAXIMUM',
        `GenerationUnit ${unit.id} is ${unit.durationSeconds}s, exceeding the hard maximum of ${MAX_GENERATION_UNIT_DURATION_SECONDS}s`,
        'GenerationUnit',
        unit.id
      )
    );
  }
  if (unit.generationMethod !== null && !GENERATION_METHODS.includes(unit.generationMethod)) {
    diagnostics.push(diag('INVALID_GENERATION_METHOD', `GenerationUnit ${unit.id} generationMethod "${unit.generationMethod}" is not one of ${GENERATION_METHODS.join(', ')}`, 'GenerationUnit', unit.id));
  }
  if (unit.continuationStrategy !== null && !CONTINUATION_STRATEGIES.includes(unit.continuationStrategy)) {
    diagnostics.push(
      diag('INVALID_CONTINUATION_STRATEGY', `GenerationUnit ${unit.id} continuationStrategy "${unit.continuationStrategy}" is not one of ${CONTINUATION_STRATEGIES.join(', ')}`, 'GenerationUnit', unit.id)
    );
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Section 17 — a shot's declared characters/props/location must be a
// subset of its parent scene's authoritative lists.
// ---------------------------------------------------------------------------
function validateShotAgainstScene(shot, scene) {
  const diagnostics = [];
  if (!scene) {
    diagnostics.push(diag('SHOT_MISSING_PARENT_SCENE', `Shot ${shot.shotId} references sceneId "${shot.sceneId}" which does not resolve to a real scene`, 'StoryboardShot', shot.shotId));
    return diagnostics;
  }
  for (const characterId of shot.characterReferences || []) {
    if (!(scene.characterIds || []).includes(characterId)) {
      diagnostics.push(diag('SHOT_CHARACTER_NOT_IN_SCENE', `Shot ${shot.shotId} references character ${characterId}, which its parent scene ${scene.sceneId} does not declare`, 'StoryboardShot', shot.shotId));
    }
  }
  for (const propId of shot.propReferences || []) {
    if (!(scene.propIds || []).includes(propId)) {
      diagnostics.push(diag('SHOT_PROP_NOT_IN_SCENE', `Shot ${shot.shotId} references prop ${propId}, which its parent scene ${scene.sceneId} does not declare`, 'StoryboardShot', shot.shotId));
    }
  }
  for (const locationId of shot.locationReferences || []) {
    if (scene.locationId && locationId !== scene.locationId) {
      diagnostics.push(diag('SHOT_LOCATION_MISMATCH', `Shot ${shot.shotId} references location ${locationId}, which differs from its parent scene ${scene.sceneId}'s declared location ${scene.locationId}`, 'StoryboardShot', shot.shotId));
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Section 17 — GenerationUnit ordering, parentage, and frame/state
// continuity (the deterministically-checkable slice only — see file header).
// ---------------------------------------------------------------------------
function validateGenerationUnitsForShot(shot, units, knownAssetIds = null) {
  const diagnostics = [];
  const unitsForShot = units.filter((u) => u.shotId === shot.shotId);
  const declaredIds = new Set(shot.generationUnitIds || []);
  const foundIds = new Set(unitsForShot.map((u) => u.id));

  // Section 17 — "start/end frame references missing assets." Only
  // checked when the caller supplies the known-asset universe (this
  // validator has no Asset store of its own — see production-schema.js).
  if (knownAssetIds) {
    for (const unit of unitsForShot) {
      if (unit.startFrameAssetId && !knownAssetIds.has(unit.startFrameAssetId)) {
        diagnostics.push(diag('DANGLING_START_FRAME_ASSET', `GenerationUnit ${unit.id} startFrameAssetId ${unit.startFrameAssetId} does not resolve to a known asset`, 'GenerationUnit', unit.id));
      }
      if (unit.endFrameAssetId && !knownAssetIds.has(unit.endFrameAssetId)) {
        diagnostics.push(diag('DANGLING_END_FRAME_ASSET', `GenerationUnit ${unit.id} endFrameAssetId ${unit.endFrameAssetId} does not resolve to a known asset`, 'GenerationUnit', unit.id));
      }
    }
  }

  // Section 17 — "missing required character/location references": a
  // GenerationUnit's own state may only name characters the parent Shot
  // itself already declares — never a character the shot never introduced.
  const shotCharacterIds = new Set(shot.characterReferences || []);
  for (const unit of unitsForShot) {
    for (const stateBag of [unit.startState, unit.endState]) {
      for (const cs of (stateBag && stateBag.characterStates) || []) {
        if (cs.characterId && !shotCharacterIds.has(cs.characterId)) {
          diagnostics.push(
            diag('GENERATION_UNIT_CHARACTER_NOT_IN_SHOT', `GenerationUnit ${unit.id} state references character ${cs.characterId}, which shot ${shot.shotId} does not declare`, 'GenerationUnit', unit.id)
          );
        }
      }
    }
  }

  for (const id of declaredIds) {
    if (!foundIds.has(id)) diagnostics.push(diag('DANGLING_GENERATION_UNIT_REFERENCE', `Shot ${shot.shotId} lists generationUnitId ${id} which does not resolve to a real GenerationUnit`, 'StoryboardShot', shot.shotId));
  }
  for (const unit of unitsForShot) {
    if (!declaredIds.has(unit.id)) {
      diagnostics.push(diag('GENERATION_UNIT_WRONG_PARENT_SHOT', `GenerationUnit ${unit.id} has shotId ${shot.shotId} but that shot does not list it in generationUnitIds`, 'GenerationUnit', unit.id));
    }
  }

  const sorted = [...unitsForShot].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const seenOrders = new Set();
  for (const unit of sorted) {
    if (unit.order === null || unit.order === undefined) continue;
    if (seenOrders.has(unit.order)) diagnostics.push(diag('INVALID_GENERATION_UNIT_ORDERING', `Shot ${shot.shotId} has more than one GenerationUnit with order ${unit.order}`, 'GenerationUnit', unit.id));
    seenOrders.add(unit.order);
  }

  const byId = new Map(unitsForShot.map((u) => [u.id, u]));
  for (const unit of unitsForShot) {
    if (!unit.continuesFromGenerationUnitId) continue;
    const predecessor = byId.get(unit.continuesFromGenerationUnitId);
    if (!predecessor) {
      diagnostics.push(diag('DANGLING_CONTINUATION_REFERENCE', `GenerationUnit ${unit.id} continuesFromGenerationUnitId ${unit.continuesFromGenerationUnitId} does not resolve within the same shot`, 'GenerationUnit', unit.id));
      continue;
    }
    if (predecessor.order !== null && unit.order !== null && predecessor.order >= unit.order) {
      diagnostics.push(diag('IMPOSSIBLE_GENERATION_ORDERING', `GenerationUnit ${unit.id} (order ${unit.order}) claims to continue from ${predecessor.id} (order ${predecessor.order}), which does not precede it`, 'GenerationUnit', unit.id));
    }
    // Section 3 — where BOTH sides declare a frame asset, they must match
    // exactly for a claimed continuation; a state-only continuation (no
    // frame assets on either side) is not checked here — that is exactly
    // the subjective slice Creative QA owns, not structural validation.
    if (predecessor.endFrameAssetId && unit.startFrameAssetId && predecessor.endFrameAssetId !== unit.startFrameAssetId) {
      diagnostics.push(
        diag(
          'INCOMPATIBLE_SEQUENTIAL_FRAME_CONTINUITY',
          `GenerationUnit ${unit.id}'s startFrameAssetId does not match its declared predecessor ${predecessor.id}'s endFrameAssetId`,
          'GenerationUnit',
          unit.id
        )
      );
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Whole-storyboard structural pass — collects every check above plus
// dangling top-level references. Returns every violation found, never
// stops at the first (a real validation report, not a boolean gate).
// ---------------------------------------------------------------------------
function validateCreativeProductionContract({ storyboard, visualBible, generationUnits = [], knownAssetIds = null }) {
  const diagnostics = [];
  const scenesById = new Map((storyboard.scenes || []).map((s) => [s.sceneId, s]));
  const characterIds = new Set((visualBible.characters || []).map((c) => c.characterId));
  const locationIds = new Set((visualBible.locations || []).map((l) => l.locationId));
  const propIds = new Set((visualBible.props || []).map((p) => p.propId));

  for (const scene of storyboard.scenes || []) {
    for (const characterId of scene.characterIds || []) {
      if (!characterIds.has(characterId)) diagnostics.push(diag('DANGLING_CHARACTER_REFERENCE', `Scene ${scene.sceneId} references unknown character ${characterId}`, 'StoryboardScene', scene.sceneId));
    }
    for (const propId of scene.propIds || []) {
      if (!propIds.has(propId)) diagnostics.push(diag('DANGLING_PROP_REFERENCE', `Scene ${scene.sceneId} references unknown prop ${propId}`, 'StoryboardScene', scene.sceneId));
    }
    if (scene.locationId && !locationIds.has(scene.locationId)) {
      diagnostics.push(diag('DANGLING_LOCATION_REFERENCE', `Scene ${scene.sceneId} references unknown location ${scene.locationId}`, 'StoryboardScene', scene.sceneId));
    }
  }

  for (const shot of storyboard.shots || []) {
    diagnostics.push(...validateShotAgainstScene(shot, scenesById.get(shot.sceneId)));
    diagnostics.push(...validateGenerationUnitsForShot(shot, generationUnits, knownAssetIds));
  }

  for (const unit of generationUnits) {
    diagnostics.push(...validateGenerationUnitDuration(unit));
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

// ---------------------------------------------------------------------------
// Section 10/11 — fold a delta-only stateTimeline forward as of a given
// scene, per createCharacter/createLocation/createProp's own stateTimeline
// field comment. `sceneOrder` maps sceneId -> its Scene.order (or any
// stable sequence number) so "as of scene N" has a real, deterministic
// meaning regardless of the order snapshots were appended in.
// ---------------------------------------------------------------------------
function resolveStateAtScene(stateTimeline, targetSceneId, sceneOrder) {
  const targetOrder = sceneOrder[targetSceneId];
  const applicable = (stateTimeline || [])
    .filter((snapshot) => sceneOrder[snapshot.sceneId] !== undefined && sceneOrder[snapshot.sceneId] <= targetOrder)
    .sort((a, b) => sceneOrder[a.sceneId] - sceneOrder[b.sceneId]);

  const resolved = {};
  for (const snapshot of applicable) {
    for (const [field, value] of Object.entries(snapshot.state || {})) {
      if (value !== null && value !== undefined) resolved[field] = value;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Section 15 — CONTINUITY GRAPH, derived (not stored). Returns, for every
// Character/Location/Prop, the set of scene/shot/generationUnit ids that
// reference it — i.e. "what depends on this."
// ---------------------------------------------------------------------------
function deriveContinuityGraph({ storyboard, generationUnits = [] }) {
  const graph = { characters: {}, locations: {}, props: {} };
  const touch = (bucket, id, kind, refId) => {
    if (!id) return;
    if (!bucket[id]) bucket[id] = [];
    bucket[id].push({ type: kind, id: refId });
  };

  for (const scene of storyboard.scenes || []) {
    for (const id of scene.characterIds || []) touch(graph.characters, id, 'StoryboardScene', scene.sceneId);
    for (const id of scene.propIds || []) touch(graph.props, id, 'StoryboardScene', scene.sceneId);
    if (scene.locationId) touch(graph.locations, scene.locationId, 'StoryboardScene', scene.sceneId);
  }
  for (const shot of storyboard.shots || []) {
    for (const id of shot.characterReferences || []) touch(graph.characters, id, 'StoryboardShot', shot.shotId);
    for (const id of shot.propReferences || []) touch(graph.props, id, 'StoryboardShot', shot.shotId);
    for (const id of shot.locationReferences || []) touch(graph.locations, id, 'StoryboardShot', shot.shotId);
  }
  for (const unit of generationUnits) {
    for (const cs of (unit.startState && unit.startState.characterStates) || []) touch(graph.characters, cs.characterId, 'GenerationUnit', unit.id);
    for (const cs of (unit.endState && unit.endState.characterStates) || []) touch(graph.characters, cs.characterId, 'GenerationUnit', unit.id);
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Section 16 — INVALIDATION. Given a changed entity id, report (never
// delete) every downstream object the continuity graph says depends on it.
// Deliberately returns a report, not a mutation — the caller decides
// whether/how to mark `stale`/`staleReason` on those objects.
// ---------------------------------------------------------------------------
function findDownstreamOfCharacterChange(characterId, { storyboard, generationUnits = [] }) {
  const graph = deriveContinuityGraph({ storyboard, generationUnits });
  return graph.characters[characterId] || [];
}

module.exports = {
  validateGenerationUnitDuration,
  validateShotAgainstScene,
  validateGenerationUnitsForShot,
  validateCreativeProductionContract,
  resolveStateAtScene,
  deriveContinuityGraph,
  findDownstreamOfCharacterChange,
};
