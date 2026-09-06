// production-completeness-service.js
//
// PRODUCTION RELIABILITY LAYER, Part 3 — CONTENT COMPLETENESS. Answers one
// question the existing pipeline never asked of itself: of everything the
// Storyboard/BeatGraph intended to produce, how much actually reached the
// final assembled video?
//
// WHY THIS EXISTS (see the silent-degradation audit in this stage's own
// report): every stage of the real production pipeline already does the
// right per-unit thing on failure — diagnose one beat, keep producing the
// rest. Two stages already COMPUTE a partial-vs-complete signal
// (beat-graph-derivation-service.js's own PARTIAL/FAILED/DERIVED status,
// timeline-compiler-service.js's own COMPILED/PARTIAL/FAILED status) and
// production-orchestrator-service.js discards both, checking only for
// 'FAILED'. A third exclusion point (video-assembly-service.js's
// ASSEMBLY_LAYER_UNSUPPORTED) has no upstream signal for it at all. This
// file does not re-implement any of those checks — it reads their already-
// computed results and answers the one question none of them answer on
// its own: "did everything the creative layer intended actually arrive?"
//
// PURE, DETERMINISTIC, READ-ONLY: takes already-computed job data (never
// re-runs derivation/resolution/execution/compilation/assembly, never
// hits a store, never calls a provider). This is the same "consume
// already-produced results" discipline services/timeline-compiler-
// service.js itself already established for its own inputs.
//
// SOURCE OF TRUTH FOR "WHAT ACTUALLY MADE IT IN": assemblyResult.
// provenance.shots[] — not timelineCompilation.shots[] — because
// provenance reflects the FINAL assembled output, catching BOTH a
// timeline-compilation-stage exclusion (PRIMARY_OVERLAP_FORBIDDEN, an
// unresolved/unexecuted beat, ...) AND an assembly-stage-only exclusion
// (ASSEMBLY_LAYER_UNSUPPORTED) in one comparison, without needing to know
// about either mechanism specifically.

// BeatGraph-derivation-stage diagnostic codes that mean "this shot was
// EXCLUDED from the beat graph entirely" (beat-graph-derivation-service.js
// increments its own rejectedBeatCount and `continue`s for exactly these
// codes — duplicated here as a short, stable, cross-referenced list rather
// than importing that file's internals, matching this codebase's own
// established "duplicate a small stable list rather than couple across
// layers" convention, e.g. timeline-compiler-service.js's own compareBeats
// comment). Deliberately excludes non-fatal/warning-only codes from that
// same file (DUPLICATE_SHOT_ORDER, SHOT_DURATION_MISSING,
// MISSING_VISUAL_INTENT, INVALID_BEAT_EDGE) — those never remove a beat.
const BEATGRAPH_EXCLUSION_CODES = [
  'MISSING_SCENE',
  'SHOT_DURATION_INVALID',
  'UNKNOWN_CHARACTER_REFERENCE',
  'UNKNOWN_LOCATION_REFERENCE',
  'UNKNOWN_PROP_REFERENCE',
  'INVALID_VISUAL_TREATMENT',
  'INVALID_NARRATIVE_ROLE',
  'INVALID_VISUAL_OBJECTIVE',
  'INVALID_NARRATION_SEGMENT',
];

const CONTENT_COMPLETENESS_LEVELS = ['FULL_CONTENT', 'PARTIAL_CONTENT', 'NO_CONTENT'];

function hasNonEmptyText(narrationSegment) {
  return Boolean(narrationSegment && typeof narrationSegment.text === 'string' && narrationSegment.text.trim().length > 0);
}

// job — a real schemas/production-job-schema.js ProductionJob (or anything
// with the same shape: beatGraph, diagnostics, beatProgress, assemblyResult).
function computeContentCompleteness(job) {
  const beatGraphBeats = (job.beatGraph && Array.isArray(job.beatGraph.beats)) ? job.beatGraph.beats : [];
  const beatGraphBeatIds = new Set(beatGraphBeats.map((b) => b.id));

  // Beats the Storyboard/BeatGraph intended to produce but that were
  // excluded before a beat even existed — see BEATGRAPH_EXCLUSION_CODES's
  // own comment for exactly which diagnostic codes count.
  const derivationExcludedBeatIds = new Set(
    (job.diagnostics || [])
      .filter((d) => d.stage === 'BEATGRAPH' && d.beatId && BEATGRAPH_EXCLUSION_CODES.includes(d.code))
      .map((d) => d.beatId)
  );

  const expectedBeatIds = new Set([...beatGraphBeatIds, ...derivationExcludedBeatIds]);

  const assembledBeatIds = new Set(
    (job.assemblyResult && job.assemblyResult.provenance && Array.isArray(job.assemblyResult.provenance.shots)
      ? job.assemblyResult.provenance.shots
      : []
    )
      .map((s) => s.beatId)
      .filter(Boolean)
  );

  const missingBeatIds = [...expectedBeatIds].filter((id) => !assembledBeatIds.has(id));

  // Narration coverage — "expected" is exactly the same condition
  // production-orchestrator-service.js's own NARRATION stage uses to
  // decide whether a beat gets narrated at all (a non-empty
  // narrationSegment.text); "actual" is a real, persisted audioEvent on
  // that beat's checkpoint — the same field presence generateNarratedAudioEvent()
  // itself uses to mean "this beat's narration genuinely completed."
  const expectedNarratedBeatIds = new Set(beatGraphBeats.filter((b) => hasNonEmptyText(b.narrationSegment)).map((b) => b.id));
  const narratedBeatIds = new Set((job.beatProgress || []).filter((p) => p.audioEvent).map((p) => p.beatId));
  const missingNarrationBeatIds = [...expectedNarratedBeatIds].filter((id) => !narratedBeatIds.has(id));

  const expectedBeatCount = expectedBeatIds.size;
  const assembledBeatCount = assembledBeatIds.size;

  let overall;
  if (expectedBeatCount === 0 || assembledBeatCount === 0) {
    overall = 'NO_CONTENT';
  } else if (missingBeatIds.length === 0 && missingNarrationBeatIds.length === 0) {
    overall = 'FULL_CONTENT';
  } else {
    overall = 'PARTIAL_CONTENT';
  }
  // An expected-but-empty production (nothing was ever intended) is not a
  // completeness failure — it simply has nothing to be complete about.
  if (expectedBeatCount === 0 && assembledBeatCount === 0) overall = 'NO_CONTENT';

  const artifact = job.assemblyResult && job.assemblyResult.artifact;
  const durationExpected = job.assemblyResult && typeof job.assemblyResult.expectedDuration === 'number' ? job.assemblyResult.expectedDuration : null;
  const durationActual = artifact && typeof artifact.duration === 'number' ? artifact.duration : null;

  return {
    overall,
    expectedBeatCount,
    assembledBeatCount,
    missingBeatIds,
    expectedNarratedBeatCount: expectedNarratedBeatIds.size,
    narratedBeatCount: narratedBeatIds.size,
    missingNarrationBeatIds,
    durationExpected,
    durationActual,
  };
}

module.exports = {
  CONTENT_COMPLETENESS_LEVELS,
  BEATGRAPH_EXCLUSION_CODES,
  computeContentCompleteness,
};
