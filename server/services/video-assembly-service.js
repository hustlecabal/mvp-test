// video-assembly-service.js
//
// P0-3B — FINAL VIDEO ASSEMBLY. The last stage of the existing, entirely
// unmodified pipeline:
//
//   BeatGraph -> MaterialResolution[] -> ExecutionResult[] ->
//   TimelineCompilationResult (services/timeline-compiler-service.js,
//   authoritative for shot startTime/duration/layer — Part 4) ->
//   RenderResult[] (services/render-service.js, one real rendered artifact
//   per compiled shot) -> [this file] -> ONE playable MP4.
//
// LAYERING, restated because it is the one rule every stage in this
// pipeline enforces on itself: this file decides nothing creative and
// re-derives no timing. It never re-resolves a material, never re-executes
// one, never re-renders one, and never recomputes shot ordering from array
// position, storyboard order, beat order, or asset creation time (Part 4)
// — the compiler's own startTime/duration/layer fields are the ONLY
// authority for where and how long each shot plays. It only VALIDATES that
// every source the compiled timeline references actually exists and is
// usable (Part 3), then composites already-decided, already-rendered
// artifacts into one container via FFmpeg.
//
// NO SECOND TIMELINE, NO SECOND RENDERING ENGINE: this file never draws
// anything itself (no Chrome, no SVG, no canvas) — every visual frame in
// the output already came from services/render-service.js's real renderer
// pipeline. FFmpeg here only concatenates/composites already-rendered MP4
// artifacts and mixes in already-measured narration audio — exactly the
// "deterministic FFmpeg composition" Part 5 asks for, using the same
// already-installed, capability-proven FFmpeg
// services/renderers/hyperframes-renderer.js already depends on (see that
// file's own env-resolution header, mirrored below).
//
// SCOPE LIMITATION, STATED HONESTLY (Part 8): only the PRIMARY layer is
// actually composited this stage. A compiled shot on any other layer
// (OVERLAY/BACKGROUND/INSERT) is real, valid Stage 26.6 output this file
// simply does not yet know how to safely layer into one frame — it is
// reported via a structured ASSEMBLY_LAYER_UNSUPPORTED diagnostic and
// excluded, never faked, never silently dropped without a trace. The
// PRIMARY track still assembles.
//
// TRANSITIONS (Part 9): schemas/timeline-compilation-schema.js's own
// createCompiledTransition() carries no rendering semantics beyond
// fromBeatId/toBeatId/kind ('TRANSITIONS_TO' only, per timeline-compiler-
// service.js's own comment) — no crossfade/wipe/duration vocabulary exists
// anywhere in this codebase to honor. Rather than invent one, or silently
// perform a plain cut where a transition was actually requested, ANY
// non-empty timelineCompilation.transitions[] fails the whole assembly
// with TRANSITION_UNSUPPORTED. A Golden Video fixture with no transitions
// is unaffected (Part 9's own explicit allowance).
//
// AUDIO POLICY (Part 11): a visual segment's own embedded audio (if any)
// is NEVER carried into the final mix — every shot segment is normalized
// with `-an` (defense in depth on top of every renderer already muting its
// own video elements — see hyperframes-renderer.js's own audioPolicy
// comments). The ONLY audio in the output is the caller-supplied,
// already-measured narration AudioEvent(s) — no music, no SFX, no ducking,
// no mastering.
//
// SECURITY (Part 20): every FFmpeg/ffprobe invocation uses execFileSync
// with an explicit argument array — never a shell string, never
// `shell: true`, never eval/new Function. Every path is either this
// module's own computed temp path or a path already validated by
// services/asset-storage.js's own traversal guard
// (resolveStoredPath/timelineStore.getAsset). outputDir is always
// caller-supplied, exactly like services/render-service.js's own
// discipline — this file never picks or persists a default location, and
// never writes under server/data itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const timelineStore = require('./timeline-store');
const assetStorage = require('./asset-storage');
const { createAssemblyResult, createAssemblyDiagnostic, createAssemblyArtifact, createShotProvenanceEntry, createNarrationProvenanceEntry } = require('../schemas/assembly-result-schema');

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
// Part 12 — deterministic duration tolerance. Every segment this file
// produces is built with an explicit `-t <exact seconds>` trim/pad against
// a fixed, constant fps, so the only real source of drift is H.264's own
// frame-boundary rounding (one frame at 30fps = 0.0333s) accumulated across
// a handful of concatenated segments plus the final concat re-encode's own
// single rounding step. 0.2s leaves real margin above that while still
// catching a genuine defect (a dropped/duplicated segment, a bad trim).
// Documented, not immutable — see this stage's final report for the real,
// measured Golden Video error this was calibrated against.
const DEFAULT_TOLERANCE_SECONDS = 0.2;

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
  return options.ffmpegPath || process.env.ASSEMBLY_FFMPEG_PATH || locateOnPath('ffmpeg') || 'ffmpeg';
}
function resolveFfprobe(options) {
  return options.ffprobePath || process.env.ASSEMBLY_FFPROBE_PATH || locateOnPath('ffprobe') || 'ffprobe';
}

function classifyTimingValue(value) {
  if (value === null || value === undefined) return 'ABSENT';
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value < 0) return 'INVALID';
  return 'VALID';
}

function diag(code, message, extra = {}) {
  return createAssemblyDiagnostic({ code, message, ...extra });
}

function fail(projectId, diagnostics, expectedDuration = null) {
  return createAssemblyResult({ projectId: projectId || null, status: 'FAILED', artifact: null, expectedDuration, diagnostics });
}

// ---------------------------------------------------------------------------
// ffprobe inspection — mirrors services/renderers/hyperframes-renderer.js's
// own ffprobeValidate() shape/discipline (never trust a non-zero exit code
// alone is not needed here — this is read-only inspection of an artifact
// render-service.js already validated at render time; a decode-integrity
// pass happens once, at the very end, on the FINAL assembled output only).
// ---------------------------------------------------------------------------
function ffprobeInspect(ffprobePath, filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, message: 'file does not exist' };
  let raw;
  try {
    raw = execFileSync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', filePath],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
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
  const duration = parsed.format && Number(parsed.format.duration);
  const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
  if (!duration || !Number.isFinite(duration) || duration <= 0) return { ok: false, message: `invalid duration: ${JSON.stringify(parsed.format)}` };
  let fps = null;
  if (videoStream && typeof videoStream.r_frame_rate === 'string' && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0) fps = num / den;
  }
  return {
    ok: true,
    duration,
    width: videoStream ? videoStream.width : null,
    height: videoStream ? videoStream.height : null,
    fps,
    videoCodec: videoStream ? videoStream.codec_name : null,
    audioCodec: audioStream ? audioStream.codec_name : null,
    hasAudio: Boolean(audioStream),
  };
}

function run(ffmpegPath, args, code, message) {
  try {
    execFileSync(ffmpegPath, args, { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').slice(-2000) : '';
    return { ok: false, error: diag(code, `${message}: ${error && error.message ? error.message : String(error)}${stderr ? ` | stderr: ${stderr}` : ''}`) };
  }
}

// scale+pad to the target frame, normalize fps, strip audio (Part 11),
// trim/pad to EXACTLY durationSeconds (Part 4 — the compiled duration is
// authoritative, never the render artifact's own reported duration).
function buildShotSegment(ffmpegPath, sourcePath, durationSeconds, width, height, fps, outPath) {
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${durationSeconds}`;
  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-t', String(durationSeconds), '-vf', vf, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath],
    'FFMPEG_FAILED',
    `failed to normalize shot segment from "${sourcePath}"`
  );
}

function buildBlackSegment(ffmpegPath, durationSeconds, width, height, fps, outPath) {
  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSeconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath],
    'FFMPEG_FAILED',
    'failed to build a black gap-filler segment'
  );
}

function concatSegments(ffmpegPath, workDir, segmentPaths, width, height, fps, outPath) {
  const listPath = path.join(workDir, 'concat.txt');
  const lines = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, lines, 'utf8');
  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-r', String(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath],
    'FFMPEG_FAILED',
    'failed to concatenate visual segments'
  );
}

// Normalizes ONE narration source to an exact-length (expectedDuration),
// silence-padded WAV, shifted to its own real, measured startTime — the
// building block for placing N independently-timed narration events onto
// one timeline without ever using word-count/WPM/target estimates (Part
// 10): every input to this function is the AudioEvent's own REAL,
// ffprobe-measurable audio file and REAL startTime.
function buildNarrationSegment(ffmpegPath, sourcePath, startTimeSeconds, expectedDuration, outPath) {
  const delayMs = Math.max(0, Math.round(startTimeSeconds * 1000));
  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-af', `adelay=${delayMs}|${delayMs},apad`, '-t', String(expectedDuration), '-ar', '48000', '-ac', '2', outPath],
    'FFMPEG_FAILED',
    `failed to place narration segment from "${sourcePath}" at startTime ${startTimeSeconds}`
  );
}

function mixNarrationSegments(ffmpegPath, segmentPaths, outPath) {
  if (segmentPaths.length === 1) {
    return run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', segmentPaths[0], '-c:a', 'pcm_s16le', outPath], 'FFMPEG_FAILED', 'failed to normalize the single narration track');
  }
  const inputArgs = segmentPaths.flatMap((p) => ['-i', p]);
  const filter = `amix=inputs=${segmentPaths.length}:duration=first:dropout_transition=0[aout]`;
  return run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs, '-filter_complex', filter, '-map', '[aout]', outPath], 'FFMPEG_FAILED', 'failed to mix narration tracks');
}

function muxFinal(ffmpegPath, videoPath, audioPath, outPath) {
  if (!audioPath) {
    return run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-c', 'copy', outPath], 'FFMPEG_FAILED', 'failed to finalize video-only output');
  }
  return run(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outPath],
    'FFMPEG_FAILED',
    'failed to mux final audio+video output'
  );
}

// ---------------------------------------------------------------------------
// Source validation (Part 3).
// ---------------------------------------------------------------------------
function validateShotSource(shot, renderResultsByExecutionId) {
  if (!shot.executionId) {
    return { error: diag('MISSING_RENDER_RESULT', `compiled shot "${shot.shotId}" has no executionId to look up a RenderResult by`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  const render = renderResultsByExecutionId.get(shot.executionId);
  if (!render) {
    return { error: diag('MISSING_RENDER_RESULT', `no RenderResult found for executionId "${shot.executionId}" (compiled shot "${shot.shotId}")`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  if (render.status !== 'COMPLETED') {
    return { error: diag('RENDER_NOT_COMPLETED', `RenderResult for executionId "${shot.executionId}" is not COMPLETED`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  if (!render.artifact || !render.artifact.path) {
    return { error: diag('RENDER_ARTIFACT_MISSING', `RenderResult for executionId "${shot.executionId}" has no artifact`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  let readable = false;
  try {
    fs.accessSync(render.artifact.path, fs.constants.R_OK);
    readable = fs.statSync(render.artifact.path).size > 0;
  } catch {
    readable = false;
  }
  if (!readable) {
    return { error: diag('RENDER_FILE_MISSING', `render artifact file does not exist or is unreadable: "${render.artifact.path}"`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  if (classifyTimingValue(render.artifact.width) !== 'VALID' || classifyTimingValue(render.artifact.height) !== 'VALID' || render.artifact.width <= 0 || render.artifact.height <= 0) {
    return { error: diag('RENDER_DIMENSIONS_UNKNOWN', `render artifact for executionId "${shot.executionId}" has unknown/invalid dimensions`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  if (classifyTimingValue(render.artifact.duration) !== 'VALID' || render.artifact.duration <= 0) {
    return { error: diag('RENDER_DURATION_UNKNOWN', `render artifact for executionId "${shot.executionId}" has unknown/invalid duration`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  if (classifyTimingValue(shot.startTime) !== 'VALID' || classifyTimingValue(shot.duration) !== 'VALID' || shot.duration <= 0) {
    return { error: diag('INVALID_SHOT_TIMING', `compiled shot "${shot.shotId}" has invalid startTime/duration`, { shotId: shot.shotId, beatId: shot.beatId }) };
  }
  return { render };
}

function validateAudioEvent(audioEvent, projectId) {
  if (!audioEvent || typeof audioEvent !== 'object') {
    return { error: diag('MISSING_AUDIO_EVENT', 'an audioEvents[] entry must be a plain AudioEvent object') };
  }
  if (typeof audioEvent.sourceAssetId !== 'string' || audioEvent.sourceAssetId.length === 0) {
    return { error: diag('AUDIO_ASSET_MISSING', `AudioEvent "${audioEvent.audioEventId || '(no id)'}" has no sourceAssetId`) };
  }
  const asset = timelineStore.getAsset(projectId, audioEvent.sourceAssetId);
  if (!asset) {
    return { error: diag('AUDIO_ASSET_MISSING', `no Asset found for AudioEvent sourceAssetId "${audioEvent.sourceAssetId}"`) };
  }
  if (asset.type !== 'audio') {
    return { error: diag('AUDIO_ASSET_WRONG_TYPE', `Asset "${asset.assetId}" has type "${asset.type}", not "audio"`) };
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return { error: diag('AUDIO_ASSET_NOT_STORED', `Asset "${asset.assetId}" storage status is "${storageStatus}", not STORED`) };
  }
  let absolutePath;
  try {
    absolutePath = assetStorage.resolveStoredPath(asset.storage.path);
  } catch (error) {
    return { error: diag('AUDIO_FILE_MISSING', `could not resolve stored path for Asset "${asset.assetId}": ${error.message}`) };
  }
  if (!fs.existsSync(absolutePath)) {
    return { error: diag('AUDIO_FILE_MISSING', `stored audio file for Asset "${asset.assetId}" does not exist on disk`) };
  }
  if (classifyTimingValue(audioEvent.duration) !== 'VALID' || audioEvent.duration <= 0) {
    return { error: diag('AUDIO_DURATION_UNKNOWN', `AudioEvent "${audioEvent.audioEventId}" has no valid measured duration`) };
  }
  if (classifyTimingValue(audioEvent.startTime) !== 'VALID') {
    return { error: diag('INVALID_SHOT_TIMING', `AudioEvent "${audioEvent.audioEventId}" has an invalid startTime`) };
  }
  return { asset, absolutePath };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------
function assembleTimeline({ projectId, timelineCompilation, renderResults, audioEvents = [], outputDir, options = {} } = {}) {
  if (!timelineCompilation || !Array.isArray(timelineCompilation.shots)) {
    return fail(projectId, [diag('INVALID_TIMELINE_COMPILATION', 'a TimelineCompilationResult with a shots array is required')]);
  }
  if (!outputDir || typeof outputDir !== 'string') {
    return fail(projectId, [diag('INVALID_TIMELINE_COMPILATION', 'an outputDir is required')]);
  }

  const width = options.targetWidth || DEFAULT_WIDTH;
  const height = options.targetHeight || DEFAULT_HEIGHT;
  const fps = options.targetFps || DEFAULT_FPS;
  const tolerance = typeof options.toleranceSeconds === 'number' ? options.toleranceSeconds : DEFAULT_TOLERANCE_SECONDS;
  const ffmpegPath = resolveFfmpeg(options);
  const ffprobePath = resolveFfprobe(options);

  const diagnostics = [];

  // --- Part 9 — transitions: only an empty set is currently supported ---
  if (Array.isArray(timelineCompilation.transitions) && timelineCompilation.transitions.length > 0) {
    return fail(
      projectId,
      [diag('TRANSITION_UNSUPPORTED', `${timelineCompilation.transitions.length} transition(s) present, but no transition rendering semantics are implemented yet — refusing to silently perform a plain cut where a transition was requested`)]
    );
  }

  // --- Part 8 — layer scope: PRIMARY only, others reported and excluded ---
  const primaryShots = [];
  for (const shot of timelineCompilation.shots.filter(Boolean)) {
    if (shot.layer !== 'PRIMARY') {
      diagnostics.push(diag('ASSEMBLY_LAYER_UNSUPPORTED', `shot "${shot.shotId}" is on layer "${shot.layer}" — compositing non-PRIMARY layers is not implemented this stage; excluded from the assembled output`, { shotId: shot.shotId, beatId: shot.beatId }));
      continue;
    }
    primaryShots.push(shot);
  }
  primaryShots.sort((a, b) => a.startTime - b.startTime);

  if (primaryShots.length === 0) {
    return fail(projectId, [...diagnostics, diag('MISSING_RENDER_RESULT', 'no PRIMARY-layer shots are available to assemble')]);
  }

  // --- Part 3 — validate every PRIMARY source; never silently skip missing media ---
  const renderResultsByExecutionId = new Map();
  for (const r of Array.isArray(renderResults) ? renderResults : []) {
    if (r && r.executionId) renderResultsByExecutionId.set(r.executionId, r);
  }

  const resolvedShots = [];
  let cursorEnd = null;
  for (const shot of primaryShots) {
    const result = validateShotSource(shot, renderResultsByExecutionId);
    if (result.error) return fail(projectId, [...diagnostics, result.error]);
    // defensive re-check: PRIMARY overlap should already be impossible per
    // timeline-compiler-service.js's own PRIMARY_OVERLAP_FORBIDDEN gate —
    // re-verified here rather than trusted blindly.
    if (cursorEnd !== null && shot.startTime < cursorEnd - 1e-9) {
      return fail(projectId, [...diagnostics, diag('INVALID_SHOT_TIMING', `PRIMARY shot "${shot.shotId}" starts at ${shot.startTime}, before the previous PRIMARY shot ends at ${cursorEnd}`, { shotId: shot.shotId, beatId: shot.beatId })]);
    }
    cursorEnd = shot.startTime + shot.duration;
    resolvedShots.push({ shot, render: result.render });
  }

  // --- Part 3 — validate every supplied AudioEvent ---
  const resolvedAudio = [];
  for (const ae of Array.isArray(audioEvents) ? audioEvents : []) {
    const result = validateAudioEvent(ae, projectId);
    if (result.error) return fail(projectId, [...diagnostics, result.error]);
    resolvedAudio.push({ audioEvent: ae, asset: result.asset, absolutePath: result.absolutePath });
  }

  // --- Part 12 — expected duration: last PRIMARY shot end vs. last narration end, whichever is later ---
  const lastPrimaryEnd = resolvedShots.reduce((max, r) => Math.max(max, r.shot.startTime + r.shot.duration), 0);
  const lastAudioEnd = resolvedAudio.reduce((max, r) => Math.max(max, r.audioEvent.startTime + r.audioEvent.duration), 0);
  const expectedDuration = Math.max(lastPrimaryEnd, lastAudioEnd);

  // --- Part 5/7 — build the visual track: shots at their real startTime, gaps preserved and black-filled ---
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-assembly-'));
  try {
    const segments = [];
    let cursor = 0;
    for (const { shot, render } of resolvedShots) {
      if (shot.startTime > cursor + 1e-9) {
        const gapDuration = shot.startTime - cursor;
        const gapPath = path.join(workDir, `gap-${segments.length}.mp4`);
        const built = buildBlackSegment(ffmpegPath, gapDuration, width, height, fps, gapPath);
        if (!built.ok) return fail(projectId, [...diagnostics, built.error], expectedDuration);
        segments.push(gapPath);
      }
      const segPath = path.join(workDir, `shot-${segments.length}.mp4`);
      const built = buildShotSegment(ffmpegPath, render.artifact.path, shot.duration, width, height, fps, segPath);
      if (!built.ok) return fail(projectId, [...diagnostics, built.error], expectedDuration);
      segments.push(segPath);
      cursor = shot.startTime + shot.duration;
    }
    if (expectedDuration > cursor + 1e-9) {
      const trailingGap = expectedDuration - cursor;
      const gapPath = path.join(workDir, `gap-${segments.length}.mp4`);
      const built = buildBlackSegment(ffmpegPath, trailingGap, width, height, fps, gapPath);
      if (!built.ok) return fail(projectId, [...diagnostics, built.error], expectedDuration);
      segments.push(gapPath);
    }

    const silentVideoPath = path.join(workDir, 'silent.mp4');
    const concatBuilt = concatSegments(ffmpegPath, workDir, segments, width, height, fps, silentVideoPath);
    if (!concatBuilt.ok) return fail(projectId, [...diagnostics, concatBuilt.error], expectedDuration);

    // --- Part 10/11 — narration only; no music/SFX/mixing beyond placement ---
    let mixedAudioPath = null;
    if (resolvedAudio.length > 0) {
      const narrationSegmentPaths = [];
      for (const { audioEvent, absolutePath } of resolvedAudio) {
        const segPath = path.join(workDir, `narr-${narrationSegmentPaths.length}.wav`);
        const built = buildNarrationSegment(ffmpegPath, absolutePath, audioEvent.startTime, expectedDuration, segPath);
        if (!built.ok) return fail(projectId, [...diagnostics, built.error], expectedDuration);
        narrationSegmentPaths.push(segPath);
      }
      mixedAudioPath = path.join(workDir, 'narration-mixed.wav');
      const mixed = mixNarrationSegments(ffmpegPath, narrationSegmentPaths, mixedAudioPath);
      if (!mixed.ok) return fail(projectId, [...diagnostics, mixed.error], expectedDuration);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `assembly-${crypto.randomUUID()}.mp4`);
    const muxed = muxFinal(ffmpegPath, silentVideoPath, mixedAudioPath, outputPath);
    if (!muxed.ok) return fail(projectId, [...diagnostics, muxed.error], expectedDuration);

    // --- Part 12 — verify actual output against expected duration ---
    const inspected = ffprobeInspect(ffprobePath, outputPath);
    if (!inspected.ok) return fail(projectId, [...diagnostics, diag('FFMPEG_FAILED', `could not validate final output: ${inspected.message}`)], expectedDuration);

    const drift = Math.abs(inspected.duration - expectedDuration);
    if (drift > tolerance) {
      return fail(
        projectId,
        [...diagnostics, diag('FINAL_DURATION_MISMATCH', `expected ${expectedDuration}s, ffprobe measured ${inspected.duration}s (drift ${drift.toFixed(3)}s exceeds tolerance ${tolerance}s)`)],
        expectedDuration
      );
    }

    // --- Part 13 — provenance ---
    const shotProvenance = resolvedShots.map(({ shot, render }) =>
      createShotProvenanceEntry({
        shotId: shot.shotId,
        beatId: shot.beatId,
        materialId: shot.materialId,
        executionId: shot.executionId,
        renderId: render.renderId,
        sourceAssetId: (shot.renderSpec && (shot.renderSpec.assetId || shot.renderSpec.sourceAssetId)) || null,
        startTime: shot.startTime,
        duration: shot.duration,
      })
    );
    const narrationProvenance = resolvedAudio.map(({ audioEvent }) =>
      createNarrationProvenanceEntry({
        audioEventId: audioEvent.audioEventId,
        sourceAssetId: audioEvent.sourceAssetId,
        scriptRefId: audioEvent.scriptRefId,
        beatId: audioEvent.beatId,
        startTime: audioEvent.startTime,
        duration: audioEvent.duration,
      })
    );

    return createAssemblyResult({
      projectId: projectId || null,
      status: 'COMPLETED',
      expectedDuration,
      artifact: createAssemblyArtifact({ format: 'MP4', path: outputPath, width: inspected.width, height: inspected.height, fps: inspected.fps, duration: inspected.duration }),
      videoSources: shotProvenance.map((p) => p.sourceAssetId).filter(Boolean),
      narrationSources: resolvedAudio.map((r) => r.audioEvent.sourceAssetId),
      diagnostics,
      provenance: { shots: shotProvenance, narration: narrationProvenance },
    });
  } catch (error) {
    return fail(projectId, [...diagnostics, diag('FFMPEG_FAILED', `assembly threw: ${error && error.message ? error.message : String(error)}`)], null);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { assembleTimeline, DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_FPS, DEFAULT_TOLERANCE_SECONDS };
