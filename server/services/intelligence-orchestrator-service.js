// intelligence-orchestrator-service.js
//
// P0-INTEL — the INTELLIGENCE ORCHESTRATOR. Coordinates the six already-
// built, separate intelligence stages into one operator-driven run:
//
//   ingestReferenceVideo()      (INT-1A, services/reference-video-
//                                 ingestion-service.js)
//   measureReferenceVideo()     (INT-1B, services/reference-video-
//                                 measurement-service.js)
//   deriveObservations()        (INT-1C, services/reference-video-
//                                 observation-service.js)
//   interpretReferenceVideo()   (INT-1D, services/reference-video-
//                                 interpretation-service.js — OPTIONAL,
//                                 see below)
//   extractPatterns()           (INT-1E, services/cross-video-pattern-
//                                 service.js)
//   generateRecommendations()   (INT-1F, services/recommendation-
//                                 service.js)
//
// This file is coordination ONLY — same discipline as services/
// production-orchestrator-service.js's own header: no ingestion algorithm,
// no ffprobe/ffmpeg invocation, no observation rule, no interpretation
// prompt, no pattern-extraction math, no recommendation logic lives here.
// Every one of those already exists in its own service; this file only
// calls them in the real dependency order (verified by direct forensic
// inspection — see this stage's final report, Part 3), persists an
// IntelligenceRun between steps, and reports structured progress/failure.
//
// FORENSIC FINDING THAT SHAPES THIS FILE (Part 3/11 of this stage's own
// spec: "do not assume the conceptual sequence is identical to the
// implementation" / "the orchestrator must respect [INT-1D's] existing
// approval/review conditions"): services/cross-video-pattern-service.js's
// extractPatterns() reads each ReferenceSet member's latest Measurements
// and ObservationSet DIRECTLY — it does not read Interpretations at all,
// and neither does services/recommendation-service.js. Interpretation
// (INT-1D) is therefore a genuinely OPTIONAL, PARALLEL branch off
// Observation, not a hard sequential prerequisite of Patterning/
// Recommendation in the real, current codebase. This file preserves that
// truth rather than inventing a dependency that does not exist: an
// IntelligenceRun can reach COMPLETE (real PatternSet + RecommendationSet)
// whether or not interpretation for any given video has been requested,
// approved, or completed. When interpretation IS requested, its own real
// approval-gate/cost/review semantics (interpretationApprovalStore,
// approval-gate.js reserve/settle) are followed exactly as INT-1D already
// implements them — this file never auto-approves, never lowers a
// threshold, and never fabricates a result when approval is missing.
//
// APPROVAL BOUNDARY: none of INT-1A/B/C/E/F require human approval before
// running (verified — no approval-gate call in measurement/observation/
// pattern/recommendation services; INT-1A's Apify calls are gated by the
// EXISTING budget check inside ingestReferenceVideo() itself, untouched
// here). Only INT-1D interpretation requires human cost approval — this
// file calls requestInterpretationApproval() to create the request, then
// only calls interpretReferenceVideo() if that approval is ALREADY
// APPROVED with unknownCostAcknowledged=true (i.e. a human already acted
// on it, via interpretationApprovalStore.decideApproval() /
// acknowledgeUnknownCost() — this file never calls either of those
// itself). This mirrors production-orchestrator-service.js's own
// "generated-new-executor.js escalates instead of auto-generating"
// discipline for the one stage in ITS chain that needs human authorization.
//
// IDEMPOTENCY / RESUMABILITY: services/reference-video-measurement-
// store.js and services/reference-video-observation-store.js are NOT
// idempotent — re-calling measureReferenceVideo()/deriveObservations()
// for the same input always appends a new record (verified — see their
// own store files' add* functions). This file supplies the idempotency
// those stores don't: it persists each stage's resulting id onto the
// IntelligenceRun's own videoProgress[] entry immediately, and every
// resumeIntelligenceRun() call skips any stage whose id is already
// recorded — exactly the same "presence of a persisted artifact means do
// not redo the expensive step" discipline production-orchestrator-
// service.js's own beatProgress[] already established.
//
// FINANCIAL BOUNDARY: this file calls zero provider APIs directly. Every
// paid call (Apify inside ingestReferenceVideo(), Anthropic inside
// interpretReferenceVideo()) remains entirely inside its own existing
// service, wrapped by that service's own existing approval-gate.js
// reserve/settle/release calls — untouched, unduplicated, un-bypassed.

const path = require('path');
const { fork } = require('child_process');

const projectStore = require('./project-store');
const referenceSetStore = require('./reference-set-store');
const referenceSetService = require('./reference-set-service');
const referenceVideoStore = require('./reference-video-store');
const { ingestReferenceVideo } = require('./reference-video-ingestion-service');
const { measureReferenceVideo } = require('./reference-video-measurement-service');
const { deriveObservations } = require('./reference-video-observation-service');
const interpretationApprovalStore = require('./reference-video-interpretation-approval-store');
const { requestInterpretationApproval, interpretReferenceVideo } = require('./reference-video-interpretation-service');
const patternStore = require('./cross-video-pattern-store');
const { extractPatterns } = require('./cross-video-pattern-service');
const recommendationStore = require('./recommendation-store');
const { generateRecommendations } = require('./recommendation-service');
const intelligenceRunStore = require('./intelligence-run-store');
const { createIntelligenceDiagnostic, createVideoProgress, createInterpretationProgress } = require('../schemas/intelligence-run-schema');

const NON_TERMINAL_STATUSES = ['REQUESTED', 'INGESTING', 'MEASURING', 'OBSERVING', 'INTERPRETING', 'PATTERNING', 'RECOMMENDING'];

function diag(stage, code, message, referenceVideoId = null) {
  return createIntelligenceDiagnostic({ stage, code, message, referenceVideoId });
}

// Every mutation of the in-memory run is followed by an immediate persist
// — the resumability checkpoint (Part 15). Never batched.
function persist(run, patch) {
  return intelligenceRunStore.updateIntelligenceRun(run.intelligenceRunId, { ...run, ...patch });
}

function fail(run, stage, code, message) {
  const failed = persist(run, {
    status: 'FAILED',
    failureStage: stage,
    diagnostics: [...run.diagnostics, diag(stage, code, message)],
  });
  return { ok: false, run: failed };
}

// Public entry point. Idempotent per project (Part 14 — mirrors
// startProduction()'s own "reuse a non-terminal job for this project"
// convention exactly): a second call while a run is still in progress
// resumes that SAME run rather than starting a duplicate one.
//
//   options:
//     referenceVideoUrls?: string[]  — new videos to ingest into a fresh
//       or existing ReferenceSet. At least one of referenceVideoUrls /
//       referenceSetId is required — Part 4's forensic finding: this
//       pipeline operates on reference videos, never a bare topic string,
//       and no video-discovery capability exists anywhere in this
//       codebase to invent one from.
//     referenceSetId?: string        — reuse an existing ReferenceSet
//       (its current members are analysed; referenceVideoUrls, if also
//       given, are ingested and ADDED to it).
//     name?, description?            — used only when a NEW ReferenceSet
//       is created (no referenceSetId given).
//     interpretationQuestions?: string[] — which INT-1D questionIds to
//       attempt per video. Defaults to [] — interpretation is opt-in,
//       never attempted unless explicitly requested (Hard Rule: never
//       trigger a paid call the caller didn't ask for).
//     acquisitionProvider?, fetchImpl?, interpretationProvider?,
//     interpretationProviderName?, interpretationModel? — provider
//       overrides for controlled testing only (see
//       startIntelligenceRunAsync()'s own header for why these are NOT
//       exposed through the async/fork path).
async function startIntelligenceRun(projectId, options = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `no project found with id "${projectId}"` };

  const existing = intelligenceRunStore.listIntelligenceRuns({ projectId, status: NON_TERMINAL_STATUSES });
  if (existing.length > 0) {
    return resumeIntelligenceRun(existing[0].intelligenceRunId, options);
  }

  const { referenceVideoUrls, referenceSetId: existingReferenceSetId, name, description, interpretationQuestions = [] } = options;

  let referenceSet;
  if (existingReferenceSetId) {
    referenceSet = referenceSetStore.getReferenceSet(projectId, existingReferenceSetId);
    if (!referenceSet) return { ok: false, code: 'REFERENCE_SET_NOT_FOUND', reason: `no ReferenceSet found with id "${existingReferenceSetId}"` };
  } else {
    if (!Array.isArray(referenceVideoUrls) || referenceVideoUrls.length === 0) {
      return {
        ok: false,
        code: 'NO_REFERENCE_INPUT',
        reason: 'Either an existing referenceSetId or a non-empty referenceVideoUrls[] is required. This intelligence pipeline operates on reference videos, not a bare topic string — no automatic video-discovery capability exists in this codebase.',
      };
    }
    const created = referenceSetService.createSet(projectId, { name: name || `Intelligence run ${new Date().toISOString()}`, description: description || '' });
    if (!created.ok) return { ok: false, code: 'REFERENCE_SET_CREATE_FAILED', reason: created.reason };
    referenceSet = created.referenceSet;
  }

  // Seed videoProgress from (a) any URLs newly requested this call and
  // (b) any ReferenceVideo already a member of an existing ReferenceSet
  // (so resuming/re-analysing a previously-curated set works honestly).
  const newUrls = Array.isArray(referenceVideoUrls) ? referenceVideoUrls : [];
  const existingMemberProgress = referenceSet.members
    .filter((m) => m.curationStatus !== 'REJECTED')
    .map((m) => {
      const rv = referenceVideoStore.getReferenceVideo(projectId, m.referenceVideoId);
      return createVideoProgress({ url: rv && rv.source ? rv.source.originalUrl : null, referenceVideoId: m.referenceVideoId, ingestionStatus: rv ? rv.status : null });
    });
  const newUrlProgress = newUrls.map((url) => createVideoProgress({ url }));

  const run = intelligenceRunStore.addIntelligenceRun({
    projectId,
    referenceSetId: referenceSet.id,
    requestedReferenceVideoUrls: newUrls,
    interpretationQuestions: [...interpretationQuestions],
    status: 'REQUESTED',
    videoProgress: [...existingMemberProgress, ...newUrlProgress],
  });

  return resumeIntelligenceRun(run.intelligenceRunId, options);
}

// The real stage-by-stage driver — resumable from any persisted
// checkpoint (Part 15). Called directly by startIntelligenceRun() and by
// scripts/run-intelligence-run.js (the forked child process).
async function resumeIntelligenceRun(intelligenceRunId, overrides = {}) {
  let run = intelligenceRunStore.getIntelligenceRun(intelligenceRunId);
  if (!run) return { ok: false, code: 'RUN_NOT_FOUND', reason: `no IntelligenceRun found with id "${intelligenceRunId}"` };
  if (!NON_TERMINAL_STATUSES.includes(run.status)) return { ok: run.status === 'COMPLETE', run };

  const { projectId, referenceSetId } = run;
  const acquisitionProvider = overrides.acquisitionProvider; // undefined -> ingestReferenceVideo()'s own real default
  const fetchImpl = overrides.fetchImpl; // undefined -> ingestReferenceVideo()'s own real default (global fetch) — same testing-only override, never crosses the fork() boundary
  const interpretationProvider = overrides.interpretationProvider; // undefined -> interpretReferenceVideo()'s own real default (Claude)
  const interpretationProviderName = overrides.interpretationProviderName || 'claude';
  const interpretationModel = overrides.interpretationModel || 'claude-sonnet-5';

  // --- STAGE: INGESTING (INT-1A) ---
  run = persist(run, { status: 'INGESTING' });
  const videoProgress = run.videoProgress.map((v) => ({ ...v, interpretations: v.interpretations.map((i) => ({ ...i })) }));

  for (let i = 0; i < videoProgress.length; i += 1) {
    const vp = videoProgress[i];
    if (vp.referenceVideoId) continue; // already ingested (resume) — Part 14 idempotency

    let referenceVideo;
    try {
      referenceVideo = await ingestReferenceVideo(projectId, { url: vp.url, provider: acquisitionProvider, fetchImpl });
    } catch (error) {
      run = persist(run, { videoProgress, diagnostics: [...run.diagnostics, diag('INGESTION', 'INGESTION_THREW', `ingestReferenceVideo threw for "${vp.url}": ${error && error.message ? error.message : String(error)}`)] });
      videoProgress[i] = { ...vp, ingestionStatus: 'FAILED' };
      continue;
    }

    videoProgress[i] = { ...vp, referenceVideoId: referenceVideo.id || null, ingestionStatus: referenceVideo.status };
    if (referenceVideo.status === 'FAILED') {
      run = persist(run, { diagnostics: [...run.diagnostics, ...(referenceVideo.diagnostics || []).map((d) => diag('INGESTION', d.code, d.message, referenceVideo.id))] });
    } else {
      // Only a genuinely persisted ReferenceVideo (COMPLETE/PARTIAL) is
      // added to the ReferenceSet — a FAILED ingestion is never a member
      // (Part 10: the run's own diagnostics/videoProgress remain the
      // honest record of what was requested; ReferenceSet membership
      // stays exactly what INT-1E's own real-membership rule already
      // requires).
      referenceSetService.addVideo(projectId, referenceSetId, referenceVideo.id, { addedBy: 'intelligence-orchestrator' });
    }
    run = persist(run, { videoProgress });
  }

  // --- STAGE: MEASURING (INT-1B) ---
  run = persist(run, { status: 'MEASURING' });
  for (let i = 0; i < videoProgress.length; i += 1) {
    const vp = videoProgress[i];
    if (!vp.referenceVideoId || vp.ingestionStatus === 'FAILED') continue; // nothing to measure
    if (vp.measurementId) continue; // already measured (resume) — Part 14 idempotency (measurementStore is NOT idempotent itself)

    const measurements = measureReferenceVideo(projectId, vp.referenceVideoId);
    videoProgress[i] = { ...vp, measurementId: measurements.id };
    if (measurements.status === 'FAILED') {
      run = persist(run, { diagnostics: [...run.diagnostics, ...(measurements.diagnostics || []).map((d) => diag('MEASUREMENT', d.code, d.message, vp.referenceVideoId))] });
    }
    run = persist(run, { videoProgress });
  }

  // --- STAGE: OBSERVING (INT-1C) ---
  run = persist(run, { status: 'OBSERVING' });
  for (let i = 0; i < videoProgress.length; i += 1) {
    const vp = videoProgress[i];
    if (!vp.measurementId) continue;
    if (vp.observationSetId) continue; // already observed (resume) — Part 14 idempotency

    const observationSet = deriveObservations(projectId, vp.measurementId);
    videoProgress[i] = { ...vp, observationSetId: observationSet.id };
    if (observationSet.status === 'FAILED') {
      run = persist(run, { diagnostics: [...run.diagnostics, ...(observationSet.diagnostics || []).map((d) => diag('OBSERVATION', d.code, d.message, vp.referenceVideoId))] });
    }
    run = persist(run, { videoProgress });
  }

  // --- STAGE: INTERPRETING (INT-1D) — OPTIONAL, NEVER BLOCKING (Part 11) ---
  if (run.interpretationQuestions.length > 0) {
    run = persist(run, { status: 'INTERPRETING' });
    for (let i = 0; i < videoProgress.length; i += 1) {
      const vp = videoProgress[i];
      if (!vp.observationSetId) continue;

      const interpretations = vp.interpretations.length > 0 ? vp.interpretations : run.interpretationQuestions.map((questionId) => createInterpretationProgress({ questionId }));

      for (let q = 0; q < interpretations.length; q += 1) {
        const ip = interpretations[q];
        if (ip.status === 'COMPLETED' || ip.status === 'FAILED') continue; // already attempted (resume) — Part 14 idempotency, never re-run a settled interpretation

        const existingApproval = interpretationApprovalStore.getApproval(projectId, vp.referenceVideoId, ip.questionId);
        const approvalReady = existingApproval && existingApproval.status === 'APPROVED' && existingApproval.unknownCostAcknowledged === true;

        if (!approvalReady) {
          if (!existingApproval || existingApproval.status === 'NONE') {
            requestInterpretationApproval(projectId, { referenceVideoId: vp.referenceVideoId, measurementsId: vp.measurementId, observationSetId: vp.observationSetId, questionId: ip.questionId, requestedBy: 'intelligence-orchestrator' });
          }
          // Hard Rule (Part 11): never "continue anyway" — this video's
          // question stays AWAITING_APPROVAL until a human decides it via
          // the existing interpretationApprovalStore.decideApproval()/
          // acknowledgeUnknownCost() — the run itself is NOT failed.
          interpretations[q] = { ...ip, status: 'AWAITING_APPROVAL' };
          continue;
        }

        const interpretation = await interpretReferenceVideo(projectId, {
          referenceVideoId: vp.referenceVideoId,
          measurementsId: vp.measurementId,
          observationSetId: vp.observationSetId,
          questionId: ip.questionId,
          provider: interpretationProvider,
          providerName: interpretationProviderName,
          model: interpretationModel,
        });
        interpretations[q] = { ...ip, status: interpretation.status === 'FAILED' ? 'FAILED' : 'COMPLETED', interpretationId: interpretation.id };
        if (interpretation.status === 'FAILED') {
          run = persist(run, { diagnostics: [...run.diagnostics, ...(interpretation.diagnostics || []).map((d) => diag('INTERPRETATION_NON_BLOCKING', d.code, d.message, vp.referenceVideoId))] });
        }
      }
      videoProgress[i] = { ...vp, interpretations };
      run = persist(run, { videoProgress });
    }
  }

  // --- STAGE: PATTERNING (INT-1E) — cross-video, ONCE per run ---
  run = persist(run, { status: 'PATTERNING' });
  let patternSetId = run.patternSetId;
  if (!patternSetId) {
    const patternSet = extractPatterns(projectId, referenceSetId);
    // extractPatterns() mirrors INT-1A's "invalid input never creates a
    // record" convention for its EARLY guard-clause failures (no project/
    // ReferenceSet/insufficient real members before any pattern math even
    // runs) — those results carry an in-memory-only id that was never
    // written to cross-video-pattern-store.js. A LATER FAILED result
    // (patterns.length === 0 after real math ran) IS persisted. This
    // file's own patternSetId must only ever reference a REAL, resolvable
    // record (Part 13's provenance rule) — never the in-memory id of a
    // result the store itself rejected, so persistence is verified
    // directly rather than inferred from `status`.
    const reallyPersisted = patternStore.getPatternSet(projectId, patternSet.id) != null;
    if (reallyPersisted) {
      patternSetId = patternSet.id;
      run = persist(run, { patternSetId });
    }
    if (patternSet.status === 'FAILED') {
      return fail(run, 'PATTERNING', patternSet.diagnostics[0] ? patternSet.diagnostics[0].code : 'PATTERN_EXTRACTION_FAILED', patternSet.diagnostics.map((d) => d.message).join('; ') || 'pattern extraction failed');
    }
  }

  // --- STAGE: RECOMMENDING (INT-1F) — ONCE per run ---
  run = persist(run, { status: 'RECOMMENDING' });
  let recommendationSetId = run.recommendationSetId;
  if (!recommendationSetId) {
    const recommendationSet = generateRecommendations(projectId, referenceSetId);
    // Same rationale as the PatternSet check immediately above —
    // generateRecommendations()'s own early guard-clause failures
    // (no project/PatternSet/no patterns to translate) are never
    // persisted to recommendation-store.js either.
    const reallyPersisted = recommendationStore.getRecommendationSet(projectId, recommendationSet.id) != null;
    if (reallyPersisted) {
      recommendationSetId = recommendationSet.id;
      run = persist(run, { recommendationSetId });
    }
    if (recommendationSet.status === 'FAILED') {
      return fail(run, 'RECOMMENDATION', recommendationSet.diagnostics[0] ? recommendationSet.diagnostics[0].code : 'RECOMMENDATION_GENERATION_FAILED', recommendationSet.diagnostics.map((d) => d.message).join('; ') || 'recommendation generation failed');
    }
  }

  run = persist(run, { status: 'COMPLETE' });
  return { ok: true, run };
}

// Asynchronous entry point (Part 21) — mirrors production-orchestrator-
// service.js's own startProductionAsync() exactly, for the exact same
// reason (that file's header documents the measured proof that
// same-process deferral does not prevent blocking synchronous/network
// work from stalling the HTTP/MCP event loop): ingestion involves real
// network acquisition + ffmpeg, and interpretation can involve a real
// external LLM call — never run inline inside a request handler.
//
// Provider overrides are deliberately NOT accepted here (a function
// cannot cross a fork() boundary) — this path always uses the real
// default providers. Controlled-provider testing calls
// startIntelligenceRun()/resumeIntelligenceRun() directly instead, same
// convention as generateNarratedAudioEvent()'s own voiceProvider/
// alignmentProvider overrides never being exposed through this file's
// production analogue.
function startIntelligenceRunAsync(projectId, options = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `no project found with id "${projectId}"` };

  const existing = intelligenceRunStore.listIntelligenceRuns({ projectId, status: NON_TERMINAL_STATUSES });
  let run;
  if (existing.length > 0) {
    run = existing[0];
  } else {
    const { referenceVideoUrls, referenceSetId: existingReferenceSetId, name, description, interpretationQuestions = [] } = options;
    if (!existingReferenceSetId && (!Array.isArray(referenceVideoUrls) || referenceVideoUrls.length === 0)) {
      return { ok: false, code: 'NO_REFERENCE_INPUT', reason: 'Either an existing referenceSetId or a non-empty referenceVideoUrls[] is required.' };
    }

    let referenceSet;
    if (existingReferenceSetId) {
      referenceSet = referenceSetStore.getReferenceSet(projectId, existingReferenceSetId);
      if (!referenceSet) return { ok: false, code: 'REFERENCE_SET_NOT_FOUND', reason: `no ReferenceSet found with id "${existingReferenceSetId}"` };
    } else {
      const created = referenceSetService.createSet(projectId, { name: name || `Intelligence run ${new Date().toISOString()}`, description: description || '' });
      if (!created.ok) return { ok: false, code: 'REFERENCE_SET_CREATE_FAILED', reason: created.reason };
      referenceSet = created.referenceSet;
    }

    const newUrls = Array.isArray(referenceVideoUrls) ? referenceVideoUrls : [];
    const existingMemberProgress = referenceSet.members
      .filter((m) => m.curationStatus !== 'REJECTED')
      .map((m) => {
        const rv = referenceVideoStore.getReferenceVideo(projectId, m.referenceVideoId);
        return createVideoProgress({ url: rv && rv.source ? rv.source.originalUrl : null, referenceVideoId: m.referenceVideoId, ingestionStatus: rv ? rv.status : null });
      });

    run = intelligenceRunStore.addIntelligenceRun({
      projectId,
      referenceSetId: referenceSet.id,
      requestedReferenceVideoUrls: newUrls,
      interpretationQuestions: [...interpretationQuestions],
      status: 'REQUESTED',
      videoProgress: [...existingMemberProgress, ...newUrls.map((url) => createVideoProgress({ url }))],
    });
  }

  const child = fork(path.join(__dirname, '..', 'scripts', 'run-intelligence-run.js'), [run.intelligenceRunId], { stdio: 'ignore' });
  child.unref();

  return { ok: true, run };
}

function getIntelligenceStatus(intelligenceRunId) {
  const run = intelligenceRunStore.getIntelligenceRun(intelligenceRunId);
  if (!run) return { ok: false, reason: `no IntelligenceRun found with id "${intelligenceRunId}"` };
  return { ok: true, run };
}

module.exports = {
  startIntelligenceRun,
  startIntelligenceRunAsync,
  resumeIntelligenceRun,
  getIntelligenceStatus,
};
