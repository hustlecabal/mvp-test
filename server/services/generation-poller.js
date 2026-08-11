// generation-poller.js
//
// Repeatedly checks a generation job's status until it settles (completed
// or failed) or we run out of attempts. This file contains no provider
// logic and no completion/asset-creation logic of its own — each check is
// delegated to generation-service.js's checkGenerationOnce(), so there is
// exactly one place that logic lives.
//
// Never creates a new generation job. If a job is already finished (or
// was never actually submitted to a provider), polling it is a no-op.

const generationStore = require('./generation-store');
const generationService = require('./generation-service');

// Sensible development defaults — short enough that a single MCP tool
// call (poll_generation) can realistically finish within one request.
// Override via environment variables for a different environment; this
// is NOT meant to model a real multi-minute video generation wait.
const POLL_INTERVAL_MS = Number(process.env.GENERATION_POLL_INTERVAL_MS) || 2000;
const POLL_MAX_ATTEMPTS = Number(process.env.GENERATION_POLL_MAX_ATTEMPTS) || 5;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// options:
//   intervalMs  - delay between attempts (default POLL_INTERVAL_MS)
//   maxAttempts - how many times to check before giving up (default POLL_MAX_ATTEMPTS)
//   sleepImpl   - injectable delay function, so tests never really wait
//   providers   - injectable provider registry, so tests never make real HTTP calls
async function pollGenerationJob(
  jobId,
  { intervalMs = POLL_INTERVAL_MS, maxAttempts = POLL_MAX_ATTEMPTS, sleepImpl = defaultSleep, providers } = {}
) {
  let job = generationStore.getGenerationJob(jobId);
  if (!job) {
    return { ok: false, reason: `No generation job found with id "${jobId}"` };
  }

  if (!generationService.IN_FLIGHT_STATUSES.includes(job.status)) {
    // Already finished (or never submitted) — nothing to poll.
    return { ok: true, job, polled: false };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    job = await generationService.checkGenerationOnce(jobId, providers ? { providers } : undefined);

    if (!generationService.IN_FLIGHT_STATUSES.includes(job.status)) {
      return { ok: true, job, polled: true, attempts: attempt };
    }

    if (attempt < maxAttempts) {
      await sleepImpl(intervalMs);
    }
  }

  // Ran out of attempts while still in-flight. This means WE stopped
  // waiting — it does not mean the provider's task failed, and the real
  // task may still complete later if checked again.
  job = generationStore.updateGenerationJob(jobId, {
    status: 'TIMED_OUT',
    timedOutAt: new Date().toISOString(),
  });

  return { ok: true, job, polled: true, timedOut: true, attempts: maxAttempts };
}

module.exports = {
  pollGenerationJob,
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
};
