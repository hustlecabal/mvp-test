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
  const contentCompleteness = job.contentCompleteness || null;
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
      summary = `Production paused — ${job.escalations.length} beat(s) require a human decision before continuing.`;
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

  return {
    productionJobId: job.productionJobId,
    projectId: job.projectId,
    isComplete,
    isTechnicallyComplete,
    isContentComplete,
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
