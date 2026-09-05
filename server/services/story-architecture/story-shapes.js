// story-shapes.js
//
// STORY ARCHITECTURE ENGINE — the pluggable-shape abstraction (phase
// brief, Part 5): "the architecture must permit different story shapes...
// Build the abstraction so that the story architecture is not permanently
// hardcoded to HOOK/SETUP/ESCALATION/ESCALATION/REVEAL/CONCLUSION."
//
// A shape is an ORDERED list of steps. Each step names:
//   - `field`        — which of StoryArgument's 6 content fields
//                       (coreQuestion/stakes/startingBelief/reframedBelief/
//                       mechanism/payoff) supplies this beat's `claim`.
//                       Every shape below uses each of the 6 fields
//                       EXACTLY ONCE — this is what structurally
//                       guarantees beat distinctness by construction
//                       (see distinctness-checker.js): as long as the 6
//                       source fields are themselves non-duplicate text,
//                       no two beats can ever be bound to the same claim.
//   - `beatFunction`  — the shape's own, richer step label (schemas/
//                       story-structure-schema.js's createStoryBeatPlan()
//                       `beatFunction` field) — e.g. 'MECHANISM' vs
//                       'COUNTEREVIDENCE' for the same underlying field,
//                       depending on which shape is telling the story.
//   - `narrativeRole` — the COARSE role narration-director-service.js's
//                       NARRATIVE_ROLES enum requires (never widened).
//   - flags           — isSetup/isEscalation/isReveal/isPayoff.
//
// ONLY 2 SHAPES ARE REGISTERED (phase brief: "do not build all templates
// now") — enough to prove the abstraction is real (Part 13's structurally-
// different-topic test uses the second one), not an exhaustive template
// library. A future shape is a new entry in SHAPE_REGISTRY, never a new
// code path in story-architecture-service.js itself.
//
// HONESTY NOTE: WHICH shape best fits a given topic is not decided by any
// intelligence in this file — that decision is either made explicitly by
// a caller (see story-architecture-service.js's `options.shape`) or, when
// omitted, falls back to PROBLEM_MECHANISM_REVEAL. Nothing here inspects
// topic content to choose a shape; claiming otherwise would be exactly
// the kind of fabricated capability the preceding Forensic Quality Review
// exists to catch.

const PROBLEM_MECHANISM_REVEAL = {
  key: 'PROBLEM_MECHANISM_REVEAL',
  description: 'A direct explainer: pose the question, state the common belief, explain the mechanism, name the consequence, reveal the reframed belief, land the payoff.',
  steps: [
    { field: 'coreQuestion', beatFunction: 'HOOK', narrativeRole: 'HOOK', isSetup: true },
    { field: 'startingBelief', beatFunction: 'STARTING_BELIEF', narrativeRole: 'EXPLANATION', isSetup: true },
    { field: 'mechanism', beatFunction: 'MECHANISM', narrativeRole: 'EXPLANATION', isEscalation: true },
    { field: 'stakes', beatFunction: 'CONSEQUENCE', narrativeRole: 'EXPLANATION', isEscalation: true },
    { field: 'reframedBelief', beatFunction: 'REVEAL', narrativeRole: 'REVEAL', isReveal: true },
    { field: 'payoff', beatFunction: 'PAYOFF', narrativeRole: 'CONCLUSION', isPayoff: true },
  ],
};

// MYTH_BUSTING deliberately reorders WHEN the reframe happens (right after
// the starting belief, as direct counterevidence) rather than saving it
// for the very end — a genuinely different progression shape, not a
// relabeling of the same order (Part 13's structural-difference test).
const MYTH_BUSTING = {
  key: 'MYTH_BUSTING',
  description: 'Open on the common belief, contradict it immediately with counterevidence, then explain the mechanism behind the contradiction, name the stakes, reveal, land the payoff.',
  steps: [
    { field: 'coreQuestion', beatFunction: 'HOOK', narrativeRole: 'HOOK', isSetup: true },
    { field: 'startingBelief', beatFunction: 'COMMON_BELIEF', narrativeRole: 'EXPLANATION', isSetup: true },
    { field: 'reframedBelief', beatFunction: 'COUNTEREVIDENCE', narrativeRole: 'EXPLANATION', isEscalation: true },
    { field: 'mechanism', beatFunction: 'MECHANISM', narrativeRole: 'EXPLANATION', isEscalation: true },
    { field: 'stakes', beatFunction: 'REVEAL', narrativeRole: 'REVEAL', isReveal: true },
    { field: 'payoff', beatFunction: 'PAYOFF', narrativeRole: 'CONCLUSION', isPayoff: true },
  ],
};

const SHAPE_REGISTRY = {
  [PROBLEM_MECHANISM_REVEAL.key]: PROBLEM_MECHANISM_REVEAL,
  [MYTH_BUSTING.key]: MYTH_BUSTING,
};

const DEFAULT_SHAPE_KEY = PROBLEM_MECHANISM_REVEAL.key;

function getShape(key) {
  return SHAPE_REGISTRY[key] || null;
}

function listShapeKeys() {
  return Object.keys(SHAPE_REGISTRY);
}

module.exports = { SHAPE_REGISTRY, DEFAULT_SHAPE_KEY, getShape, listShapeKeys };
