// Tests for services/reference-video/apify-acquisition-provider.js —
// INT-1A, Part 17/22. resolveSource is pure/local and tested with real
// inputs, no network. The three network-calling methods are tested
// entirely offline via an injected fetchImpl (the exact convention
// services/asset-storage.js's own downloadAsset already established),
// matching Part 22's explicit instruction: "do not make tests dependent
// on an external service being continuously available."

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApifyAcquisitionProvider, YOUTUBE_HOSTS, resolveSource } = require('../services/reference-video/apify-acquisition-provider');

// --- 1-8. resolveSource — pure URL parsing/normalization, no network ---------------------------------

test('1. a standard watch?v= URL resolves to platform YOUTUBE and the correct externalId', () => {
  const r = resolveSource({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.platform, 'YOUTUBE');
  assert.equal(r.externalId, 'jNQXAC9IVRw');
  assert.equal(r.normalizedUrl, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
});

test('2. a youtu.be short URL resolves to the same normalized form', () => {
  const r = resolveSource({ url: 'https://youtu.be/jNQXAC9IVRw' });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.externalId, 'jNQXAC9IVRw');
  assert.equal(r.normalizedUrl, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
});

test('3. a /shorts/ URL resolves correctly', () => {
  const r = resolveSource({ url: 'https://www.youtube.com/shorts/jNQXAC9IVRw' });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.externalId, 'jNQXAC9IVRw');
});

test('4. a URL with extra query params (?v=...&t=10s) still resolves cleanly, normalizing away the extras', () => {
  const r = resolveSource({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=10s&list=PL123' });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.normalizedUrl, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
});

test('5. a non-YouTube host is UNSUPPORTED, not FAILED — a different platform, not a broken URL', () => {
  const r = resolveSource({ url: 'https://vimeo.com/12345' });
  assert.equal(r.status, 'UNSUPPORTED');
  assert.equal(r.diagnostics[0].code, 'UNSUPPORTED_PLATFORM');
});

test('6. malformed input fails with INVALID_REFERENCE_URL, never throws', () => {
  for (const bad of [null, undefined, '', 'not a url', 'ftp://youtube.com/watch?v=x', 'https://www.youtube.com/watch?v=tooShort']) {
    assert.doesNotThrow(() => {
      const r = resolveSource({ url: bad });
      assert.equal(r.status, 'FAILED');
      assert.equal(r.diagnostics[0].code, 'INVALID_REFERENCE_URL');
    });
  }
});

test('7. YOUTUBE_HOSTS is a closed allowlist — no wildcard, no substring match', () => {
  assert.deepEqual([...YOUTUBE_HOSTS].sort(), ['m.youtube.com', 'www.youtube.com', 'youtu.be', 'youtube.com'].sort());
  // a host that merely CONTAINS "youtube.com" must not pass
  const r = resolveSource({ url: 'https://youtube.com.evil.example/watch?v=jNQXAC9IVRw' });
  assert.equal(r.status, 'UNSUPPORTED');
});

test('8. a bare channel/homepage URL (no video id) fails structurally', () => {
  const r = resolveSource({ url: 'https://www.youtube.com/@somechannel' });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'INVALID_REFERENCE_URL');
});

// --- 9-20. network-calling methods, offline via injected fetchImpl -----------------------------------

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const SOURCE = { platform: 'YOUTUBE', externalId: 'jNQXAC9IVRw', normalizedUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' };

test('9. without APIFY_API_TOKEN configured, every network method fails structurally rather than throwing', async () => {
  const originalToken = process.env.APIFY_API_TOKEN;
  delete process.env.APIFY_API_TOKEN;
  try {
    const provider = createApifyAcquisitionProvider({ fetchImpl: async () => { throw new Error('should never be called without a token'); } });
    const meta = await provider.acquireMetadata({ source: SOURCE });
    assert.equal(meta.status, 'FAILED');
    assert.match(meta.diagnostics[0].message, /APIFY_API_TOKEN/);
    const video = await provider.acquireVideo({ source: SOURCE });
    assert.equal(video.status, 'FAILED');
    const transcript = await provider.acquireTranscript({ source: SOURCE });
    assert.equal(transcript.status, 'FAILED');
  } finally {
    if (originalToken !== undefined) process.env.APIFY_API_TOKEN = originalToken;
  }
});

test('10. acquireMetadata maps a successful actor response into a provider-neutral metadata shape', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([{ title: 'A Test Video', description: 'desc', channel_name: 'Chan', published_at: '2024-01-01T00:00:00Z', view_count: 42, like_count: 5, comment_count: 1, thumbnail: 'https://x.com/t.jpg' }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireMetadata({ source: SOURCE });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.metadata.title, 'A Test Video');
  assert.equal(result.metadata.viewCount, 42);
  assert.equal(typeof result.metadata.retrievedAt, 'string');
  delete process.env.APIFY_API_TOKEN;
});

test('11. acquireMetadata and acquireTranscript for the SAME source only call the underlying actor once (shared-cache, cost discipline)', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse([{ title: 'x', transcript: [{ start: 0, end: 2, duration: 2, text: 'hello' }], transcript_text: 'hello' }]);
  };
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  await provider.acquireMetadata({ source: SOURCE });
  await provider.acquireTranscript({ source: SOURCE });
  assert.equal(calls, 1);
  delete process.env.APIFY_API_TOKEN;
});

test('12. acquireTranscript maps cue-level transcript into segments[], never words[] (Part 9 distinction)', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([{ transcript: [{ start: 0, end: 2.5, duration: 2.5, text: 'Hello there' }, { start: 2.5, end: 5, duration: 2.5, text: 'world' }], transcript_text: 'Hello there world', selected_language: 'en' }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireTranscript({ source: SOURCE });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.transcript.segments.length, 2);
  assert.equal(result.transcript.segments[0].startTime, 0);
  assert.equal(result.transcript.segments[0].endTime, 2.5);
  assert.equal(result.transcript.words, undefined); // the interface leaves words[] for the schema factory to default — never invented here
  assert.equal(result.transcript.language, 'en');
  delete process.env.APIFY_API_TOKEN;
});

test('13. acquireTranscript returns UNAVAILABLE (never FAILED) when the video genuinely has no captions', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([{ title: 'x', transcript: [], message: 'No transcript available' }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireTranscript({ source: SOURCE });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.diagnostics[0].code, 'TRANSCRIPT_UNAVAILABLE');
  delete process.env.APIFY_API_TOKEN;
});

test('14. acquireVideo maps a successful downloader response into resultUrl', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([{ status: 'success', output: { url: 'https://api.apify.com/v2/key-value-stores/abc/records/video' }, durationSeconds: 19 }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.resultUrl, 'https://api.apify.com/v2/key-value-stores/abc/records/video');
  delete process.env.APIFY_API_TOKEN;
});

test('14b. P0 Blocker A — acquireVideo attaches resultAuthHeaders carrying the real Apify token as a Bearer header, since the result URL is a private Apify key-value-store record', async () => {
  process.env.APIFY_API_TOKEN = 'real-token-for-download-auth';
  const fetchImpl = async () => jsonResponse([{ status: 'success', output: { url: 'https://api.apify.com/v2/key-value-stores/abc/records/video' } }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.resultAuthHeaders, { Authorization: 'Bearer real-token-for-download-auth' });
  delete process.env.APIFY_API_TOKEN;
});

test('15. SECURITY — acquireVideo refuses a result URL that does not point at an Apify hosting domain, even though it came from a parsed JSON response', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([{ status: 'success', output: { url: 'https://attacker.example.com/payload.mp4' } }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VIDEO_FILE_INVALID');
  delete process.env.APIFY_API_TOKEN;
});

test('16. SECURITY — a malformed result URL fails structurally rather than being passed on to a downloader', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([{ status: 'success', output: { url: 'not a url' } }]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VIDEO_FILE_INVALID');
  delete process.env.APIFY_API_TOKEN;
});

test('17. an HTTP error from Apify fails structurally with the status code in the message', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse(null, { ok: false, status: 500 });
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireMetadata({ source: SOURCE });
  assert.equal(result.status, 'FAILED');
  assert.match(result.diagnostics[0].message, /500/);
  delete process.env.APIFY_API_TOKEN;
});

test('18. an empty dataset (zero items) fails structurally, never crashes on item[0]', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse([]);
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  assert.doesNotThrow(async () => {
    const result = await provider.acquireMetadata({ source: SOURCE });
    assert.equal(result.status, 'FAILED');
  });
  delete process.env.APIFY_API_TOKEN;
});

test('18b. P0 Blocker B — VERIFIED, NOT AN EVOLINK DEFECT: an actor response of ten {"demo": true} placeholder items (real, observed live-Apify behavior for some inputs) is rejected structurally, never accepted as evidence', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse(Array.from({ length: 10 }, () => ({ demo: true })));
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VIDEO_ACQUISITION_FAILED');
  assert.match(result.diagnostics[0].message, /no result URL/);
  delete process.env.APIFY_API_TOKEN;
});

test('18c. P0 Blocker B — a malformed dataset item (not an array at all) is rejected structurally, never crashes', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => jsonResponse({ notAnArray: true });
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VIDEO_ACQUISITION_FAILED');
  delete process.env.APIFY_API_TOKEN;
});

test('19. a network-level throw (fetch itself fails) is caught and reported structurally', async () => {
  process.env.APIFY_API_TOKEN = 'fake-token-for-test';
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireVideo({ source: SOURCE });
  assert.equal(result.status, 'FAILED');
  assert.match(result.diagnostics[0].message, /ECONNRESET/);
  delete process.env.APIFY_API_TOKEN;
});

test('20. the token is never embedded in a diagnostic message or a returned result', async () => {
  process.env.APIFY_API_TOKEN = 'super-secret-token-xyz';
  const fetchImpl = async () => jsonResponse(null, { ok: false, status: 403 });
  const provider = createApifyAcquisitionProvider({ fetchImpl });
  const result = await provider.acquireMetadata({ source: SOURCE });
  assert.doesNotMatch(JSON.stringify(result), /super-secret-token-xyz/);
  delete process.env.APIFY_API_TOKEN;
});

// --- 21. security — no eval/shell/child_process anywhere in this file --------------------------------

test('21. services/reference-video/apify-acquisition-provider.js has no eval/new Function/shell/child_process call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video', 'apify-acquisition-provider.js'), 'utf8');
  const codeOnly = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /\beval\(/);
  assert.doesNotMatch(codeOnly, /new Function/);
  assert.doesNotMatch(codeOnly, /child_process/);
  assert.doesNotMatch(codeOnly, /shell:\s*true/);
});
