// discussion-acquisition-provider-interface.js
//
// CREATIVE BRAIN, Part 5 — the contract every PUBLIC DISCUSSION
// ACQUISITION provider adapter must implement. Mirrors services/
// reference-video/acquisition-provider-interface.js's exact convention
// (REQUIRED_METHODS + assert helper + provider-neutral result shapes) —
// the same discipline applied to a discussion corpus instead of video
// acquisition.
//
// APIFY IS AN ACQUISITION PROVIDER HERE TOO. services/human-voice-
// acquisition-service.js never imports an Apify-specific type or reads a
// raw actor-run response directly — it only calls acquireDiscussion() and
// reads its provider-neutral DiscussionAcquisitionResult.
//
//   acquireDiscussion({ topic, platform }) -> DiscussionAcquisitionResult
//
// One required method only — unlike video acquisition (source resolution
// / metadata / video / transcript are genuinely separate operations),
// discussion acquisition is a single search-and-fetch operation for every
// provider found (Reddit search actors bundle post+comment retrieval in
// one call).

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const REQUIRED_METHODS = ['acquireDiscussion'];

const DISCUSSION_ACQUISITION_RESULT_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'UNSUPPORTED', 'FAILED'];

function createDiscussionAcquisitionDiagnostic(overrides = {}) {
  return withDefaults({ code: null, message: '' }, overrides);
}

// One real, public discussion item — a post/thread OR a comment,
// normalized to one shape regardless of platform (Part 5's own rule:
// the Creative Brain layer never depends on scraper-specific fields).
function createDiscussionItem(overrides = {}) {
  const base = {
    externalId: null,
    platform: null, // e.g. 'REDDIT'
    kind: null, // 'POST' | 'COMMENT'
    text: '',
    parentExternalId: null, // for a COMMENT, the post/comment it replies to; null for a POST
    score: null, // upvotes/likes where the platform exposes them, else null
    retrievedAt: null,
  };
  return withDefaults(base, overrides);
}

// DiscussionAcquisitionResult — a resolvable set of real, normalized
// discussion items for one query, never a raw platform response.
function createDiscussionAcquisitionResult(overrides = {}) {
  const { items, diagnostics, ...rest } = overrides;
  const base = {
    status: null, // one of DISCUSSION_ACQUISITION_RESULT_STATUSES
    items: Array.isArray(items) ? items.map((i) => createDiscussionItem(i)) : [],
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createDiscussionAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsDiscussionAcquisitionProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Discussion acquisition provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  DISCUSSION_ACQUISITION_RESULT_STATUSES,
  createDiscussionAcquisitionDiagnostic,
  createDiscussionItem,
  createDiscussionAcquisitionResult,
  assertImplementsDiscussionAcquisitionProviderInterface,
};
