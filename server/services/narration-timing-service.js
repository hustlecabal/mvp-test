// narration-timing-service.js
//
// P0-3A — closes the one gap identified by the Coverage Audit's Part 12
// finding: real measured narration timing (schemas/audio-schema.js's
// AudioEvent, produced by services/voice-generation-service.js's real
// espeak-ng + faster-whisper pipeline) has never been connected to
// VisualBeat/BeatGraph timing. services/beat-graph-derivation-service.js
// (P0-1) leaves every beat's `startTime` permanently null and `audioEvents`
// at its schema default — this file is the missing bridge.
//
// THIS FILE DOES NOT BUILD A NEW TIMELINE ARCHITECTURE. It extends the
// EXACT 4-tier timing hierarchy schemas/audio-schema.js's own header
// already documented (and left "not implemented" — see that file's
// "TIMING PRECEDENCE" section) minimally:
//
//   TIER 1 — measured narration timing: a real AudioEvent's own `duration`
//            (services/voice-generation-service.js's ffprobe-measured
//            value — never the pre-audio `target` estimate) and `startTime`
//            (carried on the AudioEvent as-is; see the note below), applied
//            when the AudioEvent maps to this beat UNAMBIGUOUSLY.
//   TIER 2 — narrationSegment-derived timing: a beat's own
//            narrationSegment.startOffset/endOffset (authored by the
//            creative layer, schemas/visual-beat-schema.js's
//            createNarrationSegment), used only when Tier 1 did not apply.
//   TIER 3 — the beat's own existing startTime/duration, untouched by this
//            file — exactly services/timeline-compiler-service.js's own
//            existing Tier 2 (beat.startTime) precedence today.
//   TIER 4 — services/timeline-compiler-service.js's existing deterministic
//            sequential-cursor inference — entirely unchanged, this file
//            never touches that service.
//
// This file's OUTPUT is a new BeatGraph with some beats' startTime/duration
// populated from Tier 1/2 — a BETTER INPUT to the existing, completely
// unmodified Material Execution -> Timeline Compiler chain, never a second
// compiler and never a rewrite of compileTimeline()'s own 3-tier startTime
// precedence (see that file — this pass simply makes its Tier 2, "beat.
// startTime", carry a real, measured value more often).
//
// ONE HONEST NUANCE, worth stating plainly: only AudioEvent.duration is
// truly MEASURED (ffprobe, real audio). AudioEvent.startTime is carried
// forward from NarrationDirection.timing.target.startTime — an ESTIMATE,
// never itself measured (services/voice-generation-service.js's own header:
// "TIMING AUTHORITY... target and actual are never conflated"). This file
// still applies AudioEvent.startTime when present and valid (the common
// case is 0 — the narration's own local start), but the applied diagnostic
// never claims startTime itself was measured, only duration.
//
// MULTI-BEAT NARRATION (Part 5): a single NarrationDirection MAY span
// multiple beats (NarrationDirection.beatIds.length > 1) — Stage 26.9's own
// supported case. services/voice-generation-service.js already refuses to
// guess which beat such an AudioEvent belongs to and leaves `beatId: null`
// (see that file's own comment). This file inherits that same discipline:
// it NEVER divides a multi-beat AudioEvent's duration across the beats it
// covers (no fuzzy matching, no LLM, no even-split guess) — the current
// architecture carries no per-beat character/word range within
// NarrationDirection.text that would make that division safe. It returns
// MULTI_BEAT_TIMING_UNRESOLVED / NARRATION_TIMING_UNRESOLVABLE instead.
//
// MAPPING KEY (Part 3): AudioEvent.beatId is the ONLY authoritative,
// unambiguous mapping signal (set by services/voice-generation-service.js
// exactly when a NarrationDirection covered precisely one beat).
// AudioEvent.scriptRefId vs beat.narrationSegment.scriptRefId is used only
// (a) to detect a same-beat CONFLICT when a directly-matched AudioEvent's
// own scriptRefId disagrees with the beat's, and (b) to explain, with real
// diagnostic detail, why a beat with no direct match still has no
// measured timing (missing vs. genuinely ambiguous multi-beat).

const { createBeatGraph } = require('../schemas/beat-graph-schema');

// Duplicated from services/timeline-compiler-service.js's own
// classifyTimingValue — same three-way ABSENT/INVALID/VALID split, same
// established "duplicate a small comparator across files rather than
// cross-require services for one helper" convention this codebase already
// uses (see that file's own header comment for compareBeats).
function classifyTimingValue(value) {
  if (value === null || value === undefined) return 'ABSENT';
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value < 0) return 'INVALID';
  return 'VALID';
}

function diagnostic(code, beatId, message, extra = {}) {
  return { code, beatId, message, ...extra };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Defensive validation of a matched AudioEvent's own transcript.words —
// never used to SPLIT timing (see file header), only to flag data
// corruption in the measured record this pass is about to trust.
function findInvalidWordTimestamps(audioEvent) {
  const words = audioEvent && audioEvent.transcript && Array.isArray(audioEvent.transcript.words) ? audioEvent.transcript.words : [];
  return words.filter((w) => {
    if (!isPlainObject(w)) return true;
    const startClass = classifyTimingValue(w.startTime);
    const endClass = classifyTimingValue(w.endTime);
    if (startClass === 'INVALID' || endClass === 'INVALID') return true;
    if (startClass === 'VALID' && endClass === 'VALID' && w.endTime < w.startTime) return true;
    return false;
  });
}

// Public entry point.
//   beatGraph   — schemas/beat-graph-schema.js's createBeatGraph() output
//                 (e.g. P0-1's deriveBeatGraph() result). Never mutated.
//   audioEvents — an ARRAY of real schemas/audio-schema.js AudioEvent
//                 records (e.g. services/voice-generation-service.js's
//                 generateNarratedAudioEvent() output). Never mutated.
// Returns { beatGraph, status, diagnostics, appliedBeatCount, createdAt }.
//   status — 'APPLIED' (every narration-bearing beat got Tier 1/2 timing,
//     no unresolved/conflicting cases), 'PARTIAL' (some did, some didn't),
//     'UNCHANGED' (no narration-bearing beats existed — nothing to do),
//     'FAILED' (invalid beatGraph input).
function applyNarrationTiming(beatGraph, audioEvents = [], options = {}) {
  if (!beatGraph || !Array.isArray(beatGraph.beats)) {
    return {
      beatGraph: null,
      status: 'FAILED',
      diagnostics: [diagnostic('INVALID_BEAT_GRAPH', null, 'a BeatGraph with a beats array is required')],
      appliedBeatCount: 0,
      createdAt: new Date().toISOString(),
    };
  }

  const events = Array.isArray(audioEvents) ? audioEvents.filter((ae) => isPlainObject(ae)) : [];
  const diagnostics = [];

  // --- index by the one authoritative mapping key (Part 3) ---
  const directByBeatId = new Map(); // beatId -> AudioEvent[]
  const ambiguousByScriptRefId = new Map(); // scriptRefId -> AudioEvent[] (beatId === null)
  for (const ae of events) {
    if (typeof ae.beatId === 'string' && ae.beatId.length > 0) {
      if (!directByBeatId.has(ae.beatId)) directByBeatId.set(ae.beatId, []);
      directByBeatId.get(ae.beatId).push(ae);
    } else if (typeof ae.scriptRefId === 'string' && ae.scriptRefId.length > 0) {
      if (!ambiguousByScriptRefId.has(ae.scriptRefId)) ambiguousByScriptRefId.set(ae.scriptRefId, []);
      ambiguousByScriptRefId.get(ae.scriptRefId).push(ae);
    }
  }

  // --- beats in scope (Part 7): only ones with a narrationSegment at all ---
  const narratedBeats = beatGraph.beats.filter((b) => b && isPlainObject(b.narrationSegment));

  // --- how many in-scope beats share each scriptRefId — the only signal
  // available to distinguish "one beat, audio just not generated yet" from
  // "this scriptRefId genuinely spans multiple beats" (Part 5). ---
  const beatsByScriptRefId = new Map();
  for (const b of narratedBeats) {
    const ref = b.narrationSegment.scriptRefId;
    if (typeof ref !== 'string' || ref.length === 0) continue;
    if (!beatsByScriptRefId.has(ref)) beatsByScriptRefId.set(ref, []);
    beatsByScriptRefId.get(ref).push(b);
  }
  const reportedMultiBeatGroups = new Set();

  let appliedBeatCount = 0;
  const updatedBeats = beatGraph.beats.map((beat) => {
    if (!beat || !isPlainObject(beat.narrationSegment)) return beat; // out of scope — Part 7, untouched

    const scriptRefId = beat.narrationSegment.scriptRefId;
    const directMatches = directByBeatId.get(beat.id) || [];

    let appliedTier1 = false;
    let updatedBeat = beat;

    if (directMatches.length > 1) {
      diagnostics.push(
        diagnostic('NARRATION_TIMING_CONFLICT', beat.id, `${directMatches.length} AudioEvents directly claim beat "${beat.id}" — refusing to pick one`, {
          audioEventIds: directMatches.map((ae) => ae.audioEventId),
        })
      );
    } else if (directMatches.length === 1) {
      const ae = directMatches[0];

      if (typeof scriptRefId === 'string' && scriptRefId.length > 0 && typeof ae.scriptRefId === 'string' && ae.scriptRefId.length > 0 && ae.scriptRefId !== scriptRefId) {
        diagnostics.push(
          diagnostic(
            'NARRATION_TIMING_CONFLICT',
            beat.id,
            `AudioEvent "${ae.audioEventId}" is directly linked to beat "${beat.id}" but its scriptRefId ("${ae.scriptRefId}") does not match the beat's own narrationSegment.scriptRefId ("${scriptRefId}")`,
            { audioEventId: ae.audioEventId }
          )
        );
      } else {
        const invalidWords = findInvalidWordTimestamps(ae);
        if (invalidWords.length > 0) {
          diagnostics.push(
            diagnostic('INVALID_WORD_TIMESTAMP', beat.id, `AudioEvent "${ae.audioEventId}" has ${invalidWords.length} malformed word timestamp(s) — transcript words not trusted, duration/startTime still evaluated independently`, {
              audioEventId: ae.audioEventId,
            })
          );
        }

        const durationClass = classifyTimingValue(ae.duration);
        if (durationClass === 'INVALID') {
          diagnostics.push(diagnostic('INVALID_AUDIO_DURATION', beat.id, `AudioEvent "${ae.audioEventId}" duration is invalid: ${JSON.stringify(ae.duration)}`, { audioEventId: ae.audioEventId }));
        } else if (durationClass === 'ABSENT') {
          diagnostics.push(diagnostic('NARRATION_TIMING_MISSING', beat.id, `AudioEvent "${ae.audioEventId}" has no measured duration yet`, { audioEventId: ae.audioEventId }));
        } else {
          // durationClass === 'VALID' — the one truly measured field (Part 4)
          const startClass = classifyTimingValue(ae.startTime);
          let appliedStartTime;
          if (startClass === 'VALID') {
            appliedStartTime = ae.startTime;
          } else if (startClass === 'INVALID') {
            // reuses services/timeline-compiler-service.js's own established
            // code for this exact defect, per "use existing diagnostic
            // conventions where possible" (Part 8).
            diagnostics.push(diagnostic('NEGATIVE_START_TIME', beat.id, `AudioEvent "${ae.audioEventId}" startTime is invalid: ${JSON.stringify(ae.startTime)} — duration still applied`, { audioEventId: ae.audioEventId }));
            appliedStartTime = beat.startTime; // unchanged — falls through to Tier 3/4 for placement
          } else {
            appliedStartTime = beat.startTime; // ABSENT — unchanged, same fallthrough
          }

          updatedBeat = { ...beat, startTime: appliedStartTime, duration: ae.duration };
          appliedTier1 = true;
          appliedBeatCount += 1;
          diagnostics.push(
            diagnostic('NARRATION_TIMING_APPLIED', beat.id, `beat "${beat.id}" timing set from measured AudioEvent "${ae.audioEventId}" (duration=${ae.duration}${startClass === 'VALID' ? `, startTime=${ae.startTime}` : ''})`, {
              audioEventId: ae.audioEventId,
              source: 'MEASURED_AUDIO',
            })
          );
        }
      }
    } else if (typeof scriptRefId === 'string' && scriptRefId.length > 0) {
      const ambiguousGroup = ambiguousByScriptRefId.get(scriptRefId) || [];
      const beatsSharingRef = beatsByScriptRefId.get(scriptRefId) || [];

      if (ambiguousGroup.length === 0) {
        diagnostics.push(diagnostic('NARRATION_TIMING_MISSING', beat.id, `no AudioEvent has been generated yet for scriptRefId "${scriptRefId}"`));
      } else if (beatsSharingRef.length > 1) {
        if (!reportedMultiBeatGroups.has(scriptRefId)) {
          reportedMultiBeatGroups.add(scriptRefId);
          diagnostics.push(
            diagnostic(
              'MULTI_BEAT_TIMING_UNRESOLVED',
              null,
              `scriptRefId "${scriptRefId}" spans ${beatsSharingRef.length} beats (${beatsSharingRef.map((b) => b.id).join(', ')}) but its AudioEvent(s) (${ambiguousGroup.map((ae) => ae.audioEventId).join(', ')}) carry no per-beat word/character boundaries in the current architecture — cannot divide timing safely`,
              { scriptRefId, beatIds: beatsSharingRef.map((b) => b.id), audioEventIds: ambiguousGroup.map((ae) => ae.audioEventId) }
            )
          );
        }
        diagnostics.push(
          diagnostic('NARRATION_TIMING_UNRESOLVABLE', beat.id, `beat "${beat.id}" shares scriptRefId "${scriptRefId}" with other beats and cannot be safely assigned a slice of the measured audio — see the MULTI_BEAT_TIMING_UNRESOLVED diagnostic for this scriptRefId`, { scriptRefId })
        );
      } else {
        // exactly one beat in this graph references scriptRefId, yet the
        // matching AudioEvent(s) still carry beatId: null — upstream
        // (services/voice-generation-service.js) only ever nulls beatId
        // when the originating NarrationDirection did NOT cover exactly one
        // beat. Trusting a same-graph coincidence over that explicit
        // upstream signal would be exactly the "guess" Part 3 forbids.
        diagnostics.push(
          diagnostic(
            'NARRATION_TIMING_UNRESOLVABLE',
            beat.id,
            `AudioEvent(s) (${ambiguousGroup.map((ae) => ae.audioEventId).join(', ')}) for scriptRefId "${scriptRefId}" carry no direct beatId — their originating narration did not resolve to exactly one beat, so this beat cannot safely be assigned the measured timing even though it is the only beat in this graph referencing that scriptRefId`,
            { scriptRefId, audioEventIds: ambiguousGroup.map((ae) => ae.audioEventId) }
          )
        );
      }
    }

    // --- Tier 2 — narrationSegment-derived (creative-layer-authored) offsets, only when Tier 1 did not apply ---
    if (!appliedTier1) {
      const { startOffset, endOffset } = beat.narrationSegment;
      const startClass = classifyTimingValue(startOffset);
      const endClass = classifyTimingValue(endOffset);
      if (startClass === 'VALID' && endClass === 'VALID' && endOffset > startOffset) {
        const segmentDuration = endOffset - startOffset;
        updatedBeat = { ...beat, duration: segmentDuration };
        diagnostics.push(
          diagnostic('NARRATION_TIMING_APPLIED', beat.id, `beat "${beat.id}" duration set from narrationSegment offsets (${startOffset} -> ${endOffset})`, {
            source: 'NARRATION_SEGMENT_OFFSET',
          })
        );
      }
    }

    return updatedBeat;
  });

  const totalNarrated = narratedBeats.length;
  const status = totalNarrated === 0 ? 'UNCHANGED' : appliedBeatCount === totalNarrated ? 'APPLIED' : 'PARTIAL';

  return {
    beatGraph: createBeatGraph({ projectId: beatGraph.projectId, beats: updatedBeats, edges: beatGraph.edges || [] }),
    status,
    diagnostics,
    appliedBeatCount,
    createdAt: new Date().toISOString(),
  };
}

module.exports = { applyNarrationTiming, classifyTimingValue };
