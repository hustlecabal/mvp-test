// Tests for schemas/material-resolution-schema.js — plain object factories
// only, no file I/O, no provider knowledge. Mirrors visual-beat-schema.test.js's
// style.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MATERIAL_RESOLUTION_STATUSES,
  DECIDING_PHASES,
  BEAT_GRAPH_RESOLUTION_STATUSES,
  createHardGateResult,
  createCandidateResult,
  createMaterialResolution,
  createResolutionSummary,
  createBeatGraphResolution,
} = require('../schemas/material-resolution-schema');

// --- 1. Enums ---------------------------------------------------------------

test('1a. MATERIAL_RESOLUTION_STATUSES is the exact fixed vocabulary', () => {
  assert.deepEqual(MATERIAL_RESOLUTION_STATUSES, ['RESOLVED', 'UNRESOLVED']);
});

test('1b. DECIDING_PHASES is the exact fixed vocabulary', () => {
  assert.deepEqual(DECIDING_PHASES, ['CREATIVE_FIT', 'CONTINUITY', 'REUSE', 'COST', 'COMPLEXITY', 'CREATED_AT', 'SOLE_SURVIVOR']);
});

// --- 2. createHardGateResult defaults ----------------------------------------

test('2a. createHardGateResult fills in every field with a safe default', () => {
  const result = createHardGateResult();
  assert.equal(result.candidate, null);
  assert.equal(result.role, 'PRIMARY');
  assert.equal(result.allowed, null);
  assert.equal(result.rejectedBy, null);
  assert.equal(result.reason, '');
  assert.deepEqual(result.eligibleRoles, []);
});

test('2b. createHardGateResult accepts an eligibleRoles list independent of the allowed verdict', () => {
  const result = createHardGateResult({ candidate: 'BROLL_LIBRARY+BROLL_CLIP', allowed: false, rejectedBy: 'IDENTITY_REQUIRES_NON_BROLL_PRIMARY', eligibleRoles: ['OVERLAY', 'BACKGROUND', 'INSERT'] });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.eligibleRoles, ['OVERLAY', 'BACKGROUND', 'INSERT']);
});

// --- 3. createCandidateResult defaults ---------------------------------------

test('3a. createCandidateResult fills in every field with a safe default, including a nested phaseScores object with all five phases null', () => {
  const result = createCandidateResult();
  assert.equal(result.candidate, null);
  assert.equal(result.role, 'PRIMARY');
  assert.equal(result.materialSource, null);
  assert.equal(result.visualTreatment, null);
  assert.equal(result.selectedAssetId, null);
  assert.equal(result.modelRequirements, null);
  assert.deepEqual(result.eligibleRoles, ['PRIMARY']);
  assert.deepEqual(result.phaseScores, { creativeFit: null, continuity: null, reuse: null, cost: null, complexity: null });
});

test('3b. createCandidateResult\'s own default shape never has a totalScore field', () => {
  const result = createCandidateResult();
  assert.equal('totalScore' in result, false, 'a summed totalScore must never exist on a CandidateResult — ranking is ordered-phase comparison, not a weighted sum');
});

test('3c. createCandidateResult modelRequirements carries capability shape only, never a provider/model name', () => {
  const result = createCandidateResult({ modelRequirements: { textToVideo: true, minDurationSeconds: 5 } });
  assert.equal(result.modelRequirements.provider, undefined);
  assert.equal(result.modelRequirements.model, undefined);
});

// --- 4. createMaterialResolution defaults ------------------------------------

test('4a. createMaterialResolution fills in every field with a safe default', () => {
  const resolution = createMaterialResolution({ beatId: 'beat-1' });
  assert.ok(resolution.id);
  assert.equal(resolution.beatId, 'beat-1');
  assert.equal(resolution.status, null);
  assert.equal(resolution.selectedMaterial, null);
  assert.equal(resolution.decidingPhase, null);
  assert.deepEqual(resolution.candidates, []);
  assert.deepEqual(resolution.hardGateResults, []);
  assert.deepEqual(resolution.ranking, []);
  assert.deepEqual(resolution.unresolvedRequirements, []);
  assert.deepEqual(resolution.warnings, []);
  assert.equal(resolution.rationale, '');
  assert.ok(resolution.createdAt);
});

test('4b. createMaterialResolution assigns a fresh, unique id every call', () => {
  const a = createMaterialResolution();
  const b = createMaterialResolution();
  assert.notEqual(a.id, b.id);
});

test('4c. createMaterialResolution has no version/history fields — it is a computed snapshot, not an edited artifact', () => {
  const resolution = createMaterialResolution();
  assert.equal('version' in resolution, false);
  assert.equal('history' in resolution, false);
  assert.equal('updatedBy' in resolution, false);
  assert.equal('changeNote' in resolution, false);
});

test('4d. createMaterialResolution\'s own default shape never has a totalScore field', () => {
  const resolution = createMaterialResolution();
  assert.equal('totalScore' in resolution, false);
});

test('4e. an explicit undefined override never wipes a default to nothing', () => {
  const resolution = createMaterialResolution({ candidates: undefined });
  assert.deepEqual(resolution.candidates, []);
});

// --- 5. A concrete RESOLVED example, exercising every field together --------

test('5. a concrete RESOLVED MaterialResolution round-trips every field correctly', () => {
  const winner = createCandidateResult({
    candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE',
    materialSource: 'PROJECT_ASSET_REUSE',
    visualTreatment: 'STILL_IMAGE',
    selectedAssetId: 'asset-1',
    phaseScores: { creativeFit: 2, continuity: 4, reuse: 3, cost: 2, complexity: 3 },
  });
  const rejected = createHardGateResult({
    candidate: 'GENERATED_NEW+STILL_IMAGE',
    allowed: false,
    rejectedBy: 'NO_CAPABLE_MODEL',
    reason: 'no registry model satisfies the derived capability requirements',
  });

  const resolution = createMaterialResolution({
    beatId: 'beat-1',
    status: 'RESOLVED',
    selectedMaterial: winner,
    decidingPhase: 'SOLE_SURVIVOR',
    candidates: [winner],
    hardGateResults: [rejected],
    ranking: [winner.candidate],
    rationale: 'existing asset satisfies the beat',
  });

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.selectedAssetId, 'asset-1');
  assert.equal(resolution.candidates[0], winner);
  assert.equal(resolution.hardGateResults[0].rejectedBy, 'NO_CAPABLE_MODEL');
  assert.deepEqual(resolution.ranking, ['PROJECT_ASSET_REUSE+STILL_IMAGE']);
});

// --- 6. Provider neutrality / shape discipline -------------------------------

test('6a. schemas/material-resolution-schema.js has no require() of any provider, generation, or approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'material-resolution-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate|google/i.test(req), `unexpected import: ${req}`);
  }
});

test('6b. schemas/material-resolution-schema.js never mentions a specific provider or model name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'material-resolution-schema.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference provider/model "${forbidden}"`);
  }
});

test('6c. schemas/material-resolution-schema.js does no file I/O — the only require is crypto', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'material-resolution-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
});

test('6d. schemas/material-resolution-schema.js never defines a totalScore property (comments explaining its deliberate absence are fine)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'material-resolution-schema.js'), 'utf8');
  assert.doesNotMatch(text, /totalScore\s*[:=]/);
});

// --- 7. Stage 26.4 — BeatGraph-level aggregate report ------------------------------

test('7a. BEAT_GRAPH_RESOLUTION_STATUSES is the exact fixed vocabulary', () => {
  assert.deepEqual(BEAT_GRAPH_RESOLUTION_STATUSES, ['RESOLVED', 'PARTIAL', 'UNRESOLVED']);
});

test('7b. createResolutionSummary fills in every field with a safe zero/empty default — material-strategy counts only, never a cost', () => {
  const summary = createResolutionSummary();
  assert.equal(summary.totalBeats, 0);
  assert.equal(summary.resolvedBeats, 0);
  assert.equal(summary.unresolvedBeats, 0);
  assert.equal(summary.existingAssetCount, 0);
  assert.equal(summary.brollCount, 0);
  assert.equal(summary.stillImageCount, 0);
  assert.equal(summary.motionGraphicCount, 0);
  assert.equal(summary.whiteboardCount, 0);
  assert.equal(summary.kineticTypographyCount, 0);
  assert.equal(summary.aiVideoCount, 0);
  assert.deepEqual(summary.unresolvedReasons, []);
  assert.equal(summary.estimatedGenerationCandidates, 0);
  assert.equal(summary.zeroCostDeterministicCount, 0);
  assert.equal('estimatedCost' in summary, false, 'this is a strategy-count summary, never a financial estimate');
  assert.equal('reservedCredits' in summary, false);
});

test('7c. createBeatGraphResolution fills in every field with a safe default and no version/history fields', () => {
  const resolution = createBeatGraphResolution({ beatGraphId: 'proj-1' });
  assert.equal(resolution.beatGraphId, 'proj-1');
  assert.equal(resolution.status, null);
  assert.deepEqual(resolution.resolutions, []);
  assert.ok(resolution.summary);
  assert.equal(resolution.summary.totalBeats, 0);
  assert.ok(resolution.createdAt);
  assert.equal('version' in resolution, false);
  assert.equal('history' in resolution, false);
});

test('7d. createBeatGraphResolution never has a totalScore field, and neither does its nested summary', () => {
  const resolution = createBeatGraphResolution();
  assert.equal('totalScore' in resolution, false);
  assert.equal('totalScore' in resolution.summary, false);
});
