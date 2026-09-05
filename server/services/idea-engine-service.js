// idea-engine-service.js
//
// PHASE 1 EDITORIAL SPINE, Part 2 — the IDEA ENGINE operator entry point.
// Reuses the CONCEPTUAL pattern services/creative-brain-service.js already
// proves for angle candidates — GENERATE N -> EVALUATE EACH INDEPENDENTLY
// -> SELECT STRONGEST — one layer up, applied to topics/premises instead of
// angles on an already-chosen topic. Deliberately NOT a copy of creative-
// brain-service.js's code: no financial-approval gate (this phase's default
// provider is deterministic and free — see idea-engine/deterministic-idea-
// provider.js), no recommendation-set precondition, and a different
// evaluation-dimension set (idea-engine/idea-evaluation-service.js).
//
// Coordination only, same discipline as creative-brain-service.js's own
// header: no creative reasoning happens in this file, and it never
// persists a second, competing representation of "the strategy" or "the
// blueprint" — it only ties editorial-strategy-store.js's Strategy to a
// freshly generated, evaluated, and selected idea-store.js IdeaSet.

const editorialStrategyStore = require('./editorial-strategy-store');
const ideaStore = require('./idea-store');
const { assertImplementsIdeaProviderInterface } = require('./idea-engine/idea-provider-interface');
const { createDeterministicIdeaProvider } = require('./idea-engine/deterministic-idea-provider');
const { evaluateIdeaCandidate } = require('./idea-engine/idea-evaluation-service');
const { createIdeaCandidate, createIdeaEvaluationResult } = require('../schemas/idea-schema');

const DEFAULT_PROVIDER = createDeterministicIdeaProvider();

// Fewest-FAIL selection — ties broken by original candidate order (first
// generated wins), never randomly. Mirrors creative-brain-service.js's own
// selectStrongestCandidate() exactly in spirit (same rule, reimplemented
// fresh here per the phase brief's "do not copy code blindly" instruction).
function selectStrongestIdea(candidatesWithResults) {
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

async function generateIdeas(projectId, strategyId, options = {}) {
  const strategy = editorialStrategyStore.getStrategy(projectId, strategyId);
  if (!strategy) return { ok: false, code: 'STRATEGY_NOT_FOUND', reason: `no EditorialStrategy found with id "${strategyId}"` };

  const provider = options.provider || DEFAULT_PROVIDER;
  assertImplementsIdeaProviderInterface(provider);

  const candidateCount = options.candidateCount || 3;
  const candidatesResult = await provider.generateIdeaCandidates({ strategy, candidateCount });
  if (candidatesResult.status !== 'COMPLETED' || candidatesResult.candidates.length === 0) {
    return { ok: false, code: 'CANDIDATE_GENERATION_FAILED', reason: `idea candidate generation did not complete (status: ${candidatesResult.status})`, diagnostics: candidatesResult.diagnostics };
  }

  const rawCandidates = candidatesResult.candidates;
  const candidatesWithResults = rawCandidates.map((c) => ({ candidate: c, results: evaluateIdeaCandidate(c, strategy, rawCandidates) }));
  const { best, allPassed } = selectStrongestIdea(candidatesWithResults);

  const candidates = candidatesWithResults.map(({ candidate, results }) =>
    createIdeaCandidate({ ...candidate, selected: candidate === best.candidate, evaluationResults: results.map((r) => createIdeaEvaluationResult(r)) })
  );
  const selectedCandidate = candidates.find((c) => c.selected);

  const saved = ideaStore.addIdeaSet(projectId, {
    projectId,
    strategyId,
    candidates,
    selectedIdeaId: selectedCandidate.ideaId,
    status: 'SELECTED',
  });
  if (!saved.ok) return { ok: false, code: 'PERSIST_FAILED', reason: saved.reason };

  return { ok: true, ideaSet: saved.ideaSet, selectedIdea: saved.ideaSet.candidates.find((c) => c.selected), allCandidatesPassed: allPassed };
}

module.exports = { generateIdeas, selectStrongestIdea };
