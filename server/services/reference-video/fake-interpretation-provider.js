// fake-interpretation-provider.js
//
// INT-1D — implements interpretation-provider-interface.js entirely in
// memory, deterministically, with zero network access. Exists so this
// stage's full test suite (schema, evidence linkage, cost gate, human
// review, adversarial/anti-hallucination tests) never depends on a live
// paid LLM (Part 27's explicit requirement) — the same role fake-image-
// provider.js already plays for keyframe generation (Stage 13B).
//
// Two ways to use it:
//   createFakeInterpretationProvider()                — a sensible DEFAULT
//     deterministic responder: cites the first two supplied observations
//     as supporting evidence, proposes one hedged hypothesis template plus
//     one alternative, and never claims intent or a quality judgment. Good
//     enough to exercise the full happy path and the real-proof test.
//   createFakeInterpretationProvider({ respond })     — full control:
//     `respond(input)` returns a plain object merged over
//     createInterpretationProviderResult()'s defaults, for adversarial/
//     failure-path tests (malformed output, UNAVAILABLE, TIMEOUT, a
//     response that tries to smuggle an intent claim through, etc.)

const { createInterpretationProviderResult } = require('./interpretation-provider-interface');

function defaultRespond(input) {
  const cited = (input.observations || []).slice(0, 2);
  if (cited.length === 0) {
    return {
      status: 'COMPLETED',
      hypothesis: null,
      reasoning: 'No relevant observations were supplied for this question.',
      supportingObservationIds: [],
      confidence: null,
      limitations: ['No supporting evidence was available for this question.'],
    };
  }
  const primary = cited[0];
  const alt = cited[1];
  return {
    status: 'COMPLETED',
    hypothesis: `The structure described by "${primary.statement}" may be consistent with an intentional pacing choice, though this is one plausible reading among several.`,
    reasoning: `Observation ${primary.observationId} ("${primary.statement}") is the primary basis for this hypothesis. It is a measured, evidence-backed observation, not itself a judgment about intent.`,
    supportingObservationIds: [primary.observationId],
    counterObservationIds: alt ? [alt.observationId] : [],
    alternativeHypotheses: alt
      ? [{ hypothesis: `The pattern described by "${alt.statement}" may instead simply reflect the source format or platform convention, rather than a deliberate structural choice.`, reasoning: `Observation ${alt.observationId} is also consistent with this reading.` }]
      : [],
    confidence: 'MEDIUM',
    limitations: ['Based on a single reference video; no cross-video comparison was performed.'],
  };
}

function createFakeInterpretationProvider(options = {}) {
  const respond = typeof options.respond === 'function' ? options.respond : defaultRespond;
  return {
    async interpret(input) {
      const partial = await respond(input);
      return createInterpretationProviderResult({ model: 'fake-interpretation-v1', ...partial });
    },
  };
}

module.exports = { createFakeInterpretationProvider };
