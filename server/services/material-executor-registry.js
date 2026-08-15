// material-executor-registry.js
//
// Stage 26.5A — a small, deterministic lookup from executorType (see
// schemas/material-execution-schema.js's EXECUTOR_TYPES) to the module
// that implements it (services/material-executors/*). This file does NOT
// choose a material, does not choose a provider/model, does not generate
// anything, and never calls a provider or reserves a credit — it only
// resolves an executor for a material Stage 26.3's Material Resolution
// Engine already decided. See services/material-execution-service.js for
// the caller that actually decides WHICH executorType applies to a given
// resolved material and invokes the executor this file hands back.

const EXECUTORS = require('./material-executors');
const { EXECUTOR_TYPES } = require('../schemas/material-execution-schema');

// Returns the executor module ({ execute, ... }) for a given executorType,
// or null if unregistered. Never throws.
function getExecutor(executorType) {
  return EXECUTORS[executorType] || null;
}

function listExecutorTypes() {
  return [...EXECUTOR_TYPES];
}

module.exports = { getExecutor, listExecutorTypes, EXECUTOR_TYPES };
