// LIVE-PROVIDER test for services/voice/ai33-voice-provider.js — a real
// network call to AI33 Pro's TTS API, gated on EVOLINK_AI33_API_KEY and
// EVOLINK_AI33_VOICE_ID actually being set. Deliberately kept in a
// SEPARATE file from ai33-voice-provider.test.js (mock-only) — `node
// --test` runs every *.test.js file, so this file uses node:test's own
// `skip` option whenever a credential is missing, never a thrown error,
// so `npm test` stays fully green with no key configured, and this file's
// real coverage only activates once real AI33 credentials are present.
//
// Run explicitly:
//   NODE_USE_ENV_PROXY=1 EVOLINK_AI33_API_KEY=... EVOLINK_AI33_VOICE_ID=... node --test test/ai33-voice-provider-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { directNarration } = require('../services/narration-director-service');
const { createAi33VoiceProvider } = require('../services/voice/ai33-voice-provider');

const hasKey = Boolean(process.env.EVOLINK_AI33_API_KEY) && Boolean(process.env.EVOLINK_AI33_VOICE_ID);

function tempOutputPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai33-live-test-')), `${crypto.randomUUID()}.mp3`);
}

test(
  'live: a real AI33 TTS call synthesizes real audio and reports a real, ffprobe-measured duration',
  { skip: hasKey ? false : 'EVOLINK_AI33_API_KEY / EVOLINK_AI33_VOICE_ID not set — skipped, not failed' },
  () => {
    const provider = createAi33VoiceProvider();
    const narrationDirection = directNarration({
      scriptRefId: 'live-test-beat',
      text: 'More options should make choosing easier. It does the opposite.',
      beats: [{ beatId: 'live-test-beat', narrativeRole: 'HOOK' }],
    });

    const outputPath = tempOutputPath();
    const result = provider.generateVoice({ narrationDirection, outputPath });

    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.statSync(outputPath).size > 0);
    assert.ok(typeof result.duration === 'number' && result.duration > 0);
    assert.equal(result.providerMetadata.provider, 'ai33');
    assert.ok(result.providerMetadata.taskId);
    assert.ok(result.providerMetadata.remoteAudioUrl);
  }
);
