#!/usr/bin/env node
// run-production-job.js
//
// Forked by services/production-orchestrator-service.js's
// startProductionAsync() to run ONE ProductionJob's real, long-running,
// synchronous (execFileSync-heavy: Chrome, FFmpeg, espeak-ng,
// faster-whisper) pipeline in a SEPARATE OS process — so the parent
// server process (handling HTTP/MCP requests) is never blocked for the
// full, often multi-minute run. See that file's own header for exactly
// why a same-process deferral (setImmediate) does not work.
//
// This script does nothing itself. It is the thinnest possible wrapper:
// read one argv, call resumeProduction() verbatim, exit. No new
// orchestration logic lives here — resumeProduction() already persists
// the job's progress/result to disk; this process just needs to run it
// to completion (or to the next failure/escalation) and exit.

const productionOrchestrator = require('../services/production-orchestrator-service');
const productionJobStore = require('../services/production-job-store');

const productionJobId = process.argv[2];

if (!productionJobId) {
  console.error('run-production-job.js requires a productionJobId argument');
  process.exit(1);
}

try {
  const result = productionOrchestrator.resumeProduction(productionJobId);
  process.exit(result.ok || result.escalated ? 0 : 1);
} catch (error) {
  // resumeProduction()'s own stage-by-stage try/catches already turn every
  // EXPECTED failure into a persisted FAILED job — this is only a
  // last-resort guard against a truly unexpected throw, so the job never
  // gets silently stuck in a non-terminal status forever.
  const job = productionJobStore.getProductionJob(productionJobId);
  if (job && !['COMPLETE', 'FAILED', 'ESCALATED'].includes(job.status)) {
    productionJobStore.updateProductionJob(productionJobId, {
      ...job,
      status: 'FAILED',
      failureStage: null,
      diagnostics: [...job.diagnostics, { code: 'UNEXPECTED_ERROR', stage: null, beatId: null, message: error && error.message ? error.message : String(error) }],
    });
  }
  console.error(`run-production-job.js: unexpected error for job "${productionJobId}": ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
