// Tests for schemas/visual-beat-schema.js — plain object factories only,
// no file I/O, no provider knowledge. Mirrors keyframe-schema.test.js's
// style, plus dedicated coverage for the Stage 26.1 multi-material
// refinement (a VisualBeat is 1..N structured material components, not
// exactly one asset).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  VISUAL_TREATMENTS,
  MATERIAL_SOURCES,
  MOTION_LEVELS,
  COST_PRIORITIES,
  QUALITY_PRIORITIES,
  LICENSING_STATUSES,
  MATERIAL_ROLES,
  BEAT_STATUSES,
  createGenerationRequirement,
  createIdentityRequirements,
  createNarrationSegment,
  createMaterialComponent,
  createVisualBeat,
} = require('../schemas/visual-beat-schema');

// --- 1. VisualBeat defaults -----------------------------------------------------

test('1. createVisualBeat fills in every field with a safe default', () => {
  const beat = createVisualBeat();

  assert.ok(beat.id);
  assert.equal(beat.projectId, null);
  assert.equal(beat.sceneId, null);
  assert.equal(beat.shotId, null);
  assert.equal(beat.sequence, null);
  assert.equal(beat.startTime, null);
  assert.equal(beat.duration, null);
  assert.equal(beat.narrativePurpose, '');
  assert.equal(beat.narrationSegment, null);
  assert.equal(beat.visualIntent, '');
  assert.equal(beat.visualTreatment, null);
  assert.deepEqual(beat.motionRequirements, { motionLevel: null, requiresCameraMotion: null, requiresSubjectMotion: null });
  assert.equal(beat.composition, null);
  assert.equal(beat.camera, null);
  assert.equal(beat.subjectMotion, null);
  assert.equal(beat.environmentMotion, null);
  assert.equal(beat.lighting, null);
  assert.equal(beat.colour, null);
  assert.equal(beat.pacing, null);
  assert.deepEqual(beat.identityRequirements, { characterReferences: [], locationReferences: [], propReferences: [] });
  assert.deepEqual(beat.continuityRequirements, []);
  assert.equal(beat.styleRequirements, null);
  assert.equal(beat.transition, null);
  assert.deepEqual(beat.audioEvents, []);
  assert.equal(beat.graphics, null);
  assert.equal(beat.costPriority, 'MEDIUM');
  assert.equal(beat.qualityPriority, 'MEDIUM');
  assert.deepEqual(beat.fallbackStrategy, []);
  assert.deepEqual(beat.materials, [], 'a beat has zero materials until something resolves it — never invented');
  assert.equal(beat.resolvedAssetId, null);
  assert.equal(beat.resolutionScore, null);
  assert.deepEqual(beat.resolutionAlternatives, []);
  assert.equal(beat.status, 'PLANNED');
  assert.equal(beat.version, 1);
  assert.deepEqual(beat.history, []);
});

test('createVisualBeat overrides only the fields given, without wiping others to their defaults', () => {
  const beat = createVisualBeat({ sceneId: 'sc-1', shotId: 'sh-1', narrativePurpose: 'Establish the office' });
  assert.equal(beat.sceneId, 'sc-1');
  assert.equal(beat.shotId, 'sh-1');
  assert.equal(beat.narrativePurpose, 'Establish the office');
  assert.equal(beat.status, 'PLANNED', 'unrelated defaults must still apply');
  assert.equal(beat.costPriority, 'MEDIUM', 'unrelated defaults must still apply');
});

test('createVisualBeat never lets an explicit undefined override a default', () => {
  const beat = createVisualBeat({ status: undefined, costPriority: undefined });
  assert.equal(beat.status, 'PLANNED');
  assert.equal(beat.costPriority, 'MEDIUM');
});

test('createVisualBeat assigns a fresh, unique id every call', () => {
  const a = createVisualBeat();
  const b = createVisualBeat();
  assert.notEqual(a.id, b.id);
});

// --- 2. Two-axis treatment taxonomy ---------------------------------------------

test('2a. VISUAL_TREATMENTS is the exact approved two-axis vocabulary (visualTreatment = what the viewer experiences)', () => {
  assert.deepEqual(VISUAL_TREATMENTS, [
    'STILL_IMAGE',
    'AI_VIDEO',
    'BROLL_CLIP',
    'MOTION_GRAPHIC',
    'KINETIC_TYPOGRAPHY',
    'HYBRID',
  ]);
});

test('2b. MATERIAL_SOURCES is the exact approved orthogonal vocabulary (materialSource = where the material comes from)', () => {
  assert.deepEqual(MATERIAL_SOURCES, [
    'PROJECT_ASSET_REUSE',
    'GENERATED_NEW',
    'BROLL_LIBRARY',
    'DETERMINISTIC_TEMPLATE',
  ]);
});

test('2c. the two axes are genuinely independent — every treatment can pair with every source on a material component', () => {
  for (const visualTreatment of VISUAL_TREATMENTS.filter((t) => t !== 'HYBRID')) {
    for (const materialSource of MATERIAL_SOURCES) {
      const material = createMaterialComponent({ visualTreatment, materialSource });
      assert.equal(material.visualTreatment, visualTreatment);
      assert.equal(material.materialSource, materialSource);
    }
  }
});

// --- 3. Other enums ---------------------------------------------------------------

test('3a. MOTION_LEVELS is the fixed hard-gate vocabulary', () => {
  assert.deepEqual(MOTION_LEVELS, ['NONE', 'SUBTLE', 'MODERATE', 'COMPLEX']);
});

test('3b. COST_PRIORITIES / QUALITY_PRIORITIES share the same LOW/MEDIUM/HIGH vocabulary', () => {
  assert.deepEqual(COST_PRIORITIES, ['LOW', 'MEDIUM', 'HIGH']);
  assert.deepEqual(QUALITY_PRIORITIES, ['LOW', 'MEDIUM', 'HIGH']);
});

test('3c. LICENSING_STATUSES includes UNKNOWN, which a later resolver must treat as a hard fail for production use', () => {
  assert.deepEqual(LICENSING_STATUSES, ['CLEARED', 'RESTRICTED', 'UNKNOWN']);
});

test('3d. MATERIAL_ROLES is the fixed layering/sequencing vocabulary', () => {
  assert.deepEqual(MATERIAL_ROLES, ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT']);
});

test('3e. BEAT_STATUSES is separate from the project state machine, shot planning statuses, and keyframe statuses', () => {
  assert.deepEqual(BEAT_STATUSES, ['PLANNED', 'RESOLVING', 'RESOLVED', 'APPROVED', 'PLACED', 'STALE']);
});

// --- 4. Sub-factories --------------------------------------------------------------

test('4a. createGenerationRequirement defaults every field to null and only applies given overrides', () => {
  const req = createGenerationRequirement();
  assert.deepEqual(req, {
    motionLevel: null,
    camera: null,
    subjectMotion: null,
    environmentMotion: null,
    composition: null,
    lighting: null,
    colour: null,
  });
  const filled = createGenerationRequirement({ motionLevel: 'COMPLEX', subjectMotion: 'reaches, grips, opens' });
  assert.equal(filled.motionLevel, 'COMPLEX');
  assert.equal(filled.subjectMotion, 'reaches, grips, opens');
  assert.equal(filled.camera, null, 'unrelated fields stay defaulted');
});

test('4b. createIdentityRequirements defaults to three empty reference arrays', () => {
  const ir = createIdentityRequirements();
  assert.deepEqual(ir, { characterReferences: [], locationReferences: [], propReferences: [] });
});

test('4c. createNarrationSegment defaults every field to null', () => {
  const seg = createNarrationSegment();
  assert.deepEqual(seg, { text: null, scriptRefId: null, startOffset: null, endOffset: null });
});

// --- 5. Material component ----------------------------------------------------------

test('5a. createMaterialComponent fills in every field with a safe default', () => {
  const m = createMaterialComponent();
  assert.ok(m.materialId);
  assert.equal(m.materialSource, null);
  assert.equal(m.visualTreatment, null);
  assert.equal(m.assetId, null);
  assert.equal(m.generationRequirement, null);
  assert.equal(m.duration, null);
  assert.equal(m.role, 'PRIMARY');
  assert.equal(m.order, 0);
  assert.equal(m.licensingStatus, null);
  assert.deepEqual(m.identityRequirements, { characterReferences: [], locationReferences: [], propReferences: [] });
  assert.deepEqual(m.continuityRequirements, []);
});

test('5b. createMaterialComponent assigns a fresh, unique materialId every call', () => {
  const a = createMaterialComponent();
  const b = createMaterialComponent();
  assert.notEqual(a.materialId, b.materialId);
});

test('5c. a GENERATED_NEW material can carry a full generationRequirement, never a provider name', () => {
  const m = createMaterialComponent({
    materialSource: 'GENERATED_NEW',
    visualTreatment: 'AI_VIDEO',
    generationRequirement: createGenerationRequirement({ motionLevel: 'MODERATE', subjectMotion: 'walks through the door' }),
  });
  assert.equal(m.materialSource, 'GENERATED_NEW');
  assert.equal(m.generationRequirement.motionLevel, 'MODERATE');
  assert.equal(m.generationRequirement.subjectMotion, 'walks through the door');
});

test('5d. a BROLL_LIBRARY material can carry a licensingStatus', () => {
  const cleared = createMaterialComponent({ materialSource: 'BROLL_LIBRARY', visualTreatment: 'BROLL_CLIP', licensingStatus: 'CLEARED' });
  const unknown = createMaterialComponent({ materialSource: 'BROLL_LIBRARY', visualTreatment: 'BROLL_CLIP', licensingStatus: 'UNKNOWN' });
  assert.equal(cleared.licensingStatus, 'CLEARED');
  assert.equal(unknown.licensingStatus, 'UNKNOWN');
});

// --- 6. Multi-material — the Stage 26.1 refinement ------------------------------------

test('6a. a VisualBeat is never constrained to exactly one material — materials is an ordered list', () => {
  const beat = createVisualBeat({
    materials: [createMaterialComponent(), createMaterialComponent(), createMaterialComponent()],
  });
  assert.equal(beat.materials.length, 3);
});

test('6b. a single-material beat is the common case of the same structure, not a separate shape', () => {
  const single = createVisualBeat({ materials: [createMaterialComponent({ materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE' })] });
  assert.equal(single.materials.length, 1);
  assert.equal(single.materials[0].materialSource, 'PROJECT_ASSET_REUSE');
  // no special-cased field exists for "the one material" — resolvedAssetId
  // is the only convenience pointer, and it stays independent of materials.length
  assert.equal(single.resolvedAssetId, null);
});

test('6c. HYBRID example from the Stage 26.1 spec: "person walks into an office" with 4 layered materials', () => {
  const beat = createVisualBeat({
    projectId: 'proj-1',
    sceneId: 'sc-1',
    shotId: 'sh-1',
    sequence: 1,
    narrativePurpose: 'Person arrives at the office',
    visualIntent: 'Person walks into an office',
    visualTreatment: 'HYBRID',
    materials: [
      createMaterialComponent({ materialSource: 'BROLL_LIBRARY', visualTreatment: 'BROLL_CLIP', role: 'PRIMARY', order: 0, licensingStatus: 'CLEARED' }),
      createMaterialComponent({
        materialSource: 'GENERATED_NEW',
        visualTreatment: 'AI_VIDEO',
        role: 'INSERT',
        order: 1,
        generationRequirement: createGenerationRequirement({ motionLevel: 'MODERATE', subjectMotion: 'opens the door and steps through' }),
      }),
      createMaterialComponent({ materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'MOTION_GRAPHIC', role: 'OVERLAY', order: 2 }),
      createMaterialComponent({ materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'KINETIC_TYPOGRAPHY', role: 'OVERLAY', order: 3 }),
    ],
  });

  assert.equal(beat.visualTreatment, 'HYBRID');
  assert.equal(beat.materials.length, 4);
  assert.deepEqual(
    beat.materials.map((m) => m.materialSource),
    ['BROLL_LIBRARY', 'GENERATED_NEW', 'DETERMINISTIC_TEMPLATE', 'DETERMINISTIC_TEMPLATE']
  );
  assert.deepEqual(
    beat.materials.map((m) => m.visualTreatment),
    ['BROLL_CLIP', 'AI_VIDEO', 'MOTION_GRAPHIC', 'KINETIC_TYPOGRAPHY']
  );
  // ordering/layer information is preserved per material, exactly as required
  assert.deepEqual(beat.materials.map((m) => m.order), [0, 1, 2, 3]);
  assert.deepEqual(beat.materials.map((m) => m.role), ['PRIMARY', 'INSERT', 'OVERLAY', 'OVERLAY']);
  // no single material claims to BE 'HYBRID' — that value only ever
  // describes the beat's overall composition
  for (const m of beat.materials) {
    assert.notEqual(m.visualTreatment, 'HYBRID');
  }
});

test('6d. materials preserves insertion order — this schema records WHAT/ordering only, never HOW to composite', () => {
  const beat = createVisualBeat({
    materials: [
      createMaterialComponent({ order: 2 }),
      createMaterialComponent({ order: 0 }),
      createMaterialComponent({ order: 1 }),
    ],
  });
  // the array itself is insertion-ordered; `order` is a per-material field
  // a future Timeline Compiler reads — this schema does not sort for you
  assert.deepEqual(beat.materials.map((m) => m.order), [2, 0, 1]);
});

// --- 7. Provider neutrality -------------------------------------------------------------

test('7a. schemas/visual-beat-schema.js has no require() of any provider, generation, or approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'visual-beat-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate|google/i.test(req), `unexpected import: ${req}`);
  }
});

test('7b. schemas/visual-beat-schema.js never mentions a specific provider or model name as a literal field value', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'visual-beat-schema.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai', 'runway', 'kling', 'higgsfield']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference provider/model "${forbidden}"`);
  }
});

// --- 8. Shape discipline ------------------------------------------------------------------

test('8. schemas/visual-beat-schema.js does no file I/O — no fs/path/http requires', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'visual-beat-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto'], 'the only allowed require is crypto, for randomUUID');
});
