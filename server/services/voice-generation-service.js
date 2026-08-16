// voice-generation-service.js
//
// Stage 26.9B — the top-level orchestrator proving the full loop:
//
//   NarrationDirection -> Voice Generation -> Audio File ->
//   Word-Level Alignment -> AudioEvent
//
// This is the FIRST stage where EVOLINK is allowed to generate real
// narration audio (Stage 26.9's directNarration() only ever produced
// PERFORMANCE INSTRUCTIONS — never audio). This file consumes an
// already-produced, already-human-approved-if-desired
// schemas/narration-schema.js NarrationDirection (Stage 26.9 Part 12/13 —
// a human overriding energy/pace/etc. happens BEFORE this file is ever
// called, by calling services/narration-director-service.js's
// directNarration() again with a beatOverride; this file has no opinion
// about how the direction it receives was produced) and turns it into a
// real schemas/audio-schema.js AudioEvent, backed by a real
// schemas/production-schema.js Asset (type: 'audio').
//
// LAYERING: this file owns ORCHESTRATION only — it calls
// services/voice/espeak-voice-provider.js (or an injected alternative
// implementing voice-provider-interface.js) to actually synthesize audio,
// and services/voice/whisper-alignment-provider.js (or an injected
// alternative implementing alignment-provider-interface.js) to actually
// measure word timing. It never talks to an engine/CLI itself. Provider
// selection happened once, deliberately, after auditing the environment
// (see this stage's final report) — the DEFAULT providers below are the
// two the user confirmed; either can be swapped per-call via the
// `voiceProvider`/`alignmentProvider` parameters (the same dependency-
// injection convention services/render-service.js's registry and
// services/material-execution-service.js's executor lookup already use),
// which is also how this file's own tests exercise failure paths without
// needing to uninstall real espeak-ng/faster-whisper.
//
// NO SECOND TIMELINE, NO SECOND AUDIO SYSTEM (Part 5/20): the generated
// file becomes an ordinary Asset (type: 'audio') via the EXISTING
// services/asset-storage.js (Stage 26.9B's own storeUploadedAudio, added
// this stage) and services/timeline-store.js — never a new AudioAsset/
// AudioStorage/VoiceAsset model. The result is an ordinary
// schemas/audio-schema.js AudioEvent — never a new schema.
//
// TIMING AUTHORITY (Part 11/18): schemas/narration-schema.js's
// NarrationDirection.timing.target is a PRE-audio estimate. The AudioEvent
// this file produces uses ONLY the REAL, ffprobe-measured duration
// (services/voice/espeak-voice-provider.js's own createVoiceGenerationResult
// .duration) — target and actual are never conflated, and this file never
// modifies services/timeline-compiler-service.js (no compatibility change
// was found necessary this stage).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const { createAudioEvent, createTranscript, createWordTimestamp } = require('../schemas/audio-schema');
const defaultVoiceProvider = require('./voice/espeak-voice-provider');
const defaultAlignmentProvider = require('./voice/whisper-alignment-provider');

// ---------------------------------------------------------------------------
// Part 12 — deterministic script/audio consistency check. Compares the
// FULL normalized character stream (lowercased, alphanumeric only — so
// punctuation and word-boundary differences like "£100,000" transcribing
// as two ASR tokens "100"/"000" never cause a false failure, per the
// explicit "minor punctuation differences should not cause failure"
// instruction) via Levenshtein similarity. This is a STARTING threshold
// (documented, not immutable) calibrated against this stage's own real
// espeak-ng/faster-whisper proof: a correct transcription of the task's
// own example line scored ~0.94 similarity; a genuinely different
// sentence scores far lower. 0.6 leaves real margin for a synthesizer's
// own mispronunciations while still catching a truly wrong recording.
// ---------------------------------------------------------------------------
const CONSISTENCY_SIMILARITY_THRESHOLD = 0.6;

function normalizeForComparison(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => [i, ...new Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[rows - 1][cols - 1];
}

// Exported for direct testing — never fuzzy/approximate matching disguised
// as something else; this IS the deterministic algorithm, documented and
// inspectable, not a black box.
function checkScriptAudioConsistency(expectedText, alignedWords) {
  const expected = normalizeForComparison(expectedText);
  const actual = normalizeForComparison((alignedWords || []).map((w) => w.word).join(''));
  if (expected.length === 0) return { ok: false, similarity: 0, reason: 'expected text is empty' };
  if (actual.length === 0) return { ok: false, similarity: 0, reason: 'aligned transcript is empty' };
  const distance = levenshteinDistance(expected, actual);
  const similarity = 1 - distance / Math.max(expected.length, actual.length);
  return { ok: similarity >= CONSISTENCY_SIMILARITY_THRESHOLD, similarity, reason: similarity >= CONSISTENCY_SIMILARITY_THRESHOLD ? null : 'transcript diverges too far from the intended script' };
}

function fail(code, message, extra = {}) {
  return { status: 'FAILED', diagnostics: [{ code, message }], audioEvent: null, asset: null, alignment: null, ...extra };
}

// Public entry point.
//   { projectId, narrationDirection, voiceProvider?, alignmentProvider? }
//   voiceProvider/alignmentProvider default to the real, confirmed
//   espeak-ng/faster-whisper adapters — override only for controlled
//   failure-path testing (services/voice/*-provider-interface.js document
//   the exact contract any replacement must satisfy).
function generateNarratedAudioEvent({ projectId, narrationDirection, voiceProvider = defaultVoiceProvider, alignmentProvider = defaultAlignmentProvider } = {}) {
  if (!projectId) {
    return fail('INVALID_NARRATION_DIRECTION', 'a projectId is required');
  }
  if (!narrationDirection || narrationDirection.status !== 'COMPLETED') {
    return fail('INVALID_NARRATION_DIRECTION', 'narrationDirection must be a COMPLETED NarrationDirection (see services/narration-director-service.js)');
  }

  const assetId = crypto.randomUUID(); // Part 6/13B precedent — always generated server-side
  const tempWavPath = path.join(os.tmpdir(), `voice-gen-${assetId}.wav`);

  let voiceResult;
  try {
    voiceResult = voiceProvider.generateVoice({ narrationDirection, outputPath: tempWavPath });
  } catch (error) {
    return fail('VOICE_GENERATION_FAILED', `voice provider threw: ${error && error.message ? error.message : String(error)}`);
  }
  if (!voiceResult || voiceResult.status !== 'COMPLETED') {
    const diagnostics = voiceResult && Array.isArray(voiceResult.diagnostics) && voiceResult.diagnostics.length > 0 ? voiceResult.diagnostics : [{ code: 'VOICE_GENERATION_FAILED', message: 'voice provider returned no diagnostics' }];
    fs.rmSync(tempWavPath, { force: true });
    return { status: 'FAILED', diagnostics, audioEvent: null, asset: null, alignment: null };
  }

  let alignmentResult;
  try {
    alignmentResult = alignmentProvider.alignAudio({ audioPath: voiceResult.audioPath });
  } catch (error) {
    fs.rmSync(tempWavPath, { force: true });
    return fail('ALIGNMENT_FAILED', `alignment provider threw: ${error && error.message ? error.message : String(error)}`);
  }
  if (!alignmentResult || alignmentResult.status !== 'COMPLETED') {
    const diagnostics = alignmentResult && Array.isArray(alignmentResult.diagnostics) && alignmentResult.diagnostics.length > 0 ? alignmentResult.diagnostics : [{ code: 'ALIGNMENT_FAILED', message: 'alignment provider returned no diagnostics' }];
    fs.rmSync(tempWavPath, { force: true });
    return { status: 'FAILED', diagnostics, audioEvent: null, asset: null, alignment: null };
  }

  const consistency = checkScriptAudioConsistency(narrationDirection.text, alignmentResult.words);
  if (!consistency.ok) {
    fs.rmSync(tempWavPath, { force: true });
    return fail('TRANSCRIPT_MISMATCH', `aligned transcript diverges too far from the intended script (similarity ${consistency.similarity.toFixed(2)}, threshold ${CONSISTENCY_SIMILARITY_THRESHOLD})`);
  }

  // --- persist the real generated audio as an ordinary Asset (Part 5) ---
  let stored;
  try {
    const buffer = fs.readFileSync(voiceResult.audioPath);
    stored = assetStorage.storeUploadedAudio(buffer, assetId);
  } catch (error) {
    fs.rmSync(tempWavPath, { force: true });
    return fail('VOICE_GENERATION_FAILED', `could not persist generated audio: ${error.message}`);
  }
  fs.rmSync(tempWavPath, { force: true });

  const asset = timelineStore.addAsset(projectId, { assetId, type: 'audio', provider: 'local' });
  if (!asset) {
    return fail('VOICE_GENERATION_FAILED', `project "${projectId}" does not exist — asset could not be recorded`);
  }
  timelineStore.updateAssetStorage(projectId, assetId, {
    provider: 'local',
    path: stored.relativePath,
    status: 'STORED',
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    archivedAt: new Date().toISOString(),
    error: null,
  });

  // --- Transcript: text is the intended script (known immediately, per
  // audio-schema.js's own header), words[] are the REAL measured
  // timestamps from the actual audio (Part 9/18 — never estimated) ---
  const transcript = createTranscript({
    text: narrationDirection.text,
    words: alignmentResult.words.map((w) => createWordTimestamp({ word: w.word, startTime: w.start, endTime: w.end })),
  });

  // A narration spanning exactly one beat gets that beatId; a multi-beat
  // narration (Stage 26.9's own supported case) leaves it null rather than
  // silently picking one beat as if it were more authoritative than the
  // others it also covers — the same "never invent it" discipline this
  // whole codebase applies elsewhere.
  const beatId = Array.isArray(narrationDirection.beatIds) && narrationDirection.beatIds.length === 1 ? narrationDirection.beatIds[0] : null;

  const audioEvent = createAudioEvent({
    type: 'NARRATION',
    status: 'READY', // sourceAssetId is set and duration is the real, measured value
    startTime: narrationDirection.timing && narrationDirection.timing.target ? narrationDirection.timing.target.startTime : null,
    duration: voiceResult.duration, // REAL, ffprobe-measured — never narrationDirection.timing.target.duration
    sourceAssetId: assetId,
    scriptRefId: narrationDirection.scriptRefId,
    transcript,
    voiceProfile: narrationDirection.voiceProfile,
    beatId,
  });

  return {
    status: 'COMPLETED',
    diagnostics: [],
    audioEvent,
    asset: timelineStore.getAsset(projectId, assetId),
    alignment: {
      language: alignmentResult.language,
      wordCount: alignmentResult.words.length,
      meanConfidence: alignmentResult.words.reduce((sum, w) => sum + (typeof w.confidence === 'number' ? w.confidence : 0), 0) / alignmentResult.words.length,
      similarity: consistency.similarity,
    },
  };
}

module.exports = {
  CONSISTENCY_SIMILARITY_THRESHOLD,
  checkScriptAudioConsistency,
  generateNarratedAudioEvent,
};
