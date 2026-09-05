// Tests for the AI33 provenance handoff through the EXISTING, unmodified
// services/voice-generation-service.js pipeline (Story Beat -> Narration
// Segment -> [AI33 Task] -> Audio Asset -> AudioEvent). Uses a fake
// voiceProvider (implementing voice-provider-interface.js exactly, with
// the ADDITIVE providerMetadata field a real AI33 provider would attach)
// and a fake alignmentProvider — no real subprocess, no real network, no
// real whisper model load — matching this codebase's own established
// fake-provider test convention (see test/voice-generation-service.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-integration-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-integration-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const { directNarration } = require('../services/narration-director-service');
const { generateNarratedAudioEvent } = require('../services/voice-generation-service');

function newProject() {
  return projectStore.createProject({ title: 'AI33 integration test', topic: 'the paradox of choice' });
}

function fakeAi33VoiceProvider({ taskId = 'task-abc', voiceId = 'elevenlabs_test', remoteAudioUrl = 'https://ai33.example/audio/x.mp3', transcriptUrl = null, transcriptText = null, duration = 2.4 } = {}) {
  return {
    generateVoice: ({ outputPath }) => {
      fs.writeFileSync(outputPath, Buffer.from('RIFF0000WAVEfmt fake'));
      return {
        status: 'COMPLETED',
        audioPath: outputPath,
        duration,
        diagnostics: [],
        providerMetadata: { provider: 'ai33', operation: 'text-to-speech', voiceId, speed: 1, pronunciationDictionaryId: null, taskId, remoteAudioUrl, transcriptUrl, transcriptText },
      };
    },
  };
}

function fakeAlignmentProvider(text) {
  const words = text.split(/\s+/).map((word, i) => ({ word, start: i * 0.3, end: i * 0.3 + 0.25, confidence: 0.95 }));
  return { alignAudio: () => ({ status: 'COMPLETED', language: 'en', words, diagnostics: [] }) };
}

// 10. narration asset/provenance creation
test('10. the resulting Asset records ai33 provenance — provider, voice_id (model), task_id (generationId), remote URL — using the EXISTING Asset schema fields, no new asset model', () => {
  const project = newProject();
  const text = 'More options should make choosing easier.';
  const nd = directNarration({ scriptRefId: 'beat-04-01', text, beats: [{ beatId: 'beat-04-01', narrativeRole: 'HOOK' }] });
  const result = generateNarratedAudioEvent({
    projectId: project.id,
    narrationDirection: nd,
    voiceProvider: fakeAi33VoiceProvider({ taskId: 'task-987', voiceId: 'elevenlabs_narrator1', remoteAudioUrl: 'https://ai33.example/audio/987.mp3' }),
    alignmentProvider: fakeAlignmentProvider(text),
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.equal(result.asset.provider, 'ai33');
  assert.equal(result.asset.model, 'elevenlabs_narrator1');
  assert.equal(result.asset.generationId, 'task-987');
  assert.equal(result.asset.url, 'https://ai33.example/audio/987.mp3');
  assert.equal(result.asset.type, 'audio');
});

test('10b. an espeak (or any provider that never sets providerMetadata) result still records provider: "local" exactly as before this milestone', () => {
  const project = newProject();
  const text = 'Unrelated control case.';
  const nd = directNarration({ scriptRefId: 'beat-x', text, beats: [{ beatId: 'beat-x', narrativeRole: 'HOOK' }] });
  const legacyVoiceProvider = { generateVoice: ({ outputPath }) => { fs.writeFileSync(outputPath, Buffer.from('RIFF0000WAVEfmt fake')); return { status: 'COMPLETED', audioPath: outputPath, duration: 1.5, diagnostics: [] }; } };
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: legacyVoiceProvider, alignmentProvider: fakeAlignmentProvider(text) });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.equal(result.asset.provider, 'local');
  assert.equal(result.asset.model, null);
  assert.equal(result.asset.generationId, null);
  assert.equal(result.providerMetadata, undefined);
});

// 11. scriptRefId preservation
test('11. scriptRefId flows unchanged from the NarrationDirection through to the AudioEvent, regardless of which voice provider produced the audio', () => {
  const project = newProject();
  const text = 'Cut your options to three before you compare.';
  const nd = directNarration({ scriptRefId: 'beat-04-03', text, beats: [{ beatId: 'beat-04-03', narrativeRole: 'CONCLUSION' }] });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: fakeAi33VoiceProvider(), alignmentProvider: fakeAlignmentProvider(text) });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.equal(result.audioEvent.scriptRefId, 'beat-04-03');
  assert.equal(result.audioEvent.beatId, 'beat-04-03');
});

// 12. transcript/SRT preservation (full pipeline level)
test('12. AI33\'s own transcript/SRT metadata is preserved on the generateNarratedAudioEvent result, alongside (never instead of) the real Whisper-measured word timings on the AudioEvent', () => {
  const project = newProject();
  const text = 'Every option you reject still costs you something.';
  const nd = directNarration({ scriptRefId: 'beat-04-02b', text, beats: [{ beatId: 'beat-04-02b', narrativeRole: 'EXPLANATION' }] });
  const result = generateNarratedAudioEvent({
    projectId: project.id,
    narrationDirection: nd,
    voiceProvider: fakeAi33VoiceProvider({ transcriptUrl: 'https://ai33.example/t/987.srt', transcriptText: text }),
    alignmentProvider: fakeAlignmentProvider(text),
  });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  // AI33's own transcript metadata — preserved, available to the caller/report:
  assert.equal(result.providerMetadata.transcriptUrl, 'https://ai33.example/t/987.srt');
  assert.equal(result.providerMetadata.transcriptText, text);
  // The REAL, per-word timing on the AudioEvent still comes from the existing alignment seam, never fabricated:
  assert.ok(result.audioEvent.transcript.words.length > 0);
  assert.equal(result.audioEvent.transcript.words[0].word, 'Every');
  assert.ok(typeof result.audioEvent.transcript.words[0].startTime === 'number');
});

// 13 (integration level). actual audio duration propagation end-to-end
test('13. the AudioEvent\'s duration is the real, measured value returned by the voice provider — never a target/estimate', () => {
  const project = newProject();
  const text = 'It does the opposite.';
  const nd = directNarration({ scriptRefId: 'beat-04-02a', text, beats: [{ beatId: 'beat-04-02a', narrativeRole: 'EXPLANATION' }] });
  const result = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd, voiceProvider: fakeAi33VoiceProvider({ duration: 3.7 }), alignmentProvider: fakeAlignmentProvider(text) });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.equal(result.audioEvent.duration, 3.7);
});
