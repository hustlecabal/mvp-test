// story-structure-schema.js
//
// PHASE 1 EDITORIAL SPINE, Part 5 — the STORY STRUCTURE / EDITORIAL BEAT
// PLAN: a structured intermediate layer between CreativeBlueprint (whose
// hookStrategy/narrativeStrategy/pacingStrategy/emotionalArc/
// visualSpecification fields the preceding Editorial Intelligence Gap
// Audit found become "mostly dead-end prose") and the real, mechanical
// Storyboard/BeatGraph. A StoryStructure translates those Blueprint-level
// strategy decisions into EXPLICIT, per-beat editorial intent — narrative
// role, escalation/setup/reveal/payoff, an unresolved question where one
// exists, and a visual objective — BEFORE any Storyboard shot exists.
//
// `beatKey` (not shotId) — a StoryStructure is derived from a Blueprint,
// upstream of Storyboard authoring, so it cannot reference real shotIds yet
// (none exist). services/story-structure-service.js's
// authorStoryboardFromStoryStructure() creates real Storyboard shots FROM
// this plan and returns a { beatKey -> shotId } map; buildBeatGraphContext()
// then translates this same StoryStructure into the shotId-keyed context
// shape services/beat-graph-derivation-service.js's deriveBeatGraph()
// already accepts (context.narrativeRoles/visualObjectives/edges) — never
// the other way around, and never by weakening that file's own explicit
// anti-inference rule (this schema/service pair is exactly the "proper
// upstream structured input" that rule calls for).
//
// ATTENTION MECHANICS, NOT MEASURED RETENTION (phase brief, Part 5/6
// explicit instruction): isEscalation/isReveal/isPayoff/unresolvedQuestion
// are STRUCTURAL DESIGN CHOICES a human/deterministic planner makes before
// production — never a claim about how an actual audience will behave, and
// never a numeric retention/attention score. Same epistemic discipline as
// schemas/recommendation-schema.js's own BANNED_OUTCOME_CATEGORIES (never
// claim RETENTION as a measured fact).

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Value space matches schemas/visual-beat-schema.js's own VISUAL_MODES —
// documented here rather than required (schema files in this codebase
// import only `crypto` — see beat-graph-schema.js's own header for this
// convention), enforced at the service boundary (story-structure-
// service.js), exactly like visualTreatment/narrativeRole already are.
function createVisualObjective(overrides = {}) {
  const base = {
    visualObjective: '', // WHAT the viewer should see here, and why
    visualMode: null, // one of visual-beat-schema.js's VISUAL_MODES
    visualPriority: null, // free-text note on relative importance — never a numeric score
    visualChangeRequired: null, // boolean — must this beat look visually different from the one before it
  };
  return withDefaults(base, overrides);
}

// One planned beat's editorial intent. narrativeRole's value space matches
// services/narration-director-service.js's own NARRATIVE_ROLES —
// documented, not required, same reasoning as above.
function createStoryBeatPlan(overrides = {}) {
  const { visualObjective, ...rest } = overrides;
  const base = {
    beatKey: crypto.randomUUID(),
    order: null,
    purpose: '', // what this beat is FOR, in the story's own terms
    narrativeRole: null, // one of narration-director-service.js's NARRATIVE_ROLES

    // Attention-mechanics flags (Part 5/6) — structural design choices,
    // never measured outcomes. A beat may be more than one of these at
    // once (e.g. a beat can both escalate AND end on an unresolved
    // question) — they are independent booleans, not a single enum.
    isSetup: false,
    isEscalation: false,
    isReveal: false,
    isPayoff: false,

    transition: null, // same field name/shape as shot.transition
    unresolvedQuestion: null, // the open loop this beat leaves, if any — null means "resolves cleanly, opens nothing"

    visualObjective: visualObjective !== undefined ? (visualObjective === null ? null : createVisualObjective(visualObjective)) : createVisualObjective(),
  };
  return withDefaults(base, rest);
}

// A relationship between two planned beats, translated 1:1 into a real
// BeatEdge (schemas/beat-graph-schema.js) once Storyboard shots exist for
// both sides — kind's value space matches BEAT_EDGE_KINDS exactly
// (documented, not required, same reasoning as above).
function createStoryEdge(overrides = {}) {
  const base = {
    fromBeatKey: null,
    toBeatKey: null,
    kind: null, // one of beat-graph-schema.js's BEAT_EDGE_KINDS
    note: null,
  };
  return withDefaults(base, overrides);
}

const STORY_STRUCTURE_STATUSES = ['DRAFT', 'AUTHORED']; // AUTHORED once authorStoryboardFromStoryStructure() has run

function createStoryStructure(overrides = {}) {
  const { beats, edges, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    blueprintId: null, // the CreativeBlueprint this structure was derived from

    // PROMISE TRACEABILITY (Part 10) — copied through verbatim from the
    // Blueprint at derivation time, never re-derived — so a later
    // promise-fulfillment QC pass (explicitly out of scope this phase) has
    // a stable value to check the finished video against without having to
    // re-resolve it through Blueprint -> Package -> Idea every time.
    corePromise: null,
    targetDuration: null,

    beats: Array.isArray(beats) ? beats.map((b) => createStoryBeatPlan(b)) : [],
    edges: Array.isArray(edges) ? edges.map((e) => createStoryEdge(e)) : [],

    status: 'DRAFT', // one of STORY_STRUCTURE_STATUSES
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  STORY_STRUCTURE_STATUSES,
  createVisualObjective,
  createStoryBeatPlan,
  createStoryEdge,
  createStoryStructure,
};
