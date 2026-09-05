// packaging-provider-interface.js
//
// PHASE 1 EDITORIAL SPINE, Part 3 — the contract a PackagingProvider must
// implement, mirroring idea-engine/idea-provider-interface.js's own role
// one layer up. Given a selected Idea (and the Strategy it came from), a
// PackagingProvider proposes N candidate packages (title/thumbnailConcept/
// promise/curiosityMechanism/...). Provider-neutral — the phase's default
// (deterministic-packaging-provider.js) needs no credential and spends
// nothing; a future real (LLM-backed) provider can implement this same
// interface without packaging-engine-service.js changing at all.

function assertImplementsPackagingProviderInterface(provider) {
  if (!provider || typeof provider.generatePackageCandidates !== 'function') {
    throw new Error('a PackagingProvider must implement generatePackageCandidates(input)');
  }
}

// input — { idea: a real idea-schema.js createIdeaCandidate() object, strategy, candidateCount }
// returns — { status: 'COMPLETED' | 'FAILED', candidates: [{ title, thumbnailConcept, promise, curiosityMechanism, specificity, novelty, stakes, packageRationale }], diagnostics: [] }
module.exports = { assertImplementsPackagingProviderInterface };
