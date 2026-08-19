// generation-recovery-service.js
//
// P0-HARDENING-2, Part 9/10 — recovery classification for a STALE
// generation job (TIMED_OUT, or REQUESTED with no providerTaskId) BEFORE a
// caller is allowed to treat "the old attempt is gone" as true and submit
// a brand-new, separately-billed provider request for the same intent.
//
// This is the fix for P1-2, the forensic audit's confirmed double-charge
// risk: TIMED_OUT was never a member of any service's IN_FLIGHT/ACTIVE
// status list, so its own duplicate-detection check never matched it —
// calling generate again after a timeout created a second real provider
// operation with no idea whether the first one was still running, had
// already completed, or had already failed.
//
// The four possible outcomes below are exactly Part 9's own list — nothing
// invented beyond it, and this function never fabricates a provider
// status: it only returns what providerAdapter.getGenerationStatus() (the
// same real, already-proven polling call every generation service already
// makes) actually reports, or PROVIDER_OUTCOME_UNKNOWN when that call
// itself fails, is inconclusive, or there is nothing to call at all.
//
//   ALREADY_COMPLETED        — the provider confirms this operation
//                              already finished. The caller must
//                              reconcile/settle and return the EXISTING
//                              job/result — never submit a new one.
//   FAILED_CONFIRMED         — the provider confirms this operation
//                              failed. A NEW request is safe (the old one
//                              is genuinely over); the caller's existing
//                              "generation failed, you may try again"
//                              policy applies unchanged.
//   SAFE_TO_RETRY             — no provider task was ever created for this
//                              job (providerTaskId is null) AND the job's
//                              own status already reflects a resolved
//                              outcome (not REQUESTED) — nothing was ever
//                              billed, so a new request is safe.
//   PROVIDER_OUTCOME_UNKNOWN  — either the provider still reports this
//                              operation as active (so it may still
//                              complete AND be billed), or its status
//                              could not be determined at all (a
//                              network/API error, or a REQUESTED job with
//                              no providerTaskId — genuinely ambiguous,
//                              since the process could have crashed either
//                              before or during the provider call, and
//                              there is no way to tell those apart from
//                              the job record alone). In every one of
//                              these cases a new request is NOT safe — the
//                              caller must block automatic retry and
//                              surface this for a human decision (Part 9:
//                              "do not automatically declare the provider
//                              operation failed merely because this
//                              process stopped observing it").

const RECOVERY_CLASSIFICATIONS = ['SAFE_TO_RETRY', 'PROVIDER_OUTCOME_UNKNOWN', 'ALREADY_COMPLETED', 'FAILED_CONFIRMED'];

async function classifyJobRecovery(job, providerAdapter) {
  if (!job.providerTaskId) {
    // A job that reached a terminal, non-REQUESTED status without ever
    // getting a providerTaskId only gets there through this codebase's
    // own catch blocks, which already release the reservation before
    // setting that status — nothing is left to determine.
    if (job.status !== 'REQUESTED') {
      return {
        classification: 'SAFE_TO_RETRY',
        reason: 'No provider task was ever created for this job, and its status is already resolved; nothing was billed.',
        providerStatus: null,
      };
    }
    // Still REQUESTED with no providerTaskId: could be mid-submission
    // (this process is still legitimately awaiting the provider) or a
    // genuine crash before/during that same call. This function cannot
    // tell those apart, so it never guesses.
    return {
      classification: 'PROVIDER_OUTCOME_UNKNOWN',
      reason: 'This job never recorded a provider task id and is still REQUESTED — it is not possible to tell whether the process crashed before, during, or after the provider call.',
      providerStatus: null,
    };
  }

  let providerStatus;
  try {
    providerStatus = await providerAdapter.getGenerationStatus(job.providerTaskId);
  } catch (err) {
    return {
      classification: 'PROVIDER_OUTCOME_UNKNOWN',
      reason: `Provider status could not be resolved: ${err.message}`,
      providerStatus: null,
    };
  }

  if (providerStatus.status === 'COMPLETED') {
    return { classification: 'ALREADY_COMPLETED', reason: 'The provider reports this operation already completed.', providerStatus };
  }
  if (providerStatus.status === 'FAILED') {
    return { classification: 'FAILED_CONFIRMED', reason: 'The provider confirms this operation failed.', providerStatus };
  }
  // Any other real provider status (SUBMITTED/PROCESSING/PENDING/etc.)
  // means the operation is still active as far as the provider is
  // concerned — its final outcome, and therefore its final cost, is not
  // yet resolved.
  return {
    classification: 'PROVIDER_OUTCOME_UNKNOWN',
    reason: `The provider reports this operation is still active (status: "${providerStatus.status}"); its final outcome is not yet resolved.`,
    providerStatus,
  };
}

module.exports = { RECOVERY_CLASSIFICATIONS, classifyJobRecovery };
