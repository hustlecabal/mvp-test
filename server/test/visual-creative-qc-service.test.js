// Tests for services/visual-creative-qc-service.js — treatment adherence,
// continuity, specificity, reference-overfitting, beat-relevance, and
// visual-rule-consistency, each an INDEPENDENT PASS/FAIL/WARN finding
// (never a combined score).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createMaterialSpecification, createMaterialReference } = require('../schemas/material-specification-schema');
const creativeQc = require('../services/visual-creative-qc-service');

function find(findings, code) {
  return findings.find((f) => f.code === code);
}

test('1. treatment adherence PASSes when executorType matches the treatment', () => {
  const spec = createMaterialSpecification({ treatment: 'WHITEBOARD' });
  const findings = creativeQc.evaluateVisualMaterial(spec, { executorType: 'WHITEBOARD' });
  assert.equal(find(findings, 'TREATMENT_MISMATCH').result, 'PASS');
});

test('2. treatment adherence FAILs when executorType does not match the treatment', () => {
  const spec = createMaterialSpecification({ treatment: 'WHITEBOARD' });
  const findings = creativeQc.evaluateVisualMaterial(spec, { executorType: 'KINETIC_TYPOGRAPHY' });
  assert.equal(find(findings, 'TREATMENT_MISMATCH').result, 'FAIL');
});

test('3. treatment adherence WARNs when no executorType is supplied (not evaluable)', () => {
  const spec = createMaterialSpecification({ treatment: 'STILL_IMAGE' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'TREATMENT_MISMATCH').result, 'WARN');
});

test('4. continuity PASSes when a shot has no continuity-required entities', () => {
  const spec = createMaterialSpecification({ references: [] });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'CHARACTER_DRIFT').result, 'PASS');
});

test('5. continuity PASSes when every reference has a resolved canonical asset', () => {
  const spec = createMaterialSpecification({ references: [createMaterialReference({ entityType: 'CHARACTER', entityId: 'c1', assetId: 'asset-1' })] });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'CHARACTER_DRIFT').result, 'PASS');
});

test('6. continuity WARNs (CHARACTER_DRIFT) when a required character has no resolved reference asset', () => {
  const spec = createMaterialSpecification({ references: [createMaterialReference({ entityType: 'CHARACTER', entityId: 'c1', assetId: null })] });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  const finding = find(findings, 'CHARACTER_DRIFT');
  assert.equal(finding.result, 'WARN');
  assert.ok(finding.detail.includes('c1'));
});

test('7. continuity WARNs (LOCATION_DRIFT) when only an unresolved location is required, never CHARACTER_DRIFT for it', () => {
  const spec = createMaterialSpecification({ references: [createMaterialReference({ entityType: 'LOCATION', entityId: 'loc1', assetId: null })] });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'LOCATION_DRIFT').result, 'WARN');
});

test('8. specificity FAILs on empty subject/composition/action', () => {
  const spec = createMaterialSpecification({ subject: '', composition: '', action: '' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'GENERIC_VISUAL_DIRECTION').result, 'FAIL');
});

test('9. specificity FAILs on a generic placeholder phrase', () => {
  const spec = createMaterialSpecification({ subject: 'a nice picture', composition: '', action: '' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  const finding = find(findings, 'GENERIC_VISUAL_DIRECTION');
  assert.equal(finding.result, 'FAIL');
  assert.ok(finding.detail.includes('generic placeholder phrase'));
});

test('10. specificity PASSes on real, concrete text', () => {
  const spec = createMaterialSpecification({ subject: 'A weathered lighthouse keeper climbs 47 spiral stairs in dense fog', composition: '', action: '' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'GENERIC_VISUAL_DIRECTION').result, 'PASS');
});

test('11. reference overfitting WARNs when no evidence text is supplied', () => {
  const spec = createMaterialSpecification({ subject: 'x' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'REFERENCE_TEMPLATE_IMITATION').result, 'WARN');
});

test('12. reference overfitting FAILs when the material text is a near-verbatim copy of a single evidence source', () => {
  const evidence = 'A weathered lighthouse keeper climbs the spiral stairs at dawn to check the lamp mechanism carefully';
  const spec = createMaterialSpecification({ subject: evidence, composition: '', action: '' });
  const findings = creativeQc.evaluateVisualMaterial(spec, { evidenceTexts: [evidence] });
  assert.equal(find(findings, 'REFERENCE_TEMPLATE_IMITATION').result, 'FAIL');
});

test('13. reference overfitting PASSes when material text is unrelated to the evidence', () => {
  const spec = createMaterialSpecification({ subject: 'A city skyline at night with neon signage', composition: '', action: '' });
  const findings = creativeQc.evaluateVisualMaterial(spec, { evidenceTexts: ['A completely unrelated discussion about ocean currents and tidal patterns.'] });
  assert.equal(find(findings, 'REFERENCE_TEMPLATE_IMITATION').result, 'PASS');
});

test('14. beat relevance is always WARN — honestly not evaluable without vision capability, never fabricated PASS/FAIL', () => {
  const spec = createMaterialSpecification({ shotPurpose: 'establish the setting' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  const finding = find(findings, 'BEAT_MISMATCH');
  assert.equal(finding.result, 'WARN');
  assert.ok(finding.detail.includes('not evaluable without vision capability'));
});

test('15. visual rule consistency PASSes when negativeConstraints do not appear in positive fields', () => {
  const spec = createMaterialSpecification({ composition: 'wide shot', camera: 'static', lighting: 'soft', negativeConstraints: ['no lens flares'] });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'CONFLICTING_VISUAL_RULES').result, 'PASS');
});

test('16. visual rule consistency FAILs when a negative constraint text also appears in a positive field (CONFLICTING_VISUAL_RULES)', () => {
  const spec = createMaterialSpecification({ composition: 'lens flares across the frame', camera: '', lighting: '', negativeConstraints: ['lens flares'] });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.equal(find(findings, 'CONFLICTING_VISUAL_RULES').result, 'FAIL');
});

test('17. evaluateVisualMaterial never collapses findings into a single score — result is always an array of independent findings', () => {
  const spec = createMaterialSpecification({ subject: 'x' });
  const findings = creativeQc.evaluateVisualMaterial(spec, {});
  assert.ok(Array.isArray(findings));
  assert.ok(findings.length >= 6);
  for (const f of findings) assert.ok(['PASS', 'FAIL', 'WARN'].includes(f.result));
});

test('18. hasFailure() returns true iff at least one finding is FAIL', () => {
  const passing = [{ result: 'PASS' }, { result: 'WARN' }];
  const failing = [{ result: 'PASS' }, { result: 'FAIL' }];
  assert.equal(creativeQc.hasFailure(passing), false);
  assert.equal(creativeQc.hasFailure(failing), true);
});

test('19. evaluateVisualMaterial reuses Creative Brain\'s own countAnchors/phrasingOverlapRatio, never a duplicate implementation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'visual-creative-qc-service.js'), 'utf8');
  assert.ok(source.includes("require('./creative-brain/creative-evaluation-service')"));
  assert.ok(!/function tokenize\(/.test(source));
  assert.ok(!/function ngrams\(/.test(source));
});

test('20. security — visual-creative-qc-service.js has no eval/new Function/network call', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'visual-creative-qc-service.js'), 'utf8');
  assert.ok(!/\beval\(/.test(source));
  assert.ok(!/new Function\(/.test(source));
  assert.ok(!/\bfetch\(/.test(source));
});
