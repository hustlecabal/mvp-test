// idea-provider-interface.js
//
// PHASE 1 EDITORIAL SPINE, Part 2 — the contract an IdeaProvider must
// implement, mirroring services/creative-brain/creative-brain-provider-
// interface.js's own role for angle candidates. Only one method: given a
// Strategy and a candidate count, propose that many candidate ideas.
// Deliberately provider-neutral (no LLM assumed) — this phase's own
// default provider (deterministic-idea-provider.js) needs no credential,
// no network call, and no approval/budget gate, because it spends nothing.
// A future real (LLM-backed) IdeaProvider can implement this same
// interface without idea-engine-service.js changing at all.

function assertImplementsIdeaProviderInterface(provider) {
  if (!provider || typeof provider.generateIdeaCandidates !== 'function') {
    throw new Error('an IdeaProvider must implement generateIdeaCandidates(input)');
  }
}

// input — { strategy: a real editorial-strategy-schema.js createEditorialStrategy() object, candidateCount }
// returns — { status: 'COMPLETED' | 'FAILED', candidates: [{ topic, premise, rationale }], diagnostics: [] }
module.exports = { assertImplementsIdeaProviderInterface };
