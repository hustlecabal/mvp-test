// reference-video-ingestion-service.js
//
// INT-1A — the top-level orchestrator proving the full RAW EVIDENCE loop:
//
//   Reference URL -> resolveSource -> [idempotency check] ->
//   acquireMetadata -> acquireVideo -> archive into Asset storage ->
//   ffprobe (video) -> ffmpeg audio extraction -> archive into Asset
//   storage -> ffprobe (audio) -> acquireTranscript (provider, falling
//   back to LOCAL_WHISPER only when the provider has none) ->
//   ReferenceVideo -> reference-video-store.js
//
// LAYERING, restated because it is the one rule every orchestrator in this
// codebase enforces on itself: this file decides nothing about WHAT the
// video means. It never measures pacing, never detects a hook, never asks
// a model to interpret anything — see schemas/reference-video-schema.js's
// own header. It only makes sure the RAW EVIDENCE (Layer 1 of the INT-1
// specification) is retrieved once, honestly, and durably, so a later
// stage never has to re-acquire it.
//
// APIFY IS AN ACQUISITION PROVIDER, NEVER HARD-WIRED HERE: this file only
// ever calls the four methods services/reference-video/acquisition-
// provider-interface.js defines — swap `provider` for a different
// adapter and nothing in this file changes (matching services/voice-
// generation-service.js's own `voiceProvider`/`alignmentProvider`
// dependency-injection convention exactly).
//
// NO SECOND ASSET SYSTEM (Part 4/5): the acquired video and its extracted
// audio become ordinary schemas/production-schema.js Assets (type:
// 'video'/'audio'), stored through the EXISTING services/asset-storage.js
// and services/timeline-store.js — never a new binary-storage path.
//
// FATALITY RULE (Part 14): only a failed VIDEO acquisition fails the whole
// ingestion — a ReferenceVideo with no video asset has nothing for any
// later stage to look at. Missing metadata, missing audio, or missing
// transcript each degrade the result to PARTIAL, never FAILED, exactly
// the task's own worked example ("missing transcript... should not
// necessarily mean reference video ingestion failed").

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const projectStore = require('./project-store');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const gate = require('./approval-gate');
const referenceVideoStore = require('./reference-video-store');
const whisperAlignmentProvider = require('./voice/whisper-alignment-provider');
const { createApifyAcquisitionProvider } = require('./reference-video/apify-acquisition-provider');
const { assertImplementsAcquisitionProviderInterface } = require('./reference-video/acquisition-provider-interface');
const { createReferenceVideo, createAcquisitionStageResult, createReferenceVideoDiagnostic } = require('../schemas/reference-video-schema');

const defaultProvider = createApifyAcquisitionProvider();

// P0-HARDENING-2, Part 7/11 — Apify's own documented, FIXED per-result
// price for the metadata+transcript actor (see reference-video/apify-
// acquisition-provider.js's own header — starvibe/youtube-video-transcript
// at $0.005/result, independently re-verified for that stage, not
// estimated here). This is a genuinely KNOWN pre-call cost (every
// successful call costs exactly this, regardless of video length), unlike
// the video-downloader actor below, whose per-second price cannot be
// turned into a real cost without a duration this codebase never obtains
// from Apify (see acquireVideo's own comments) — so that one is reserved
// and settled as explicitly UNKNOWN, never computed from a locally
// ffprobe-measured duration (that would be inventing a number Apify never
// reported).
const APIFY_METADATA_TRANSCRIPT_PRICE_USD = 0.005;

// The exact, literal diagnostic message runActorSync() (apify-acquisition-
// provider.js) returns when APIFY_API_TOKEN is not configured — the ONE
// case where this service can be certain Apify's network layer was never
// reached, so a reservation may be safely released rather than settled as
// an unknown-but-real spend. Any other failure reason is treated
// conservatively as "may have reached Apify's billing layer" and settled
// UNKNOWN, never released — matching Apify's own documented pricing model
// (billed for compute time regardless of whether the run was useful).
const APIFY_NO_TOKEN_MESSAGE = 'no APIFY_API_TOKEN configured in this environment';

function apifyFailureReachedNetwork(diagnostics) {
  const message = diagnostics && diagnostics[0] && diagnostics[0].message;
  return message !== APIFY_NO_TOKEN_MESSAGE;
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function locateOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
function resolveFfmpeg(options) {
  return options.ffmpegPath || process.env.REFERENCE_VIDEO_FFMPEG_PATH || locateOnPath('ffmpeg') || 'ffmpeg';
}
function resolveFfprobe(options) {
  return options.ffprobePath || process.env.REFERENCE_VIDEO_FFPROBE_PATH || locateOnPath('ffprobe') || 'ffprobe';
}

// Local, duplicated ffprobe helper — richer than services/video-assembly-
// service.js's own ffprobeInspect (bitrate/pixel format/container/file
// size, and both a video AND an audio profile independently), because this
// file measures an ARBITRARY, externally-sourced file, never one of this
// codebase's own rendered artifacts. Same "duplicate a small helper rather
// than cross-require services for one function" convention this codebase
// already uses repeatedly (see services/narration-timing-service.js's own
// header for the same reasoning applied to classifyTimingValue).
function ffprobeFile(ffprobePath, filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, message: 'file does not exist' };
  let raw;
  try {
    raw = execFileSync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration,bit_rate,format_name,size', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels,bit_rate', '-of', 'json', filePath],
      { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString('utf8');
  } catch (error) {
    return { ok: false, message: `ffprobe failed to run: ${error && error.message ? error.message : String(error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'ffprobe returned unparseable output' };
  }
  const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
  const duration = parsed.format && Number(parsed.format.duration);
  let fps = null;
  if (videoStream && typeof videoStream.r_frame_rate === 'string' && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && Number.isFinite(num)) fps = num / den;
  }
  return {
    ok: true,
    video: videoStream
      ? {
          duration: Number.isFinite(duration) ? duration : null,
          width: videoStream.width || null,
          height: videoStream.height || null,
          fps,
          videoCodec: videoStream.codec_name || null,
          pixelFormat: videoStream.pix_fmt || null,
          bitrate: videoStream.bit_rate ? Number(videoStream.bit_rate) : parsed.format && parsed.format.bit_rate ? Number(parsed.format.bit_rate) : null,
          containerFormat: (parsed.format && parsed.format.format_name) || null,
          fileSizeBytes: parsed.format && parsed.format.size ? Number(parsed.format.size) : null,
        }
      : null,
    audio: audioStream
      ? {
          duration: Number.isFinite(duration) ? duration : null,
          audioCodec: audioStream.codec_name || null,
          sampleRate: audioStream.sample_rate ? Number(audioStream.sample_rate) : null,
          channels: audioStream.channels || null,
          bitrate: audioStream.bit_rate ? Number(audioStream.bit_rate) : null,
        }
      : null,
  };
}

function extractAudio(ffmpegPath, videoPath, outWavPath) {
  try {
    execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outWavPath], { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').slice(-1000) : '';
    return { ok: false, message: `${error && error.message ? error.message : String(error)}${stderr ? ` | stderr: ${stderr}` : ''}` };
  }
}

function stage(name, status, message) {
  return createAcquisitionStageResult({ stage: name, status, message: message || null, completedAt: new Date().toISOString() });
}
function diag(code, message, stageName) {
  return createReferenceVideoDiagnostic({ code, message, stage: stageName || null });
}

// Public entry point.
//   projectId — an existing project
//   { url, provider?, allowWhisperFallback?, fetchImpl?, ffmpegPath?, ffprobePath?, maxVideoBytes? }
//   provider defaults to the real Apify adapter — override only for
//   controlled/offline tests, the same convention services/voice-
//   generation-service.js already established for voiceProvider/
//   alignmentProvider.
async function ingestReferenceVideo(projectId, options = {}) {
  const { url, provider = defaultProvider, allowWhisperFallback = true, fetchImpl, ffmpegPath: ffmpegOverride, ffprobePath: ffprobeOverride, maxVideoBytes } = options || {};

  const project = projectStore.getProject(projectId);
  if (!project) {
    return createReferenceVideo({ projectId, status: 'FAILED', diagnostics: [diag('VIDEO_ACQUISITION_FAILED', `no project found with id "${projectId}"`)] });
  }
  assertImplementsAcquisitionProviderInterface(provider);

  const ffmpegPath = resolveFfmpeg({ ffmpegPath: ffmpegOverride });
  const ffprobePath = resolveFfprobe({ ffprobePath: ffprobeOverride });

  const stages = [];
  const diagnostics = [];

  // --- Part 3 — resolve source (local, no network) ---
  const resolution = await provider.resolveSource({ url });
  stages.push(stage('RESOLVE_SOURCE', resolution.status === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED', resolution.diagnostics[0] && resolution.diagnostics[0].message));
  if (resolution.status !== 'COMPLETED') {
    const code = resolution.status === 'UNSUPPORTED' ? 'UNSUPPORTED_PLATFORM' : 'INVALID_REFERENCE_URL';
    // Never persisted — there is no stable (platform, externalId) identity
    // to index it by (Part 15), matching every other service in this
    // codebase's "invalid input never creates a record" discipline.
    return createReferenceVideo({
      projectId,
      status: 'FAILED',
      acquisition: { provider: 'apify', stages },
      diagnostics: [diag(code, (resolution.diagnostics[0] && resolution.diagnostics[0].message) || 'source could not be resolved', 'RESOLVE_SOURCE')],
    });
  }
  const source = { platform: resolution.platform, externalId: resolution.externalId, originalUrl: url, normalizedUrl: resolution.normalizedUrl };

  // --- Part 15 — idempotency: an existing record for this exact
  // (platform, externalId) short-circuits BEFORE any paid acquisition
  // call is made, so re-ingesting the same reference never re-spends. ---
  const existing = referenceVideoStore.findByExternalId(projectId, source.platform, source.externalId);
  if (existing) return existing;

  // P0 Hardening (finding J) — every real Apify call below this point is
  // billed (see apify-acquisition-provider.js's own header: metadata+
  // transcript at $0.005/result, video at $0.00015/s). Nothing previously
  // checked this project's approval-gate.js budget/approval state before
  // making them — a confirmed, completely ungated real-money spend path.
  // Gated here, before the FIRST billed call, using the same project-wide
  // canProceed() checkpoint approval-gate.js already defines (never a
  // second budget system) — the only honest option available: unlike
  // keyframe/video generation, no per-call cost estimate exists here before
  // the call is made (duration is unknown until metadata is fetched), so
  // there is nothing to compare against a per-operation estimate the way
  // checkKeyframeBudget()/checkVideoBudget() do. A human must therefore
  // either approve this project with a real estimatedCost, or explicitly
  // acknowledge the cost is unknown (gate.acknowledgeUnknownCost) — exactly
  // Rule 6/8's "no invented default amount, no fabricated cost" discipline.
  const budgetCheck = gate.canProceed(project);
  if (!budgetCheck.allowed) {
    return createReferenceVideo({
      projectId,
      source,
      status: 'FAILED',
      diagnostics: [diag('BUDGET_APPROVAL_REQUIRED', `Reference video ingestion blocked by budget/approval gate: ${budgetCheck.reason}`)],
    });
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-reference-video-'));
  try {
    // --- Part 11 — metadata (non-fatal) ---
    // P0-HARDENING-2, Part 7/11 — reserve the known, fixed Apify price
    // BEFORE the billed call. acquireTranscript() below shares this exact
    // same underlying actor call (see apify-acquisition-provider.js's own
    // per-externalId cache) — it gets no separate reservation/settlement
    // of its own, since it is not a second billed operation.
    const apifyMetadataOperationId = crypto.randomUUID();
    await gate.reserveBudget(projectId, {
      jobId: apifyMetadataOperationId,
      provider: 'apify',
      operation: 'metadata_transcript',
      amount: APIFY_METADATA_TRANSCRIPT_PRICE_USD,
      currency: 'usd',
    });

    let metadata = null;
    const metaResult = await provider.acquireMetadata({ source });
    if (metaResult.status === 'COMPLETED') {
      metadata = metaResult.metadata;
      stages.push(stage('ACQUIRE_METADATA', 'SUCCEEDED'));
      await gate.settleUsdSpend(projectId, {
        jobId: apifyMetadataOperationId,
        provider: 'apify',
        operation: 'metadata_transcript',
        amount: APIFY_METADATA_TRANSCRIPT_PRICE_USD,
        note: 'starvibe/youtube-video-transcript — fixed per-result price, billed on a successful run regardless of which fields it returned.',
      });
    } else {
      stages.push(stage('ACQUIRE_METADATA', 'FAILED', metaResult.diagnostics[0] && metaResult.diagnostics[0].message));
      diagnostics.push(diag('METADATA_UNAVAILABLE', (metaResult.diagnostics[0] && metaResult.diagnostics[0].message) || 'metadata unavailable', 'ACQUIRE_METADATA'));
      if (apifyFailureReachedNetwork(metaResult.diagnostics)) {
        await gate.settleUsdSpend(projectId, {
          jobId: apifyMetadataOperationId,
          provider: 'apify',
          operation: 'metadata_transcript',
          amount: null,
          note: `ACQUIRE_METADATA failed after Apify's network layer may have been reached (${(metaResult.diagnostics[0] && metaResult.diagnostics[0].message) || 'unknown error'}); settling as UNKNOWN rather than assuming free.`,
        });
      } else {
        await gate.releaseReservation(projectId, {
          jobId: apifyMetadataOperationId,
          provider: 'apify',
          currency: 'usd',
          amount: APIFY_METADATA_TRANSCRIPT_PRICE_USD,
          note: 'No APIFY_API_TOKEN configured; Apify was never actually called, so nothing was billed.',
        });
      }
    }

    // --- Part 4 — video acquisition (FATAL if it fails) ---
    // P0-HARDENING-2, Part 6/11 — the video-downloader actor bills per
    // second of output, but this adapter never learns the duration (see
    // apify-acquisition-provider.js's acquireVideo — no duration/cost
    // field exists in its mapped result). There is no known pre-call cost
    // to reserve, so this is reserved with an explicit UNKNOWN amount
    // (never a fabricated number) and settled the same way — never
    // computed after the fact from a locally ffprobe-measured duration,
    // which would just be a different way of inventing the same number.
    const apifyVideoOperationId = crypto.randomUUID();
    await gate.reserveBudget(projectId, {
      jobId: apifyVideoOperationId,
      provider: 'apify',
      operation: 'video_download',
      amount: null,
      currency: 'usd',
    });

    const videoResult = await provider.acquireVideo({ source });
    if (videoResult.status !== 'COMPLETED' || !videoResult.resultUrl) {
      stages.push(stage('ACQUIRE_VIDEO', 'FAILED', videoResult.diagnostics[0] && videoResult.diagnostics[0].message));
      if (apifyFailureReachedNetwork(videoResult.diagnostics)) {
        await gate.settleUsdSpend(projectId, {
          jobId: apifyVideoOperationId,
          provider: 'apify',
          operation: 'video_download',
          amount: null,
          note: `ACQUIRE_VIDEO failed after Apify's network layer may have been reached (${(videoResult.diagnostics[0] && videoResult.diagnostics[0].message) || 'unknown error'}); settling as UNKNOWN rather than assuming free.`,
        });
      } else {
        await gate.releaseReservation(projectId, {
          jobId: apifyVideoOperationId,
          provider: 'apify',
          currency: 'usd',
          note: 'No APIFY_API_TOKEN configured; Apify was never actually called, so nothing was billed.',
        });
      }
      return createReferenceVideo({
        projectId,
        source,
        metadata,
        acquisition: { provider: 'apify', stages },
        status: 'FAILED',
        diagnostics: [...diagnostics, diag('VIDEO_ACQUISITION_FAILED', (videoResult.diagnostics[0] && videoResult.diagnostics[0].message) || 'video acquisition failed', 'ACQUIRE_VIDEO')],
      });
    }

    const videoAssetId = crypto.randomUUID();
    let downloaded;
    try {
      downloaded = await assetStorage.downloadAsset(videoResult.resultUrl, videoAssetId, {
        fetchImpl: fetchImpl || fetch,
        maxBytes: maxVideoBytes,
        headers: videoResult.resultAuthHeaders || undefined,
      });
    } catch (error) {
      stages.push(stage('ACQUIRE_VIDEO', 'FAILED', error.message));
      // The Apify actor call itself already succeeded (videoResult.status
      // was COMPLETED above) — only this server's own local download
      // failed. Settle, never release: Apify already ran.
      await gate.settleUsdSpend(projectId, {
        jobId: apifyVideoOperationId,
        provider: 'apify',
        operation: 'video_download',
        amount: null,
        note: `Apify's actor run succeeded, but downloading the result locally failed (${error.message}); the Apify run itself was still real and billed. Amount stays UNKNOWN.`,
      });
      return createReferenceVideo({
        projectId,
        source,
        metadata,
        acquisition: { provider: 'apify', stages },
        status: 'FAILED',
        diagnostics: [...diagnostics, diag('VIDEO_FILE_INVALID', `could not download the acquired video: ${error.message}`, 'ACQUIRE_VIDEO')],
      });
    }
    stages.push(stage('ACQUIRE_VIDEO', 'SUCCEEDED'));
    await gate.settleUsdSpend(projectId, {
      jobId: apifyVideoOperationId,
      provider: 'apify',
      operation: 'video_download',
      amount: null,
      note: 'epctex/youtube-video-downloader billed per second of output; this adapter never obtains the duration/cost, so the real amount stays UNKNOWN.',
    });

    timelineStore.addAsset(projectId, { assetId: videoAssetId, type: 'video', provider: 'apify' });
    timelineStore.updateAssetStorage(projectId, videoAssetId, {
      provider: 'local',
      path: downloaded.relativePath,
      status: 'STORED',
      contentType: downloaded.contentType,
      sizeBytes: downloaded.sizeBytes,
      archivedAt: new Date().toISOString(),
      error: null,
    });
    const videoAbsolutePath = assetStorage.resolveStoredPath(downloaded.relativePath);

    // --- Part 6/7 — ffprobe technical facts, MEASURED, never guessed ---
    const probed = ffprobeFile(ffprobePath, videoAbsolutePath);
    let videoTechnical = null;
    if (probed.ok && probed.video) {
      videoTechnical = probed.video;
    } else {
      diagnostics.push(diag('VIDEO_METADATA_UNAVAILABLE', (probed.ok ? 'no video stream found' : probed.message) || 'video technical metadata unavailable'));
    }

    // --- Part 5 — audio: extracted locally from the downloaded video via
    // FFmpeg (never a second paid download) — non-fatal if it fails or if
    // the source has no audio stream at all. ---
    let audioAssetId = null;
    let audioTechnical = null;
    let audioAbsolutePath = null;
    const wavPath = path.join(workDir, 'audio.wav');
    const extraction = extractAudio(ffmpegPath, videoAbsolutePath, wavPath);
    if (!extraction.ok || !fs.existsSync(wavPath)) {
      stages.push(stage('ACQUIRE_AUDIO', 'FAILED', extraction.message || 'no audio stream to extract'));
      diagnostics.push(diag('AUDIO_EXTRACTION_FAILED', extraction.message || 'no audio stream present in the acquired video', 'ACQUIRE_AUDIO'));
    } else {
      audioAssetId = crypto.randomUUID();
      const audioBuffer = fs.readFileSync(wavPath);
      const stored = assetStorage.storeUploadedAudio(audioBuffer, audioAssetId);
      timelineStore.addAsset(projectId, { assetId: audioAssetId, type: 'audio', provider: 'local' });
      timelineStore.updateAssetStorage(projectId, audioAssetId, {
        provider: 'local',
        path: stored.relativePath,
        status: 'STORED',
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        archivedAt: new Date().toISOString(),
        error: null,
      });
      audioAbsolutePath = assetStorage.resolveStoredPath(stored.relativePath);
      stages.push(stage('ACQUIRE_AUDIO', 'SUCCEEDED'));
      const audioProbe = ffprobeFile(ffprobePath, audioAbsolutePath);
      if (audioProbe.ok && audioProbe.audio) audioTechnical = audioProbe.audio;
    }

    // --- Part 8/10 — transcript: provider first, LOCAL_WHISPER only as an
    // explicit fallback, never silently overwriting a retrieved one. ---
    // P0-HARDENING-2, Part 7/11 — no separate Apify reservation/settlement
    // here: acquireTranscript() shares the exact same underlying billed
    // actor call as ACQUIRE_METADATA above (apify-acquisition-provider.js's
    // own per-externalId cache), already reserved and settled once.
    let transcript = null;
    const transcriptResult = await provider.acquireTranscript({ source });
    if (transcriptResult.status === 'COMPLETED' && transcriptResult.transcript) {
      transcript = { ...transcriptResult.transcript, source: 'ACQUISITION_PROVIDER' };
      stages.push(stage('ACQUIRE_TRANSCRIPT', 'SUCCEEDED'));
    } else if (allowWhisperFallback && audioAbsolutePath) {
      const whisperResult = whisperAlignmentProvider.alignAudio({ audioPath: audioAbsolutePath });
      if (whisperResult.status === 'COMPLETED') {
        transcript = {
          text: whisperResult.words.map((w) => w.word).join(' '),
          language: whisperResult.language,
          source: 'LOCAL_WHISPER',
          words: whisperResult.words.map((w) => ({ word: w.word, startTime: w.start, endTime: w.end })),
          segments: [],
        };
        stages.push(stage('ACQUIRE_TRANSCRIPT', 'SUCCEEDED', 'local Whisper fallback'));
      } else {
        stages.push(stage('ACQUIRE_TRANSCRIPT', 'FAILED', whisperResult.diagnostics[0] && whisperResult.diagnostics[0].message));
        diagnostics.push(diag('TRANSCRIPT_UNAVAILABLE', 'neither the acquisition provider nor local Whisper produced a transcript', 'ACQUIRE_TRANSCRIPT'));
      }
    } else {
      stages.push(stage('ACQUIRE_TRANSCRIPT', 'FAILED', transcriptResult.diagnostics[0] && transcriptResult.diagnostics[0].message));
      diagnostics.push(diag('TRANSCRIPT_UNAVAILABLE', (transcriptResult.diagnostics[0] && transcriptResult.diagnostics[0].message) || 'no transcript available', 'ACQUIRE_TRANSCRIPT'));
    }

    const status = diagnostics.length === 0 ? 'COMPLETE' : 'PARTIAL';
    const referenceVideo = createReferenceVideo({
      projectId,
      source,
      metadata,
      videoAssetId,
      audioAssetId,
      videoTechnical,
      audioTechnical,
      transcript,
      acquisition: { provider: 'apify', stages, completedAt: new Date().toISOString() },
      status,
      diagnostics,
    });

    const saved = referenceVideoStore.addReferenceVideo(projectId, referenceVideo);
    return saved.ok ? saved.referenceVideo : referenceVideo;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { ingestReferenceVideo, ffprobeFile };
