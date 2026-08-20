// human-voice-acquisition-service.js
//
// CREATIVE BRAIN, Part 5 — the ONLY file that ever calls a discussion
// acquisition provider. Everything downstream (services/human-voice-
// profile-service.js) works only from this file's already-normalized
// DiscussionItem[] output — never a provider-specific shape.
//
// FINANCIAL BOUNDARY — mirrors services/reference-video-ingestion-
// service.js's own Apify gating exactly (that file's own header/P0
// Hardening finding J is the direct precedent): project-wide
// gate.canProceed() checkpoint before any billed call, reserve BEFORE
// calling the provider, settle a REAL computed amount after (never
// guessed) — harshmaur/reddit-scraper's own documented PAY_PER_EVENT
// pricing ($0.02/GB actor start + $0.002/post-or-comment result) lets
// this file compute a real settled cost from the real item count
// returned, unlike the YouTube video-download call this pattern is
// modeled on (which never learns a cost basis at all).

const crypto = require('crypto');
const projectStore = require('./project-store');
const gate = require('./approval-gate');
const { createDiscussionAcquisitionResult, createDiscussionAcquisitionDiagnostic } = require('./human-voice/discussion-acquisition-provider-interface');
const { createRedditAcquisitionProvider } = require('./human-voice/reddit-acquisition-provider');

const REDDIT_ACTOR_START_PRICE_USD = 0.02; // 1 GB minimum memory tier, one event
const REDDIT_RESULT_PRICE_USD = 0.002; // per post/comment result

function diag(code, message) {
  return createDiscussionAcquisitionDiagnostic({ code, message });
}

// Real reachability check — mirrors reference-video-ingestion-service.js's
// own apifyFailureReachedNetwork(): a missing-token/local-config failure
// never reached Apify at all and is released, never settled as UNKNOWN.
function reachedNetwork(diagnostics) {
  return !diagnostics.some((d) => typeof d.message === 'string' && d.message.includes('no APIFY_API_TOKEN configured'));
}

async function acquireHumanVoiceCorpus(projectId, { topic, platform = 'REDDIT', provider } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [diag('PROJECT_NOT_FOUND', `no project found with id "${projectId}"`)] });
  }
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    return createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [diag('INVALID_QUERY', 'topic is required')] });
  }
  if (platform !== 'REDDIT') {
    return createDiscussionAcquisitionResult({ status: 'UNSUPPORTED', diagnostics: [diag('UNSUPPORTED_PLATFORM', `platform "${platform}" has no acquisition provider`)] });
  }

  const activeProvider = provider || createRedditAcquisitionProvider();

  const budgetCheck = gate.canProceed(project);
  if (!budgetCheck.allowed) {
    return createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [diag('BUDGET_APPROVAL_REQUIRED', `Human Voice acquisition blocked by budget/approval gate: ${budgetCheck.reason}`)] });
  }

  const operationId = crypto.randomUUID();
  await gate.reserveBudget(projectId, { jobId: operationId, provider: 'apify', operation: 'discussion_acquisition', amount: null, currency: 'usd' });

  const result = await activeProvider.acquireDiscussion({ topic });

  if (result.status !== 'COMPLETED') {
    if (reachedNetwork(result.diagnostics)) {
      await gate.settleUsdSpend(projectId, {
        jobId: operationId,
        provider: 'apify',
        operation: 'discussion_acquisition',
        amount: result.items.length > 0 ? REDDIT_ACTOR_START_PRICE_USD + REDDIT_RESULT_PRICE_USD * result.items.length : null,
        note: `discussion_acquisition did not complete (${result.status}); settling based on real returned item count (${result.items.length}), never guessed.`,
      });
    } else {
      await gate.releaseReservation(projectId, { jobId: operationId, provider: 'apify', currency: 'usd', note: 'No APIFY_API_TOKEN configured; Apify was never actually called, so nothing was billed.' });
    }
    return result;
  }

  const settledAmount = REDDIT_ACTOR_START_PRICE_USD + REDDIT_RESULT_PRICE_USD * result.items.length;
  await gate.settleUsdSpend(projectId, {
    jobId: operationId,
    provider: 'apify',
    operation: 'discussion_acquisition',
    amount: settledAmount,
    note: `harshmaur/reddit-scraper — real documented pricing ($${REDDIT_ACTOR_START_PRICE_USD} actor start + $${REDDIT_RESULT_PRICE_USD}/result x ${result.items.length} results).`,
  });

  return result;
}

module.exports = { acquireHumanVoiceCorpus };
