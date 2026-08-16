// reference-video-observation-service.js
//
// INT-1C — the orchestrator proving Layer 3 of the INT-1 specification:
//
//   ReferenceVideoMeasurements (INT-1B) -> ObservationSet
//
// Reads an already-persisted schemas/reference-video-measurement-schema.js
// ReferenceVideoMeasurements record (services/reference-video-measurement-
// store.js) and runs every rule in services/reference-video/observation-
// rules.js's registry against it. Nothing in this file computes a new
// number from raw video/audio bytes — that is Layer 2's job, already done.
// This file only asks, deterministically and rule by rule: "given these
// already-measured numbers, what factual statement (if any) follows?"
//
// NO LLM, NO NETWORK, NO PROVIDER CALL (Part 17/22) — every rule is a pure
// function; this orchestrator's only job is to run each one, wrap a
// non-null result into a real schemas/reference-video-observation-
// schema.js Observation with real evidence pointing at the real
// measurements record, and persist the set.
//
// A rule returning null is not a failure — it means the required evidence
// was missing, invalid, or insufficient (Part 20), and this file never
// invents a substitute. Two rules are DIAGNOSTIC rather than observational
// (SCENE_OBSERVATION_UNAVAILABLE, TEXT_PRESENCE_OCR_UNAVAILABLE) — their
// non-null result becomes an ObservationSet diagnostic, never an
// Observation (an absence-of-capability statement is not itself "a
// structured statement derived from measured evidence" about the video).

const projectStore = require('./project-store');
const measurementStore = require('./reference-video-measurement-store');
const observationStore = require('./reference-video-observation-store');
const { rules } = require('./reference-video/observation-rules');
const { createObservationSet, createObservation, createObservationMethodology, createObservationDiagnostic, createEvidenceLink } = require('../schemas/reference-video-observation-schema');

function diag(code, ruleId, message) {
  return createObservationDiagnostic({ code, ruleId, message });
}

// Public entry point.
//   projectId, measurementsId — an existing, persisted ReferenceVideoMeasurements record
function deriveObservations(projectId, measurementsId) {
  if (!projectStore.getProject(projectId)) {
    return createObservationSet({ projectId, measurementsId, status: 'FAILED', diagnostics: [diag('INVALID_MEASUREMENTS', null, `no project found with id "${projectId}"`)] });
  }
  const measurements = measurementStore.getMeasurement(projectId, measurementsId);
  if (!measurements) {
    return createObservationSet({ projectId, measurementsId, status: 'FAILED', diagnostics: [diag('INVALID_MEASUREMENTS', null, `no ReferenceVideoMeasurements found with id "${measurementsId}" in project "${projectId}"`)] });
  }
  if (measurements.status === 'FAILED') {
    return createObservationSet({
      projectId,
      referenceVideoId: measurements.referenceVideoId,
      measurementsId,
      status: 'FAILED',
      diagnostics: [diag('INSUFFICIENT_MEASUREMENTS', null, 'the underlying ReferenceVideoMeasurements record itself failed — no reliable evidence to observe from')],
    });
  }

  const observations = [];
  const diagnostics = [];

  for (const rule of rules) {
    let result;
    try {
      result = rule.evaluate(measurements);
    } catch (error) {
      diagnostics.push(diag('CONTRADICTORY_MEASUREMENTS', rule.id, `rule "${rule.id}" could not be evaluated against this measurements record: ${error.message}`));
      continue;
    }
    if (!result) continue; // Part 20 — insufficient/missing evidence; never invented

    if (rule.isDiagnostic) {
      diagnostics.push(diag(rule.diagnosticCode, rule.id, result.message));
      continue;
    }

    observations.push(
      createObservation({
        referenceVideoId: measurements.referenceVideoId,
        measurementsId: measurements.id,
        category: rule.category,
        statement: result.statement,
        evidence: (result.evidence || []).map((e) => createEvidenceLink({ measurementsId: measurements.id, metricPath: e.metricPath, value: e.value, unit: e.unit })),
        confidence: result.confidence,
        methodology: createObservationMethodology({ ruleId: rule.id, description: rule.description, limitations: rule.limitations }),
      })
    );
  }

  const status = observations.length === 0 && diagnostics.length === 0 ? 'FAILED' : diagnostics.length === 0 ? 'COMPLETE' : 'PARTIAL';

  const observationSet = createObservationSet({
    projectId,
    referenceVideoId: measurements.referenceVideoId,
    measurementsId: measurements.id,
    observations,
    status,
    diagnostics,
  });

  const saved = observationStore.addObservationSet(projectId, observationSet);
  return saved.ok ? saved.observationSet : observationSet;
}

module.exports = { deriveObservations };
