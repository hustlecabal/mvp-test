#!/usr/bin/env node
// run-intelligence-run.js
//
// Forked by services/intelligence-orchestrator-service.js's
// startIntelligenceRunAsync() to run ONE IntelligenceRun's real,
// long-running (network acquisition, ffmpeg, potentially an external LLM
// call) pipeline in a SEPARATE OS process — exact same rationale and
// pattern as scripts/run-production-job.js (see that file's own header).
//
// Thinnest possible wrapper: read one argv, call resumeIntelligenceRun()
// verbatim, exit. No new orchestration logic lives here.

const intelligenceOrchestrator = require('../services/intelligence-orchestrator-service');
const intelligenceRunStore = require('../services/intelligence-run-store');

const intelligenceRunId = process.argv[2];

if (!intelligenceRunId) {
  console.error('run-intelligence-run.js requires an intelligenceRunId argument');
  process.exit(1);
}

intelligenceOrchestrator
  .resumeIntelligenceRun(intelligenceRunId)
  .then((result) => {
    process.exit(result.ok ? 0 : 1);
  })
  .catch((error) => {
    // resumeIntelligenceRun()'s own stage-by-stage handling already turns
    // every EXPECTED failure into a persisted FAILED run — this is only a
    // last-resort guard against a truly unexpected throw, so the run
    // never gets silently stuck in a non-terminal status forever.
    const run = intelligenceRunStore.getIntelligenceRun(intelligenceRunId);
    if (run && !['COMPLETE', 'FAILED'].includes(run.status)) {
      intelligenceRunStore.updateIntelligenceRun(intelligenceRunId, {
        ...run,
        status: 'FAILED',
        failureStage: null,
        diagnostics: [...run.diagnostics, { stage: null, code: 'UNEXPECTED_ERROR', referenceVideoId: null, message: error && error.message ? error.message : String(error) }],
      });
    }
    console.error(`run-intelligence-run.js: unexpected error for run "${intelligenceRunId}": ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
