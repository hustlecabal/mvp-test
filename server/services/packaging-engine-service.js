// packaging-engine-service.js
//
// PHASE 1 EDITORIAL SPINE, Part 3 — the PACKAGING ENGINE operator entry
// point. Same GENERATE N -> EVALUATE EACH INDEPENDENTLY -> SELECT STRONGEST
// pattern as idea-engine-service.js, one layer further down the hierarchy:
// Strategy -> Idea -> **Package** -> (Angle ->) Blueprint. Coordination
// only — no creative reasoning here, no second representation of the
// Idea/Strategy.

const editorialStrategyStore = require('./editorial-strategy-store');
const ideaStore = require('./idea-store');
const packageStore = require('./package-store');
const { assertImplementsPackagingProviderInterface } = require('./packaging-engine/packaging-provider-interface');
const { createDeterministicPackagingProvider } = require('./packaging-engine/deterministic-packaging-provider');
const { evaluatePackageCandidate } = require('./packaging-engine/packaging-evaluation-service');
const { createPackageCandidate, createPackageEvaluationResult } = require('../schemas/package-schema');

const DEFAULT_PROVIDER = createDeterministicPackagingProvider();

// Fewest-FAIL selection, ties broken by original candidate order — the same
// rule idea-engine-service.js/creative-brain-service.js each apply at their
// own layer, reimplemented fresh here per the phase brief's "do not copy
// code blindly" instruction.
function selectStrongestPackage(candidatesWithResults) {
  let best = candidatesWithResults[0];
  let bestFailCount = best.results.filter((r) => r.result === 'FAIL').length;
  for (const c of candidatesWithResults.slice(1)) {
    const failCount = c.results.filter((r) => r.result === 'FAIL').length;
    if (failCount < bestFailCount) {
      best = c;
      bestFailCount = failCount;
    }
  }
  return { best, allPassed: bestFailCount === 0 };
}

async function generatePackages(projectId, ideaId, options = {}) {
  const found = ideaStore.findIdeaCandidate(projectId, ideaId);
  if (!found) return { ok: false, code: 'IDEA_NOT_FOUND', reason: `no Idea candidate found with id "${ideaId}"` };
  const { idea, ideaSet } = { idea: found.idea, ideaSet: found.ideaSet };
  const strategy = editorialStrategyStore.getStrategy(projectId, ideaSet.strategyId);

  const provider = options.provider || DEFAULT_PROVIDER;
  assertImplementsPackagingProviderInterface(provider);

  const candidateCount = options.candidateCount || 3;
  const candidatesResult = await provider.generatePackageCandidates({ idea, strategy, candidateCount });
  if (candidatesResult.status !== 'COMPLETED' || candidatesResult.candidates.length === 0) {
    return { ok: false, code: 'CANDIDATE_GENERATION_FAILED', reason: `package candidate generation did not complete (status: ${candidatesResult.status})`, diagnostics: candidatesResult.diagnostics };
  }

  const rawCandidates = candidatesResult.candidates;
  const candidatesWithResults = rawCandidates.map((c) => ({ candidate: c, results: evaluatePackageCandidate(c, { idea, strategy, allPackages: rawCandidates }) }));
  const { best, allPassed } = selectStrongestPackage(candidatesWithResults);

  const candidates = candidatesWithResults.map(({ candidate, results }) =>
    createPackageCandidate({ ...candidate, selected: candidate === best.candidate, evaluationResults: results.map((r) => createPackageEvaluationResult(r)) })
  );
  const selectedCandidate = candidates.find((c) => c.selected);

  const saved = packageStore.addPackageSet(projectId, {
    projectId,
    ideaId,
    candidates,
    selectedPackageId: selectedCandidate.packageId,
    status: 'SELECTED',
  });
  if (!saved.ok) return { ok: false, code: 'PERSIST_FAILED', reason: saved.reason };

  return { ok: true, packageSet: saved.packageSet, selectedPackage: saved.packageSet.candidates.find((c) => c.selected), allCandidatesPassed: allPassed };
}

module.exports = { generatePackages, selectStrongestPackage };
