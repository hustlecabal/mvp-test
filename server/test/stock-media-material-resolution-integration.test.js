// Tests for the STOCK_MEDIA candidate block in services/material-
// resolution-service.js's resolveMaterial()/resolveBeatGraph(). Material
// Resolution never calls a provider or the network here — every test only
// exercises the pure, injectable context.stockMediaProviders gate (see
// that block's own header comment for why).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-stockmr-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const materialResolutionService = require('../services/material-resolution-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function imageBeat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'STILL_IMAGE', ...overrides });
}

function videoBeat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'BROLL_CLIP', ...overrides });
}

// --- No provider configured -------------------------------------------------------------------

test('no context.stockMediaProviders — STOCK_MEDIA hard-gates as NO_PROVIDER_CONFIGURED and never survives to ranking', () => {
  const project = makeProject();
  const resolution = materialResolutionService.resolveMaterial(project.id, videoBeat(), {});
  const gate = resolution.hardGateResults.find((g) => g.candidate === 'STOCK_MEDIA+BROLL_CLIP');
  assert.ok(gate);
  assert.equal(gate.allowed, false);
  assert.equal(gate.rejectedBy, 'NO_PROVIDER_CONFIGURED');
  assert.equal(resolution.candidates.some((c) => c.materialSource === 'STOCK_MEDIA'), false);
});

// --- I. image request through Material Resolution -------------------------------------------------------------------

test('I. with a provider configured, a STILL_IMAGE beat produces a real STOCK_MEDIA candidate (proposed strategy, no asset resolved yet)', () => {
  const project = makeProject();
  const resolution = materialResolutionService.resolveMaterial(project.id, imageBeat(), { stockMediaProviders: ['pexels'] });

  // GENERATED_NEW+STILL_IMAGE is also offered for this beat (the resolver
  // proposes every viable strategy) — the point of this test is that
  // STOCK_MEDIA is genuinely AMONG the offered candidates, not that it
  // necessarily wins the ranking (PROJECT_ASSET_REUSE/GENERATED_NEW's own
  // relative ranking is out of scope here — see test/material-resolution-
  // service.test.js for that existing coverage).
  const stockCandidate = resolution.candidates.find((c) => c.materialSource === 'STOCK_MEDIA' && c.visualTreatment === 'STILL_IMAGE');
  assert.ok(stockCandidate, 'a STOCK_MEDIA+STILL_IMAGE candidate must be offered');
  assert.equal(stockCandidate.selectedAssetId, null, 'resolveMaterial never resolves an actual asset for STOCK_MEDIA — that is Media Acquisition/Execution\'s job');
});

// --- J. video request through Material Resolution -------------------------------------------------------------------

test('J. with a provider configured, a BROLL_CLIP beat resolves to STOCK_MEDIA when no B-roll library or approved video asset exists', () => {
  const project = makeProject();
  const resolution = materialResolutionService.resolveMaterial(project.id, videoBeat(), { stockMediaProviders: ['pixabay'] });

  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'STOCK_MEDIA');
  assert.equal(resolution.selectedMaterial.visualTreatment, 'BROLL_CLIP');
});

// --- character identity gate -------------------------------------------------------------------

test('a character-identity beat rejects STOCK_MEDIA for PRIMARY (both treatments), same discipline as BROLL_LIBRARY', () => {
  const project = makeProject();
  const b = videoBeat({ identityRequirements: { characterReferences: ['zandra'], locationReferences: [], propReferences: [] } });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, { stockMediaProviders: ['pexels'] });

  const gate = resolution.hardGateResults.find((g) => g.candidate === 'STOCK_MEDIA+BROLL_CLIP');
  assert.equal(gate.allowed, false);
  assert.equal(gate.rejectedBy, 'IDENTITY_REQUIRES_NON_STOCK_PRIMARY');
  assert.deepEqual(gate.eligibleRoles, ['OVERLAY', 'BACKGROUND', 'INSERT']);
});

// --- determinism -------------------------------------------------------------------

test('repeated resolutions with the same context are byte-identical', () => {
  const project = makeProject();
  const first = materialResolutionService.resolveMaterial(project.id, videoBeat(), { stockMediaProviders: ['pexels', 'pixabay'] });
  const second = materialResolutionService.resolveMaterial(project.id, videoBeat(), { stockMediaProviders: ['pexels', 'pixabay'] });
  assert.equal(first.selectedMaterial.candidate, second.selectedMaterial.candidate);
  assert.deepEqual(first.ranking, second.ranking);
});

// --- resolveBeatGraph passthrough + summary tally -------------------------------------------------------------------

test('resolveBeatGraph passes context.stockMediaProviders through to every beat and tallies stockMediaCount', () => {
  const project = makeProject();
  const b1 = videoBeat({ id: 'b1' });
  // b2 has no identity/continuity requirement either, so its own
  // STILL_IMAGE beat ALSO resolves to STOCK_MEDIA (reuse-phase score 2,
  // beating GENERATED_NEW's 0) once a provider is available — a real,
  // intentional consequence of REUSE_ORDINAL treating free stock media as
  // more "reuse-worthy" than a fresh paid generation whenever nothing else
  // distinguishes the two candidates. Both beats are expected to land on
  // STOCK_MEDIA here, not just b1.
  const b2 = imageBeat({ id: 'b2' });
  const graph = createBeatGraph({ projectId: project.id, beats: [b1, b2] });

  const report = materialResolutionService.resolveBeatGraph(project.id, graph, { stockMediaProviders: ['pexels'] });

  assert.equal(report.summary.totalBeats, 2);
  assert.equal(report.resolutions.find((r) => r.beatId === 'b1').selectedMaterial.materialSource, 'STOCK_MEDIA');
  assert.equal(report.resolutions.find((r) => r.beatId === 'b2').selectedMaterial.materialSource, 'STOCK_MEDIA');
  assert.equal(report.summary.stockMediaCount, 2);
  assert.equal(report.summary.zeroCostDeterministicCount >= 2, true);
});

// --- no network / no provider import -------------------------------------------------------------------

test('material-resolution-service.js still contains no provider/network import after this stage\'s change', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-resolution-service.js'), 'utf8');
  for (const forbidden of ['fetch(', 'axios', 'http.request', 'https.request', 'child_process']) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `must not contain "${forbidden}"`);
  }
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*media-acquisition-service[^'"`]*['"`]\s*\)/, 'must never require media-acquisition-service.js directly');
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*approval-gate[^'"`]*['"`]\s*\)/);
});
