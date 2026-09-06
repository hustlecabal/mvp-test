// creative-qa-service.js
//
// PRODUCTION RELIABILITY LAYER, Part 1 — the first REAL implementation of
// services/creative-qa-interface.js. Deliberately NOT an AI judge: every
// check here is deterministic, computed from existing production
// metadata that already exists by the time a ProductionJob reaches QC —
// services/production-completeness-service.js's ContentCompleteness, and
// the timeline compiler's own already-computed TIMELINE_GAP diagnostics.
// No new signal is invented; this file only interprets signals the
// pipeline already produces.
//
// TECHNICAL VALIDITY vs CREATIVE/CONTENT VALIDITY (kept structurally
// separate, per this stage's own instruction): production-orchestrator-
// service.js's existing runAutomaticQc() proves the output FILE is valid
// (exists, non-empty, real duration/dimensions/fps). Nothing there looks
// at whether the intended CONTENT actually arrived. This file is that
// second, separate check — a technically perfect MP4 can still FAIL here.
//
// PASS/FAIL/WARN per dimension, never a fabricated composite score — the
// same discipline every other evaluator in this codebase already follows
// (idea/packaging/story-architecture evaluators, all PASS/FAIL/WARN
// dimension arrays). summarizeCreativeQAReport() below derives the
// simpler {passed, severity, issues, warnings, affectedBeatIds,
// recommendedAction} shape this stage asked for as a thin, PASS/WARN/FAIL
// summary layer on top of the underlying findings — not a replacement for
// them.

const { createCreativeQAFinding, createCreativeQAReport, CREATIVE_QA_DIMENSIONS } = require('./creative-qa-interface');

// A compiled beat shorter than this is almost always a technical artifact
// (a rounding/inference error, a truncated render) rather than a
// deliberate creative choice — flagged as a WARNING, never a FAIL, since
// a genuinely intentional quick-cut beat is possible and this file never
// claims certainty about creative intent.
const MIN_PLAUSIBLE_SCENE_SECONDS = 0.5;

function beatCoverageFindings(contentCompleteness) {
  if (contentCompleteness.missingBeatIds.length === 0) {
    return [createCreativeQAFinding({ dimension: 'BEAT_COVERAGE', result: 'PASS', objectType: 'ProductionJob', objectId: null, note: `all ${contentCompleteness.expectedBeatCount} expected beat(s) reached the final assembly` })];
  }
  return contentCompleteness.missingBeatIds.map((beatId) =>
    createCreativeQAFinding({
      dimension: 'BEAT_COVERAGE',
      result: 'FAIL',
      objectType: 'VisualBeat',
      objectId: beatId,
      note: `beat "${beatId}" was expected but never reached the final assembled video`,
    })
  );
}

function narrationCoverageFindings(contentCompleteness) {
  if (contentCompleteness.expectedNarratedBeatCount === 0) {
    return [createCreativeQAFinding({ dimension: 'NARRATION_COVERAGE', result: 'PASS', objectType: 'ProductionJob', objectId: null, note: 'no beat in this production required narration' })];
  }
  if (contentCompleteness.missingNarrationBeatIds.length === 0) {
    return [createCreativeQAFinding({ dimension: 'NARRATION_COVERAGE', result: 'PASS', objectType: 'ProductionJob', objectId: null, note: `all ${contentCompleteness.expectedNarratedBeatCount} beat(s) requiring narration have real, persisted audio` })];
  }
  return contentCompleteness.missingNarrationBeatIds.map((beatId) =>
    createCreativeQAFinding({
      dimension: 'NARRATION_COVERAGE',
      result: 'FAIL',
      objectType: 'VisualBeat',
      objectId: beatId,
      note: `beat "${beatId}" was intended to be narrated but has no persisted audio — the video may play silently over this beat`,
    })
  );
}

// Reuses timeline-compiler-service.js's OWN already-computed TIMELINE_GAP
// diagnostic — never recomputed here. A gap is suspicious, not
// necessarily wrong (it could be an intentional pacing choice the
// creative layer made explicitly), so this is WARN, never FAIL.
function timelineContentMismatchFindings(job) {
  const gaps = (job.diagnostics || []).filter((d) => d.code === 'TIMELINE_GAP');
  if (gaps.length === 0) {
    return [createCreativeQAFinding({ dimension: 'TIMELINE_CONTENT_MISMATCH', result: 'PASS', objectType: 'ProductionJob', objectId: null, note: 'no unexpected gaps in the compiled timeline' })];
  }
  return gaps.map((gap) =>
    createCreativeQAFinding({ dimension: 'TIMELINE_CONTENT_MISMATCH', result: 'WARN', objectType: 'VisualBeat', objectId: gap.beatId, note: gap.message })
  );
}

function sceneLengthPlausibilityFindings(job) {
  const shots = (job.assemblyResult && job.assemblyResult.provenance && Array.isArray(job.assemblyResult.provenance.shots)) ? job.assemblyResult.provenance.shots : [];
  const short = shots.filter((s) => typeof s.duration === 'number' && s.duration > 0 && s.duration < MIN_PLAUSIBLE_SCENE_SECONDS);
  if (short.length === 0) {
    return [createCreativeQAFinding({ dimension: 'SCENE_LENGTH_PLAUSIBILITY', result: 'PASS', objectType: 'ProductionJob', objectId: null, note: 'no implausibly short scenes in the assembled output' })];
  }
  return short.map((s) =>
    createCreativeQAFinding({
      dimension: 'SCENE_LENGTH_PLAUSIBILITY',
      result: 'WARN',
      objectType: 'VisualBeat',
      objectId: s.beatId,
      note: `beat "${s.beatId}" is only ${s.duration}s in the final assembly — likely too short to convey its intended content`,
    })
  );
}

// job — a real ProductionJob with assemblyResult already set.
// contentCompleteness — services/production-completeness-service.js's
// computeContentCompleteness(job) output.
function runDeterministicCreativeQA(job, contentCompleteness) {
  const findings = [
    ...beatCoverageFindings(contentCompleteness),
    ...narrationCoverageFindings(contentCompleteness),
    ...timelineContentMismatchFindings(job),
    ...sceneLengthPlausibilityFindings(job),
    // Subjective dimensions (CREATIVE_QA_DIMENSIONS' other entries) are
    // deliberately absent here — no finding is fabricated for a dimension
    // this file cannot actually evaluate. Their absence from a report is
    // the honest signal "not evaluated," never silently marked PASS.
  ];
  return createCreativeQAReport({ subjectType: 'ProductionJob', subjectId: job.productionJobId, reviewedBy: 'creative-qa-service:deterministic', findings });
}

// Derives the {passed, severity, issues, warnings, affectedBeatIds,
// recommendedAction} shape this stage asked for — a thin summary over the
// findings above, never a second source of truth. No numeric score: this
// codebase has a standing rule against fabricated composite scores, and
// nothing about these findings supports one cleanly (a FAIL is a FAIL
// regardless of how many other dimensions happened to PASS).
function summarizeCreativeQAReport(report) {
  const fails = report.findings.filter((f) => f.result === 'FAIL');
  const warns = report.findings.filter((f) => f.result === 'WARN');
  const severity = fails.length > 0 ? 'FAIL' : warns.length > 0 ? 'WARN' : 'PASS';
  const affectedBeatIds = [...new Set(report.findings.filter((f) => f.result !== 'PASS' && f.objectType === 'VisualBeat' && f.objectId).map((f) => f.objectId))];

  let recommendedAction = 'No action needed — Creative QA found no issues.';
  const failedDimensions = new Set(fails.map((f) => f.dimension));
  if (failedDimensions.has('BEAT_COVERAGE')) {
    recommendedAction = `${fails.filter((f) => f.dimension === 'BEAT_COVERAGE').length} beat(s) are missing from the final video — inspect job.diagnostics for the affected beat id(s) across BEATGRAPH/MATERIAL_RESOLUTION/MATERIAL_EXECUTION/RENDERING/TIMELINE_COMPILATION/ASSEMBLY stages, fix the underlying cause, and start a new production run.`;
  } else if (failedDimensions.has('NARRATION_COVERAGE')) {
    recommendedAction = `${fails.filter((f) => f.dimension === 'NARRATION_COVERAGE').length} beat(s) are missing intended narration audio — check job.diagnostics with stage NARRATION for the affected beat id(s) and start a new production run once fixed.`;
  } else if (severity === 'WARN') {
    recommendedAction = 'Review the flagged timeline gaps/short scenes before treating this output as final.';
  }

  return { passed: severity !== 'FAIL', severity, issues: fails.map((f) => f.note), warnings: warns.map((f) => f.note), affectedBeatIds, recommendedAction };
}

module.exports = {
  MIN_PLAUSIBLE_SCENE_SECONDS,
  runDeterministicCreativeQA,
  summarizeCreativeQAReport,
};
