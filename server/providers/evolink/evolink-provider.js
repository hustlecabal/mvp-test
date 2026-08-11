// evolink-provider.js
//
// Implements the generic provider interface (../provider-interface.js) for
// EvoLink specifically. This file contains NO EvoLink field names and NO
// HTTP logic of its own — it only wires evolink-client.js (HTTP) and
// evolink-mapper.js (translation) together in the shape the rest of the
// application expects.
//
// IMPORTANT — cost safety: this file does not, and must not, decide
// whether a generation is allowed to happen. That decision belongs to
// services/approval-gate.js and schemas/state-machine.js, upstream of
// this provider. By the time anything calls createGeneration() here, the
// approval/budget gate has already said yes.

const client = require('./evolink-client');
const mapper = require('./evolink-mapper');

async function createGeneration(genericRequest, options = {}) {
  const evolinkBody = mapper.toEvolinkRequest(genericRequest);
  const evolinkResponse = await client.createVideoGenerationTask(evolinkBody, options);
  return mapper.fromEvolinkTask(evolinkResponse);
}

async function getGenerationStatus(generationId, options = {}) {
  const evolinkResponse = await client.getTask(generationId, options);
  return mapper.fromEvolinkTask(evolinkResponse);
}

// EvoLink's task-query endpoint returns status and results together —
// there's no separate "fetch just the result" call to make. This exists
// as its own named operation because the generic provider interface
// requires it, and because a caller asking for "the result" is expressing
// different intent than one just checking progress.
async function getGenerationResult(generationId, options = {}) {
  return getGenerationStatus(generationId, options);
}

// Not part of the required provider interface. A safe, read-only,
// non-generation way to confirm an API key works — see
// docs/integrations/evolink-api.md. Not called anywhere yet.
async function checkAccountCredits(options = {}) {
  return client.getCredits(options);
}

module.exports = {
  createGeneration,
  getGenerationStatus,
  getGenerationResult,
  checkAccountCredits,
};
