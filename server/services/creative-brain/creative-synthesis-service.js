// creative-synthesis-service.js
//
// CREATIVE BRAIN, Part 21/24/28 — the ONLY file that ever calls a
// CreativeBrainProvider. Mirrors services/reference-video-interpretation-
// service.js's exact financial-control sequence (that file's own header
// is the direct precedent): estimate -> request approval -> human
// decides (creative-brain-approval-store.js, separately) -> re-check
// approval+budget -> reserve USD -> call -> settle (real usage or
// UNKNOWN, never zero) -> strict validate-no-repair.
//
// COST BUCKET (this stage's sign-off): settles against the EXISTING
// `anthropic` usdSpend bucket in services/approval-gate.js — no new
// ledger bucket.
//
// PART 28's "ONE approval covers both calls": generateAngleCandidates()
// and synthesizeDirection() both check the SAME CreativeBrainApproval
// record (keyed by recommendationSetId, never by an individual call) —
// a human decides once, both calls proceed under that one decision.
// Each is still its own separate reserve/settle pair (two real, billable
// Anthropic calls), matching interpretReferenceVideo's own "one
// reservation per real provider call" discipline.

const crypto = require('crypto');
const projectStore = require('./../project-store');
const gate = require('./../approval-gate');
const modelRegistry = require('./../creative-brain-model-registry');
const creativeBrainApprovalStore = require('./../creative-brain-approval-store');
const { createAngleCandidatesInput, createDirectionSynthesisInput, assertImplementsCreativeBrainProviderInterface } = require('./creative-brain-provider-interface');

const CHARS_PER_TOKEN_ESTIMATE = 4;
// P0 Golden Run Blocker Repair, Blocker C — recalibrated against a real
// measured call (971 input / 2000 output tokens, 727 of which were
// thinking, for ONE direction-synthesis call) once the routing fix made
// a real call possible for the first time. These feed the human-facing
// PRE-APPROVAL cost estimate (estimateGenerationCostUsd, below) — the
// old 900/900 estimates were never wrong in a way any real call could
// have shown before now, but they meaningfully understated the real cost
// a human approves against, which matters given this is the one number a
// human sees before authorizing spend.
const ESTIMATED_ANGLE_OUTPUT_TOKENS = 1500; // comfortably fits the observed real usage; candidates alone rarely need extensive thinking
const ESTIMATED_DIRECTION_OUTPUT_TOKENS = 4500; // observed real call: ~2000 (thinking + truncated text) before the max_tokens fix; a complete, untruncated response needs more
const DEFAULT_MODEL = { provider: 'claude', model: 'claude-sonnet-5' };

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN_ESTIMATE);
}

function checkCreativeBrainBudget(project, approval) {
  gate.ensureShape(project);
  if (project.creditLedger.blocked) {
    return { allowed: false, reason: project.creditLedger.blockedReason || 'Project is blocked pending resolution of a budget overage.' };
  }
  if (!approval.unknownCostAcknowledged) {
    return {
      allowed: false,
      reason:
        approval.estimatedCost == null
          ? `Estimated cost is unknown and has not been explicitly acknowledged by a human (policy: ${gate.UNKNOWN_COST_POLICY}).`
          : `Estimated cost ($${approval.estimatedCost} USD) cannot be validated against the project's credit budget and must be explicitly acknowledged by a human (policy: ${gate.UNKNOWN_COST_POLICY}) before this call can proceed.`,
    };
  }
  return { allowed: true, reason: null };
}

// Part 24/28 — a single estimate covering BOTH real calls this
// generation attempt will make (candidate generation + direction
// synthesis), so a human approves the whole attempt once.
function estimateGenerationCostUsd({ input, provider = DEFAULT_MODEL.provider, model = DEFAULT_MODEL.model }) {
  const inputTokens = estimateTokens(JSON.stringify(input));
  const angleCost = modelRegistry.estimateCostUsd({ provider, model, estimatedInputTokens: inputTokens, estimatedOutputTokens: ESTIMATED_ANGLE_OUTPUT_TOKENS });
  const directionCost = modelRegistry.estimateCostUsd({ provider, model, estimatedInputTokens: inputTokens, estimatedOutputTokens: ESTIMATED_DIRECTION_OUTPUT_TOKENS });
  if (angleCost == null || directionCost == null) return null;
  return Math.round((angleCost + directionCost) * 1_000_000) / 1_000_000;
}

function requestCreativeBrainApproval(projectId, recommendationSetId, { input, requestedBy, provider, model } = {}) {
  const estimatedCost = estimateGenerationCostUsd({ input, provider, model });
  return creativeBrainApprovalStore.requestApproval(projectId, recommendationSetId, {
    estimatedCost,
    reason: 'Creative Brain candidate generation + direction synthesis (2 LLM calls under one approval)',
    requestedBy,
  });
}

async function generateAngleCandidates(projectId, { topic, format, targetDuration, candidateCount = 3, recommendations = [], voicePatterns = [], provider, providerName = 'claude', model = DEFAULT_MODEL.model } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { status: 'FAILED', diagnostics: [{ code: 'PROJECT_NOT_FOUND', message: `no project found with id "${projectId}"` }], candidates: [] };

  const activeProvider = provider;
  assertImplementsCreativeBrainProviderInterface(activeProvider);

  const input = createAngleCandidatesInput({ topic, format, targetDuration, candidateCount, recommendations, voicePatterns });
  const inputTokens = estimateTokens(JSON.stringify(input));

  return callProviderMethod(project, projectId, input, activeProvider, 'generateAngleCandidates', {
    operation: 'creative_brain_angle_candidates',
    estimatedOutputTokens: ESTIMATED_ANGLE_OUTPUT_TOKENS,
    inputTokens,
    providerName,
    model,
  });
}

async function synthesizeDirection(projectId, { topic, format, targetDuration, selectedAngle, recommendations = [], voicePatterns = [], provider, providerName = 'claude', model = DEFAULT_MODEL.model } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { status: 'FAILED', diagnostics: [{ code: 'PROJECT_NOT_FOUND', message: `no project found with id "${projectId}"` }] };

  const activeProvider = provider;
  assertImplementsCreativeBrainProviderInterface(activeProvider);

  const input = createDirectionSynthesisInput({ topic, format, targetDuration, selectedAngle, recommendations, voicePatterns });
  const inputTokens = estimateTokens(JSON.stringify(input));

  return callProviderMethod(project, projectId, input, activeProvider, 'synthesizeDirection', {
    operation: 'creative_brain_direction_synthesis',
    estimatedOutputTokens: ESTIMATED_DIRECTION_OUTPUT_TOKENS,
    inputTokens,
    providerName,
    model,
  });
}

// Shared reserve -> call -> settle sequence for either of the two real
// calls, given the caller has already resolved which recommendationSetId
// this generation attempt is scoped to via the approval record — the
// approval CHECK itself happens in creative-brain-service.js (the
// orchestrator), which is the one place that knows the recommendationSetId
// this whole attempt is scoped to; this file only ever performs the
// metered call once told the approval is real (never re-checks approval
// itself, to avoid a second, divergent copy of that gate logic).
async function callProviderMethod(project, projectId, input, provider, methodName, { operation, estimatedOutputTokens, inputTokens, model }) {
  const operationId = crypto.randomUUID();
  const estimatedCost = modelRegistry.estimateCostUsd({ provider: 'claude', model, estimatedInputTokens: inputTokens, estimatedOutputTokens });

  await gate.reserveBudget(projectId, { jobId: operationId, provider: 'anthropic', operation, amount: estimatedCost, currency: 'usd' });

  let outcome;
  try {
    outcome = await provider[methodName](input);
  } catch (error) {
    await gate.settleUsdSpend(projectId, { jobId: operationId, provider: 'anthropic', operation, amount: null, note: `${methodName} threw: ${error && error.message ? error.message : String(error)}; settling as UNKNOWN rather than assuming free.` });
    throw error;
  }

  if (outcome.status === 'UNAVAILABLE') {
    await gate.releaseReservation(projectId, { jobId: operationId, provider: 'anthropic', currency: 'usd', amount: estimatedCost, note: 'Provider reported UNAVAILABLE (no credential configured) — never actually called, nothing billed.' });
    return outcome;
  }

  // Uses the ORIGINALLY REQUESTED `model` (never outcome.model) — the
  // real provider always echoes back exactly what it was asked to use,
  // so this stays correct for real calls, while a test/fake provider
  // reporting its own non-registry model name (e.g. "fake-creative-
  // brain") never breaks real-cost calculation by accident.
  const realCost = outcome.usage ? modelRegistry.estimateCostUsd({ provider: 'claude', model, estimatedInputTokens: outcome.usage.inputTokens, estimatedOutputTokens: outcome.usage.outputTokens }) : null;
  await gate.settleUsdSpend(projectId, { jobId: operationId, provider: 'anthropic', operation, amount: realCost, note: outcome.usage ? `real usage: ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out tokens` : 'no usage reported by provider — settling as UNKNOWN, never zero' });

  return outcome;
}

module.exports = {
  checkCreativeBrainBudget,
  estimateGenerationCostUsd,
  requestCreativeBrainApproval,
  generateAngleCandidates,
  synthesizeDirection,
};
