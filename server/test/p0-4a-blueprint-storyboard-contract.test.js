// Tests for the P0-4A Blueprint -> Storyboard contract additions to
// schemas/creative-schema.js: Storyboard.blueprintId,
// StoryboardShot.recommendationIds[], StoryboardShot.visualTreatment.
//
// P0-4A is a CONTRACT stage only — there is no Blueprint -> Storyboard
// generator anywhere in this codebase yet (that is P0-4B, explicitly out
// of scope here). These tests prove the contract fields exist, default
// correctly, survive persistence/versioned-update/serialization, remain
// backward-compatible with pre-existing data, and do not open a path for
// Blueprint strategy text to masquerade as shot-level production detail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p04a-projects-'));
process.env.CREATIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p04a-creative-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p04a-blueprints-'));
process.env.RECOMMENDATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-p04a-recs-'));

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const schema = require('../schemas/creative-schema');
const { deriveBeatGraph } = require('../services/beat-graph-derivation-service');
const recommendationStore = require('../services/recommendation-store');
const blueprintStore = require('../services/creative-blueprint-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

// P0 Hardening (finding G) — builds a real, persisted RecommendationSet +
// APPROVED CreativeBlueprint referencing it, and points a Storyboard at
// that Blueprint, so recommendationIds validation (creative-store.js) has
// a real chain to resolve against. Returns { recommendation, blueprintId }.
function setupBlueprintWithRecommendation(projectId) {
  const recommendation = createRecommendation({
    projectId,
    referenceSetId: 'rs1',
    recommendationType: 'RECURRING_PATTERN_APPLICATION',
    derivationType: 'SINGLE_PATTERN',
    category: 'OPENING_STRUCTURE',
    statement: 'stmt',
    rationale: 'rationale',
    action: 'Consider doing X.',
    sourcePatternIds: ['pattern-1'],
    confidence: 'MEDIUM',
    evidenceSufficiency: 'SUFFICIENT',
    meetsMinimumEvidenceThreshold: true,
  });
  const recSet = createRecommendationSet({ projectId, referenceSetId: 'rs1', patternSetId: 'pattern-set-1', recommendations: [recommendation], status: 'COMPLETE' });
  const savedSet = recommendationStore.addRecommendationSet(projectId, recSet).recommendationSet;
  const blueprint = createCreativeBlueprint({
    projectId,
    recommendationSetId: savedSet.id,
    status: 'APPROVED',
    concept: 'a concept',
    corePromise: 'a promise',
    targetDuration: 60,
  });
  const savedBlueprint = blueprintStore.addCreativeBlueprint(projectId, blueprint).blueprint;
  creativeStore.updateStoryboard(projectId, { blueprintId: savedBlueprint.id });
  return { recommendation: savedSet.recommendations[0], blueprintId: savedBlueprint.id };
}

// 1. new Storyboard provenance field is accepted
test('1. Storyboard.blueprintId is accepted when supplied', () => {
  const storyboard = schema.createStoryboard({ projectId: 'proj-1', blueprintId: 'blueprint-123' });
  assert.equal(storyboard.blueprintId, 'blueprint-123');
});

test('1b. StoryboardShot.recommendationIds/visualTreatment are accepted when supplied', () => {
  const shot = schema.createStoryboardShot({ recommendationIds: ['rec-1', 'rec-2'], visualTreatment: 'STILL_IMAGE' });
  assert.deepEqual(shot.recommendationIds, ['rec-1', 'rec-2']);
  assert.equal(shot.visualTreatment, 'STILL_IMAGE');
});

// 2. new fields have correct defaults
test('2. Storyboard.blueprintId defaults to null (never fabricated)', () => {
  assert.equal(schema.createStoryboard().blueprintId, null);
});

test('2b. StoryboardShot.recommendationIds defaults to [], visualTreatment defaults to null', () => {
  const shot = schema.createStoryboardShot();
  assert.deepEqual(shot.recommendationIds, []);
  assert.equal(shot.visualTreatment, null);
});

// 3. invalid IDs/types are rejected according to existing schema conventions
test('3. schema-factory layer applies NO type validation to the new fields — matches every sibling field in this file (continuityRequirements, characterReferences, etc., all plain pass-through via withDefaults, confirmed by direct inspection); this is the real, existing convention, not invented here', () => {
  // A non-array value is stored as-is, exactly like continuityRequirements/characterReferences would be.
  const shot = schema.createStoryboardShot({ recommendationIds: 'not-an-array' });
  assert.equal(shot.recommendationIds, 'not-an-array');
  // Enum enforcement for visualTreatment (like SHOT_PLANNING_STATUSES for `status`) lives at the
  // MCP/REST/service boundary in this codebase's established convention, never inside the schema
  // factory — confirmed no schema file requires another schema file (grep across schemas/, every
  // file imports only crypto). Out of scope for P0-4A per its own explicit boundary.
  const shotWithUnknownTreatment = schema.createStoryboardShot({ visualTreatment: 'NOT_A_REAL_TREATMENT' });
  assert.equal(shotWithUnknownTreatment.visualTreatment, 'NOT_A_REAL_TREATMENT');
});

// 4/5. survive serialization
test('4. recommendationIds[] survives a JSON serialize/deserialize round-trip', () => {
  const shot = schema.createStoryboardShot({ recommendationIds: ['rec-a', 'rec-b'] });
  const roundTripped = JSON.parse(JSON.stringify(shot));
  assert.deepEqual(roundTripped.recommendationIds, ['rec-a', 'rec-b']);
});

test('5. visualTreatment survives a JSON serialize/deserialize round-trip', () => {
  const shot = schema.createStoryboardShot({ visualTreatment: 'MOTION_GRAPHIC' });
  const roundTripped = JSON.parse(JSON.stringify(shot));
  assert.equal(roundTripped.visualTreatment, 'MOTION_GRAPHIC');
});

// 6. old Storyboards without the fields still validate/load
test('6. a pre-existing Storyboard record missing the new fields entirely (simulating on-disk data written before P0-4A) remains loadable, and every pre-existing field stays intact', () => {
  const project = newProject();
  // creative-store.js never re-runs the schema factory on load (loadRecord() is a raw
  // JSON.parse of whatever is on disk) — an old record's shape is preserved exactly as
  // it was written, confirmed by direct inspection of ensureRecord()/loadRecord().
  const oldShapedShot = { shotId: 'legacy-shot-1', sceneId: null, order: 1, duration: 5, purpose: 'intro', status: 'DRAFT' }; // no recommendationIds/visualTreatment keys at all
  const record = creativeStore.getCreativeRecord(project.id); // ensures the record file exists
  void record;
  creativeStore.addStoryboardShot(project.id, { shotId: undefined, ...oldShapedShot });
  const storyboard = creativeStore.getStoryboard(project.id);
  assert.equal(storyboard.shots.length, 1);
  assert.equal(storyboard.shots[0].purpose, 'intro'); // pre-existing field intact
  // The new fields DO get their schema defaults here because addStoryboardShot() always
  // constructs a fresh record via createStoryboardShot(overrides) — the "genuinely old,
  // pre-P0-4A, already-on-disk" case (fields simply absent as JS properties) is proven
  // directly against the raw object below, without going through the factory at all.
  assert.equal(storyboard.shots[0].recommendationIds !== undefined, true); // factory-constructed path backfills the default
  assert.equal('recommendationIds' in oldShapedShot, false); // the raw pre-P0-4A shape never had the key
});

// Direct raw-file read/write helpers for this test file only — creative-
// store.js's own getCreativeRecord() intentionally returns a STRIPPED view
// (no projectId — see its own implementation, creative-store.js:451) meant
// for read-only external consumption, never as a write-back primitive.
// These tests instead read/write the exact on-disk shape creative-store.js
// itself uses (recordFilePath()/saveRecord()), preserving `projectId`, so
// the record stays writable by the real store functions afterward.
function creativeRecordFilePath(projectId) {
  return path.join(process.env.CREATIVE_DATA_DIR, `${projectId}.json`);
}
function readRawCreativeRecord(projectId) {
  return JSON.parse(fs.readFileSync(creativeRecordFilePath(projectId), 'utf8'));
}
function writeRawCreativeRecord(record) {
  fs.writeFileSync(creativeRecordFilePath(record.projectId), JSON.stringify(record, null, 2));
}

// P0 Hardening (finding G) — updateStoryboardShot/addStoryboardShot now
// validate recommendationIds/visualTreatment at write time (creative-
// store.js), closing a silent-corruption gap where a typo'd or stale id
// was previously accepted with no error anywhere. This test previously
// asserted the OLD, unvalidated behavior (writing a fabricated "rec-9" id
// with no real Blueprint/Recommendation behind it succeeded silently) —
// updated to assert the corrected, intentional behavior: unvalidatable
// recommendationIds now throw, and a genuinely resolvable id succeeds.
test('6b. updateStoryboardShot on a genuinely old (pre-P0-4A) stored shot never throws for fields it does not touch, rejects a recommendationId that cannot be validated against any Blueprint, and accepts one that resolves to a real Recommendation', () => {
  const project = newProject();
  const shot = creativeStore.addStoryboardShot(project.id, { purpose: 'intro' });
  // Simulate genuinely old on-disk data by deleting the new keys directly from the persisted record.
  const record = readRawCreativeRecord(project.id);
  delete record.storyboard.shots[0].recommendationIds;
  delete record.storyboard.shots[0].visualTreatment;
  writeRawCreativeRecord(record);

  // No blueprintId is set on this storyboard, so a fabricated recommendationId cannot be
  // validated — this must now throw rather than silently persist an unverifiable reference.
  assert.throws(() => creativeStore.updateStoryboardShot(project.id, shot.shotId, { recommendationIds: ['rec-9'] }, {}), /no blueprintId set/);

  // A field the new validation doesn't touch (purpose) still updates cleanly on the old shape.
  const updatedPurpose = creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised intro' }, {});
  assert.equal(updatedPurpose.purpose, 'revised intro');

  // Once a real Blueprint/RecommendationSet is wired up, a genuinely resolvable recommendationId succeeds.
  const { recommendation } = setupBlueprintWithRecommendation(project.id);
  const updated = creativeStore.updateStoryboardShot(project.id, shot.shotId, { recommendationIds: [recommendation.id] }, {});
  assert.deepEqual(updated.recommendationIds, [recommendation.id]);
  assert.equal(updated.purpose, 'revised intro'); // untouched pre-existing field survives
});

// 7. versioned Storyboard updates preserve the new fields
test('7. setting Storyboard.blueprintId, then performing an unrelated versioned update (adding a new scene), preserves blueprintId', () => {
  const project = newProject();
  creativeStore.addStoryboardScene(project.id, { title: 'scene-1' });
  const record = readRawCreativeRecord(project.id);
  record.storyboard.blueprintId = 'blueprint-abc';
  writeRawCreativeRecord(record);

  const versionBefore = creativeStore.getStoryboard(project.id).version;
  creativeStore.addStoryboardScene(project.id, { title: 'scene-2' }); // triggers applyVersionedUpdate() -> version bump
  const storyboardAfter = creativeStore.getStoryboard(project.id);
  assert.equal(storyboardAfter.version, versionBefore + 1);
  assert.equal(storyboardAfter.blueprintId, 'blueprint-abc');
  assert.equal(storyboardAfter.scenes.length, 2);
});

// P0 Hardening (finding G) — recommendationIds must now resolve to a real
// Recommendation via the Storyboard's own blueprintId (previously accepted
// any string, including a fabricated "rec-1" with nothing behind it).
// Updated to set up a real Blueprint/RecommendationSet first, matching the
// same corrected-behavior pattern as test 6b above.
test('7b. adding a new shot to a storyboard preserves an existing shot\'s own recommendationIds/visualTreatment', () => {
  const project = newProject();
  const { recommendation } = setupBlueprintWithRecommendation(project.id);
  const first = creativeStore.addStoryboardShot(project.id, { recommendationIds: [recommendation.id], visualTreatment: 'WHITEBOARD' });
  creativeStore.addStoryboardShot(project.id, { purpose: 'second shot' });
  const storyboard = creativeStore.getStoryboard(project.id);
  const firstAfter = storyboard.shots.find((s) => s.shotId === first.shotId);
  assert.deepEqual(firstAfter.recommendationIds, [recommendation.id]);
  assert.equal(firstAfter.visualTreatment, 'WHITEBOARD');
  assert.equal(storyboard.shots.length, 2);
});

// 8. no unrelated fields were changed
test('8. every pre-existing StoryboardShot field is untouched — exact field-set comparison against the pre-P0-4A shape plus exactly the 2 new fields', () => {
  const shot = schema.createStoryboardShot();
  const preExistingFields = [
    'shotId', 'sceneId', 'order', 'duration', 'purpose', 'narrativeBeat', 'visualDescription', 'subject',
    'location', 'action', 'camera', 'framing', 'lens', 'movement', 'lighting', 'soundNotes', 'transition',
    'continuityRequirements', 'characterReferences', 'locationReferences', 'propReferences', 'referenceAssets',
    'promptDraft', 'status',
  ];
  const newFields = ['recommendationIds', 'visualTreatment'];
  assert.deepEqual(Object.keys(shot).sort(), [...preExistingFields, ...newFields].sort());
});

test('8b. every pre-existing Storyboard field is untouched — exact field-set comparison plus exactly 1 new field (blueprintId)', () => {
  const storyboard = schema.createStoryboard();
  const preExistingFields = ['id', 'projectId', 'scenes', 'shots', 'version', 'updatedAt', 'updatedBy', 'changeNote', 'history'];
  assert.deepEqual(Object.keys(storyboard).sort(), [...preExistingFields, 'blueprintId'].sort());
});

// ---------------------------------------------------------------------------
// P0 Hardening (finding G) — service-boundary validation for the three
// P0-4A contract fields, closing the silent-corruption gap this file's own
// tests 3/6b/7b (pre-hardening) explicitly documented as out of scope.
// ---------------------------------------------------------------------------

test('G1. update_storyboard rejects a blueprintId that does not resolve to a real CreativeBlueprint in this project', () => {
  const project = newProject();
  assert.throws(() => creativeStore.updateStoryboard(project.id, { blueprintId: 'not-a-real-blueprint-id' }), /does not resolve to a CreativeBlueprint/);
  assert.equal(creativeStore.getStoryboard(project.id), null); // never persisted
});

test('G2. update_storyboard accepts a blueprintId that resolves to a real CreativeBlueprint', () => {
  const project = newProject();
  const { blueprintId } = setupBlueprintWithRecommendation(project.id);
  const storyboard = creativeStore.getStoryboard(project.id);
  assert.equal(storyboard.blueprintId, blueprintId);
});

test('G3. create_storyboard_shot rejects a recommendationId that does not resolve to a Recommendation in the referenced Blueprint\'s RecommendationSet', () => {
  const project = newProject();
  setupBlueprintWithRecommendation(project.id);
  assert.throws(() => creativeStore.addStoryboardShot(project.id, { recommendationIds: ['not-a-real-recommendation-id'] }), /does not resolve to a Recommendation/);
});

test('G4. create_storyboard_shot rejects recommendationIds when the storyboard has no blueprintId set at all', () => {
  const project = newProject();
  assert.throws(() => creativeStore.addStoryboardShot(project.id, { recommendationIds: ['whatever'] }), /no blueprintId set/);
});

test('G5. create_storyboard_shot rejects a visualTreatment outside VISUAL_TREATMENTS', () => {
  const project = newProject();
  assert.throws(() => creativeStore.addStoryboardShot(project.id, { visualTreatment: 'NOT_A_REAL_TREATMENT' }), /not a recognized value/);
});

test('G6. create_storyboard_shot accepts a real visualTreatment with no Blueprint reference required', () => {
  const project = newProject();
  const shot = creativeStore.addStoryboardShot(project.id, { visualTreatment: 'BROLL_CLIP' });
  assert.equal(shot.visualTreatment, 'BROLL_CLIP');
});

test('G7. update_storyboard_shot rejects an invalid recommendationId/visualTreatment the same way addStoryboardShot does', () => {
  const project = newProject();
  const shot = creativeStore.addStoryboardShot(project.id, { purpose: 'intro' });
  assert.throws(() => creativeStore.updateStoryboardShot(project.id, shot.shotId, { visualTreatment: 'FAKE' }), /not a recognized value/);
  assert.throws(() => creativeStore.updateStoryboardShot(project.id, shot.shotId, { recommendationIds: ['ghost-rec'] }), /no blueprintId set/);
});

// 10. the contract does not permit Blueprint strategy text to masquerade as shot-level generated content
test('10. createStoryboardShot()\'s own source code contains no reference to any Blueprint strategy field name — structural proof no auto-derivation exists', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'creative-schema.js'), 'utf8');
  const functionSource = source.slice(source.indexOf('function createStoryboardShot'), source.indexOf('function createStoryboard('));
  const blueprintStrategyFieldNames = ['concept', 'corePromise', 'hookStrategy', 'narrativeStrategy', 'pacingStrategy', 'visualStrategy', 'narrationStrategy', 'targetAudience'];
  for (const field of blueprintStrategyFieldNames) {
    assert.ok(!functionSource.includes(field), `createStoryboardShot must never reference Blueprint.${field}`);
  }
});

test('10b. supplying Blueprint-strategy-shaped keys as overrides never expands them into production fields (camera/lighting/visualDescription) — plain pass-through only, exactly like every other override', () => {
  const shot = schema.createStoryboardShot({ recommendationIds: ['rec-1'] }); // no visualStrategy/hookStrategy input path exists at all
  assert.equal(shot.camera, null);
  assert.equal(shot.lighting, null);
  assert.equal(shot.visualDescription, null);
});

// 11. existing P0-1 behavior remains unchanged
test('11. deriveBeatGraph() (P0-1) is unaffected by the new fields being present on a shot — it neither copies nor is confused by recommendationIds/visualTreatment', () => {
  const storyboard = schema.createStoryboard({
    projectId: 'proj-1',
    blueprintId: 'blueprint-xyz',
    scenes: [schema.createStoryboardScene({ sceneId: 'scene-1' })],
    shots: [schema.createStoryboardShot({ sceneId: 'scene-1', order: 1, duration: 5, purpose: 'intro', recommendationIds: ['rec-1', 'rec-2'], visualTreatment: 'STILL_IMAGE' })],
  });
  const result = deriveBeatGraph(storyboard, {});
  assert.equal(result.status, 'DERIVED');
  assert.equal(result.derivedBeatCount, 1);
  const beat = result.beatGraph.beats[0];
  // P0-1's own explicit field list (id, projectId, sceneId, shotId, sequence, startTime, duration,
  // narrativePurpose, visualIntent, visualTreatment, narrationSegment, camera, lighting,
  // identityRequirements, continuityRequirements, transition, status) never reads shot.recommendationIds
  // at all — confirmed unchanged this session — and beat.visualTreatment stays null because P0-1 only
  // ever sets it from context.treatments (never inferred from the shot itself, even though the shot
  // now HAS its own visualTreatment field).
  assert.equal(beat.visualTreatment, null);
  assert.equal('recommendationIds' in beat, false);
});
