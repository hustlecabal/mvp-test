// LIVE-PROVIDER test for services/music/ai33-music-provider.js — a real
// network call to AI33's documented music-generation API, gated on
// EVOLINK_AI33_API_KEY actually being set. Deliberately kept in a
// SEPARATE file from ai33-music-provider.test.js (mock-only), mirroring
// test/ai33-voice-provider-live.test.js's own exact convention: `node
// --test` runs every *.test.js file, so this file uses node:test's own
// `skip` option whenever the credential is missing, never a thrown
// error, so `npm test` stays fully green with no key configured.
//
// PHASE 3B STEP 7/8 — this is the "one real AI33/Suno music generation"
// the milestone requires, run through the ACTUAL acquireMusic() ->
// createMusicAudioEvent() pipeline (never a hand-rolled fetch), on a
// short, production-relevant instrumental brief. See the Phase 3B final
// report for this test's exact real, observed outcome (including if it
// is blocked by this sandbox's own network egress policy rather than by
// anything in this codebase).
//
// Run explicitly:
//   EVOLINK_AI33_API_KEY=... node --test test/ai33-music-provider-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-music-live-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-music-live-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const musicAcquisitionService = require('../services/music-acquisition-service');
const { createMusicAcquisitionRequest } = require('../schemas/music-acquisition-schema');

const hasKey = Boolean(process.env.EVOLINK_AI33_API_KEY);

test(
  'live: a real AI33 Music generation call produces a real, playable instrumental track that flows into the existing MUSIC AudioEvent path',
  { skip: hasKey ? false : 'EVOLINK_AI33_API_KEY not set — skipped, not failed', timeout: 200000 },
  async () => {
    const project = projectStore.createProject({ title: 'ai33 music live test', topic: 'live smoke test' });

    const request = createMusicAcquisitionRequest({
      projectId: project.id,
      provider: 'ai33',
      searchQuery:
        'cinematic documentary background music about the hidden importance of bees, emotional but hopeful, organic textures, subtle percussion, restrained tension, suitable underneath narration, no vocals',
      instrumental: true,
    });

    const result = await musicAcquisitionService.acquireMusic(request);

    // Real, honest recording of whatever actually happened — never
    // fabricated. A failure here (e.g. a blocked host) is reported via
    // this assertion message, not hidden.
    assert.equal(result.status, 'ACQUIRED', `AI33 Music live call did not reach ACQUIRED: ${JSON.stringify(result, null, 2)}`);

    assert.equal(result.provider, 'ai33');
    assert.ok(result.providerMetadata && result.providerMetadata.taskId, 'a real task id must be recorded');
    assert.ok(result.assetId);

    const asset = timelineStore.getAsset(project.id, result.assetId);
    assert.ok(asset);
    assert.equal(asset.type, 'audio');
    assert.equal(asset.storage.status, 'STORED');

    const audioEvent = musicAcquisitionService.createMusicAudioEvent(result);
    assert.equal(audioEvent.type, 'MUSIC');
    assert.equal(audioEvent.sourceAssetId, result.assetId);
  }
);
