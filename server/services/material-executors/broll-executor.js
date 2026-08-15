// broll-executor.js
//
// Stage 26.5B, Part 5 — the BROLL_CLIP deterministic executor. Takes an
// ALREADY-SELECTED B-roll material (Material Resolution's Stage 26.5B
// Part 4 decision — services/material-resolution-service.js's
// BROLL_LIBRARY block: materialSource 'BROLL_LIBRARY', visualTreatment
// 'BROLL_CLIP', selectedAssetId set, brollSegment lineage attached) and
// produces a deterministic BROLL_CLIP render specification describing HOW
// that clip should sit on the future timeline: trim window, playback rate,
// fit/crop, transform, audio policy.
//
// It NEVER searches, ranks, or selects a B-roll segment — Material
// Resolution already made that choice. This executor performs a final,
// DEFENSIVE re-validation of the already-selected segment/asset (still
// ACTIVE, still LICENSED, Asset still exists/video/STORED) — the exact
// same "re-check, never re-decide" discipline
// project-asset-reuse-executor.js already established for
// PROJECT_ASSET_REUSE, never a second selection or a fresh library query.
//
// It never copies, mutates, or re-archives the underlying Asset or the
// BRollSegment record — read-only via the existing, unmodified
// broll-library-service.js and timeline-store.js. No provider, no
// network, no ffprobe/media probing: media duration is used ONLY when
// schemas/broll-schema.js's media.duration is already known (Stage 26.5B
// Part 2 deliberately allows it to be null) — never invented, never
// derived by inspecting the file.

const timelineStore = require('../timeline-store');
const brollLibraryService = require('../broll-library-service');
const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

const FIT_VALUES = ['COVER', 'CONTAIN', 'FILL'];
// Deterministic default: MUTE. B-roll is overlay/cutaway footage — its own
// captured audio is not, by default, the beat's intended soundtrack
// (narration/music own that role). KEEP/DUCK are available for a caller
// that explicitly wants the clip's own audio.
const AUDIO_POLICIES = ['MUTE', 'KEEP', 'DUCK'];

function fail(beat, materialId, code, message, sourceAssetIds = []) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'BROLL_CLIP',
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds,
    diagnostics: [createDiagnostic({ code, message })],
  });
}

// input: { projectId, beat, selectedMaterial, options }
//   selectedMaterial — a Stage 26.5B Part 4 CandidateResult (materialSource
//     'BROLL_LIBRARY', visualTreatment 'BROLL_CLIP', selectedAssetId set,
//     brollSegment: { segmentId, assetId, licensing, source, media,
//     descriptiveMetadata, usage } set — see
//     schemas/material-resolution-schema.js). A legacy Stage 26.3
//     context.brollSegments fixture candidate (brollSegment: null) is
//     NEVER executable here — it fails structurally (MISSING_SEGMENT_ID),
//     exactly as intended: that path only ever existed to unit-test the
//     resolver's gating logic, never to be executed.
//   options — { startTime, duration, trimIn, trimOut, trimFromEnd,
//     playbackRate, fit, transform, audioPolicy, position, scale,
//     opacity }, all optional; startTime/duration default to the beat's
//     own fields when omitted.
function execute({ projectId, beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;

  // --- Requirement: the resolved candidate must already identify every
  // field this executor needs. Never re-resolve/re-select — anything
  // missing here fails structurally, it is never silently filled in from a
  // fresh library lookup. ---
  if (!selectedMaterial || selectedMaterial.materialSource !== 'BROLL_LIBRARY' || selectedMaterial.visualTreatment !== 'BROLL_CLIP') {
    return fail(beat, materialId, 'INVALID_MATERIAL', 'selectedMaterial must be a BROLL_LIBRARY + BROLL_CLIP candidate');
  }
  const lineage = selectedMaterial.brollSegment;
  if (!lineage || !lineage.segmentId) {
    return fail(beat, materialId, 'MISSING_SEGMENT_ID', 'selectedMaterial.brollSegment.segmentId is required for BROLL_CLIP execution');
  }
  if (!selectedMaterial.selectedAssetId) {
    return fail(beat, materialId, 'MISSING_ASSET_ID', 'selectedMaterial.selectedAssetId is required for BROLL_CLIP execution');
  }
  const assetId = selectedMaterial.selectedAssetId;

  // --- Defensive re-check of the B-roll segment itself (never a re-selection) ---
  const segment = brollLibraryService.getBrollSegment(projectId, lineage.segmentId);
  if (!segment) {
    return fail(beat, materialId, 'SEGMENT_NOT_FOUND', `no B-roll segment found with id "${lineage.segmentId}" in project "${projectId}"`, [assetId]);
  }
  if (segment.status !== 'ACTIVE') {
    return fail(beat, materialId, 'SEGMENT_NOT_ACTIVE', `B-roll segment "${lineage.segmentId}" has status "${segment.status}", not ACTIVE`, [assetId]);
  }
  if (segment.licensing.status !== 'LICENSED') {
    return fail(beat, materialId, 'SEGMENT_NOT_LICENSED', `B-roll segment "${lineage.segmentId}" licensing status is "${segment.licensing.status}", not LICENSED`, [assetId]);
  }

  // --- Defensive re-check of the referenced Asset (by the candidate's own
  // selectedAssetId — same trust model project-asset-reuse-executor.js
  // already uses for PROJECT_ASSET_REUSE) ---
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) {
    return fail(beat, materialId, 'ASSET_NOT_FOUND', `no asset found with id "${assetId}" in project "${projectId}"`, [assetId]);
  }
  if (asset.type !== 'video') {
    return fail(beat, materialId, 'ASSET_WRONG_TYPE', `asset "${assetId}" has type "${asset.type}", not "video"`, [assetId]);
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return fail(beat, materialId, 'ASSET_NOT_USABLE', `asset "${assetId}" storage status is "${storageStatus}", not STORED`, [assetId]);
  }

  // --- Timing (same "explicit option, fall back to beat" convention as
  // project-asset-reuse-executor.js) ---
  const startTime = options.startTime !== undefined ? options.startTime : beat && beat.startTime;
  const duration = options.duration !== undefined ? options.duration : beat && beat.duration;
  if (typeof startTime !== 'number' || Number.isNaN(startTime) || startTime < 0) {
    return fail(beat, materialId, 'INVALID_START_TIME', `startTime must be a non-negative number, got ${JSON.stringify(startTime)}`, [assetId]);
  }
  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return fail(beat, materialId, 'INVALID_DURATION', `duration must be a positive number, got ${JSON.stringify(duration)}`, [assetId]);
  }

  // --- Playback rate / trim ---
  const playbackRate = options.playbackRate !== undefined ? options.playbackRate : 1;
  if (typeof playbackRate !== 'number' || Number.isNaN(playbackRate) || playbackRate <= 0) {
    return fail(beat, materialId, 'INVALID_PLAYBACK_RATE', `playbackRate must be a positive number, got ${JSON.stringify(playbackRate)}`, [assetId]);
  }

  const trimIn = options.trimIn !== undefined ? options.trimIn : 0;
  if (typeof trimIn !== 'number' || Number.isNaN(trimIn) || trimIn < 0) {
    return fail(beat, materialId, 'INVALID_TRIM_IN', `trimIn must be a non-negative number, got ${JSON.stringify(trimIn)}`, [assetId]);
  }

  // Stage 26.5B Part 2's own rule: media.duration may be null ("unknown
  // metadata stays unknown" — no ffprobe, no probing, never invented here
  // either). Only used BELOW to VALIDATE a trim window when it is known.
  const knownSourceDuration = typeof segment.media.duration === 'number' ? segment.media.duration : null;

  let trimOut;
  if (options.trimFromEnd === true) {
    // Trimming relative to the end of the source clip fundamentally
    // requires knowing how long the source clip is — fail safely rather
    // than guessing when it is not known.
    if (knownSourceDuration === null) {
      return fail(
        beat,
        materialId,
        'UNKNOWN_MEDIA_DURATION',
        `trimFromEnd was requested but B-roll segment "${lineage.segmentId}" has no known media duration to trim relative to`,
        [assetId]
      );
    }
    trimOut = knownSourceDuration;
    if (trimOut <= trimIn) {
      return fail(beat, materialId, 'IMPOSSIBLE_TRIM', `trimIn (${trimIn}) leaves no room before the known media duration (${knownSourceDuration}s)`, [assetId]);
    }
  } else if (options.trimOut !== undefined) {
    trimOut = options.trimOut;
    if (typeof trimOut !== 'number' || Number.isNaN(trimOut) || trimOut <= trimIn) {
      return fail(beat, materialId, 'INVALID_TRIM_OUT', `trimOut must be a number greater than trimIn (${trimIn}), got ${JSON.stringify(trimOut)}`, [assetId]);
    }
  } else {
    // Derived default: the clip must play for exactly `duration` seconds
    // at `playbackRate`, so it consumes `duration * playbackRate` seconds
    // of SOURCE media starting at trimIn. This is arithmetic on the
    // REQUESTED timeline duration, never a guess about the source's own
    // total length.
    trimOut = trimIn + duration * playbackRate;
  }

  // If (and only if) the source's own media duration IS known, validate
  // the trim window against it — never invent a duration when it's null.
  if (knownSourceDuration !== null && trimOut > knownSourceDuration) {
    return fail(
      beat,
      materialId,
      'TRIM_EXCEEDS_KNOWN_DURATION',
      `requested trim window [${trimIn}, ${trimOut}] exceeds the B-roll segment's known media duration (${knownSourceDuration}s)`,
      [assetId]
    );
  }

  const fit = FIT_VALUES.includes(options.fit) ? options.fit : 'COVER';
  const audioPolicy = AUDIO_POLICIES.includes(options.audioPolicy) ? options.audioPolicy : 'MUTE';

  const renderSpec = {
    type: 'BROLL_CLIP',
    sourceAssetId: assetId,
    brollSegmentId: lineage.segmentId,
    startTime,
    duration,
    trimIn,
    trimOut,
    playbackRate,
    fit,
    transform: options.transform || null,
    position: options.position || { x: 0, y: 0 },
    scale: typeof options.scale === 'number' ? options.scale : 1,
    opacity: typeof options.opacity === 'number' ? options.opacity : 1,
    audioPolicy,
    role: selectedMaterial.role || 'PRIMARY',
  };

  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'BROLL_CLIP',
    status: 'COMPLETED',
    duration,
    renderSpec,
    sourceAssetIds: [assetId],
    diagnostics: [],
  });
}

module.exports = { execute, FIT_VALUES, AUDIO_POLICIES };
