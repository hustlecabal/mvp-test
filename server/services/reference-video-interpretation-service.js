// reference-video-interpretation-service.js
//
// INT-1D — the orchestrator proving Layer 4 of the INT-1 specification:
//
//   ObservationSet (INT-1C) -> Interpretation
//
// THE EVIDENCE CHAIN (Part 3) IS VALIDATED, NEVER ASSUMED: before any
// provider is ever called, this file confirms observationSet.measurementsId
// === measurements.id === the caller's measurementsId, and
// measurements.referenceVideoId === the caller's referenceVideoId. Any
// break in that chain is INTERPRETATION_EVIDENCE_MISSING — there is no
// path to a persisted Interpretation that skips this check.
//
// PART 5's LLM BOUNDARY, enforced by construction: this file builds the
// ENTIRE InterpretationInput itself, from already-persisted Measurements/
// Observations only, and hands it to `provider.interpret(input)` — the
// provider (fake or real) never receives a projectId, a file path, or
// anything it could use to re-derive more evidence than it was given.
//
// PART 7 — NO BEST-EFFORT REPAIR: validateProviderResult() below either
// accepts a COMPLETED result whole, or rejects it whole with a diagnostic.
// It never trims a too-long hypothesis, never fabricates a missing
// supportingObservationIds entry, and never clamps a disallowed "HIGH"
// confidence down to MEDIUM — a provider that violates an explicit
// instruction produced INVALID output, full stop.
//
// A REJECTED/INVALID/FAILED RESULT IS NEVER PERSISTED (matching INT-1A's
// own "invalid input never creates a record" precedent) — this function
// returns a transient, unpersisted Interpretation-shaped object with
// status: 'FAILED' and real diagnostics for the caller to see, but
// nothing is written to services/reference-video-interpretation-store.js
// unless the result is genuinely valid.

const crypto = require('crypto');
const projectStore = require('./project-store');
const gate = require('./approval-gate');
const measurementStore = require('./reference-video-measurement-store');
const observationStore = require('./reference-video-observation-store');
const interpretationStore = require('./reference-video-interpretation-store');
const interpretationApprovalStore = require('./reference-video-interpretation-approval-store');
const modelRegistry = require('./reference-video-interpretation-model-registry');
const { createInterpretationInput, assertImplementsInterpretationProviderInterface } = require('./reference-video/interpretation-provider-interface');
const {
  INTERPRETATION_QUESTIONS,
  INTERPRETATION_QUESTION_IDS,
  INTERPRETATION_CONFIDENCE_LEVELS,
  createInterpretation,
  createInterpretationDiagnostic,
  createInterpretationReview,
  createEvidenceReference,
} = require('../schemas/reference-video-interpretation-schema');

// Part 18 — a documented, conservative ~4-characters-per-token heuristic
// (the same rough ratio Anthropic's own pricing FAQ states: "1 token is
// approximately 4 characters"). Never precise, always disclosed as an
// estimate via the persisted audit trail's estimatedCostUsd, never
// silently treated as exact.
const CHARS_PER_TOKEN_ESTIMATE = 4;
// A fixed, conservative output-token estimate (Part 18: "estimated output
// size WHERE POSSIBLE" — a structured JSON interpretation response is
// reliably in the low hundreds of tokens; 800 leaves real headroom without
// requiring a per-call guess this codebase has no way to make accurately
// before the call happens).
const ESTIMATED_OUTPUT_TOKENS = 800;

// Part 11/24 — never an exhaustive NLP intent classifier (out of scope,
// and no such tool exists in this codebase); a targeted, documented
// pattern for the specific unqualified-intent phrasing Part 11 names.
// Hedged phrasing ("is consistent with an attempt to...", "may be
// intended to...") does NOT match this pattern — only unqualified
// assertions of a real person's actual mental state.
const INTENT_CLAIM_PATTERN = /\b(the creator|the editor|the filmmaker|the video\s?maker)\s+(deliberately|intentionally|purposefully|clearly wanted|wanted to|chose to|decided to|meant to)\b/i;
// Part 12/16 — no quality/virality/engagement scoring language anywhere.
const QUALITY_JUDGMENT_PATTERN = /\b(excellent|great|amazing|impressive|compelling|masterful|terrible|viral score|engagement score|quality score|hook score|storytelling score|retention score|editing score)\b/i;
// Part 13 — no recommendations.
const RECOMMENDATION_PATTERN = /\b(evolink should|you should|creators? should|make your videos?|we recommend|i recommend)\b/i;

function diag(code, message) {
  return createInterpretationDiagnostic({ code, message });
}

function containsBannedLanguage(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (INTENT_CLAIM_PATTERN.test(text)) return 'unqualified creator-intent claim';
  if (QUALITY_JUDGMENT_PATTERN.test(text)) return 'quality/virality judgment language';
  if (RECOMMENDATION_PATTERN.test(text)) return 'a recommendation/directive';
  return null;
}

// Part 3/24 — validates the FULL evidence chain before anything else runs.
// Returns { ok:false, diagnostic } or { ok:true, measurements, observationSet }.
function resolveEvidenceChain(projectId, referenceVideoId, measurementsId, observationSetId) {
  const measurements = measurementStore.getMeasurement(projectId, measurementsId);
  if (!measurements) return { ok: false, diagnostic: diag('INTERPRETATION_EVIDENCE_MISSING', `no ReferenceVideoMeasurements found with id "${measurementsId}"`) };
  if (measurements.referenceVideoId !== referenceVideoId) {
    return { ok: false, diagnostic: diag('INTERPRETATION_INPUT_INVALID', `measurements "${measurementsId}" belong to a different reference video than requested`) };
  }
  const observationSet = observationStore.getObservationSet(projectId, observationSetId);
  if (!observationSet) return { ok: false, diagnostic: diag('INTERPRETATION_EVIDENCE_MISSING', `no ObservationSet found with id "${observationSetId}"`) };
  if (observationSet.measurementsId !== measurementsId) {
    return { ok: false, diagnostic: diag('INTERPRETATION_INPUT_INVALID', `ObservationSet "${observationSetId}" was derived from different measurements than requested — evidence chain broken`) };
  }
  return { ok: true, measurements, observationSet };
}

// Part 6 — a small, fixed digest of the most broadly relevant measurement
// numbers, never the entire ReferenceVideoMeasurements record.
function buildMeasurementsDigest(measurements) {
  const digest = {};
  if (measurements.video && measurements.video.technical) digest.durationSeconds = measurements.video.technical.duration;
  if (measurements.shotRhythm) {
    digest.shotCount = measurements.shotRhythm.shotCount;
    digest.shotsPerMinute = measurements.shotRhythm.shotsPerMinute ? measurements.shotRhythm.shotsPerMinute.value : null;
  }
  if (measurements.audio) {
    digest.speechPercentage = measurements.audio.speechPercentage ? measurements.audio.speechPercentage.value : null;
    digest.totalSilenceSeconds = measurements.audio.totalSilenceDuration ? measurements.audio.totalSilenceDuration.value : null;
  }
  if (measurements.transcript) {
    digest.wordsPerMinute = measurements.transcript.wordsPerMinute ? measurements.transcript.wordsPerMinute.value : null;
    digest.totalWords = measurements.transcript.totalWords ? measurements.transcript.totalWords.value : null;
  }
  return digest;
}

// Part 6 — selects only the Observations relevant to this question's
// declared categories. Part 24's defense-in-depth: an Observation whose
// OWN statement contains banned language (which INT-1C's rule registry
// would never legitimately produce) is excluded and reported rather than
// forwarded to a provider — corrupted/anomalous evidence is never passed
// through silently.
function selectRelevantObservations(observationSet, questionId) {
  const question = INTERPRETATION_QUESTIONS[questionId];
  const relevant = observationSet.observations.filter((o) => question.relevantCategories.includes(o.category));
  const excluded = [];
  const clean = relevant.filter((o) => {
    const reason = containsBannedLanguage(o.statement);
    if (reason) {
      excluded.push({ observationId: o.id, reason });
      return false;
    }
    return true;
  });
  return { included: clean, excluded };
}

// Part 18 — the cost estimate, never fabricated. Returns
// { estimatedInputTokens, estimatedOutputTokens, estimatedCostUsd } where
// estimatedCostUsd is null when pricing isn't known for this model.
function estimateInterpretationCost(input, { provider = 'claude', model = 'claude-sonnet-5' } = {}) {
  const estimatedInputTokens = Math.ceil(JSON.stringify(input).length / CHARS_PER_TOKEN_ESTIMATE);
  const estimatedCostUsd = modelRegistry.estimateCostUsd({ provider, model, estimatedInputTokens, estimatedOutputTokens: ESTIMATED_OUTPUT_TOKENS });
  return { estimatedInputTokens, estimatedOutputTokens: ESTIMATED_OUTPUT_TOKENS, estimatedCostUsd };
}

// P0 Hardening (finding J) — this previously mirrored services/keyframe-
// generation-service.js's checkKeyframeBudget() verbatim, including its
// `estimatedCost > remaining` comparison. That comparison is a currency-
// unit-mismatch bug here: approval.estimatedCost is USD (from
// reference-video-interpretation-model-registry.js's estimateCostUsd —
// see the schema's own field comment), while project.creditLedger is
// denominated in EvoLink credits (approval-gate.js). A $0.01 USD estimate
// and a 0.01-credit estimate are not the same amount of money, and no
// verified USD -> credits conversion rate exists anywhere in this codebase
// (Rule 8: never invent one to make an incompatible comparison "work").
// The prior comparison could therefore let a real, unbounded USD spend
// through as long as the raw number looked small next to the remaining
// credit figure — the definition of "money without a real ceiling" (Rule
// 6/7). The only honest fix: a non-null (known) USD estimate is exactly as
// incomparable to the credit ledger as a genuinely unknown one, so it
// requires the SAME explicit human unknownCostAcknowledged acknowledgment
// this function already required for a null estimate — a human looking at
// the real USD figure (visible on the approval record) confirms they
// understand it is a real-currency charge, not a credits charge, before
// interpretReferenceVideo() may call the provider.
function checkInterpretationBudget(project, approval) {
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
          : `Estimated cost ($${approval.estimatedCost} USD) is denominated in a different currency than the project's credit budget, with no verified conversion rate available — it cannot be validated against the remaining credit budget and must be explicitly acknowledged by a human (policy: ${gate.UNKNOWN_COST_POLICY}) before this interpretation can proceed.`,
    };
  }
  return { allowed: true, reason: null };
}

// Public entry point for Part 18's PRE-CALL gate — builds the input,
// estimates cost, and requests (but does not decide) approval. A human
// (or test) must separately call interpretationApprovalStore.decideApproval
// before interpretReferenceVideo() below will proceed — mirrors
// request_keyframe_generation_approval / approve_keyframe_generation's
// two-step, explicit-human-action convention exactly.
function requestInterpretationApproval(projectId, { referenceVideoId, measurementsId, observationSetId, questionId, provider = 'claude', model = 'claude-sonnet-5', requestedBy } = {}) {
  if (!projectStore.getProject(projectId)) return { ok: false, reason: `No project found with id "${projectId}"` };
  if (!INTERPRETATION_QUESTION_IDS.includes(questionId)) return { ok: false, reason: `"${questionId}" is not a recognized interpretation question` };

  const chain = resolveEvidenceChain(projectId, referenceVideoId, measurementsId, observationSetId);
  if (!chain.ok) return { ok: false, reason: chain.diagnostic.message, diagnostic: chain.diagnostic };

  const { included } = selectRelevantObservations(chain.observationSet, questionId);
  const input = createInterpretationInput({
    questionId,
    question: INTERPRETATION_QUESTIONS[questionId].text,
    referenceVideo: { title: null, description: null, platform: null }, // Part 6 — title/description are intentionally NOT looked up here; only the caller's own explicit metadata argument (not implemented in this stage — see final report's known-scope note) would populate this
    measurements: buildMeasurementsDigest(chain.measurements),
    observations: included.map((o) => ({ observationId: o.id, category: o.category, statement: o.statement, confidence: o.confidence })),
  });

  const costEstimate = estimateInterpretationCost(input, { provider, model });
  const approval = interpretationApprovalStore.requestApproval(projectId, referenceVideoId, questionId, {
    estimatedCost: costEstimate.estimatedCostUsd,
    reason: `Interpretation call for question "${questionId}" (${input.observations.length} observations, ~${costEstimate.estimatedInputTokens} estimated input tokens)`,
    requestedBy,
  });
  return { ok: true, approval, costEstimate, input };
}

// The actual interpretation call.
async function interpretReferenceVideo(projectId, { referenceVideoId, measurementsId, observationSetId, questionId, provider, providerName = 'claude', model = 'claude-sonnet-5' } = {}) {
  if (!projectStore.getProject(projectId)) {
    return createInterpretation({ projectId, referenceVideoId, status: 'FAILED', diagnostics: [diag('INTERPRETATION_INPUT_INVALID', `no project found with id "${projectId}"`)] });
  }
  if (!INTERPRETATION_QUESTION_IDS.includes(questionId)) {
    return createInterpretation({ projectId, referenceVideoId, status: 'FAILED', diagnostics: [diag('INTERPRETATION_INPUT_INVALID', `"${questionId}" is not a recognized interpretation question`)] });
  }

  const chain = resolveEvidenceChain(projectId, referenceVideoId, measurementsId, observationSetId);
  if (!chain.ok) {
    return createInterpretation({ projectId, referenceVideoId, measurementsId, observationSetId, status: 'FAILED', diagnostics: [chain.diagnostic] });
  }

  const { included, excluded } = selectRelevantObservations(chain.observationSet, questionId);
  if (included.length === 0) {
    return createInterpretation({
      projectId,
      referenceVideoId,
      measurementsId,
      observationSetId,
      status: 'FAILED',
      diagnostics: [diag('INTERPRETATION_EVIDENCE_MISSING', `no relevant, valid observations are available for question "${questionId}"${excluded.length > 0 ? ` (${excluded.length} excluded for containing banned language: ${excluded.map((e) => e.reason).join('; ')})` : ''}`)],
    });
  }

  const input = createInterpretationInput({
    questionId,
    question: INTERPRETATION_QUESTIONS[questionId].text,
    referenceVideo: { title: null, description: null, platform: null },
    measurements: buildMeasurementsDigest(chain.measurements),
    observations: included.map((o) => ({ observationId: o.id, category: o.category, statement: o.statement, confidence: o.confidence })),
  });

  // --- Part 18 — the cost gate. Must already be APPROVED. ---
  const project = projectStore.getProject(projectId);
  const approval = interpretationApprovalStore.getApproval(projectId, referenceVideoId, questionId);
  if (approval.status !== 'APPROVED') {
    return createInterpretation({
      projectId,
      referenceVideoId,
      measurementsId,
      observationSetId,
      status: 'FAILED',
      diagnostics: [diag('INTERPRETATION_COST_BLOCKED', 'No explicit interpretation approval. Call requestInterpretationApproval and decide it (interpretationApprovalStore.decideApproval) before interpreting.')],
    });
  }
  const budgetCheck = checkInterpretationBudget(project, approval);
  if (!budgetCheck.allowed) {
    return createInterpretation({ projectId, referenceVideoId, measurementsId, observationSetId, status: 'FAILED', diagnostics: [diag('INTERPRETATION_COST_BLOCKED', budgetCheck.reason)] });
  }

  // --- provider call ---
  try {
    assertImplementsInterpretationProviderInterface(provider);
  } catch (error) {
    return createInterpretation({ projectId, referenceVideoId, measurementsId, observationSetId, status: 'FAILED', diagnostics: [diag('INTERPRETATION_PROVIDER_UNAVAILABLE', error.message)] });
  }

  // P0-HARDENING-2, Part 6/7/12 — reserve Anthropic USD exposure BEFORE
  // the billed call, in its own explicitly-labelled sub-ledger — never
  // merged with the credits ledger above (Part 7). approval.estimatedCost
  // is the same estimate checkInterpretationBudget already required a
  // human to approve/acknowledge; reserving it here is bookkeeping, not a
  // second budget check (there is no numeric USD ceiling anywhere in this
  // codebase to enforce against — see approval-gate.js's reserveBudget).
  const anthropicOperationId = crypto.randomUUID();
  await gate.reserveBudget(projectId, {
    jobId: anthropicOperationId,
    provider: 'anthropic',
    operation: questionId,
    amount: approval.estimatedCost,
    currency: 'usd',
    unknownCostAcknowledged: approval.unknownCostAcknowledged,
  });

  const requestedAt = new Date().toISOString();
  let result;
  try {
    result = await provider.interpret(input);
  } catch (error) {
    // The provider threw before returning any structured result at all —
    // no HTTP response was ever received (see claude-interpretation-
    // provider.js's own try/catch, which normally converts this into a
    // TIMEOUT/FAILED result instead of throwing). Genuinely ambiguous
    // whether Anthropic's servers processed anything billable, so this is
    // settled UNKNOWN, never released (Part 1 Rule 12).
    await gate.settleUsdSpend(projectId, { jobId: anthropicOperationId, provider: 'anthropic', operation: questionId, amount: null, note: `Provider threw before returning a result: ${error.message}` });
    return createInterpretation({ projectId, referenceVideoId, measurementsId, observationSetId, status: 'FAILED', diagnostics: [diag('INTERPRETATION_FAILED', `provider threw: ${error.message}`)] });
  }
  const respondedAt = new Date().toISOString();

  // P0-HARDENING-2, Part 12 — real usage, when the provider reported one,
  // converted to a real actual cost via the SAME registry function that
  // produced the estimate — never replacing estimatedCostUsd, always
  // alongside it (see createInterpretationAuditTrail's own comment).
  const actualCostUsd = result.usage ? modelRegistry.estimateCostUsd({ provider: providerName, model: result.model || model, estimatedInputTokens: result.usage.inputTokens, estimatedOutputTokens: result.usage.outputTokens }) : null;

  if (result.status !== 'COMPLETED') {
    if (result.status === 'UNAVAILABLE') {
      // Confirmed never reached the provider (e.g. no API key configured
      // — see claude-interpretation-provider.js) — safe to release.
      await gate.releaseReservation(projectId, { jobId: anthropicOperationId, provider: 'anthropic', currency: 'usd', amount: approval.estimatedCost, note: 'Provider reported UNAVAILABLE; never actually called.' });
    } else if (result.usage) {
      // INVALID with real usage attached: the HTTP call DID reach
      // Anthropic and WAS billed — this adapter's own parsing of the
      // model's JSON content failed, not the API call itself.
      await gate.settleUsdSpend(projectId, { jobId: anthropicOperationId, provider: 'anthropic', operation: questionId, amount: actualCostUsd, note: `Provider returned status ${result.status} but reported real usage; response reached Anthropic and was billed.` });
    } else {
      // TIMEOUT/FAILED/INVALID-without-usage: genuinely ambiguous whether
      // Anthropic processed and billed this request. Settled UNKNOWN,
      // never released (Part 1 Rule 12/13).
      await gate.settleUsdSpend(projectId, { jobId: anthropicOperationId, provider: 'anthropic', operation: questionId, amount: null, note: `Provider returned status ${result.status}; outcome/billing cannot be confirmed from here.` });
    }
    const codeByStatus = { UNAVAILABLE: 'INTERPRETATION_PROVIDER_UNAVAILABLE', TIMEOUT: 'INTERPRETATION_TIMEOUT', INVALID: 'INTERPRETATION_INVALID', FAILED: 'INTERPRETATION_FAILED' };
    const code = codeByStatus[result.status] || 'INTERPRETATION_FAILED';
    const message = (result.diagnostics[0] && result.diagnostics[0].message) || `provider returned status ${result.status}`;
    return createInterpretation({ projectId, referenceVideoId, measurementsId, observationSetId, status: 'FAILED', diagnostics: [diag(code, message)] });
  }

  // --- Part 7 — strict structural + semantic validation, no repair ---
  const validation = validateProviderResult(result, included);
  if (!validation.ok) {
    // Anthropic was genuinely called and billed for a COMPLETED response
    // that this codebase's own stricter validation then rejected — settle
    // with whatever real usage was reported, never released.
    await gate.settleUsdSpend(projectId, { jobId: anthropicOperationId, provider: 'anthropic', operation: questionId, amount: actualCostUsd, note: `Provider result rejected by local validation: ${validation.reason}` });
    return createInterpretation({ projectId, referenceVideoId, measurementsId, observationSetId, status: 'FAILED', diagnostics: [diag('INTERPRETATION_INVALID', validation.reason)] });
  }

  await gate.settleUsdSpend(projectId, { jobId: anthropicOperationId, provider: 'anthropic', operation: questionId, amount: actualCostUsd, note: actualCostUsd == null ? 'Provider completed but reported no usage; actual cost stays UNKNOWN.' : null });

  const observationById = new Map(included.map((o) => [o.id, o]));
  const evidenceRef = (id) => {
    const o = observationById.get(id);
    return createEvidenceReference({ observationId: id, category: o.category, statement: o.statement });
  };

  const interpretation = createInterpretation({
    projectId,
    referenceVideoId,
    measurementsId,
    observationSetId,
    question: INTERPRETATION_QUESTIONS[questionId].text,
    hypothesis: result.hypothesis,
    reasoning: result.reasoning,
    supportingEvidence: result.supportingObservationIds.map(evidenceRef),
    counterEvidence: result.counterObservationIds.map((id) => ({ observationId: id, note: (observationById.get(id) || {}).statement || '' })),
    alternativeHypotheses: result.alternativeHypotheses,
    confidence: result.confidence,
    limitations: result.limitations,
    audit: {
      questionId,
      suppliedObservationIds: included.map((o) => o.id),
      provider: providerName,
      model: result.model || model,
      requestedAt,
      respondedAt,
      estimatedCostUsd: approval.estimatedCost,
      actualInputTokens: result.usage ? result.usage.inputTokens : null,
      actualOutputTokens: result.usage ? result.usage.outputTokens : null,
      actualCostUsd,
    },
    status: 'PENDING_REVIEW',
  });

  const saved = interpretationStore.addInterpretation(projectId, interpretation);
  return saved.ok ? saved.interpretation : interpretation;
}

// Part 7 — every check here rejects the WHOLE result; nothing is trimmed,
// defaulted, or clamped.
function validateProviderResult(result, includedObservations) {
  if (typeof result.hypothesis !== 'string' || result.hypothesis.trim().length === 0) return { ok: false, reason: 'hypothesis is missing or empty' };
  if (typeof result.reasoning !== 'string' || result.reasoning.trim().length === 0) return { ok: false, reason: 'reasoning is missing or empty' };
  if (!Array.isArray(result.supportingObservationIds) || result.supportingObservationIds.length === 0) {
    return { ok: false, reason: 'supportingObservationIds must be a non-empty array — an interpretation without evidence is invalid (Part 3)' };
  }
  if (!INTERPRETATION_CONFIDENCE_LEVELS.includes(result.confidence)) {
    return { ok: false, reason: `confidence must be one of ${INTERPRETATION_CONFIDENCE_LEVELS.join('/')} — a provider claiming HIGH (or anything else) violates the required contract and is rejected outright, never clamped` };
  }

  const validIds = new Set(includedObservations.map((o) => o.id));
  const fabricatedSupporting = result.supportingObservationIds.filter((id) => !validIds.has(id));
  if (fabricatedSupporting.length > 0) return { ok: false, reason: `supportingObservationIds references id(s) not present in the supplied evidence: ${fabricatedSupporting.join(', ')}` };
  const fabricatedCounter = (result.counterObservationIds || []).filter((id) => !validIds.has(id));
  if (fabricatedCounter.length > 0) return { ok: false, reason: `counterObservationIds references id(s) not present in the supplied evidence: ${fabricatedCounter.join(', ')}` };

  const textsToScan = [result.hypothesis, result.reasoning, ...(result.alternativeHypotheses || []).flatMap((a) => [a.hypothesis, a.reasoning]), ...(result.limitations || [])];
  for (const text of textsToScan) {
    const reason = containsBannedLanguage(text);
    if (reason) return { ok: false, reason: `output contains ${reason}: "${text}"` };
  }
  return { ok: true };
}

// Part 19 — human review. ACCEPT/REJECT update the SAME record's status
// (no content changes to preserve). EDIT creates a brand-new record with
// the human's text, links back via supersedesInterpretationId, and marks
// the original SUPERSEDED — the original machine output is never
// overwritten. REQUEST_ALTERNATIVE only records the request; it does not
// automatically spend again.
function reviewInterpretation(projectId, interpretationId, { decision, reviewedBy, note, editedHypothesis, editedReasoning } = {}) {
  const original = interpretationStore.getInterpretation(projectId, interpretationId);
  if (!original) return { ok: false, reason: `no Interpretation found with id "${interpretationId}"` };

  if (decision === 'ACCEPT') {
    interpretationStore.updateReviewState(projectId, interpretationId, { status: 'ACCEPTED', review: createInterpretationReview({ decision, reviewedBy, note }) });
    return { ok: true, interpretation: interpretationStore.getInterpretation(projectId, interpretationId) };
  }
  if (decision === 'REJECT') {
    interpretationStore.updateReviewState(projectId, interpretationId, { status: 'REJECTED', review: createInterpretationReview({ decision, reviewedBy, note }) });
    return { ok: true, interpretation: interpretationStore.getInterpretation(projectId, interpretationId) };
  }
  if (decision === 'REQUEST_ALTERNATIVE') {
    interpretationStore.updateReviewState(projectId, interpretationId, { review: createInterpretationReview({ decision, reviewedBy, note }) });
    return { ok: true, interpretation: interpretationStore.getInterpretation(projectId, interpretationId) };
  }
  if (decision === 'EDIT') {
    if (typeof editedHypothesis !== 'string' || editedHypothesis.trim().length === 0) return { ok: false, reason: 'editedHypothesis is required for an EDIT review' };
    const bannedReason = containsBannedLanguage(editedHypothesis) || containsBannedLanguage(editedReasoning || '');
    if (bannedReason) return { ok: false, reason: `edited text contains ${bannedReason} — the same constraints apply to human edits` };

    const edited = createInterpretation({
      ...original,
      id: undefined, // force a fresh id
      hypothesis: editedHypothesis,
      reasoning: typeof editedReasoning === 'string' ? editedReasoning : original.reasoning,
      status: 'ACCEPTED',
      supersedesInterpretationId: original.id,
      reviews: [],
      createdAt: undefined,
    });
    const saved = interpretationStore.addInterpretation(projectId, edited);
    interpretationStore.updateReviewState(projectId, interpretationId, {
      status: 'SUPERSEDED',
      review: createInterpretationReview({ decision, reviewedBy, note, resultingInterpretationId: saved.interpretation.id }),
    });
    return { ok: true, interpretation: saved.interpretation, original: interpretationStore.getInterpretation(projectId, interpretationId) };
  }
  return { ok: false, reason: `"${decision}" is not a recognized review decision` };
}

module.exports = {
  requestInterpretationApproval,
  interpretReferenceVideo,
  reviewInterpretation,
  checkInterpretationBudget,
  estimateInterpretationCost,
  resolveEvidenceChain,
  selectRelevantObservations,
  containsBannedLanguage,
  buildMeasurementsDigest,
  validateProviderResult,
};
