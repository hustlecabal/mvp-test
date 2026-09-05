// story-architecture-provider-interface.js
//
// STORY ARCHITECTURE ENGINE — the contract a StoryArchitectureProvider
// must implement, mirroring idea-engine/idea-provider-interface.js and
// packaging-engine/packaging-provider-interface.js's own role one layer
// further down the hierarchy (Strategy -> Idea -> Package -> **Story
// Argument** -> Blueprint's Storyboard). Provider-neutral — the phase's
// default (deterministic-story-architecture-provider.js) needs no
// credential and spends nothing; a future real (LLM-backed) provider can
// implement this same interface without story-architecture-service.js
// changing at all (phase brief, Part 10: "the provider boundary must
// allow a real intelligent provider to replace it later without changing
// orchestration").

function assertImplementsStoryArchitectureProviderInterface(provider) {
  if (!provider || typeof provider.generateStoryArgument !== 'function') {
    throw new Error('a StoryArchitectureProvider must implement generateStoryArgument(input)');
  }
}

// input — { idea, package: selectedPackage, blueprint, strategy, shape? (one of story-shapes.js's registered keys) }
// returns — { status: 'COMPLETED' | 'FAILED', storyArgument: { coreQuestion, stakes, startingBelief, reframedBelief, mechanism, payoff, shape, questions[], beats[] }, diagnostics: [] }
module.exports = { assertImplementsStoryArchitectureProviderInterface };
