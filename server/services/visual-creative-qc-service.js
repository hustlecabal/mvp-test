// visual-creative-qc-service.js
//
// VISUAL WORLD, Parts 19-22 — CREATIVE QC, structurally separate from
// TECHNICAL QC (services/visual-technical-qc-service.js — "is this a
// valid file" vs this file's "does it express the intended beat").
//
// Every dimension is an independent PASS/FAIL/WARN check (Part 19's own
// explicit instruction: never collapse into "visual quality = 87" — the
// EXACT same discipline this codebase already locked for Creative Brain's
// own evaluation layer). REUSES rather than duplicates: countAnchors()
// and phrasingOverlapRatio() are the SAME functions services/creative-
// brain/creative-evaluation-service.js already exports and uses for its
// own specificity/originality checks — this file applies them to visual
// MaterialSpecification text instead of Creative Angle text, never
// reimplementing the algorithm a second time.
//
// PART 22'S OWN WARNING, honored structurally: this file has NO vision
// model access (no ANTHROPIC_API_KEY in any environment this stage could
// verify against) — every check here is a STRUCTURAL/COMPLETENESS check
// against the MaterialSpecification and its resolved references, never a
// judgment about actual pixel content. A check that would require looking
// at the image (does it "look generic," does it "resemble the reference
// too closely") is out of scope for this file and reported as WARN with
// an honest "not evaluable without vision capability" detail — never
// silently skipped, never claimed as PASS.

const { countAnchors, phrasingOverlapRatio } = require('./creative-brain/creative-evaluation-service');

const PHRASING_OVERLAP_THRESHOLD = 0.4; // same threshold Creative Brain's own originality check uses
const MIN_SPECIFICITY_ANCHORS = 1;

function finding(dimension, code, res, detail) {
  return { dimension, code, result: res, detail };
}

// --- Dimension 1: Treatment adherence -----------------------------------
function evaluateTreatmentAdherence(materialSpec, executorType) {
  if (!executorType) return [finding('treatmentAdherence', 'TREATMENT_MISMATCH', 'WARN', 'no execution result supplied — not evaluable')];
  const expected = { STILL_IMAGE: ['GENERATED_NEW_STILL_IMAGE', 'STILL_IMAGE_MOTION', 'PROJECT_ASSET_REUSE'], AI_VIDEO: ['GENERATED_NEW_VIDEO', 'PROJECT_ASSET_REUSE'], BROLL_CLIP: ['BROLL_CLIP', 'PROJECT_ASSET_REUSE'], MOTION_GRAPHIC: ['MOTION_GRAPHIC'], KINETIC_TYPOGRAPHY: ['KINETIC_TYPOGRAPHY'], WHITEBOARD: ['WHITEBOARD'] };
  const allowed = expected[materialSpec.treatment] || [];
  const ok = allowed.includes(executorType);
  return [finding('treatmentAdherence', 'TREATMENT_MISMATCH', ok ? 'PASS' : 'FAIL', `treatment "${materialSpec.treatment}" executed via "${executorType}" (expected one of: ${allowed.join(', ') || 'none known'})`)];
}

// --- Dimension 2: Continuity linkage (Part 14/21 CHARACTER_DRIFT/LOCATION_DRIFT signal) ---
function evaluateContinuity(materialSpec) {
  if (materialSpec.references.length === 0) {
    return [finding('continuity', 'CHARACTER_DRIFT', 'PASS', 'no continuity-required entities for this shot')];
  }
  const unresolved = materialSpec.references.filter((r) => !r.assetId);
  if (unresolved.length === 0) {
    return [finding('continuity', 'CHARACTER_DRIFT', 'PASS', `all ${materialSpec.references.length} continuity-required entit(y/ies) have a resolved canonical reference asset`)];
  }
  const code = unresolved.some((r) => r.entityType === 'LOCATION') && !unresolved.some((r) => r.entityType === 'CHARACTER') ? 'LOCATION_DRIFT' : 'CHARACTER_DRIFT';
  return [finding('continuity', code, 'WARN', `${unresolved.length} of ${materialSpec.references.length} continuity-required entit(y/ies) have no resolved canonical reference asset yet — generation proceeded without a locked appearance for: ${unresolved.map((r) => `${r.entityType}:${r.entityId}`).join(', ')}`)];
}

// --- Dimension 3: Specificity / genericness (Part 21 GENERIC_VISUAL_DIRECTION) ---
function evaluateSpecificity(materialSpec) {
  const combined = `${materialSpec.subject} ${materialSpec.composition} ${materialSpec.action}`.trim();
  if (combined.length === 0) return [finding('specificity', 'GENERIC_VISUAL_DIRECTION', 'FAIL', 'subject/composition/action are all empty')];
  const anchors = countAnchors(combined);
  const genericPhrases = ['a cinematic shot', 'an image of', 'a picture of', 'a nice picture', 'a beautiful scene', 'something interesting'];
  const lower = combined.toLowerCase();
  const genericHit = genericPhrases.find((p) => lower === p || lower.startsWith(`${p} `));
  if (genericHit) return [finding('specificity', 'GENERIC_VISUAL_DIRECTION', 'FAIL', `matches a generic placeholder phrase: "${genericHit}"`)];
  return [finding('specificity', 'GENERIC_VISUAL_DIRECTION', anchors >= MIN_SPECIFICITY_ANCHORS || combined.split(/\s+/).length >= 4 ? 'PASS' : 'WARN', `${anchors} concrete anchor(s), ${combined.split(/\s+/).length} word(s) of subject/composition/action text`)];
}

// --- Dimension 4: Reference overfitting (Part 13/21 REFERENCE_TEMPLATE_IMITATION) ---
// evidenceTexts — raw text this shot's visual decision was derived from
// (e.g. the source Recommendation statements a Blueprint's provenance
// traces back to). Reuses Creative Brain's own phrasingOverlapRatio() —
// never a second n-gram implementation.
function evaluateReferenceOverfitting(materialSpec, { evidenceTexts = [] } = {}) {
  if (evidenceTexts.length === 0) {
    return [finding('referenceOverfitting', 'REFERENCE_TEMPLATE_IMITATION', 'WARN', 'no evidence text supplied to compare against — not evaluable')];
  }
  const candidateText = `${materialSpec.subject} ${materialSpec.composition} ${materialSpec.action}`;
  const ratio = phrasingOverlapRatio(candidateText, evidenceTexts);
  return [finding('referenceOverfitting', 'REFERENCE_TEMPLATE_IMITATION', ratio <= PHRASING_OVERLAP_THRESHOLD ? 'PASS' : 'FAIL', `${Math.round(ratio * 100)}% 5-gram overlap with a single evidence source (threshold ${Math.round(PHRASING_OVERLAP_THRESHOLD * 100)}%)`)];
}

// --- Dimension 5: Beat relevance (Part 25) — inherently a semantic
// question this codebase cannot answer without vision/language judgment
// on the actual rendered content; reported honestly as WARN, never a
// fabricated PASS/FAIL (Part 21 — "some must be WARN... if confidence is
// low"). ---
function evaluateBeatRelevance(materialSpec) {
  if (!materialSpec.shotPurpose) return [finding('beatRelevance', 'BEAT_MISMATCH', 'WARN', 'no shotPurpose to compare against')];
  return [finding('beatRelevance', 'BEAT_MISMATCH', 'WARN', 'beat-relevance requires visual/semantic judgment of the actual rendered content — not evaluable without vision capability in this environment')];
}

// --- Dimension 6: Internal consistency of visual rules (Part 21 CONFLICTING_VISUAL_RULES) ---
function evaluateVisualRuleConsistency(materialSpec) {
  if (materialSpec.negativeConstraints.length === 0) return [finding('visualRuleConsistency', 'CONFLICTING_VISUAL_RULES', 'PASS', 'no negativeConstraints to conflict with')];
  const positiveText = `${materialSpec.composition} ${materialSpec.camera} ${materialSpec.lighting}`.toLowerCase();
  const conflicts = materialSpec.negativeConstraints.filter((c) => typeof c === 'string' && c.trim().length > 0 && positiveText.includes(c.toLowerCase().trim()));
  return [finding('visualRuleConsistency', 'CONFLICTING_VISUAL_RULES', conflicts.length === 0 ? 'PASS' : 'FAIL', conflicts.length === 0 ? 'no negative constraint text also appears in the positive composition/camera/lighting fields' : `negative constraint(s) also appear in positive fields: ${conflicts.join(', ')}`)];
}

// Public entry point — evaluates ONE shot's MaterialSpecification against
// its (optional) execution result and (optional) evidence text. Never
// mutates anything, never calls a provider, never talks to approval-gate.js.
function evaluateVisualMaterial(materialSpec, { executorType = null, evidenceTexts = [] } = {}) {
  return [
    ...evaluateTreatmentAdherence(materialSpec, executorType),
    ...evaluateContinuity(materialSpec),
    ...evaluateSpecificity(materialSpec),
    ...evaluateReferenceOverfitting(materialSpec, { evidenceTexts }),
    ...evaluateBeatRelevance(materialSpec),
    ...evaluateVisualRuleConsistency(materialSpec),
  ];
}

function hasFailure(findings) {
  return findings.some((f) => f.result === 'FAIL');
}

module.exports = { evaluateVisualMaterial, hasFailure };
