// provider-interface.js
//
// The contract every generation provider adapter (EvoLink, and eventually
// others — LongCat, a local provider, etc.) must implement. Nothing
// outside a specific provider's own folder should ever depend on that
// provider's internals — only on this shape.
//
// A provider must expose three operations:
//   createGeneration(genericRequest)      -> generic generation status
//   getGenerationStatus(generationId)     -> generic generation status
//   getGenerationResult(generationId)     -> generic generation status
//
// "genericRequest" is the shape from schemas/production-schema.js's
// createGenerationRequest(): { provider, model, task, references, prompt,
// parameters }. Every operation returns our OWN generic status shape
// (createGenerationStatus, below) — never a raw provider response. That
// keeps EvoLink-specific field names contained entirely inside
// providers/evolink/, so a different provider can be swapped in later
// without touching anything that calls this interface.

const REQUIRED_METHODS = ['createGeneration', 'getGenerationStatus', 'getGenerationResult'];

function assertImplementsProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Provider is missing required method: ${method}()`);
    }
  }
}

// Our internal, provider-agnostic status vocabulary. Every adapter must
// map its own status values into these — see docs/integrations/
// evolink-api.md's "Job / Task Lifecycle" section for the EvoLink mapping.
// TIMED_OUT is ours alone — it means WE gave up waiting, not that the
// provider reported any particular outcome (see generation-poller.js).
const GENERATION_STATUSES = ['REQUESTED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

function createGenerationStatus(overrides = {}) {
  const base = {
    generationId: null,
    provider: null,
    model: null,
    status: 'REQUESTED',
    progress: null,
    // A cost the provider reserved/estimated at submission time, if it
    // provided one. Never assume this exists — see
    // docs/integrations/evolink-api.md's "Pricing / Cost" section.
    reservedCost: null,
    results: [],
    error: null,
  };
  return { ...base, ...overrides };
}

module.exports = {
  REQUIRED_METHODS,
  GENERATION_STATUSES,
  assertImplementsProviderInterface,
  createGenerationStatus,
};
