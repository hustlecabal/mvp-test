// reddit-acquisition-provider.js
//
// CREATIVE BRAIN — the ONE real DiscussionAcquisitionProvider
// implementation (discussion-acquisition-provider-interface.js), backed
// by the real Apify actor `harshmaur/reddit-scraper` (verified live via
// Apify Store search this stage — 10,992 total users, no login/API key
// required from Reddit itself, PAY_PER_EVENT: $0.002/post-or-comment
// result + $0.02/GB actor-start — see this stage's final report).
//
// SSRF DISCIPLINE — mirrors services/reference-video/apify-acquisition-
// provider.js's own exact rule: this server NEVER fetches Reddit
// directly. The topic/query string is only ever passed as a JSON
// parameter to Apify's own actor input; Apify's sandboxed infrastructure
// performs the real Reddit fetch. This server only ever fetches the
// fixed, hardcoded https://api.apify.com/v2/... endpoint.
//
// COST GATE: with no APIFY_API_TOKEN configured, every call returns a
// structured FAILED result rather than throwing or silently no-op'ing —
// same discipline as the YouTube provider.

const { createDiscussionAcquisitionDiagnostic, createDiscussionAcquisitionResult } = require('./discussion-acquisition-provider-interface');

const APIFY_API_BASE = 'https://api.apify.com/v2';
const REDDIT_SCRAPER_ACTOR = 'harshmaur~reddit-scraper';

function apifyToken() {
  return process.env.APIFY_API_TOKEN || null;
}

async function runActorSync(actorSlug, input, fetchImpl) {
  const token = apifyToken();
  if (!token) return { error: 'no APIFY_API_TOKEN configured in this environment' };
  const url = `${APIFY_API_BASE}/acts/${actorSlug}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  } catch (error) {
    return { error: `network error calling Apify: ${error && error.message ? error.message : String(error)}` };
  }
  if (!response.ok) return { error: `Apify returned HTTP ${response.status}` };
  let items;
  try {
    items = await response.json();
  } catch {
    return { error: 'Apify returned unparseable JSON' };
  }
  if (!Array.isArray(items)) return { error: 'Apify returned a non-array dataset' };
  return { items };
}

// Mapped verbatim from harshmaur/reddit-scraper's own live-verified output
// schema (`dataType` marks 'post' vs 'comment'; a comment's `parentId`
// links it to its post/parent comment). Never invented fields.
function mapItem(item, retrievedAt) {
  const isComment = item.dataType === 'comment';
  return {
    externalId: typeof item.id === 'string' ? item.id : null,
    platform: 'REDDIT',
    kind: isComment ? 'COMMENT' : 'POST',
    text: isComment ? (typeof item.body === 'string' ? item.body : '') : [item.title, item.body].filter((s) => typeof s === 'string' && s.length > 0).join('\n\n'),
    parentExternalId: isComment ? (typeof item.parentId === 'string' ? item.parentId : typeof item.postId === 'string' ? item.postId : null) : null,
    score: typeof item.score === 'number' ? item.score : typeof item.commentUpVotes === 'number' ? item.commentUpVotes : null,
    retrievedAt,
  };
}

function createRedditAcquisitionProvider({ fetchImpl = fetch, maxPostsCount = 25, maxCommentsPerPost = 10 } = {}) {
  async function acquireDiscussion({ topic } = {}) {
    if (typeof topic !== 'string' || topic.trim().length === 0) {
      return createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [createDiscussionAcquisitionDiagnostic({ code: 'INVALID_QUERY', message: 'topic is required' })] });
    }
    const { items, error } = await runActorSync(
      REDDIT_SCRAPER_ACTOR,
      { searchTerms: [topic], searchPosts: true, searchComments: false, crawlCommentsPerPost: true, includeNSFW: false, maxPostsCount, maxCommentsPerPost },
      fetchImpl
    );
    if (error) {
      return createDiscussionAcquisitionResult({ status: 'FAILED', diagnostics: [createDiscussionAcquisitionDiagnostic({ code: 'DISCUSSION_ACQUISITION_FAILED', message: error })] });
    }
    if (items.length === 0) {
      return createDiscussionAcquisitionResult({ status: 'UNAVAILABLE', diagnostics: [createDiscussionAcquisitionDiagnostic({ code: 'NO_DISCUSSION_FOUND', message: `no Reddit discussion found for topic "${topic}"` })] });
    }
    const retrievedAt = new Date().toISOString();
    const mapped = items.map((item) => mapItem(item, retrievedAt)).filter((i) => i.externalId && i.text.trim().length > 0);
    return createDiscussionAcquisitionResult({ status: 'COMPLETED', items: mapped });
  }

  return { acquireDiscussion };
}

module.exports = { createRedditAcquisitionProvider };
