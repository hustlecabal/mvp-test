// timeline-compiler-service.js
//
// Stage 26.6, Part 2 — the TIMELINE COMPILER. Converts already-decided
// deterministic outputs into an executable temporal plan:
//
//   BeatGraph + MaterialResolution[] + ExecutionResult[]  -->  compiled
//   Shot[] + transitions[] (schemas/production-schema.js's EXISTING Shot
//   shape, extended with 5 additive fields — see that file's own comment)
//
// This is deliberately NOT a rendering, generation, ranking, or selection
// service. It never calls a provider, never spends a credit, never
// re-resolves a material (that already happened — services/material-
// resolution-service.js), and never re-executes a material (that already
// happened — services/material-execution-service.js). It only combines
// already-decided results. It is PURE: it never writes to disk, never
// calls timelineStore.addShot()/addScene(), and never mutates any of its
// own inputs (BeatGraph, MaterialResolution[], ExecutionResult[]).
// Persisting a compiled result into a real project's Timeline IR is a
// later, separate, explicit operation this file does not perform.
//
// NO SECOND TIMELINE: every compiled entry is an ordinary
// schemas/production-schema.js Shot record (createShot()), never a new
// "TimelineEvent" shape. See docs/architecture/stage-26.2-visual-
// production-master-spec.md Section 16 and the Stage 26.6 Part 1 audit for
// why.

const productionSchema = require('../schemas/production-schema');
const { MATERIAL_ROLES } = require('../schemas/visual-beat-schema');
const { AUDIO_EVENT_TYPES } = require('../schemas/audio-schema');
const { createCompilationDiagnostic, createCompiledTransition, createTimelineCompilationResult } = require('../schemas/timeline-compilation-schema');

// ---------------------------------------------------------------------------
// Deterministic beat ordering — the EXACT comparator
// services/material-resolution-service.js's resolveBeatGraph() already
// uses (sceneId -> sequence -> beat.id), duplicated here rather than
// imported (services, unlike schema files, MAY cross-require each other in
// this codebase, but this comparator is small enough, and independent
// enough of Material Resolution's own concerns, that duplicating it avoids
// this file depending on material-resolution-service.js at all — this
// compiler consumes RESOLUTIONS, it does not need the resolver itself).
// ---------------------------------------------------------------------------
function compareBeats(a, b) {
  const sceneCompare = String(a.sceneId).localeCompare(String(b.sceneId));
  if (sceneCompare !== 0) return sceneCompare;
  const sequenceCompare = (a.sequence ?? 0) - (b.sequence ?? 0);
  if (sequenceCompare !== 0) return sequenceCompare;
  return String(a.id).localeCompare(String(b.id));
}

// Deterministic ordering among a single beat's own resolved materials —
// "material order" (Part 2, Section 7) collapses to materialId ordering
// today because no MaterialComponent.order value flows into a
// MaterialResolution yet (Stage 26.3/26.4/26.5A/26.5B only ever resolve/
// execute ONE material per beat — see this file's own header). `id` is a
// defensive final tie-break only: two resolutions for the same beat never
// share a materialId in any real candidate-id construction, so this rung
// is never actually reached by real data, and is kept only per Part 2,
// Section 7's own explicit tie-break chain.
function compareResolutionsByMaterial(a, b) {
  const aId = a.selectedMaterial ? a.selectedMaterial.candidate : '';
  const bId = b.selectedMaterial ? b.selectedMaterial.candidate : '';
  const cmp = String(aId).localeCompare(String(bId));
  if (cmp !== 0) return cmp;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

// ABSENT (null/undefined) is legitimately allowed to fall through to the
// next tier of the timing hierarchy (Part 2, Section 3). INVALID (present
// but NaN/Infinity/negative/non-number) is a genuine defect and must be
// REJECTED, never silently replaced by a fallback tier — that would be
// "silently repairing invalid timing," explicitly forbidden.
function classifyTimingValue(value) {
  if (value === null || value === undefined) return 'ABSENT';
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value < 0) return 'INVALID';
  return 'VALID';
}

// visualTreatment -> legacy Shot asset field, EXACTLY the routing rule
// services/material-resolution-service.js's own toTimelineShotFields()
// already established for a single beat — reused here, not reinvented, so
// an older consumer that reads shot.keyframeAssetId/videoAssetId directly
// (rather than shot.renderSpec) keeps working. Never derived from
// renderSpec's own fields — sourced from the execution's sourceAssetIds
// only, which is the pre-existing, already-validated asset reference.
function deriveLegacyAssetFields(visualTreatment, sourceAssetIds) {
  const assetId = Array.isArray(sourceAssetIds) && sourceAssetIds.length > 0 ? sourceAssetIds[0] : null;
  if (!assetId) return { keyframeAssetId: null, videoAssetId: null };
  if (visualTreatment === 'STILL_IMAGE') return { keyframeAssetId: assetId, videoAssetId: null };
  if (visualTreatment === 'AI_VIDEO' || visualTreatment === 'BROLL_CLIP') return { keyframeAssetId: null, videoAssetId: assetId };
  return { keyframeAssetId: null, videoAssetId: null };
}

// Interval-sweep overlap detection over PRIMARY-layer shots only (Part 2,
// Section 8 — only PRIMARY overlap is forbidden; OVERLAY/BACKGROUND/INSERT
// sharing a window with a PRIMARY, or with each other, is the intended,
// common hybrid-beat case). Returns the Set of shot objects involved in
// ANY overlap — every shot in that set is excluded from the final result;
// neither side is arbitrarily kept as a "winner," since picking one would
// itself be a silent repair.
function findPrimaryOverlaps(primaryShots) {
  const sorted = [...primaryShots].sort(
    (a, b) => a.startTime - b.startTime || String(a.beatId || '').localeCompare(String(b.beatId || '')) || String(a.materialId || '').localeCompare(String(b.materialId || ''))
  );
  const overlapping = new Set();
  let active = [];
  for (const shot of sorted) {
    const endTime = shot.startTime + shot.duration;
    active = active.filter((entry) => entry.endTime > shot.startTime);
    if (active.length > 0) {
      overlapping.add(shot);
      for (const entry of active) overlapping.add(entry.shot);
    }
    active.push({ shot, endTime });
  }
  return overlapping;
}

// ---------------------------------------------------------------------------
// Public entry point. Pure: never mutates beatGraph/resolutions/executions,
// never writes to disk, never calls timelineStore, never calls a provider,
// never reserves a credit. Returns a structured compilation result even
// when nothing compiles — never throws for an ordinary "nothing resolved
// yet" case, exactly like resolveMaterial()/resolveBeatGraph() already
// don't throw for "no eligible candidate."
//
//   beatGraph   — schemas/beat-graph-schema.js's createBeatGraph() output
//   resolutions — an ARRAY of MaterialResolution (schemas/material-
//                 resolution-service.js's resolveMaterial() output, one
//                 per beat today — see file header re: hybrid beats).
//                 Grouped internally by resolution.beatId.
//   executions  — an ARRAY of ExecutionResult (services/material-
//                 execution-service.js's executeMaterial() output).
//                 Matched internally to a resolution by
//                 (execution.beatId, execution.materialId).
//   audioInputs — PHASE 3A, additive, optional (defaults to []). An ARRAY
//                 of already-resolved schemas/audio-schema.js AudioEvent
//                 records (today: the NARRATION events services/
//                 production-orchestrator-service.js's own narration
//                 cursor already produced upstream of this call — this
//                 function REGISTERS their already-decided timing, it
//                 never recomputes it; see this file's own audio-placement
//                 section below for beat/scene/whole-timeline derivation
//                 of anything ABSENT). Every existing caller that omits
//                 this parameter gets audio: [] in the result, byte-
//                 identical to this function's pre-Phase-3A behavior.
//   context     — { projectId } optional, informational only (stamped onto
//                 the result for a later persistence step's convenience;
//                 never read by any validation/timing/ordering decision in
//                 this function).
// ---------------------------------------------------------------------------
function compileTimeline(beatGraph, resolutions, executions, audioInputs = [], context = {}) {
  const diagnostics = [];

  if (!beatGraph || !Array.isArray(beatGraph.beats)) {
    return createTimelineCompilationResult({
      projectId: context.projectId || null,
      status: 'FAILED',
      shots: [],
      transitions: [],
      diagnostics: [createCompilationDiagnostic({ code: 'INVALID_BEAT_GRAPH', message: 'a BeatGraph with a beats array is required' })],
    });
  }

  const orderedBeats = beatGraph.beats.filter((b) => b && b.id).sort(compareBeats);

  // --- group resolutions by beatId (never mutating the input array itself) ---
  const resolutionsByBeatId = new Map();
  for (const resolution of Array.isArray(resolutions) ? resolutions : []) {
    if (!resolution || !resolution.beatId) continue;
    if (!resolutionsByBeatId.has(resolution.beatId)) resolutionsByBeatId.set(resolution.beatId, []);
    resolutionsByBeatId.get(resolution.beatId).push(resolution);
  }

  // --- index executions by (beatId, materialId) ---
  const executionsByKey = new Map();
  for (const execution of Array.isArray(executions) ? executions : []) {
    if (!execution || !execution.beatId || !execution.materialId) continue;
    executionsByKey.set(`${execution.beatId}::${execution.materialId}`, execution);
  }

  const shots = [];
  let sequentialCursor = 0;

  for (const beat of orderedBeats) {
    const beatResolutions = (resolutionsByBeatId.get(beat.id) || []).slice().sort(compareResolutionsByMaterial);

    if (beatResolutions.length === 0) {
      diagnostics.push(createCompilationDiagnostic({ code: 'UNRESOLVED_BEAT', beatId: beat.id, message: `no MaterialResolution was supplied for beat "${beat.id}"` }));
      continue;
    }

    let beatInferredStartTime = null; // computed at most once per beat — see file header's timing precedence note

    for (const resolution of beatResolutions) {
      if (resolution.status !== 'RESOLVED' || !resolution.selectedMaterial || !resolution.selectedMaterial.candidate) {
        diagnostics.push(createCompilationDiagnostic({ code: 'UNRESOLVED_BEAT', beatId: beat.id, message: `beat "${beat.id}"'s MaterialResolution is not RESOLVED — excluded from the compiled timeline` }));
        continue;
      }

      const materialId = resolution.selectedMaterial.candidate;
      const execution = executionsByKey.get(`${beat.id}::${materialId}`);

      if (!execution) {
        diagnostics.push(createCompilationDiagnostic({ code: 'EXECUTION_FAILED', beatId: beat.id, materialId, message: `no ExecutionResult was supplied for beat "${beat.id}" material "${materialId}"` }));
        continue;
      }
      if (execution.status !== 'COMPLETED') {
        const executorDiagCodes = Array.isArray(execution.diagnostics) ? execution.diagnostics.map((d) => d.code).join(', ') : '';
        diagnostics.push(
          createCompilationDiagnostic({
            code: 'EXECUTION_FAILED',
            beatId: beat.id,
            materialId,
            message: `execution for beat "${beat.id}" material "${materialId}" did not COMPLETE${executorDiagCodes ? ` (${executorDiagCodes})` : ''}`,
          })
        );
        continue;
      }

      // --- duration: always sourced from the execution itself. A
      // COMPLETED ExecutionResult structurally guarantees a valid,
      // positive, finite duration (every executor's own INVALID_DURATION
      // gate already enforced this before ever returning COMPLETED) — but
      // re-checked defensively here rather than assumed. ---
      const duration = execution.duration;
      const durationClass = classifyTimingValue(duration);
      if (durationClass !== 'VALID' || duration <= 0) {
        diagnostics.push(
          createCompilationDiagnostic({ code: 'INVALID_DURATION', beatId: beat.id, materialId, message: `execution duration must be a finite number > 0, got ${JSON.stringify(duration)}` })
        );
        continue;
      }

      // --- startTime: 3-tier precedence (Part 2, Section 3) ---
      //   1. execution.renderSpec.startTime, when present (ASSET_PLACEMENT/
      //      BROLL_CLIP today)
      //   2. beat.startTime, when present
      //   3. deterministic sequential inference: the running cursor,
      //      computed ONCE per beat so every material belonging to the
      //      same beat still shares a start time by default (the same
      //      sharing that tiers 1/2 already produce naturally for a
      //      hybrid beat's OVERLAY/BACKGROUND/INSERT materials).
      let startTime;
      let timingWasInferred = false;

      const specStartTime = execution.renderSpec ? execution.renderSpec.startTime : undefined;
      const specStartTimeClass = classifyTimingValue(specStartTime);
      const beatStartTimeClass = classifyTimingValue(beat.startTime);

      if (specStartTimeClass === 'VALID') {
        startTime = specStartTime;
      } else if (specStartTimeClass === 'INVALID') {
        diagnostics.push(
          createCompilationDiagnostic({ code: 'NEGATIVE_START_TIME', beatId: beat.id, materialId, message: `execution.renderSpec.startTime is invalid: ${JSON.stringify(specStartTime)}` })
        );
        continue;
      } else if (beatStartTimeClass === 'VALID') {
        startTime = beat.startTime;
      } else if (beatStartTimeClass === 'INVALID') {
        diagnostics.push(createCompilationDiagnostic({ code: 'NEGATIVE_START_TIME', beatId: beat.id, materialId, message: `beat.startTime is invalid: ${JSON.stringify(beat.startTime)}` }));
        continue;
      } else {
        if (beatInferredStartTime === null) beatInferredStartTime = sequentialCursor;
        startTime = beatInferredStartTime;
        timingWasInferred = true;
      }

      const endTime = startTime + duration;
      sequentialCursor = Math.max(sequentialCursor, endTime);

      // --- structural self-consistency: an asset-referencing renderSpec
      // must list that same asset in sourceAssetIds. Never a live re-query
      // against timelineStore — the executor already validated the asset
      // at execution time; this only guards the RESULT's own internal
      // consistency. ---
      const specAssetId = execution.renderSpec ? execution.renderSpec.assetId || execution.renderSpec.sourceAssetId : null;
      if (specAssetId && !(Array.isArray(execution.sourceAssetIds) && execution.sourceAssetIds.includes(specAssetId))) {
        diagnostics.push(
          createCompilationDiagnostic({ code: 'MISSING_SOURCE_ASSET', beatId: beat.id, materialId, message: `renderSpec references asset "${specAssetId}" which is not listed in sourceAssetIds` })
        );
        continue;
      }

      // --- layer: reuses MATERIAL_ROLES unchanged — no TEXT/UI/AUDIO/
      // VIDEO_LAYER/BROLL_LAYER invented. ---
      const layer = resolution.selectedMaterial.role || 'PRIMARY';
      if (!MATERIAL_ROLES.includes(layer)) {
        diagnostics.push(createCompilationDiagnostic({ code: 'INVALID_LAYER_ORDER', beatId: beat.id, materialId, message: `selectedMaterial.role "${layer}" is not one of ${MATERIAL_ROLES.join(', ')}` }));
        continue;
      }

      const legacyAssetFields = deriveLegacyAssetFields(resolution.selectedMaterial.visualTreatment, execution.sourceAssetIds);

      const shot = productionSchema.createShot({
        sceneId: beat.sceneId,
        startTime,
        duration,
        narrativePurpose: beat.narrativePurpose || '',
        composition: beat.composition,
        camera: beat.camera,
        subjectAction: beat.subjectMotion || '',
        environmentAction: beat.environmentMotion || '',
        keyframeAssetId: legacyAssetFields.keyframeAssetId,
        videoAssetId: legacyAssetFields.videoAssetId,
        generationId: null, // no new generation was performed — see toTimelineShotFields's own identical rule
        layer,
        renderSpec: execution.renderSpec, // carried forward VERBATIM — never reinterpreted/flattened
        beatId: beat.id,
        materialId,
        executionId: execution.executionId,
        status: 'PLANNED',
        approvalStatus: 'NONE',
      });

      if (timingWasInferred) {
        diagnostics.push(
          createCompilationDiagnostic({ code: 'TIMING_INFERRED', beatId: beat.id, materialId, message: `no explicit execution/beat startTime — inferred sequentially as ${startTime}` })
        );
      }

      shots.push(shot);
    }
  }

  // --- PRIMARY overlap detection — excludes every involved shot, never picks a winner ---
  const primaryShots = shots.filter((s) => s.layer === 'PRIMARY');
  const overlapping = findPrimaryOverlaps(primaryShots);
  let finalShots = shots;
  if (overlapping.size > 0) {
    for (const shot of overlapping) {
      diagnostics.push(
        createCompilationDiagnostic({
          code: 'PRIMARY_OVERLAP_FORBIDDEN',
          beatId: shot.beatId,
          materialId: shot.materialId,
          message: `PRIMARY material for beat "${shot.beatId}" (${shot.materialId}) overlaps another PRIMARY material in time [${shot.startTime}, ${shot.startTime + shot.duration}) — both excluded`,
        })
      );
    }
    finalShots = shots.filter((s) => !overlapping.has(s));
  }

  // --- gap reporting (informational only — never repaired) ---
  const finalPrimarySorted = finalShots.filter((s) => s.layer === 'PRIMARY').sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < finalPrimarySorted.length; i++) {
    const prev = finalPrimarySorted[i - 1];
    const curr = finalPrimarySorted[i];
    const prevEnd = prev.startTime + prev.duration;
    if (curr.startTime > prevEnd) {
      diagnostics.push(
        createCompilationDiagnostic({
          code: 'TIMELINE_GAP',
          beatId: curr.beatId,
          materialId: curr.materialId,
          message: `a gap of ${curr.startTime - prevEnd}s exists between beat "${prev.beatId}" (ends ${prevEnd}) and beat "${curr.beatId}" (starts ${curr.startTime}) — not repaired`,
        })
      );
    }
  }

  // ---------------------------------------------------------------------
  // PHASE 3A — AUDIO PLACEMENT. Reuses the SAME authority this function
  // already established for visual shots above — an audioInputs[] entry's
  // own explicit startTime/duration wins when present (Tier 1, identical
  // discipline to shot timing's own explicit-override tier); when ABSENT,
  // placement is derived from finalShots — the SAME already-finalized
  // compiled shots above, never a new sequential cursor:
  //   - beatId set  -> that beat's own compiled Shot (PRIMARY preferred,
  //                    else the first) supplies the reference window —
  //                    the beat-attached-SFX case.
  //   - sceneId set (no beatId) -> every compiled Shot sharing that
  //                    sceneId supplies a [min start, max end) window —
  //                    the scene-spanning AMBIENCE case.
  //   - neither set -> the WHOLE compiled timeline's own [0, max end)
  //                    window — the video-spanning MUSIC case.
  // NARRATION events arrive here with real, already-measured duration and
  // an already-decided target startTime (services/production-orchestrator-
  // service.js's own narration cursor, upstream of this call) — both
  // VALID, so this loop only ever REGISTERS their timing, never
  // recomputes it. Every entry is carried through verbatim (spread) with
  // only startTime/duration finalized — the same "renderSpec copied
  // verbatim, never reinterpreted" discipline shots already follow above.
  // ---------------------------------------------------------------------
  const compiledAudio = [];
  for (const audioEvent of Array.isArray(audioInputs) ? audioInputs : []) {
    if (!audioEvent || typeof audioEvent !== 'object') {
      diagnostics.push(createCompilationDiagnostic({ code: 'INVALID_AUDIO_EVENT', message: 'an audioInputs[] entry must be a plain AudioEvent object' }));
      continue;
    }
    if (!AUDIO_EVENT_TYPES.includes(audioEvent.type)) {
      diagnostics.push(
        createCompilationDiagnostic({
          code: 'INVALID_AUDIO_TYPE',
          beatId: audioEvent.beatId || null,
          message: `AudioEvent "${audioEvent.audioEventId || '(no id)'}" has type "${audioEvent.type}", not one of ${AUDIO_EVENT_TYPES.join(', ')}`,
        })
      );
      continue;
    }

    const startClass = classifyTimingValue(audioEvent.startTime);
    if (startClass === 'INVALID') {
      diagnostics.push(
        createCompilationDiagnostic({ code: 'NEGATIVE_AUDIO_START_TIME', beatId: audioEvent.beatId || null, message: `AudioEvent "${audioEvent.audioEventId}" startTime is invalid: ${JSON.stringify(audioEvent.startTime)}` })
      );
      continue;
    }
    const durationClass = classifyTimingValue(audioEvent.duration);
    if (durationClass === 'INVALID') {
      diagnostics.push(
        createCompilationDiagnostic({ code: 'INVALID_AUDIO_DURATION', beatId: audioEvent.beatId || null, message: `AudioEvent "${audioEvent.audioEventId}" duration is invalid: ${JSON.stringify(audioEvent.duration)}` })
      );
      continue;
    }

    const needsReference = startClass !== 'VALID' || durationClass !== 'VALID';
    let referenceStart = null;
    let referenceEnd = null;

    if (needsReference) {
      let derivationDiagnostic = null;
      if (audioEvent.beatId) {
        const beatShots = finalShots.filter((s) => s.beatId === audioEvent.beatId);
        const referenceShot = beatShots.find((s) => s.layer === 'PRIMARY') || beatShots[0] || null;
        if (!referenceShot) {
          derivationDiagnostic = createCompilationDiagnostic({
            code: 'AUDIO_BEAT_NOT_COMPILED',
            beatId: audioEvent.beatId,
            message: `AudioEvent "${audioEvent.audioEventId}" references beatId "${audioEvent.beatId}", which has no compiled Shot to derive timing from`,
          });
        } else {
          referenceStart = referenceShot.startTime;
          referenceEnd = referenceShot.startTime + referenceShot.duration;
        }
      } else if (audioEvent.sceneId) {
        const sceneShots = finalShots.filter((s) => s.sceneId === audioEvent.sceneId);
        if (sceneShots.length === 0) {
          derivationDiagnostic = createCompilationDiagnostic({
            code: 'AUDIO_SCENE_NOT_COMPILED',
            beatId: null,
            message: `AudioEvent "${audioEvent.audioEventId}" references sceneId "${audioEvent.sceneId}", which has no compiled Shot to derive timing from`,
          });
        } else {
          referenceStart = Math.min(...sceneShots.map((s) => s.startTime));
          referenceEnd = Math.max(...sceneShots.map((s) => s.startTime + s.duration));
        }
      } else if (finalShots.length === 0) {
        derivationDiagnostic = createCompilationDiagnostic({
          code: 'AUDIO_TIMELINE_EMPTY',
          beatId: null,
          message: `AudioEvent "${audioEvent.audioEventId}" has no explicit startTime/duration and no beatId/sceneId to derive it from, and the compiled timeline has no shots at all`,
        });
      } else {
        referenceStart = 0;
        referenceEnd = Math.max(...finalShots.map((s) => s.startTime + s.duration));
      }

      if (derivationDiagnostic) {
        diagnostics.push(derivationDiagnostic);
        continue;
      }
    }

    const finalStartTime = startClass === 'VALID' ? audioEvent.startTime : referenceStart;
    const finalDuration = durationClass === 'VALID' ? audioEvent.duration : referenceEnd - finalStartTime;

    if (typeof finalDuration !== 'number' || !(finalDuration > 0)) {
      diagnostics.push(
        createCompilationDiagnostic({ code: 'INVALID_AUDIO_DURATION', beatId: audioEvent.beatId || null, message: `AudioEvent "${audioEvent.audioEventId}" resolved to a non-positive duration (${finalDuration})` })
      );
      continue;
    }

    if (needsReference) {
      diagnostics.push(
        createCompilationDiagnostic({
          code: 'AUDIO_TIMING_INFERRED',
          beatId: audioEvent.beatId || null,
          message: `AudioEvent "${audioEvent.audioEventId}" (${audioEvent.type}) had no explicit startTime/duration — inferred [${finalStartTime}, ${finalStartTime + finalDuration}) from the compiled timeline`,
        })
      );
    }

    compiledAudio.push({ ...audioEvent, startTime: finalStartTime, duration: finalDuration });
  }

  // --- transitions: BeatEdge(kind: TRANSITIONS_TO) -> the existing
  // TimelineIR transitions[] array's first-ever entry shape (see
  // schemas/timeline-compilation-schema.js's own header for why this is
  // not a second timeline model). ---
  const validBeatIds = new Set(orderedBeats.map((b) => b.id));
  const beatIdsWithCompiledShots = new Set(finalShots.map((s) => s.beatId));
  const transitions = [];
  for (const edge of Array.isArray(beatGraph.edges) ? beatGraph.edges : []) {
    if (!edge || edge.kind !== 'TRANSITIONS_TO') continue;
    if (!validBeatIds.has(edge.fromBeatId) || !validBeatIds.has(edge.toBeatId)) {
      diagnostics.push(
        createCompilationDiagnostic({ code: 'INVALID_TRANSITION', message: `transition edge "${edge.edgeId}" references a beat not present in this BeatGraph` })
      );
      continue;
    }
    if (!beatIdsWithCompiledShots.has(edge.fromBeatId) || !beatIdsWithCompiledShots.has(edge.toBeatId)) {
      diagnostics.push(
        createCompilationDiagnostic({ code: 'INVALID_TRANSITION', message: `transition edge "${edge.edgeId}" references a beat that produced no compiled Shot` })
      );
      continue;
    }
    transitions.push(createCompiledTransition({ fromBeatId: edge.fromBeatId, toBeatId: edge.toBeatId, kind: edge.kind, note: edge.note }));
  }

  // --- status (mirrors resolveBeatGraph()'s own RESOLVED/PARTIAL/UNRESOLVED derivation) ---
  const totalBeats = orderedBeats.length;
  const compiledBeatsCount = beatIdsWithCompiledShots.size;
  const status = totalBeats === 0 || compiledBeatsCount === totalBeats ? 'COMPILED' : compiledBeatsCount === 0 ? 'FAILED' : 'PARTIAL';

  return createTimelineCompilationResult({
    projectId: context.projectId || null,
    status,
    shots: finalShots,
    transitions,
    audio: compiledAudio,
    diagnostics,
  });
}

module.exports = { compileTimeline };
