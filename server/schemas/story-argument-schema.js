// story-argument-schema.js
//
// STORY ARCHITECTURE ENGINE — the explicit representation of WHAT THE
// VIDEO IS ARGUING/REVEALING, generated from Idea + Package + Blueprint,
// upstream of (and the real content source for) StoryStructure.
//
// FIELD DECISIONS, DOCUMENTED (per this phase's explicit "do not blindly
// use all of these if existing fields already represent the same
// concept — avoid duplicate state" instruction):
//
//   - `centralClaim` — DELIBERATELY OMITTED. This is exactly
//     schemas/creative-blueprint-schema.js's own `corePromise` (itself,
//     once a Package is selected, authoritatively set from
//     selectedPackage.promise — see services/creative-brain-service.js).
//     Storing it a third time here would be the "duplicate state" this
//     phase explicitly warns against. Any reader that needs the central
//     claim reads `blueprint.corePromise` via this record's own
//     `blueprintId` reference — never a copy.
//   - `coreQuestion` — KEPT. No existing field holds "the single question
//     this video exists to answer": CreativeBlueprint.hookStrategy is a
//     STRATEGY statement about narrative craft/delivery ("open on the
//     moment someone realizes..."), never the question itself.
//   - `stakes` — KEPT, distinct from PackageCandidate.stakes. The
//     Package's stakes field is PACKAGING framing (why a viewer should
//     click) — audience-facing, marketing-register text. This field is
//     the ARGUMENT's own internal stakes (why the unresolved question
//     matters within the story's own logic) — a real, different piece of
//     information even though both may be seeded from the same
//     upstream evidence.
//   - `startingBelief` / `reframedBelief` — KEPT. No existing field
//     anywhere in this codebase captures a myth-vs-truth/before-vs-after
//     belief pair; PackageCandidate.curiosityMechanism gestures at "what
//     creates the open loop" but never states the two beliefs themselves.
//   - `mechanism` — KEPT. No existing field explains HOW something works
//     structurally; CreativeBlueprint.narrativeStrategy/pacingStrategy
//     describe delivery craft, not the mechanism's own content.
//   - `payoff` — KEPT, distinct from corePromise/Package.promise (the
//     marketing pitch) and from mechanism/reframedBelief (the reveal
//     itself) — payoff is the specific, resolved articulation the
//     CONCLUSION beat's claim is checked against (see
//     services/story-architecture/story-architecture-evaluator.js's
//     promiseAlignment dimension), which only exists once the argument has
//     actually walked through startingBelief -> mechanism -> reframedBelief.
//
// NEVER a retention/CTR/engagement claim anywhere in this file — every
// field here is a structural piece of THE ARGUMENT, never a prediction
// about how an audience will behave (same epistemic discipline as
// schemas/recommendation-schema.js's BANNED_OUTCOME_CATEGORIES).

const crypto = require('crypto');
const { createStoryBeatPlan } = require('./story-structure-schema');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const STORY_QUESTION_STATUSES = ['OPEN', 'RESOLVED'];

// A structured open-loop record — the id `creates`/`resolves` on
// schemas/story-structure-schema.js's createStoryBeatPlan() actually
// reference. One record per question the argument raises.
function createStoryQuestion(overrides = {}) {
  const base = {
    questionId: crypto.randomUUID(),
    text: '',
    createdByBeatKey: null, // the beat that first raises this question
    resolvedByBeatKey: null, // null while OPEN — the beat that answers it, once one does
    status: 'OPEN', // one of STORY_QUESTION_STATUSES
  };
  return withDefaults(base, overrides);
}

const STORY_ARGUMENT_STATUSES = ['DRAFT', 'EVALUATED', 'SELECTED'];

// The StoryArgument record itself. `beats` reuses schemas/story-structure-
// schema.js's createStoryBeatPlan() verbatim — this file never defines a
// second, parallel beat shape (see file header).
function createStoryArgument(overrides = {}) {
  const { questions, beats, evaluationResults, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    blueprintId: null,
    ideaId: null,
    packageId: null,

    shape: null, // one of services/story-architecture/story-shapes.js's registered shape keys — documented, not required here (same convention as narrativeRole/visualTreatment elsewhere in this codebase)

    coreQuestion: '',
    stakes: '',
    startingBelief: '',
    reframedBelief: '',
    mechanism: '',
    payoff: '',

    questions: Array.isArray(questions) ? questions.map((q) => createStoryQuestion(q)) : [],
    beats: Array.isArray(beats) ? beats.map((b) => createStoryBeatPlan(b)) : [],

    selected: false,
    evaluationResults: Array.isArray(evaluationResults) ? [...evaluationResults] : [],

    status: 'DRAFT', // one of STORY_ARGUMENT_STATUSES
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

const STORY_ARGUMENT_SET_STATUSES = ['DRAFT', 'EVALUATED', 'SELECTED'];

// StoryArgumentSet — one record per generation attempt (mirrors IdeaSet/
// PackageSet's own "one record per run, keep every candidate for
// transparency" convention exactly).
function createStoryArgumentSet(overrides = {}) {
  const { candidates, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    blueprintId: null,
    candidates: Array.isArray(candidates) ? candidates.map((c) => createStoryArgument(c)) : [],
    selectedStoryArgumentId: null,
    status: 'DRAFT', // one of STORY_ARGUMENT_SET_STATUSES
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  STORY_QUESTION_STATUSES,
  STORY_ARGUMENT_STATUSES,
  STORY_ARGUMENT_SET_STATUSES,
  createStoryQuestion,
  createStoryArgument,
  createStoryArgumentSet,
};
