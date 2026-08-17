// INT-1A, Part 19/20 — the REAL acquisition proof.
//
// HONESTY ABOUT WHAT "REAL" MEANS HERE: the server-side application code
// (services/reference-video/apify-acquisition-provider.js) is production-
// ready but requires APIFY_API_TOKEN, which is not available anywhere in
// this environment (confirmed: `env | grep -i apify` returns nothing; see
// this stage's final report). What IS real: two live Apify actor runs,
// executed via Claude Code's OWN Apify MCP connection (a development-
// environment credential, never EVOLINK's), against the real Apify API —
//   starvibe/youtube-video-transcript  (run 7S8x0DuGZugJ2qXKa, SUCCEEDED)
//   streamers/youtube-video-downloader (run 3V9x1LDE0EDRUyVa2, SUCCEEDED)
// against the real, public YouTube video "Me at the zoo"
// (https://www.youtube.com/watch?v=jNQXAC9IVRw — the first video ever
// uploaded to YouTube, chosen for being tiny, public, and unambiguous).
// The exact response payloads below are captured VERBATIM from those two
// real runs — nothing here is fabricated or hand-typed to look plausible.
//
// This is a "relay" provider — explicitly NOT services/reference-video/
// apify-acquisition-provider.js (the real, server-authenticating adapter,
// covered by its own fully-offline test suite in test/apify-acquisition-
// provider.test.js). It stands in for a not-yet-configured production
// APIFY_API_TOKEN, exactly as scoped with the user before this proof ran.
// Everything downstream of resolveSource/acquireMetadata/acquireTranscript
// — the actual video DOWNLOAD, ffprobe measurement, audio extraction, and
// ReferenceVideo persistence — runs through the REAL, unmodified
// services/reference-video-ingestion-service.js, using the REAL global
// fetch() against the real Apify-hosted result URL (confirmed publicly
// downloadable with no token: `curl` returned a real 604,682-byte MP4).
//
// EXPIRY: the downloader actor's own key-value store record expires
// ~3 days after the run above. If that has already happened, the real
// video download will fail with a 404 — this test SKIPS in that case
// (Part 22: "do not make tests dependent on an external service being
// continuously available") rather than reddening the suite for a
// transient/expected external-storage TTL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-real-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-real-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const rvTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rv-real-store-'));
process.env.REFERENCE_VIDEO_DATA_DIR = rvTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const referenceVideoStore = require('../services/reference-video-store');
const gate = require('../services/approval-gate');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');

const REAL_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const REAL_RESULT_URL = 'https://api.apify.com/v2/key-value-stores/R0N9jY9r9OljVp74n/records/jNQXAC9IVRw_Meatthezoo.mp4';

// Verbatim from Apify run 7S8x0DuGZugJ2qXKa (starvibe/youtube-video-transcript).
const REAL_METADATA_TRANSCRIPT_ITEM = {
  title: 'Me at the zoo',
  description: 'Microplastics are accumulating in human brains at an alarming rate\nhttps://www.youtube.com/watch?v=0PT5c1z3LL8',
  channel_name: 'jawed',
  channel_id: 'UC4QobU6STFB0P71PMvOGN5A',
  published_at: '2005-04-24T03:31:52Z',
  view_count: 405031885,
  like_count: 19371347,
  comment_count: 10563237,
  thumbnail: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
  selected_language: 'English',
  transcript_text:
    "All right, so here we are, in front of the\nelephants the cool thing about these guys is that they\nhave really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to\nsay",
  transcript: [
    { start: 1.2, end: 3.36, duration: 2.16, text: 'All right, so here we are, in front of the\nelephants' },
    { start: 5.318, end: 7.974, duration: 2.656, text: 'the cool thing about these guys is that they\nhave really...' },
    { start: 7.974, end: 12.616, duration: 4.642, text: 'really really long trunks' },
    { start: 12.616, end: 14.367, duration: 1.751, text: "and that's cool" },
    { start: 14.421, end: 15.733, duration: 1.312, text: '(baaaaaaaaaaahhh!!)' },
    { start: 16.881, end: 18.881, duration: 2, text: "and that's pretty much all there is to\nsay" },
  ],
};

function realRelayProvider() {
  return {
    async resolveSource({ url }) {
      assert.ok(url === REAL_VIDEO_URL || url === 'https://youtu.be/jNQXAC9IVRw', `unexpected url passed to resolveSource: ${url}`);
      return { status: 'COMPLETED', platform: 'YOUTUBE', externalId: 'jNQXAC9IVRw', normalizedUrl: REAL_VIDEO_URL, diagnostics: [] };
    },
    async acquireMetadata() {
      const item = REAL_METADATA_TRANSCRIPT_ITEM;
      return {
        status: 'COMPLETED',
        metadata: {
          title: item.title,
          description: item.description,
          publishedAt: item.published_at,
          retrievedAt: new Date().toISOString(),
          viewCount: item.view_count,
          likeCount: item.like_count,
          commentCount: item.comment_count,
          category: null,
          tags: [],
          thumbnailUrl: item.thumbnail,
        },
        diagnostics: [],
      };
    },
    async acquireVideo() {
      return { status: 'COMPLETED', resultUrl: REAL_RESULT_URL, diagnostics: [] };
    },
    async acquireTranscript() {
      const item = REAL_METADATA_TRANSCRIPT_ITEM;
      return {
        status: 'COMPLETED',
        transcript: {
          text: item.transcript_text,
          language: item.selected_language,
          segments: item.transcript.map((c) => ({ text: c.text, startTime: c.start, endTime: c.end })),
        },
        diagnostics: [],
      };
    },
  };
}

async function realResultUrlIsStillLive() {
  try {
    const res = await fetch(REAL_RESULT_URL, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

test('REAL PROOF — ingesting a real, public YouTube video produces a durable ReferenceVideo with real video/audio Assets, real ffprobe facts, and a real transcript', async (t) => {
  if (!(await realResultUrlIsStillLive())) {
    t.skip('the ~3-day Apify key-value-store URL from this proof run has expired — re-running the real acquisition would require a new (small) real spend; see this stage\'s final report for the original captured evidence');
    return;
  }

  const project = projectStore.createProject({ title: 'EVOLINK INT-1A REAL ACQUISITION PROOF', topic: 'Me at the zoo' });
  // P0 Hardening (finding J) — ingestReferenceVideo() now requires the
  // project's approval-gate.js budget/approval checkpoint to allow it
  // before making any real provider call; this proof is not testing that
  // gate (test/reference-video-ingestion-service.test.js's G1-G5 do), so
  // it authorizes the project up front, same as every other fixture.
  gate.setBudget(project, 1);
  gate.requestApproval(project, { estimatedCost: 0 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  projectStore.touch(project);
  const rv = await ingestReferenceVideo(project.id, { url: REAL_VIDEO_URL, provider: realRelayProvider() });

  console.log(`[INT-1A REAL PROOF] ReferenceVideo ${rv.id} — status ${rv.status}`);
  console.log(`[INT-1A REAL PROOF] title="${rv.metadata && rv.metadata.title}" duration=${rv.videoTechnical && rv.videoTechnical.duration}s ${rv.videoTechnical && rv.videoTechnical.width}x${rv.videoTechnical && rv.videoTechnical.height}`);

  assert.equal(rv.status, 'COMPLETE');
  assert.deepEqual(rv.diagnostics, []);
  assert.equal(rv.source.platform, 'YOUTUBE');
  assert.equal(rv.source.externalId, 'jNQXAC9IVRw');
  assert.equal(rv.metadata.title, 'Me at the zoo');
  assert.equal(rv.metadata.viewCount, 405031885);

  assert.ok(rv.videoAssetId);
  const videoAsset = timelineStore.getAsset(project.id, rv.videoAssetId);
  assert.equal(videoAsset.storage.status, 'STORED');
  assert.ok(videoAsset.storage.sizeBytes > 100000, 'the real downloaded file is a real size, not a stub');

  // real, ffprobe-measured facts about the real file — never guessed
  assert.ok(rv.videoTechnical.duration > 17 && rv.videoTechnical.duration < 21, `duration ${rv.videoTechnical.duration} should be ~19s`);
  assert.equal(rv.videoTechnical.width, 320);
  assert.equal(rv.videoTechnical.videoCodec, 'vp9');

  // real extracted audio
  assert.ok(rv.audioAssetId);
  const audioAsset = timelineStore.getAsset(project.id, rv.audioAssetId);
  assert.equal(audioAsset.storage.status, 'STORED');
  assert.ok(rv.audioTechnical.duration > 17);

  // real, human-authored (not auto-generated) captions, with real timestamps
  assert.equal(rv.transcript.source, 'ACQUISITION_PROVIDER');
  assert.match(rv.transcript.text, /elephants/i);
  assert.equal(rv.transcript.segments.length, 6);
  assert.equal(rv.transcript.segments[0].startTime, 1.2);

  // === Part 20 — re-ingestion proof: idempotent, no duplicate spend/binary ===
  const rv2 = await ingestReferenceVideo(project.id, { url: 'https://youtu.be/jNQXAC9IVRw', provider: realRelayProvider() });
  assert.equal(rv2.id, rv.id);
  assert.equal(rv2.videoAssetId, rv.videoAssetId);
  assert.equal(referenceVideoStore.listReferenceVideos(project.id).length, 1);
  assert.equal(timelineStore.listAssets(project.id).filter((a) => a.type === 'video').length, 1);
  console.log('[INT-1A REAL PROOF] re-ingestion returned the identical record — idempotency confirmed, no duplicate real download');
});
