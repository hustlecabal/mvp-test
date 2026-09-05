// deterministic-idea-provider.js
//
// PHASE 1 EDITORIAL SPINE, Part 2 — the default, always-available
// IdeaProvider. Free and offline: it never calls an LLM, spends nothing,
// and needs no approval/budget gate. It generates N candidate ideas by
// recombining an EditorialStrategy's OWN already-supplied text through a
// small, fixed set of "idea shapes" — never inventing a new factual claim,
// exactly the same "template scaffolding around real, already-supplied
// content" discipline services/beat-graph-derivation-service.js's
// firstNonEmpty() and services/narration-director-service.js's
// DIRECTOR_RULES already use elsewhere in this codebase.
//
// HONESTY NOTE (mirrors narration-director-service.js's own "starting
// rules, not immutable creative truth"): these three shapes are a starting
// point for turning a Strategy into candidate topics, not a claim that they
// are the only or the best possible ideas — that judgment is exactly what
// idea-evaluation-service.js's independent scoring (and a human's eventual
// selection) exists to make. A future real (LLM-backed) IdeaProvider can
// replace this file without idea-engine-service.js changing at all (see
// idea-provider-interface.js).

function fallback(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return '';
}

const IDEA_SHAPES = [
  {
    key: 'PROBLEM_FIRST',
    buildTopic: (s) => fallback(s.audienceNeed, s.contentPromise, 'the core problem this content addresses'),
    buildPremise: (s) =>
      `${fallback(s.audienceNeed, 'the problem')} — examined directly, for ${fallback(s.targetAudience, 'this audience')}.`,
  },
  {
    key: 'MISCONCEPTION',
    buildTopic: (s) => `what ${fallback(s.targetAudience, 'people')} get wrong about ${fallback(s.audienceNeed, 'this')}`,
    buildPremise: (s) =>
      `${fallback(s.positioning, 'this content')} exists because the common take on "${fallback(s.audienceNeed, 'this problem')}" misses something — this idea names what.`,
  },
  {
    key: 'PROMISE_DELIVERY',
    buildTopic: (s) => fallback(s.contentPromise, s.audienceNeed, 'the promise this content makes'),
    buildPremise: (s) =>
      `A concrete demonstration of "${fallback(s.contentPromise, 'the promise')}" applied to ${fallback(s.audienceNeed, 'a real case')}.`,
  },
];

function createDeterministicIdeaProvider() {
  async function generateIdeaCandidates(input = {}) {
    const { strategy, candidateCount = 3 } = input;
    if (!strategy) {
      return { status: 'FAILED', candidates: [], diagnostics: [{ code: 'MISSING_STRATEGY', message: 'a Strategy is required to generate idea candidates' }] };
    }
    const count = Math.max(1, Math.min(candidateCount, IDEA_SHAPES.length));
    const candidates = IDEA_SHAPES.slice(0, count).map((shape) => ({
      topic: shape.buildTopic(strategy),
      premise: shape.buildPremise(strategy),
      rationale: `Generated via the ${shape.key} idea shape from EditorialStrategy "${strategy.id}".`,
    }));
    return { status: 'COMPLETED', candidates, diagnostics: [] };
  }
  return { generateIdeaCandidates };
}

module.exports = { IDEA_SHAPES, createDeterministicIdeaProvider };
