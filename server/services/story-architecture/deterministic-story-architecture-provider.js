// deterministic-story-architecture-provider.js
//
// STORY ARCHITECTURE ENGINE — the default, always-available
// StoryArchitectureProvider. Free and offline, same discipline as idea-
// engine/deterministic-idea-provider.js and packaging-engine/
// deterministic-packaging-provider.js: it recombines Idea/Package/
// Blueprint/Strategy's OWN already-supplied text into the 6 StoryArgument
// content fields, then binds each of those 6 fields to exactly ONE beat
// via the chosen story-shapes.js shape.
//
// WHY THIS STRUCTURALLY FIXES PHASE 1'S DUPLICATE-BEAT BUG: Phase 1's
// deriveStoryStructure() generated N generic "ESCALATION" beats that all
// read the SAME Blueprint field (pacingStrategy), so two escalation beats
// were byte-identical. This provider instead maps each of the 6 DISTINCT
// StoryArgument fields (coreQuestion/startingBelief/mechanism/stakes/
// reframedBelief/payoff) to exactly one beat, each field sourced from a
// DIFFERENT upstream field (idea.topic / strategy.positioning /
// blueprint.narrativeStrategy / package.stakes+strategy.audienceNeed /
// package.curiosityMechanism / package.promise) — as long as those six
// upstream strings are themselves non-identical (true by construction for
// Phase 1's own deterministic Idea/Packaging providers), no two beats can
// ever be bound to the same claim. Distinctness is structural here, not
// merely hoped for and caught later by evaluation.
//
// HONESTY NOTE (same as every other deterministic provider in this
// codebase): this is a starting point that demonstrates the STRUCTURE a
// real intelligent provider must fill — plausible-sounding sentence
// templates around real upstream text, never a claim of genuine narrative
// craft. It cannot invent topic knowledge that isn't already present
// somewhere in Idea/Package/Blueprint/Strategy's own text.

const { getShape, DEFAULT_SHAPE_KEY } = require('./story-shapes');
const { createStoryBeatPlan, createVisualObjective } = require('../../schemas/story-structure-schema');
const { createStoryQuestion } = require('../../schemas/story-argument-schema');

function fallback(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return '';
}

// Interrogative-shape guard — the SAME class of defect the preceding
// Forensic Quality Review found in Phase 1's packaging templates ("Why why
// more choice...?"). This file is new code being written specifically for
// Story Architecture; not re-introducing an obvious, avoidable defect in
// brand-new code is baseline competence, not a fix to packaging (out of
// scope, untouched).
const INTERROGATIVE_STARTS = ['why', 'how', 'what', 'when', 'where', 'who', 'which', 'is', 'are', 'does', 'do', 'can', 'should', 'will'];
function asQuestion(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (INTERROGATIVE_STARTS.includes(firstWord)) return trimmed.endsWith('?') ? trimmed : `${trimmed}?`;
  if (trimmed.endsWith('?')) return trimmed;
  return `Why ${trimmed}?`;
}

// The 6 StoryArgument content fields, each sourced from a DIFFERENT
// upstream field (see file header for the full non-overlap rationale).
function buildContent({ idea, pkg, blueprint, strategy }) {
  const coreQuestion = asQuestion(idea.topic);
  const startingBelief = `Most people assume ${fallback(strategy.positioning, 'the obvious explanation is enough')} — without questioning it.`;
  const mechanism = fallback(blueprint.narrativeStrategy, idea.premise, 'the underlying mechanism has not been articulated');
  const stakes = `${fallback(pkg.stakes, 'There is a real cost to getting this wrong.')} This matters specifically for ${fallback(strategy.audienceNeed, 'the audience this was made for')}.`;
  const reframedBelief = fallback(pkg.curiosityMechanism, 'the reframe has not been articulated');
  const payoff = fallback(pkg.promise, idea.premise, 'the payoff has not been articulated');
  return { coreQuestion, startingBelief, mechanism, stakes, reframedBelief, payoff };
}

// visualMode mapping keyed by beatFunction (richer than the coarse
// narrativeRole -> visualMode table Phase 1 used) — still a fixed table
// (documented, not required, same convention as every enum-adjacent field
// in this codebase), but now selecting among visual-beat-schema.js's
// VISUAL_MODES per STEP FUNCTION rather than per coarse role, so
// MECHANISM and CONSEQUENCE (both narrativeRole EXPLANATION) get
// different visualMode values.
const VISUAL_MODE_BY_FUNCTION = {
  HOOK: 'EMOTIONAL',
  STARTING_BELIEF: 'ILLUSTRATIVE',
  COMMON_BELIEF: 'ILLUSTRATIVE',
  MECHANISM: 'EXPLANATORY',
  CONSEQUENCE: 'EVIDENCE',
  COUNTEREVIDENCE: 'METAPHORICAL',
  REVEAL: 'EVIDENCE',
  PAYOFF: 'EMOTIONAL',
};

const WHY_IT_EXISTS_BY_FUNCTION = {
  HOOK: 'Introduces the central question the rest of the argument must answer.',
  STARTING_BELIEF: "States the common assumption the argument is about to complicate.",
  COMMON_BELIEF: "States the common assumption the argument is about to contradict.",
  MECHANISM: 'Explains the underlying mechanism the consequence/reveal beats depend on.',
  CONSEQUENCE: 'Names what the mechanism actually costs, raising the stakes before the reveal.',
  COUNTEREVIDENCE: 'Directly contradicts the starting belief, ahead of explaining why.',
  REVEAL: "Delivers the reframed belief the hook's question was actually asking about.",
  PAYOFF: 'Resolves the argument into a concrete takeaway tied back to the hook.',
};

// Content-specific visual objective (Part 8): derived from THIS beat's own
// claim (WHAT to show) and its own whyItExists (WHY), never a canned
// per-role sentence. HONESTY NOTE: this template cannot invent a genuine
// visual metaphor (e.g. "a decision tree branching") the way a real
// intelligent provider eventually should — it names WHAT to ground the
// visual in and WHY, which is the structural contract the phase brief
// asks for, not a claim of creative visual invention.
//
// DISCOVERED BY THIS PHASE'S OWN EVALUATOR, DURING TESTING: an earlier
// version of this template wrapped every beat's claim in one long, FIXED
// sentence ("Ground this beat's visual in its own specific claim — ...
// rather than a generic X illustration: show the concrete scene, object,
// or comparison the claim itself describes"). That shared boilerplate
// text dominated the Jaccard token set story-architecture-evaluator.js's
// beatDistinctness dimension computes, making two genuinely DIFFERENT
// visual objectives look near-duplicate on paper purely because of the
// wrapper, not the content — the evaluator caught this correctly. The
// fix: minimize shared scaffolding (just "Show:") and let the beat's own
// whyItExists (which already varies per beatFunction) carry the
// explanatory weight instead of a second fixed phrase.
function buildVisualObjective(claim, whyItExists) {
  return `${whyItExists ? `${whyItExists} ` : ''}Show: "${claim}"`;
}

function createDeterministicStoryArchitectureProvider() {
  async function generateStoryArgument(input = {}) {
    const { idea, package: pkg, blueprint, strategy, shape: shapeKeyOverride } = input;
    if (!idea || !pkg || !blueprint) {
      return { status: 'FAILED', storyArgument: null, diagnostics: [{ code: 'MISSING_INPUT', message: 'idea, package, and blueprint are all required to generate a StoryArgument' }] };
    }
    const shape = getShape(shapeKeyOverride) || getShape(DEFAULT_SHAPE_KEY);
    const content = buildContent({ idea, pkg, blueprint, strategy: strategy || {} });

    // --- Pass 1: build every beat, wiring up creates/resolves after via beatKey ---
    const beats = shape.steps.map((step, index) =>
      createStoryBeatPlan({
        order: index + 1,
        beatFunction: step.beatFunction,
        narrativeRole: step.narrativeRole,
        purpose: WHY_IT_EXISTS_BY_FUNCTION[step.beatFunction] || step.beatFunction,
        claim: content[step.field],
        whyItExists: WHY_IT_EXISTS_BY_FUNCTION[step.beatFunction] || null,
        isSetup: Boolean(step.isSetup),
        isEscalation: Boolean(step.isEscalation),
        isReveal: Boolean(step.isReveal),
        isPayoff: Boolean(step.isPayoff),
        visualObjective: createVisualObjective({
          visualObjective: buildVisualObjective(content[step.field], WHY_IT_EXISTS_BY_FUNCTION[step.beatFunction]),
          visualMode: VISUAL_MODE_BY_FUNCTION[step.beatFunction] || 'ILLUSTRATIVE',
          visualPriority: step.isReveal ? 'the payoff moment — must be visually distinct' : step.isSetup && index === 0 ? 'primary — must land in the first beat' : `${step.beatFunction} beat`,
          visualChangeRequired: Boolean(step.isEscalation || step.isReveal || index === 0),
        }),
      })
    );

    const hookBeat = beats.find((b) => b.beatFunction === 'HOOK') || beats[0];
    const mechanismBeat = beats.find((b) => b.beatFunction === 'MECHANISM');
    const revealBeat = beats.find((b) => b.isReveal) || beats[beats.length - 2];
    const payoffBeat = beats.find((b) => b.isPayoff) || beats[beats.length - 1];

    // --- Questions (Part 6/7): two tracked open loops, both resolved at the reveal ---
    const questions = [];
    const q1 = createStoryQuestion({ text: content.coreQuestion, createdByBeatKey: hookBeat.beatKey, resolvedByBeatKey: revealBeat.beatKey, status: 'RESOLVED' });
    questions.push(q1);
    hookBeat.creates = [q1.questionId];
    revealBeat.resolves = [...revealBeat.resolves, q1.questionId];

    if (mechanismBeat && mechanismBeat !== hookBeat && mechanismBeat !== revealBeat) {
      const q2 = createStoryQuestion({ text: asQuestion(`what specifically causes this`), createdByBeatKey: mechanismBeat.beatKey, resolvedByBeatKey: revealBeat.beatKey, status: 'RESOLVED' });
      questions.push(q2);
      mechanismBeat.creates = [...mechanismBeat.creates, q2.questionId];
      revealBeat.resolves = [...revealBeat.resolves, q2.questionId];
    }

    // --- Reveal/payoff linkage (Part 7): structured beatKey references, never prose alone ---
    revealBeat.unresolvedQuestion = null;
    hookBeat.unresolvedQuestion = content.coreQuestion;
    payoffBeat.paysOffBeatKeys = [...new Set([...payoffBeat.paysOffBeatKeys, hookBeat.beatKey, revealBeat.beatKey])];

    const storyArgument = {
      shape: shape.key,
      ...content,
      questions,
      beats,
    };

    return { status: 'COMPLETED', storyArgument, diagnostics: [] };
  }
  return { generateStoryArgument };
}

module.exports = { createDeterministicStoryArchitectureProvider, asQuestion, buildContent };
