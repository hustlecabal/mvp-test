// production-diagnosis-service.js
//
// PRODUCTION RELIABILITY LAYER, Part 2 — diagnoseProductionJob(job). The
// single read-only synthesis layer this stage exists to add: before this
// file, answering "what happened to this job" meant manually correlating
// job.diagnostics[], job.escalations[], job.beatProgress[], job.qc, and
// (now) job.contentCompleteness/job.creativeQa by hand. This function does
// that correlation once, deterministically, and returns one structured
// answer usable by a human or an agent without opening any of those
// arrays directly.
//
// PURE AND READ-ONLY: never mutates job, never calls a store, never
// re-runs any production stage. Safe to call on a job in any state,
// including one still in progress or one produced before this stage
// existed (job.contentCompleteness/job.creativeQa simply read as null —
// see isContentComplete's own null-handling below, never fabricated).

const { summarizeCreativeQAReport } = require('./creative-qa-service');
const { computeContentCompleteness } = require('./production-completeness-service');

// Duplicated, small, stable lists rather than importing production-
// orchestrator-service.js/production-job-schema.js's own constants — the
// same "duplicate a short stable list across layers rather than couple to
// it" convention timeline-compiler-service.js's own compareBeats comment
// already established. Keeping this file import-free of the orchestrator
// also means it can never accidentally create a circular dependency.
const TERMINAL_STATUSES = ['COMPLETE', 'FAILED', 'ESCALATED'];
const NON_TERMINAL_STATUSES = ['REQUESTED', 'DERIVING_BEATS', 'RESOLVING_MATERIALS', 'EXECUTING_MATERIALS', 'RENDERING', 'GENERATING_NARRATION', 'COMPILING_TIMELINE', 'ASSEMBLING', 'QC'];
const STAGE_ORDER = ['APPROVAL_BOUNDARY', 'STORYBOARD', 'BEATGRAPH', 'MATERIAL_RESOLUTION', 'MATERIAL_EXECUTION', 'RENDERING', 'NARRATION', 'TIMELINE_COMPILATION', 'ASSEMBLY', 'QC'];

// Heuristic, deterministic, and conservative: a code this codebase's own
// providers already name consistently for a transient condition (network/
// timeout/unavailable/rate-limit) is treated as retryable; a code naming a
// structural defect (invalid/missing/dangling/unsupported/unresolved/
// mismatch/duplicate, or a "no approved/acquired X exists" escalation
// reason) is treated as not retryable. A code matching neither returns
// null — "not confidently classified" is reported honestly rather than
// guessed.
const RETRYABLE_CODE_PATTERN = /TIMEOUT|NETWORK|UNAVAILABLE|RATE_LIMIT|THROTTL/i;
const NON_RETRYABLE_CODE_PATTERN = /INVALID|MISSING|DANGLING|UNSUPPORTED|UNKNOWN|UNRESOLVED|MISMATCH|DUPLICATE|NO_APPROVED|NO_ACQUIRED|NO_BEATS/i;

function classifyRetryable(code) {
  if (!code) return null;
  if (RETRYABLE_CODE_PATTERN.test(code)) return true;
  if (NON_RETRYABLE_CODE_PATTERN.test(code)) return false;
  return null;
}

function diagnoseProductionJob(job) {
  // PRODUCTION QUALITY/READINESS — production-orchestrator-service.js only
  // ever calls computeContentCompleteness() once, right before status:
  // COMPLETE (that file's own header). A job that instead terminates
  // FAILED/ESCALATED never gets one computed, leaving isContentComplete
  // permanently null/unknown for exactly the jobs where "how much content
  // actually made it in" matters most — a real Golden Video run reached
  // ESCALATED with only 3 of 11 beats assembled, and this function had
  // nothing to say about it beyond the raw escalations array.
  // computeContentCompleteness() is already pure/read-only and already
  // documented to accept "anything with the same shape" (beatGraph,
  // diagnostics, beatProgress, assemblyResult) — every one of which a
  // TERMINAL job already has once BeatGraph derivation has run. This
  // computes it on the fly using ONLY that existing data — never a second
  // completeness system, and never overwriting a genuinely pre-computed
  // job.contentCompleteness (the COMPLETE path's own value always wins).
  // Guarded to terminal jobs only (never IN_PROGRESS) so a still-resolving
  // job is never given a premature, misleading completeness read.
  const isTerminalStatus = job.status === 'COMPLETE' || job.status === 'FAILED' || job.status === 'ESCALATED';
  const contentCompleteness = job.contentCompleteness || (isTerminalStatus && job.beatGraph ? computeContentCompleteness(job) : null);
  const creativeQa = job.creativeQa ? summarizeCreativeQAReport(job.creativeQa) : null;

  const isComplete = job.status === 'COMPLETE';
  const isTechnicallyComplete = job.qc ? job.qc.passed : null;
  const isContentComplete = contentCompleteness ? contentCompleteness.overall === 'FULL_CONTENT' : null;

  const affectedBeatIds = [
    ...new Set([
      ...(job.diagnostics || []).map((d) => d.beatId).filter(Boolean),
      ...(job.escalations || []).map((e) => e.beatId).filter(Boolean),
      ...(contentCompleteness ? [...contentCompleteness.missingBeatIds, ...contentCompleteness.missingNarrationBeatIds] : []),
    ]),
  ];

  let failingStage = job.failureStage || null;
  if (!failingStage && (job.diagnostics || []).length > 0) {
    const stagesPresent = new Set(job.diagnostics.map((d) => d.stage).filter(Boolean));
    failingStage = STAGE_ORDER.find((s) => stagesPresent.has(s)) || null;
  }

  let retryable = null;
  if (job.status === 'FAILED') {
    const last = job.diagnostics[job.diagnostics.length - 1];
    retryable = last ? classifyRetryable(last.code) : null;
  } else if (job.status === 'ESCALATED') {
    // An escalation is genuinely actionable — but the action is a human
    // approval decision, never a mechanical retry of the same call.
    retryable = false;
  }

  // HONEST LIMITATION (confirmed by inspection of production-orchestrator-
  // service.js's own resumeProduction(): it early-returns for FAILED/
  // ESCALATED without retrying anything): a job can only genuinely resume
  // from its checkpointed beatProgress while still non-terminal. This is
  // reported accurately rather than implying a resume capability that
  // does not exist today.
  const canResumeFromCheckpoint = NON_TERMINAL_STATUSES.includes(job.status);

  let classification;
  if (job.status === 'FAILED') classification = 'HARD_FAILURE';
  else if (job.status === 'ESCALATED') classification = 'ESCALATED';
  else if (!TERMINAL_STATUSES.includes(job.status)) classification = 'IN_PROGRESS';
  else if (isContentComplete === false || (creativeQa && creativeQa.severity === 'FAIL')) classification = 'PARTIAL_SUCCESS';
  else if (creativeQa && creativeQa.severity === 'WARN') classification = 'WARNING';
  else classification = 'SUCCESS';

  let summary;
  let recommendedAction;
  switch (classification) {
    case 'HARD_FAILURE': {
      const lastDiag = job.diagnostics[job.diagnostics.length - 1];
      summary = `Production failed at stage ${failingStage || 'UNKNOWN'}${lastDiag ? `: [${lastDiag.code}] ${lastDiag.message}` : ''}.`;
      recommendedAction = retryable === true
        ? 'The last failure looks transient (network/timeout/provider availability) — retrying this production run may succeed.'
        : 'The last failure looks structural — fix the underlying issue described above before starting a new production run.';
      break;
    }
    case 'ESCALATED': {
      // PRODUCTION QUALITY/READINESS — surfaces the same completeness
      // numbers PARTIAL_SUCCESS's own summary already reports, so an
      // ESCALATED job (assembly may well have technically COMPLETED on
      // whatever beats DID resolve — see assembleTimeline()'s own
      // partial-timeline behavior) never reads as merely "paused" when
      // what actually happened is most of the intended video is missing.
      const completenessNote = contentCompleteness
        ? ` ${contentCompleteness.assembledBeatCount}/${contentCompleteness.expectedBeatCount} beat(s) reached the final assembly (${contentCompleteness.overall}).`
        : '';
      summary = `Production paused — ${job.escalations.length} beat(s) require a human decision before continuing.${completenessNote}`;
      recommendedAction = job.escalations.length > 0 ? job.escalations.map((e) => e.reason).join(' ') : 'Resolve the pending escalation(s), then start a new production run.';
      break;
    }
    case 'IN_PROGRESS': {
      summary = `Production is still running (current stage: ${job.status}).`;
      recommendedAction = 'No action needed yet — call resumeProduction() again, or wait for the in-flight run to reach a terminal state.';
      break;
    }
    case 'PARTIAL_SUCCESS': {
      const missingBeats = contentCompleteness ? contentCompleteness.missingBeatIds.length : null;
      const missingNarration = contentCompleteness ? contentCompleteness.missingNarrationBeatIds.length : null;
      summary = `Production reached COMPLETE, but content is incomplete: ${missingBeats ?? '?'} beat(s) and ${missingNarration ?? '?'} narration(s) did not reach the final video.`;
      recommendedAction = creativeQa ? creativeQa.recommendedAction : 'Inspect diagnostics for the missing beat id(s) and start a new production run once fixed.';
      break;
    }
    case 'WARNING': {
      summary = `Production completed with all intended content present, but Creative QA flagged ${creativeQa.warnings.length} warning(s).`;
      recommendedAction = creativeQa.recommendedAction;
      break;
    }
    default: {
      summary = 'Production completed successfully with all intended content present.';
      recommendedAction = 'No action needed.';
    }
  }

  // PRODUCTION QUALITY/READINESS — the one, explicit, authoritative
  // caller-facing gate this stage exists to add. Deliberately distinct
  // from isTechnicallyComplete (== job.qc.passed, an aggregate of 15
  // checks that only ever assert the ASSEMBLED FILE's own technical
  // validity — codec/duration/dimensions/audio presence — and correctly
  // PASS even when most beats escalated, since "no unaccounted-for
  // failure" is all that check set was ever designed to mean; see
  // NO_UNRESOLVED_REQUIRED_MATERIALS_BEYOND_ESCALATIONS's own check
  // message). isProductionReady instead reads the SAME classification
  // this function already computes from status + content completeness +
  // Creative QA — SUCCESS/WARNING are the only two classifications where
  // every intended beat genuinely reached the final video. A caller must
  // never infer "this production is ready" from job.qc.passed alone; this
  // field is the one to check instead. No new QC check was added and no
  // existing QC check was changed — this is entirely a diagnosis-layer
  // fix (see this function's own header for why job.qc's narrower,
  // file-level meaning is correct and is left exactly as it was).
  const isProductionReady = classification === 'SUCCESS' || classification === 'WARNING';

  return {
    productionJobId: job.productionJobId,
    projectId: job.projectId,
    isComplete,
    isTechnicallyComplete,
    isContentComplete,
    isProductionReady,
    // Additive, explicit counts a caller previously had to derive by hand
    // from contentCompleteness/escalations — null only when neither is
    // computable (e.g. a job with no beatGraph at all).
    unresolvedBeatCount: contentCompleteness ? contentCompleteness.missingBeatIds.length : null,
    unresolvedMaterialCount: (job.escalations || []).length,
    failingStage,
    affectedBeatIds,
    summary,
    retryable,
    recommendedAction,
    canResumeFromCheckpoint,
    classification, // 'SUCCESS' | 'WARNING' | 'PARTIAL_SUCCESS' | 'ESCALATED' | 'HARD_FAILURE' | 'IN_PROGRESS'
    contentCompleteness,
    creativeQa,
    diagnostics: job.diagnostics || [],
    escalations: job.escalations || [],
  };
}

module.exports = { diagnoseProductionJob, classifyRetryable };
