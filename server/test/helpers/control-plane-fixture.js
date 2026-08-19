// INT-2.5-P0 — shared test helper. Every generation-service.js /
// keyframe-generation-service.js / video-generation-service.js call now
// runs through control-plane-service.js's validateProductionPrerequisites()
// FIRST (see each service's own runSafetyChecks()). Any test fixture that
// exercises a real generation call must satisfy that prerequisite or it
// will be correctly BLOCKED before ever reaching the check the test
// actually means to exercise.
//
// Builds a real, persisted APPROVED CreativeBlueprint + a real ACCEPTed
// PreProductionGateResult + a Storyboard.blueprintId link — the same
// "real record, direct construction via schema factories + stores" pattern
// p0-4a-blueprint-storyboard-contract.test.js's own setupBlueprintWithRecommendation
// helper already used, and the same one generation-service.test.js /
// keyframe-generation-service.test.js / video-generation-service.test.js
// each independently established for this exact stage — centralized here
// once every OTHER consumer of these three services needed the identical
// fixture, rather than re-duplicated a dozen more times.
//
// IMPORTANT: require() this helper only AFTER the calling test file has
// set process.env.CREATIVE_DATA_DIR / CREATIVE_BLUEPRINT_DATA_DIR /
// PRE_PRODUCTION_GATE_DATA_DIR — those stores read their data directory
// from the environment at module-load time, exactly like every other
// store in this codebase.

const creativeStore = require('../../services/creative-store');
const creativeBlueprintStore = require('../../services/creative-blueprint-store');
const preProductionGateStore = require('../../services/pre-production-gate-store');
const { createCreativeBlueprint } = require('../../schemas/creative-blueprint-schema');
const { createPreProductionGateResult } = require('../../schemas/pre-production-gate-schema');

function satisfyProductionPrerequisites(projectId) {
  const blueprint = createCreativeBlueprint({
    projectId,
    recommendationSetId: 'rec-set-fixture',
    status: 'APPROVED',
    concept: 'fixture concept',
    corePromise: 'fixture promise',
    targetDuration: 60,
  });
  const savedBlueprint = creativeBlueprintStore.addCreativeBlueprint(projectId, blueprint).blueprint;
  const gateResult = createPreProductionGateResult({
    projectId,
    blueprintId: savedBlueprint.id,
    blueprintRevision: savedBlueprint.id,
    blueprintUpdatedAt: savedBlueprint.updatedAt,
    machineAssessment: 'PROCEED',
    costStatus: 'UNKNOWN',
  });
  const savedGateResult = preProductionGateStore.addGateResult(projectId, gateResult).gateResult;
  preProductionGateStore.recordHumanDecision(projectId, savedGateResult.id, { humanDecision: 'ACCEPT', humanDecidedBy: 'test-fixture', humanRationale: null });
  creativeStore.updateStoryboard(projectId, { blueprintId: savedBlueprint.id });
  return { blueprintId: savedBlueprint.id, gateResultId: savedGateResult.id };
}

module.exports = { satisfyProductionPrerequisites };
