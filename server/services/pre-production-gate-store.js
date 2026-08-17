// pre-production-gate-store.js
//
// INT-2.5 — persistence for PreProductionGateResult records (schemas/
// pre-production-gate-schema.js). Same one-JSON-file-per-project
// convention every store in this codebase uses — `{ projectId,
// gateResults: [] }`. Never mutates a CreativeBlueprint, RecommendationSet,
// Recommendation, PatternSet, ObservationSet, Measurements, ReferenceVideo,
// or VisualBible record — this file only ever writes its own small JSON
// index of DERIVED gate-result data.
//
// APPEND-ONLY, MACHINE FIELDS NEVER OVERWRITTEN (spec Part 3/11): once a
// PreProductionGateResult is added via addGateResult(), its
// machineAssessment/blockers/warnings/information/reasoning are permanent.
// recordHumanDecision() below is the ONLY update function this file
// exposes, and it touches ONLY humanDecision/humanDecidedBy/
// humanDecidedAt/humanRationale — mirrors creative-blueprint-store.js's
// updateCreativeBlueprintReviewState() exactly (same narrow "only these
// named fields, never the machine-derived ones" contract).
//
// UNLIKE RecommendationSet/PatternSet (a "one record per generation
// attempt" wrapper around many child records), a PreProductionGateResult
// is ITSELF the reviewable unit — same convention CreativeBlueprint
// already established. Re-running the gate against the same Blueprint
// revision appends a NEW result rather than overwriting the prior one,
// so a full history of every gate evaluation for a Blueprint stays
// inspectable (spec Part 18's audit-trail requirement).

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const PRE_PRODUCTION_GATE_DATA_DIR = process.env.PRE_PRODUCTION_GATE_DATA_DIR
  ? path.resolve(process.env.PRE_PRODUCTION_GATE_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'pre-production-gates');

fs.mkdirSync(PRE_PRODUCTION_GATE_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(PRE_PRODUCTION_GATE_DATA_DIR, `${projectId}.json`);
}

function loadLibrary(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveLibrary(library) {
  fs.writeFileSync(fileFor(library.projectId), JSON.stringify(library, null, 2));
}

function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, gateResults: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, gateResults: [] };
}

function getGateResult(projectId, gateResultId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.gateResults.find((g) => g.id === gateResultId) || null;
}

function listGateResults(projectId, { blueprintId } = {}) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return blueprintId ? library.gateResults.filter((g) => g.blueprintId === blueprintId) : library.gateResults.slice();
}

function getLatestGateResultForBlueprint(projectId, blueprintId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.gateResults.filter((g) => g.blueprintId === blueprintId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, g) => (new Date(g.createdAt) > new Date(latest.createdAt) ? g : latest));
}

function addGateResult(projectId, gateResult) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(gateResult));
  library.gateResults.push(stored);
  saveLibrary(library);
  return { ok: true, gateResult: stored };
}

// Spec Part 11 — records the human's decision on an EXISTING gate result.
// Never touches machineAssessment/blockers/warnings/information/reasoning.
// Returns null for a non-existent project/gate result (same convention as
// creative-blueprint-store.js's updateCreativeBlueprintReviewState()).
//
// P0 Hardening (finding D) — APPENDS to humanDecisions[] rather than
// overwriting scalars in place. A later decision's own rationale can
// legitimately be null (e.g. a plain ACCEPT never needs one) WITHOUT that
// erasing an earlier decision's own rationale (e.g. a mandatory OVERRIDE
// justification) — the earlier entry stays exactly as it was pushed. The
// four scalar fields are still updated, as a read-convenience mirror of
// the array's own newest entry — every existing caller reading them
// unchanged still sees the correct "latest decision" value.
function recordHumanDecision(projectId, gateResultId, { humanDecision, humanDecidedBy, humanRationale }) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const gateResult = library.gateResults.find((g) => g.id === gateResultId);
  if (!gateResult) return null;
  const decidedAt = new Date().toISOString();
  if (!Array.isArray(gateResult.humanDecisions)) gateResult.humanDecisions = [];
  gateResult.humanDecisions.push({ decision: humanDecision, decidedBy: humanDecidedBy || null, decidedAt, rationale: humanRationale !== undefined ? humanRationale : null });
  gateResult.humanDecision = humanDecision;
  gateResult.humanDecidedBy = humanDecidedBy || null;
  gateResult.humanDecidedAt = decidedAt;
  gateResult.humanRationale = humanRationale !== undefined ? humanRationale : null;
  saveLibrary(library);
  return gateResult;
}

module.exports = {
  PRE_PRODUCTION_GATE_DATA_DIR,
  getGateResult,
  listGateResults,
  getLatestGateResultForBlueprint,
  addGateResult,
  recordHumanDecision,
};
