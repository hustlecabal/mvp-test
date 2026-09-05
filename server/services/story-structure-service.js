// story-structure-service.js
//
// PHASE 1 EDITORIAL SPINE, Part 5/6 — the BLUEPRINT -> STORY STRUCTURE ->
// BEATGRAPH bridge the preceding Editorial Intelligence Gap Audit named as
// the single most important missing connective piece. Three pure/thin
// functions:
//
//   deriveStoryStructure(blueprint)            — CreativeBlueprint -> StoryStructure (pure, deterministic)
//   authorStoryboardFromStoryStructure(...)     — StoryStructure -> real Storyboard shots (the ONE place this
//                                                  bridge actually writes anything)
//   buildBeatGraphContext(...)                  — StoryStructure + { beatKey -> shotId } -> the exact
//                                                  context shape beat-graph-derivation-service.js's
//                                                  deriveBeatGraph() already accepts
//
// deriveStoryStructure() is PURE and DETERMINISTIC (never mutates its
// input, never persists, never calls a provider) — the same discipline
// beat-graph-derivation-service.js's own header documents for itself, one
// layer up. It NEVER weakens that file's anti-inference rule: it does not
// read a Storyboard shot's free text at all (no Storyboard exists yet when
// this runs) — it only recombines the Blueprint's OWN already-decided
// strategy fields (hookStrategy/narrativeStrategy/pacingStrategy/
// corePromise/emotionalArc/visualStrategy/structuralDirection) into
// EXPLICIT per-beat structure, exactly the "proper upstream structured
// input" beat-graph-derivation-service.js's own header calls for.
//
// ATTENTION MECHANICS, NOT MEASURED RETENTION (phase brief) — the canonical
// arc below (HOOK -> SETUP -> N x ESCALATION -> REVEAL -> CONCLUSION) is a
// STARTING STRUCTURE, the same "starting rules, not immutable creative
// truth" honesty narration-director-service.js's own DIRECTOR_RULES already
// documents — never a claim that this shape maximizes any measured outcome.

const {
  createStoryBeatPlan,
  createStoryEdge,
  createVisualObjective,
  createStoryStructure,
} = require('../schemas/story-structure-schema');
const creativeStore = require('./creative-store');
const storyStructureStore = require('./story-structure-store');

const MIN_BEATS = 4; // HOOK + SETUP + REVEAL + CONCLUSION, zero escalation beats
const MAX_BEATS = 10;
const DEFAULT_BEAT_COUNT = 6;
const DEFAULT_BEAT_DURATION_SECONDS = 6;

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Public entry point #1. Pure — never persists. `blueprint` is a real,
// already-APPROVED (or at least already-built) schemas/creative-blueprint-
// schema.js createCreativeBlueprint() object.
function deriveStoryStructure(blueprint, options = {}) {
  if (!blueprint || !blueprint.id) {
    return { ok: false, code: 'INVALID_BLUEPRINT', reason: 'a real CreativeBlueprint object is required' };
  }

  const plannedSectionCount =
    blueprint.structuralDirection && typeof blueprint.structuralDirection.plannedSectionCount === 'number' ? blueprint.structuralDirection.plannedSectionCount : null;
  const beatCount = clamp(options.beatCount || plannedSectionCount || DEFAULT_BEAT_COUNT, MIN_BEATS, MAX_BEATS);
  const escalationCount = Math.max(0, beatCount - 4);

  const beats = [];

  const hookBeat = createStoryBeatPlan({
    order: 1,
    purpose: 'Open on the hook — establish the question this video answers.',
    narrativeRole: 'HOOK',
    isSetup: true,
    unresolvedQuestion: firstNonEmpty(blueprint.hookStrategy, blueprint.corePromise) || null,
    visualObjective: createVisualObjective({
      visualObjective: firstNonEmpty(blueprint.visualStrategy, blueprint.concept),
      visualMode: 'EMOTIONAL',
      visualPriority: 'primary — must land in the first beat',
      visualChangeRequired: true,
    }),
  });
  beats.push(hookBeat);

  const setupBeat = createStoryBeatPlan({
    order: 2,
    purpose: 'Establish context — why this matters, in plain terms.',
    narrativeRole: 'EXPLANATION',
    isSetup: true,
    visualObjective: createVisualObjective({
      visualObjective: firstNonEmpty(blueprint.narrativeStrategy, blueprint.concept),
      visualMode: 'ILLUSTRATIVE',
      visualPriority: 'supports the hook — should not compete with it',
      visualChangeRequired: false,
    }),
  });
  beats.push(setupBeat);

  const escalationBeats = [];
  for (let i = 1; i <= escalationCount; i += 1) {
    const escalationBeat = createStoryBeatPlan({
      order: 2 + i,
      purpose: `Escalate: step ${i} of the argument.`,
      narrativeRole: 'EXPLANATION',
      isEscalation: true,
      visualObjective: createVisualObjective({
        visualObjective: firstNonEmpty(blueprint.pacingStrategy, blueprint.visualStrategy, blueprint.concept),
        visualMode: 'EXPLANATORY',
        visualPriority: `escalation step ${i} — should look different from the previous beat`,
        visualChangeRequired: true,
      }),
    });
    escalationBeats.push(escalationBeat);
    beats.push(escalationBeat);
  }

  const revealBeat = createStoryBeatPlan({
    order: 2 + escalationCount + 1,
    purpose: 'Reveal — deliver the core insight the hook promised.',
    narrativeRole: 'REVEAL',
    isReveal: true,
    visualObjective: createVisualObjective({
      visualObjective: firstNonEmpty(blueprint.corePromise, blueprint.concept),
      visualMode: 'EVIDENCE',
      visualPriority: 'the payoff moment — must be visually distinct',
      visualChangeRequired: true,
    }),
  });
  beats.push(revealBeat);

  const conclusionBeat = createStoryBeatPlan({
    order: 2 + escalationCount + 2,
    purpose: 'Close — pay off the promise and land the takeaway.',
    narrativeRole: 'CONCLUSION',
    isPayoff: true,
    visualObjective: createVisualObjective({
      visualObjective: firstNonEmpty(blueprint.emotionalArc, blueprint.concept),
      visualMode: 'EMOTIONAL',
      visualPriority: 'closing — should feel resolved',
      visualChangeRequired: false,
    }),
  });
  beats.push(conclusionBeat);

  // Edges (Part 6): ONE DEPENDS_ON edge marking that the REVEAL beat is
  // what closes the HOOK's own open loop — a real structural relationship
  // this derivation explicitly decided, never inferred from beat text.
  //
  // Deliberately NOT a TRANSITIONS_TO chain for plain sequential order:
  // that ordering is already fully expressed by each beat's own `order`
  // field (and, once authored, StoryboardShot.order) — no edge is needed
  // to express it. This matters beyond tidiness: TRANSITIONS_TO is not a
  // free-form "these beats are in sequence" annotation in this codebase —
  // timeline-compiler-service.js turns every TRANSITIONS_TO BeatEdge into
  // a real TimelineIR transition, and video-assembly-service.js's own
  // documented policy (Part 9) REFUSES to assemble at all when any
  // transitions[] exist, rather than silently perform a plain cut where a
  // real crossfade/wipe was requested but no rendering semantics exist yet
  // for it. Emitting TRANSITIONS_TO here for mere ordering would make every
  // real production run built from a StoryStructure fail at ASSEMBLY —
  // discovered and fixed during this phase's own real end-to-end test.
  const edges = [];
  if (hookBeat.unresolvedQuestion) {
    edges.push(createStoryEdge({ fromBeatKey: hookBeat.beatKey, toBeatKey: revealBeat.beatKey, kind: 'DEPENDS_ON', note: "the reveal beat resolves the hook beat's open loop" }));
  }

  const storyStructure = createStoryStructure({
    projectId: blueprint.projectId,
    blueprintId: blueprint.id,
    corePromise: blueprint.corePromise || null,
    targetDuration: blueprint.targetDuration || null,
    beats,
    edges,
    status: 'DRAFT',
  });

  return { ok: true, storyStructure };
}

// Public entry point #2 — the ONE place this bridge actually writes
// anything. Creates ONE Storyboard scene and one shot per planned beat, in
// order, via the EXISTING creative-store.js API (never a second Storyboard
// write path).
//
// `treatments` (optional, { [beatKey]: one of VISUAL_TREATMENTS }) and
// `treatmentByRole` (optional, { [narrativeRole]: one of VISUAL_TREATMENTS })
// are BOTH accepted, `treatments` taking precedence per-beat when both name
// the same beat — `treatmentByRole` exists because `beatKey` is freshly
// randomized by EVERY deriveStoryStructure() call (it is not derived from
// anything stable), so a caller can only know real beatKeys AFTER this same
// StoryStructure has already been derived; `treatmentByRole` lets a caller
// decide treatments up front, keyed by the one thing that IS stable and
// known in advance (the canonical HOOK/EXPLANATION/REVEAL/CONCLUSION arc
// deriveStoryStructure() always produces). `durations` (optional,
// { [beatKey]: seconds }, defaults to DEFAULT_BEAT_DURATION_SECONDS) is
// beatKey-only for the same reason `treatments` supports it.
//
// visualTreatment itself is the caller's own production decision either
// way — documented elsewhere in this codebase (schemas/creative-schema.js's
// own StoryboardShot comment) as HUMAN_AUTHORED, never invented by a
// derivation step, and this bridge does not change that: a beat naming no
// treatment via either map simply gets `visualTreatment: null`.
function authorStoryboardFromStoryStructure(projectId, storyStructure, options = {}) {
  if (!storyStructure || !Array.isArray(storyStructure.beats) || storyStructure.beats.length === 0) {
    return { ok: false, reason: 'a real StoryStructure with at least one planned beat is required' };
  }
  const treatments = options.treatments || {};
  const treatmentByRole = options.treatmentByRole || {};
  const durations = options.durations || {};
  const durationByRole = options.durationByRole || {}; // same beatKey-vs-role reasoning as treatmentByRole above

  const scene = creativeStore.addStoryboardScene(projectId, { title: options.sceneTitle || 'Scene 1', order: 1 });
  if (!scene) return { ok: false, reason: `no project found with id "${projectId}"` };

  const beatKeyToShotId = {};
  const sortedBeats = [...storyStructure.beats].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const beat of sortedBeats) {
    const visualTreatment = Object.prototype.hasOwnProperty.call(treatments, beat.beatKey)
      ? treatments[beat.beatKey]
      : Object.prototype.hasOwnProperty.call(treatmentByRole, beat.narrativeRole)
      ? treatmentByRole[beat.narrativeRole]
      : null;
    const duration =
      durations[beat.beatKey] !== undefined
        ? durations[beat.beatKey]
        : Object.prototype.hasOwnProperty.call(durationByRole, beat.narrativeRole)
        ? durationByRole[beat.narrativeRole]
        : DEFAULT_BEAT_DURATION_SECONDS;
    const shot = creativeStore.addStoryboardShot(projectId, {
      sceneId: scene.sceneId,
      order: beat.order,
      duration,
      purpose: beat.purpose,
      narrativeBeat: beat.narrativeRole,
      visualDescription: beat.visualObjective ? beat.visualObjective.visualObjective : null,
      transition: beat.transition,
      visualTreatment,
    });
    beatKeyToShotId[beat.beatKey] = shot.shotId;
  }

  if (storyStructure.blueprintId) {
    creativeStore.updateStoryboard(projectId, { blueprintId: storyStructure.blueprintId });
  }
  storyStructureStore.markAuthored(projectId, storyStructure.id);

  return { ok: true, storyboard: creativeStore.getStoryboard(projectId), beatKeyToShotId };
}

// Public entry point #3 — translates a StoryStructure (keyed by beatKey)
// plus the { beatKey -> shotId } map authorStoryboardFromStoryStructure()
// just produced into the exact shotId-keyed context shape beat-graph-
// derivation-service.js's deriveBeatGraph() already accepts. A beatKey that
// never got authored into a shot (shouldn't happen via the normal flow
// above, but never trusted implicitly) is simply skipped, never invented.
function buildBeatGraphContext(storyStructure, beatKeyToShotId) {
  const narrativeRoles = {};
  const visualObjectives = {};
  for (const beat of storyStructure.beats) {
    const shotId = beatKeyToShotId[beat.beatKey];
    if (!shotId) continue;
    if (beat.narrativeRole) narrativeRoles[shotId] = beat.narrativeRole;
    if (beat.visualObjective) {
      visualObjectives[shotId] = {
        visualObjective: beat.visualObjective.visualObjective,
        visualMode: beat.visualObjective.visualMode,
        visualPriority: beat.visualObjective.visualPriority,
        visualChangeRequired: beat.visualObjective.visualChangeRequired,
      };
    }
  }

  const edges = [];
  for (const edge of storyStructure.edges) {
    const fromShotId = beatKeyToShotId[edge.fromBeatKey];
    const toShotId = beatKeyToShotId[edge.toBeatKey];
    if (!fromShotId || !toShotId) continue;
    edges.push({ fromShotId, toShotId, kind: edge.kind, note: edge.note });
  }

  return { narrativeRoles, visualObjectives, edges };
}

module.exports = {
  MIN_BEATS,
  MAX_BEATS,
  DEFAULT_BEAT_COUNT,
  DEFAULT_BEAT_DURATION_SECONDS,
  deriveStoryStructure,
  authorStoryboardFromStoryStructure,
  buildBeatGraphContext,
};
