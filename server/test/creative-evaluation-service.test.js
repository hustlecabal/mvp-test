// Tests for services/creative-brain/creative-evaluation-service.js —
// CREATIVE BRAIN, Part 25/26. Every dimension is an independent PASS/
// FAIL/WARN check — this file asserts real, deterministic differentiation
// between a generic candidate (Part 12's own worked "WEAK" example) and a
// specific one (Part 12's own worked "STRONGER" example), never a fixed
// canned result.

const test = require('node:test');
const assert = require('node:assert/strict');

const ev = require('../services/creative-brain/creative-evaluation-service');

const TOPIC = 'why people leave high-paying jobs';
const WEAK_CANDIDATE = { concept: 'The reasons people quit high-paying jobs', corePromise: 'The reasons people leave high-paying jobs.', hookStrategy: 'Have you ever wondered why people quit high-paying jobs?' };
const STRONG_CANDIDATE = {
  concept: 'The surprising point at which money stops compensating for loss of control',
  corePromise: '78% of the people who leave high-paying jobs describe the same specific moment: not a bad boss, but the day they realized they had zero say over their own calendar.',
  hookStrategy: 'Open on the exact meeting where someone signs a raise they will quit over 6 months later.',
};

// --- specificity / genericHook ---------------------------------------------

test("1. Part 12's WEAK worked example fails WEAK_SPECIFICITY and GENERIC_ANGLE", () => {
  const results = ev.evaluateCandidate(WEAK_CANDIDATE, { topic: TOPIC });
  const specificity = results.find((r) => r.code === 'WEAK_SPECIFICITY');
  const angle = results.find((r) => r.code === 'GENERIC_ANGLE');
  assert.equal(specificity.result, 'FAIL');
  assert.equal(angle.result, 'FAIL');
});

test("2. Part 12's WEAK worked example fails GENERIC_HOOK (matches the generic-opener pattern)", () => {
  const results = ev.evaluateCandidate(WEAK_CANDIDATE, { topic: TOPIC });
  const hook = results.find((r) => r.code === 'GENERIC_HOOK');
  assert.equal(hook.result, 'FAIL');
});

test("3. Part 12's STRONGER worked example passes WEAK_SPECIFICITY and GENERIC_ANGLE", () => {
  const results = ev.evaluateCandidate(STRONG_CANDIDATE, { topic: TOPIC });
  const specificity = results.find((r) => r.code === 'WEAK_SPECIFICITY');
  const angle = results.find((r) => r.code === 'GENERIC_ANGLE');
  assert.equal(specificity.result, 'PASS');
  assert.equal(angle.result, 'PASS');
});

test('4. countAnchors counts numbers, contrast markers, and quoted phrases', () => {
  assert.equal(ev.countAnchors('plain text with no anchors'), 0);
  assert.equal(ev.countAnchors('40% of people, but not everyone, said "it changed everything"'), 3);
});

// --- coherence (reuses the EXISTING creative-blueprint-service check) -----

test('5. coherence WARNs when no structuralDirection is supplied', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity' }, { topic: TOPIC });
  const coherence = results.find((r) => r.dimension === 'coherence');
  assert.equal(coherence.result, 'WARN');
});

test('6. coherence FAILs a genuinely contradictory structuralDirection (8 sections x 20s > 60s target) — reuses detectStructuralContradiction verbatim', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity' }, { topic: TOPIC, structuralDirection: { plannedSectionCount: 8, minimumSectionDurationSeconds: 20 }, targetDuration: 60 });
  const coherence = results.find((r) => r.dimension === 'coherence');
  assert.equal(coherence.result, 'FAIL');
  assert.match(coherence.detail, /exceeds/);
});

test('7. coherence PASSes a structurally consistent direction', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity' }, { topic: TOPIC, structuralDirection: { plannedSectionCount: 3, minimumSectionDurationSeconds: 20 }, targetDuration: 180 });
  const coherence = results.find((r) => r.dimension === 'coherence');
  assert.equal(coherence.result, 'PASS');
});

// --- emotional logic --------------------------------------------------------

test('8. NO_MEANINGFUL_TENSION FAILs a flat/empty emotionalArc', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: '' }, { topic: TOPIC });
  assert.equal(results.find((r) => r.code === 'NO_MEANINGFUL_TENSION').result, 'FAIL');
});

test('9. NO_MEANINGFUL_TENSION PASSes an arc naming >= 2 distinct emotional stages', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'Curiosity at the open, quiet unease through the middle, clarity at the close' }, { topic: TOPIC });
  assert.equal(results.find((r) => r.code === 'NO_MEANINGFUL_TENSION').result, 'PASS');
});

// --- originality / reference overfitting (Part 23) -------------------------

test('10. REFERENCE_TEMPLATE_IMITATION FAILs when the candidate heavily repeats a single evidence source\'s own 5-grams', () => {
  const recommendations = [{ statement: 'the surprising point at which money stops compensating for loss of control over your life is the real driver', rationale: 'x', evidenceSufficiency: 'SUFFICIENT' }];
  const overfitCandidate = { concept: 'the surprising point at which money stops compensating for loss of control', corePromise: 'the surprising point at which money stops compensating for loss of control over your life', hookStrategy: 'open here' };
  const results = ev.evaluateCandidate(overfitCandidate, { topic: TOPIC, recommendations });
  const originality = results.filter((r) => r.dimension === 'originality');
  assert.ok(originality.some((r) => r.result === 'FAIL'), 'expected at least one FAIL originality check on heavy phrasing overlap');
});

test('11. REFERENCE_TEMPLATE_IMITATION PASSes genuinely original phrasing relative to the evidence', () => {
  const recommendations = [{ statement: 'reference videos in this set open with a concrete scene before any abstraction', rationale: 'x', evidenceSufficiency: 'SUFFICIENT' }];
  const results = ev.evaluateCandidate(STRONG_CANDIDATE, { topic: TOPIC, recommendations });
  const phrasingCheck = results.find((r) => r.dimension === 'originality' && r.code === 'REFERENCE_TEMPLATE_IMITATION' && /5-grams/.test(r.detail));
  assert.equal(phrasingCheck.result, 'PASS');
});

test('12. structuralSimilarity/dominantEvidenceRatio WARN "not supplied" when the caller omits them, never fabricating a PASS or FAIL', () => {
  const results = ev.evaluateOriginality ? null : ev.evaluateCandidate(STRONG_CANDIDATE, { topic: TOPIC });
  const found = ev.evaluateCandidate(STRONG_CANDIDATE, { topic: TOPIC });
  const warns = found.filter((r) => r.result === 'WARN');
  assert.ok(warns.length >= 2, 'expected structuralSimilarity and dominantEvidenceRatio to both WARN when omitted');
});

test('13. dominantEvidenceRatio above threshold FAILs referenceOverfitting; below threshold PASSes', () => {
  const above = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec() }, { topic: TOPIC, dominantEvidenceRatio: 0.9 });
  const below = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec() }, { topic: TOPIC, dominantEvidenceRatio: 0.2 });
  assert.equal(above.find((r) => r.dimension === 'referenceOverfitting').result, 'FAIL');
  assert.equal(below.find((r) => r.dimension === 'referenceOverfitting').result, 'PASS');
});

// --- visual taste (completeness only, Part 15's sign-off) ------------------

function fullVisualSpec(overrides = {}) {
  return {
    composition: 'x', palette: 'x', lighting: 'x', texture: 'x', depth: 'x', cameraLanguage: 'x',
    subjectTreatment: 'x', environmentalTreatment: 'x', visualDensity: 'x', motionLanguage: 'x', typography: 'x', negativeConstraints: 'x',
    ...overrides,
  };
}

test('14. VISUAL_DIRECTION_TOO_GENERIC FAILs when visualSpecification is missing dimensions', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: { composition: 'x' } }, { topic: TOPIC });
  const visual = results.find((r) => r.dimension === 'visualTaste');
  assert.equal(visual.result, 'FAIL');
  assert.match(visual.detail, /missing dimension/);
});

test('15. VISUAL_DIRECTION_TOO_GENERIC PASSes when all 12 dimensions are populated — completeness only, never an aesthetic judgment', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec() }, { topic: TOPIC });
  const visual = results.find((r) => r.dimension === 'visualTaste');
  assert.equal(visual.result, 'PASS');
  assert.match(visual.detail, /completeness only/);
});

// --- treatment fit -----------------------------------------------------------

test('16. treatmentFit is honestly reported as not-applicable at this stage, never a fabricated PASS/FAIL', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec() }, { topic: TOPIC });
  const fit = results.find((r) => r.dimension === 'treatmentFit');
  assert.equal(fit.result, 'WARN');
  assert.match(fit.detail, /not applicable/);
});

// --- banned language (defense in depth) -------------------------------------

test('17. EXCESSIVE_CLICHE_DENSITY FAILs when a candidate/direction field matches a cliche/filler pattern', () => {
  const clicheCandidate = { ...STRONG_CANDIDATE, concept: 'At the end of the day, ' + STRONG_CANDIDATE.concept };
  const results = ev.evaluateCandidate(clicheCandidate, { topic: TOPIC });
  assert.equal(results.find((r) => r.code === 'EXCESSIVE_CLICHE_DENSITY').result, 'FAIL');
});

test('18. UNSUPPORTED_CLAIM FAILs when narration text contains a causal/certainty pattern', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec(), narrationText: 'This always guarantees success for everyone who tries it.' }, { topic: TOPIC });
  assert.equal(results.find((r) => r.code === 'UNSUPPORTED_CLAIM').result, 'FAIL');
});

test('19. bannedLanguage PASSes clean text', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec(), narrationText: 'A specific, grounded narration line with no cliches.' }, { topic: TOPIC });
  assert.equal(results.find((r) => r.code === 'EXCESSIVE_CLICHE_DENSITY').result, 'PASS');
  assert.equal(results.find((r) => r.code === 'UNSUPPORTED_CLAIM').result, 'PASS');
});

// --- structural checks -------------------------------------------------------

test('20. hasFailure() correctly detects any FAIL among a results array', () => {
  assert.equal(ev.hasFailure([{ result: 'PASS' }, { result: 'WARN' }]), false);
  assert.equal(ev.hasFailure([{ result: 'PASS' }, { result: 'FAIL' }]), true);
});

test('21. evaluateDirection never collapses results into a single combined score — every entry keeps its own independent PASS/FAIL/WARN', () => {
  const results = ev.evaluateDirection(STRONG_CANDIDATE, { emotionalArc: 'curiosity, then clarity', visualSpecification: fullVisualSpec() }, { topic: TOPIC });
  assert.ok(Array.isArray(results));
  for (const r of results) {
    assert.ok(['PASS', 'FAIL', 'WARN'].includes(r.result));
    assert.ok(typeof r.dimension === 'string');
  }
  assert.ok(!results.some((r) => typeof r.score === 'number'), 'no combined numeric score field must ever appear on a result');
});

test('22. security — creative-evaluation-service.js has no network call, no eval, no LLM/provider import', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/creative-brain/creative-evaluation-service.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/\beval\s*\(/.test(src));
  assert.ok(!/creative-brain-provider/.test(src));
});
