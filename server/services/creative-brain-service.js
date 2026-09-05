// creative-brain-service.js
//
// CREATIVE BRAIN — the ONE operator entry point. Coordinates the already-
// built specialist pieces (services/creative-brain/creative-synthesis-
// service.js's two LLM calls, services/creative-brain/creative-
// evaluation-service.js's 8-dimension checks) into ONE real, persisted
// CreativeBlueprint via the EXISTING, UNMODIFIED-IN-SPIRIT
// buildCreativeBlueprintDraft() (services/creative-blueprint-service.js
// — extended only additively to accept this file's new fields; see that
// file's own comment at the call site). This file is coordination ONLY:
// no creative reasoning, no evidence fabrication, no second Blueprint
// representation (this stage's own sign-off, locked: "CreativeBlueprint
// remains the canonical creative object — no parallel Creative Brain
// Output abstraction").
//
// THE CORRECTED SELECTION RULE (this stage's sign-off, locked): if every
// generated angle candidate fails evaluation, the STRONGEST candidate
// (fewest FAILs) is still selected and a real Blueprint is still
// persisted — carrying the FAIL diagnostics, which the EXISTING
// BLOCKING_DIAGNOSTIC_CODES gate already prevents from ever reaching
// APPROVED. Never ALL_CANDIDATES_REJECTED-and-nothing-persisted. Never a
// false PASS. Never silently discarded.

const projectStore = require('./project-store');
const recommendationStore = require('./recommendation-store');
const humanVoiceProfileStore = require('./human-voice-profile-store');
const creativeBrainApprovalStore = require('./creative-brain-approval-store');
const creativeBlueprintService = require('./creative-blueprint-service');
const synthesisService = require('./creative-brain/creative-synthesis-service');
const evaluationService = require('./creative-brain/creative-evaluation-service');
const { createCreativeAngleCandidate, createCreativeEvaluationResult, createHumanVoiceInfluence } = require('../schemas/creative-blueprint-schema');

const MAX_VOICE_PATTERNS_PER_DIMENSION = 3; // token-budget cap (Part 28 — cost stays bounded regardless of corpus size)

// Recommendations with INSUFFICIENT_EVIDENCE are never handed to the LLM
// as usable evidence — mirrors creative-blueprint-service.js's own
// INSUFFICIENT_EVIDENCE_RECOMMENDATION rule (Part 6 forensic finding).
function selectUsableRecommendations(recommendationSet) {
  return (recommendationSet.recommendations || []).filter((r) => r.evidenceSufficiency !== 'INSUFFICIENT_EVIDENCE');
}

function toRecommendationEvidence(recommendations) {
  return recommendations.map((r) => ({ recommendationId: r.id, statement: r.statement, rationale: r.rationale, evidenceSufficiency: r.evidenceSufficiency }));
}

function toVoicePatternEvidence(profile) {
  if (!profile) return [];
  const evidence = [];
  const { VOICE_PATTERN_DIMENSIONS } = require('../schemas/human-voice-profile-schema');
  for (const dimension of VOICE_PATTERN_DIMENSIONS) {
    const entries = (profile[dimension] || []).slice().sort((a, b) => b.supportCount - a.supportCount).slice(0, MAX_VOICE_PATTERNS_PER_DIMENSION);
    for (const entry of entries) evidence.push({ dimension, pattern: entry.pattern, supportCount: entry.supportCount, patternId: entry.id });
  }
  return evidence;
}

// Fewest-FAIL selection (Part 24's corrected rule) — ties broken by
// original candidate order (first generated wins), never randomly.
function selectStrongestCandidate(candidatesWithResults) {
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

// One FAIL result -> one blueprint diagnostic, using the exact code the
// evaluation dimension already produced (the 10 anti-slop codes added to
// CREATIVE_BLUEPRINT_DIAGNOSTIC_CODES/BLOCKING_DIAGNOSTIC_CODES).
function evaluationResultsToDiagnostics(results) {
  return results.filter((r) => r.result === 'FAIL' && r.code).map((r) => ({ code: r.code, message: r.detail }));
}

async function generateCreativeBlueprint(projectId, options = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `no project found with id "${projectId}"` };

  const { referenceSetId, recommendationSetId, humanVoiceProfileId, topic, format, targetDuration, candidateCount = 3, provider, requestedBy, strategyId, selectedIdea, selectedPackage } = options;

  const recommendationSet = recommendationSetId
    ? recommendationStore.getRecommendationSet(projectId, recommendationSetId)
    : referenceSetId
    ? recommendationStore.getLatestRecommendationSetForReferenceSet(projectId, referenceSetId)
    : null;
  if (!recommendationSet || recommendationSet.projectId !== projectId) {
    return { ok: false, code: 'INVALID_RECOMMENDATION_SET', reason: `no RecommendationSet found for referenceSetId "${referenceSetId}" / recommendationSetId "${recommendationSetId}"` };
  }

  if (typeof topic !== 'string' || topic.trim().length === 0) {
    return { ok: false, code: 'MISSING_TOPIC', reason: 'topic is required' };
  }

  const usableRecommendations = selectUsableRecommendations(recommendationSet);
  if (usableRecommendations.length === 0) {
    return { ok: false, code: 'NO_USABLE_RECOMMENDATIONS', reason: 'every Recommendation in this RecommendationSet has INSUFFICIENT_EVIDENCE — Creative Brain cannot generate an evidence-grounded angle' };
  }
  const recommendationEvidence = toRecommendationEvidence(usableRecommendations);

  let humanVoiceProfile = null;
  if (humanVoiceProfileId) {
    humanVoiceProfile = humanVoiceProfileStore.getHumanVoiceProfile(projectId, humanVoiceProfileId);
    if (!humanVoiceProfile) return { ok: false, code: 'HUMAN_VOICE_PROFILE_NOT_FOUND', reason: `no HumanVoiceProfile found with id "${humanVoiceProfileId}"` };
  }
  const voicePatternEvidence = toVoicePatternEvidence(humanVoiceProfile);

  // --- FINANCIAL GATE (Part 21/28) — never auto-approved, never bypassed
  const input = { topic, format, targetDuration, candidateCount, recommendations: recommendationEvidence, voicePatterns: voicePatternEvidence };
  let approval = creativeBrainApprovalStore.getApproval(projectId, recommendationSet.id);
  if (approval.status === 'NONE') {
    approval = synthesisService.requestCreativeBrainApproval(projectId, recommendationSet.id, { input, requestedBy });
  }
  if (approval.status !== 'APPROVED') {
    return { ok: false, code: 'CREATIVE_BRAIN_APPROVAL_REQUIRED', reason: `Creative Brain generation requires human approval (current status: ${approval.status}) — estimated cost: ${approval.estimatedCost != null ? `$${approval.estimatedCost} USD` : 'unknown'}`, approval };
  }
  const budgetCheck = synthesisService.checkCreativeBrainBudget(project, approval);
  if (!budgetCheck.allowed) {
    return { ok: false, code: 'BUDGET_APPROVAL_REQUIRED', reason: `Creative Brain generation blocked by budget/approval gate: ${budgetCheck.reason}` };
  }

  // --- STAGE 1: candidate generation (Part 24 — ONE call, N candidates)
  const candidatesResult = await synthesisService.generateAngleCandidates(projectId, { topic, format, targetDuration, candidateCount, recommendations: recommendationEvidence, voicePatterns: voicePatternEvidence, provider });
  if (candidatesResult.status !== 'COMPLETED' || candidatesResult.candidates.length === 0) {
    return { ok: false, code: 'CANDIDATE_GENERATION_FAILED', reason: `angle candidate generation did not complete (status: ${candidatesResult.status})`, diagnostics: candidatesResult.diagnostics };
  }

  // --- STAGE 2: independent evaluation of each candidate (Part 25) -----
  const candidatesWithResults = candidatesResult.candidates.map((c) => ({ candidate: c, results: evaluationService.evaluateCandidate(c, { topic, recommendations: recommendationEvidence, voicePatterns: voicePatternEvidence }) }));
  const { best, allPassed } = selectStrongestCandidate(candidatesWithResults);

  // --- STAGE 3: direction synthesis for the selected angle only --------
  const directionResult = await synthesisService.synthesizeDirection(projectId, { topic, format, targetDuration, selectedAngle: best.candidate, recommendations: recommendationEvidence, voicePatterns: voicePatternEvidence, provider });
  if (directionResult.status !== 'COMPLETED') {
    return { ok: false, code: 'DIRECTION_SYNTHESIS_FAILED', reason: `direction synthesis did not complete (status: ${directionResult.status})`, diagnostics: directionResult.diagnostics };
  }

  // --- STAGE 4: full 8-dimension evaluation of the synthesized direction
  const directionResults = evaluationService.evaluateDirection(best.candidate, directionResult, { topic, recommendations: recommendationEvidence, voicePatterns: voicePatternEvidence });

  const candidates = candidatesWithResults.map(({ candidate, results }) =>
    createCreativeAngleCandidate({ ...candidate, selected: candidate === best.candidate, evaluationResults: results.map((r) => createCreativeEvaluationResult(r)) })
  );

  const humanVoiceInfluences = voicePatternEvidence.map((v) => createHumanVoiceInfluence({ patternId: v.patternId, howUsed: `Surfaced as a ${v.dimension} signal (support count ${v.supportCount}) during creative synthesis.` }));

  const recommendationDecisions = usableRecommendations.map((r) => ({
    recommendationId: r.id,
    decision: 'ACCEPT',
    decidedBy: 'creative-brain',
    finalCreativeDecision: 'Used as evidence for this Blueprint\'s Creative Angle (auto-generated by Creative Brain).',
  }));

  const additionalDiagnostics = evaluationResultsToDiagnostics(directionResults);

  // PHASE 1 EDITORIAL SPINE — Strategy -> Idea -> Package -> Angle ->
  // Blueprint. Angle generation/evaluation/selection above (Stages 1-4) is
  // UNCHANGED and always runs — a Package never replaces the angle work,
  // it only becomes the AUTHORITATIVE source for the Blueprint's own
  // identity fields once one exists (phase brief, Part 4: "the Blueprint
  // should no longer invent a title independently when a selected package
  // already exists"). Ordering rationale: the angle stage still supplies
  // narrativeStrategy/pacingStrategy/visualStrategy/emotionalArc/
  // visualSpecification/narrationText — none of which Packaging generates
  // — so discarding Stage 1-4 entirely would lose real, already-working
  // production-direction synthesis for no benefit; overriding only the
  // title/corePromise/hookStrategy fields a Package actually replaces is
  // the smaller, additive change.
  const blueprint = creativeBlueprintService.buildCreativeBlueprintDraft(projectId, {
    referenceSetId: recommendationSet.referenceSetId,
    recommendationSetId: recommendationSet.id,
    strategyId: strategyId || null,
    ideaId: selectedIdea ? selectedIdea.ideaId : null,
    packageId: selectedPackage ? selectedPackage.packageId : null,
    title: selectedPackage ? selectedPackage.title : best.candidate.concept,
    concept: best.candidate.concept,
    corePromise: selectedPackage ? selectedPackage.promise : best.candidate.corePromise,
    format: format || null,
    targetDuration: typeof targetDuration === 'number' ? targetDuration : null,
    hookStrategy: selectedPackage && selectedPackage.curiosityMechanism ? selectedPackage.curiosityMechanism : best.candidate.hookStrategy,
    narrativeStrategy: directionResult.narrativeStrategy,
    pacingStrategy: directionResult.pacingStrategy,
    visualStrategy: directionResult.visualDirection,
    narrationStrategy: directionResult.narrationStrategy,
    tone: directionResult.tone,
    emotionalArc: directionResult.emotionalArc,
    visualDirection: directionResult.visualDirection,
    visualSpecification: directionResult.visualSpecification,
    narrationDirection: { narrationText: directionResult.narrationText },
    recommendationDecisions,
    humanVoiceProfileId: humanVoiceProfile ? humanVoiceProfile.id : null,
    humanVoiceInfluences,
    candidates,
    evaluationResults: directionResults.map((r) => createCreativeEvaluationResult(r)),
    additionalDiagnostics,
  });

  return { ok: true, blueprint, allCandidatesPassed: allPassed, candidatesGenerated: candidatesResult.candidates.length };
}

module.exports = { generateCreativeBlueprint, selectUsableRecommendations, toRecommendationEvidence, toVoicePatternEvidence, selectStrongestCandidate };
