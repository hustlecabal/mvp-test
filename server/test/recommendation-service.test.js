// Tests for services/recommendation-service.js — INT-1F Part 19's full
// deterministic test list. Every test builds its own synthetic, real
// Pattern/PatternSet records via schemas/cross-video-pattern-schema.js's
// own factories and persists them through services/cross-video-pattern-
// store.js — this file never fabricates a Recommendation directly and
// never bypasses generateRecommendations()'s own translation path. The
// real 3-video corpus proof (Part 20) lives in a separate, temporary,
// non-committed script (see the INT-1F final report) since these unit
// tests need fast, controllable, deterministic Pattern fixtures instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [envVar, prefix] of [
  ['PROJECT_DATA_DIR', 'evolink-recsvc-projects-'],
  ['CROSS_VIDEO_PATTERN_DATA_DIR', 'evolink-recsvc-patterns-'],
  ['RECOMMENDATION_DATA_DIR', 'evolink-recsvc-recs-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const patternStore = require('../services/cross-video-pattern-store');
const recommendationStore = require('../services/recommendation-store');
const recSvc = require('../services/recommendation-service');
const { createPattern, createPatternSet, createHomogeneityReport, createPatternDiagnostic } = require('../schemas/cross-video-pattern-schema');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function persistPatternSet(projectId, referenceSetId, patterns, overrides = {}) {
  const patternSet = createPatternSet({ projectId, referenceSetId, patterns, status: 'COMPLETE', ...overrides });
  const saved = patternStore.addPatternSet(projectId, patternSet);
  return saved.patternSet;
}

const RECURRING_MET = () =>
  createPattern({
    type: 'RECURRING_OBSERVATION',
    category: 'OPENING',
    ruleId: 'OPENING_QUESTION_DETECTED',
    statement: '"OPENING_QUESTION_DETECTED" was detected in 5 of 5 reference video(s) in this set (100%).',
    prevalence: { supportingCount: 5, totalCount: 5, percentage: 100 },
    support: [{ referenceVideoId: 'rv-1', observationId: 'obs-1' }, { referenceVideoId: 'rv-2', observationId: 'obs-2' }, { referenceVideoId: 'rv-3', observationId: 'obs-3' }],
    confidence: 'MEDIUM',
    meetsMinimumEvidenceThreshold: true,
    limitations: [],
  });

const NUMERIC_MET = () =>
  createPattern({
    type: 'NUMERIC_DISTRIBUTION',
    category: 'SHOT_RHYTHM',
    metric: 'shotsPerMinute',
    statement: 'Across 5 of 5 reference video(s) with a measured value, "shotsPerMinute" has median 4.000 shots_per_minute (mean 4.200, range 3.000-5.000).',
    prevalence: { supportingCount: 5, totalCount: 5, percentage: 100 },
    distribution: { count: 5, mean: 4.2, median: 4.0, min: 3.0, max: 5.0, p25: 3.5, p75: 4.5, p90: 4.9, stdDev: 0.7 },
    support: [{ referenceVideoId: 'rv-1', measurementsId: 'm-1', value: 4.0 }],
    confidence: 'LOW',
    meetsMinimumEvidenceThreshold: true,
    limitations: [],
  });

const CO_OCCURRENCE_MET = () =>
  createPattern({
    type: 'CO_OCCURRENCE',
    category: 'CO_OCCURRENCE',
    statement: '"RULE_A" and "RULE_B" co-occur in 5 of 5 reference video(s) (100%). This is a joint-frequency count, not evidence that either influences or causes the other.',
    prevalence: { supportingCount: 5, totalCount: 5, percentage: 100 },
    coOccurrence: { ruleIdA: 'RULE_A', ruleIdB: 'RULE_B', categoryA: 'OPENING', categoryB: 'SILENCE' },
    support: [{ referenceVideoId: 'rv-1' }, { referenceVideoId: 'rv-2' }],
    confidence: 'MEDIUM',
    meetsMinimumEvidenceThreshold: true,
    limitations: ['Co-occurrence describes joint frequency only; it is not evidence of a causal or influential relationship (Part 13).'],
  });

const OUTLIER_PATTERN = () =>
  createPattern({
    type: 'OUTLIER',
    category: 'VISUAL_CHANGE',
    metric: 'frameDifferenceMean',
    statement: 'Reference video rv-9 has "frameDifferenceMean" = 5.000, a statistical outlier relative to this set\'s median (1.000).',
    prevalence: { supportingCount: 1, totalCount: 5, percentage: 20 },
    outlier: { referenceVideoId: 'rv-9', metric: 'frameDifferenceMean', value: 5.0, medianValue: 1.0, deviation: 4.0 },
    support: [{ referenceVideoId: 'rv-9', value: 5.0 }],
    confidence: 'LOW',
    meetsMinimumEvidenceThreshold: false,
    limitations: ['A single-video outlier is inherently below the minimum evidence threshold for a recurring pattern — recorded for visibility, not as a recurring behavior.'],
  });

const RECURRING_BELOW_THRESHOLD = () =>
  createPattern({
    type: 'RECURRING_OBSERVATION',
    category: 'OPENING',
    ruleId: 'OPENING_QUESTION_DETECTED',
    statement: '"OPENING_QUESTION_DETECTED" was detected in 2 of 5 reference video(s) in this set (40%).',
    prevalence: { supportingCount: 2, totalCount: 5, percentage: 40 },
    support: [{ referenceVideoId: 'rv-1' }, { referenceVideoId: 'rv-2' }],
    confidence: 'LOW',
    meetsMinimumEvidenceThreshold: false,
    limitations: ['Supported by only 2 of 5 video(s) (40%) — below this stage\'s minimum evidence threshold.'],
  });

// --- 1. valid recommendation from a qualifying pattern ---

test('1. a RECURRING_OBSERVATION pattern that meets the minimum evidence threshold produces a SUFFICIENT, actionable recommendation', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.status, 'COMPLETE');
  assert.equal(set.recommendations.length, 1);
  const rec = set.recommendations[0];
  assert.equal(rec.recommendationType, 'RECURRING_PATTERN_APPLICATION');
  assert.equal(rec.evidenceSufficiency, 'SUFFICIENT');
  assert.ok(rec.action);
  assert.notEqual(rec.statement, rec.rationale); // Part 2 — never collapsed into one sentence
  assert.notEqual(rec.rationale, rec.action);
});

// --- 2. insufficient evidence ---

test('2. a pattern below the minimum evidence threshold produces a CAUTION recommendation with no action, never a normal one', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_BELOW_THRESHOLD()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.equal(rec.recommendationType, 'CAUTION');
  assert.equal(rec.evidenceSufficiency, 'INSUFFICIENT_EVIDENCE');
  assert.equal(rec.action, null);
  assert.match(rec.statement, /2 of 5/);
});

// --- 3/4. LOW / MEDIUM confidence ---

test('3. a LOW-confidence source pattern produces a LOW-confidence recommendation, never upgraded', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [NUMERIC_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.recommendations[0].confidence, 'LOW');
});

test('4. a MEDIUM-confidence source pattern produces a MEDIUM-confidence recommendation', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.recommendations[0].confidence, 'MEDIUM');
});

// --- 5. contradictory / split patterns ---

test('5. a pattern with less than 100% prevalence never has its recommendation claim universal application', () => {
  const project = newProject();
  const split = createPattern({
    type: 'RECURRING_OBSERVATION',
    category: 'OPENING',
    ruleId: 'OPENING_QUESTION_DETECTED',
    statement: '"OPENING_QUESTION_DETECTED" was detected in 6 of 10 reference video(s) in this set (60%).',
    prevalence: { supportingCount: 6, totalCount: 10, percentage: 60 },
    support: Array.from({ length: 6 }, (_, i) => ({ referenceVideoId: `rv-${i}` })),
    confidence: 'MEDIUM',
    meetsMinimumEvidenceThreshold: true,
    limitations: [],
  });
  persistPatternSet(project.id, 'rs1', [split]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.match(rec.rationale, /6 of 10/);
  assert.doesNotMatch(rec.action, /\ball videos\b/i);
  assert.doesNotMatch(rec.action, /\bevery video\b/i);
  assert.match(rec.action, /^Consider/); // conditional framing, never a bare directive
});

// --- 6. co-occurrence recommendation ---

test('6. a CO_OCCURRENCE pattern produces a CO_OCCURRENCE_APPLICATION recommendation with derivationType CO_OCCURRENCE_PATTERN and a causation disclaimer preserved', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [CO_OCCURRENCE_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.equal(rec.recommendationType, 'CO_OCCURRENCE_APPLICATION');
  assert.equal(rec.derivationType, 'CO_OCCURRENCE_PATTERN');
  assert.match(rec.rationale, /not evidence that either influences or causes the other/);
  assert.ok(rec.limitations.some((l) => /not evidence of a causal or influential relationship/.test(l)));
});

// --- 7. outlier recommendation ---

test('7. an OUTLIER pattern produces an ALTERNATIVE_STRATEGY recommendation, SUFFICIENT (not blocked), even though meetsMinimumEvidenceThreshold is false', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [OUTLIER_PATTERN()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.equal(rec.recommendationType, 'ALTERNATIVE_STRATEGY');
  assert.equal(rec.evidenceSufficiency, 'SUFFICIENT');
  assert.equal(rec.meetsMinimumEvidenceThreshold, false); // verbatim from the pattern — never re-derived
  assert.ok(rec.action);
});

// --- 8. heterogeneous reference set ---

test('8. a PatternSet with homogeneityReport warnings carries those warnings forward into every recommendation\'s limitations[]', () => {
  const project = newProject();
  const homogeneityReport = createHomogeneityReport({ warnings: [createPatternDiagnostic({ code: 'HETEROGENEOUS_REFERENCE_SET', message: 'duration coefficient of variation (0.62) exceeds 0.5' })] });
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()], { homogeneityReport });
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.ok(rec.limitations.some((l) => /duration coefficient of variation/.test(l)));
});

// --- 9. missing provenance / 10. invalid pattern ---

test('9. a pattern with a malformed support[] (not an array) is rejected structurally, never silently accepted', () => {
  const project = newProject();
  const broken = RECURRING_MET();
  broken.support = 'not-an-array';
  // createPatternSet()/createPattern() would silently NORMALIZE a non-array
  // support back to [] (the schema's own factory guarantees the invariant
  // by construction) — bypass that factory entirely via a direct store
  // write so this test genuinely exercises validateSourcePattern()'s own
  // defense-in-depth check against a truly malformed, hand-built record.
  patternStore.addPatternSet(project.id, { id: 'ps-broken', projectId: project.id, referenceSetId: 'rs1', patterns: [broken], homogeneityReport: null, status: 'COMPLETE', diagnostics: [], createdAt: new Date().toISOString() });
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.recommendations.length, 0);
  assert.equal(set.status, 'FAILED');
  assert.ok(set.diagnostics.some((d) => d.code === 'INVALID_SOURCE_PATTERN'));
});

test('10. an invalid Pattern (unrecognized type) is rejected, and valid patterns in the same set are still translated (PARTIAL, not all-or-nothing)', () => {
  const project = newProject();
  const broken = RECURRING_MET();
  broken.type = 'NOT_A_REAL_TYPE';
  persistPatternSet(project.id, 'rs1', [broken, NUMERIC_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.status, 'PARTIAL');
  assert.equal(set.recommendations.length, 1);
  assert.ok(set.diagnostics.some((d) => d.code === 'INVALID_SOURCE_PATTERN'));
});

test('10b. validateSourcePattern rejects a pattern claiming a banned outcome-vocabulary category', () => {
  const project = newProject();
  const bannedCategory = RECURRING_MET();
  bannedCategory.category = 'VIRALITY';
  persistPatternSet(project.id, 'rs1', [bannedCategory]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.recommendations.length, 0);
  assert.ok(set.diagnostics.some((d) => d.code === 'INVALID_SOURCE_PATTERN' && /banned outcome-vocabulary/.test(d.message)));
});

// --- 11/12. unsupported causal / certainty language ---

test('11. containsUnsupportedLanguage rejects an affirmative causal claim but not the co-occurrence disclaimer sentence itself', () => {
  assert.equal(recSvc.containsUnsupportedLanguage('This causes more views.'), 'an unsupported causal claim');
  assert.equal(recSvc.containsUnsupportedLanguage('X increases retention among viewers.'), 'an unsupported causal claim');
  assert.equal(recSvc.containsUnsupportedLanguage('"A" and "B" co-occur. This is a joint-frequency count, not evidence that either influences or causes the other.'), null);
});

test('12. containsUnsupportedLanguage rejects unsupported certainty language', () => {
  assert.equal(recSvc.containsUnsupportedLanguage('This always works.'), 'an unsupported certainty claim');
  assert.equal(recSvc.containsUnsupportedLanguage('Proven to work every time.'), 'an unsupported certainty claim');
  assert.equal(recSvc.containsUnsupportedLanguage('The secret is consistency.'), 'an unsupported certainty claim');
  assert.equal(recSvc.containsUnsupportedLanguage('This guarantees success.'), 'an unsupported certainty claim');
});

test('12b. containsUnsupportedLanguage rejects outcome/quality judgment vocabulary', () => {
  assert.equal(recSvc.containsUnsupportedLanguage('This makes videos go viral.'), 'an unsupported outcome/quality judgment');
  assert.equal(recSvc.containsUnsupportedLanguage('A high engagement score.'), 'an unsupported outcome/quality judgment');
});

// --- 13-16. human review decisions ---

test('13. human ACCEPT on a SUFFICIENT recommendation succeeds and sets status ACCEPTED', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'ACCEPT', reviewedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.status, 'ACCEPTED');
});

test('13b. human ACCEPT on an INSUFFICIENT_EVIDENCE recommendation is structurally blocked (Part 5)', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_BELOW_THRESHOLD()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'ACCEPT', reviewedBy: 'human1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /INSUFFICIENT_EVIDENCE/);
});

test('14. human REJECT sets status REJECTED', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'REJECT', reviewedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.status, 'REJECTED');
});

test('15. human EDIT creates a NEW ACCEPTED recommendation, marks the original SUPERSEDED, and never overwrites the original\'s content', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const original = set.recommendations[0];
  const result = recSvc.reviewRecommendation(project.id, set.id, original.id, { decision: 'EDIT', reviewedBy: 'human1', editedAction: 'Use a provocative question rather than a generic question.' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.status, 'ACCEPTED');
  assert.equal(result.recommendation.action, 'Use a provocative question rather than a generic question.');
  assert.equal(result.recommendation.supersedesRecommendationId, original.id);
  assert.equal(result.original.status, 'SUPERSEDED');
  assert.equal(result.original.action, original.action); // never overwritten in place
  assert.equal(result.original.reviews[0].resultingRecommendationId, result.recommendation.id);
});

test('15b. EDIT is rejected if the edited text itself contains banned language, even from a human', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'EDIT', reviewedBy: 'human1', editedAction: 'This causes viewers to keep watching.' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /causal claim/);
});

test('15c. EDIT on an INSUFFICIENT_EVIDENCE recommendation is blocked — editing is not a backdoor around Part 5', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_BELOW_THRESHOLD()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'EDIT', reviewedBy: 'human1', editedStatement: 'edited' });
  assert.equal(result.ok, false);
});

test('16. human REQUEST_ALTERNATIVE sets status NEEDS_ALTERNATIVE without creating a new record', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'REQUEST_ALTERNATIVE', reviewedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.status, 'NEEDS_ALTERNATIVE');
  assert.equal(recommendationStore.getRecommendationSet(project.id, set.id).recommendations.length, 1);
});

test('16b. human FLAG sets status FLAGGED', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const result = recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'FLAG', reviewedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.status, 'FLAGGED');
});

test('16c. reviewRecommendation rejects an unrecognized decision and a non-existent recommendation/set', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'NOT_REAL' }).ok, false);
  assert.equal(recSvc.reviewRecommendation(project.id, '11111111-1111-4111-8111-111111111111', set.recommendations[0].id, { decision: 'ACCEPT' }).ok, false);
  assert.equal(recSvc.reviewRecommendation(project.id, set.id, '11111111-1111-4111-8111-111111111111', { decision: 'ACCEPT' }).ok, false);
});

// --- 17. immutable machine fields ---

test('17. ACCEPT/REJECT/FLAG never touch statement/rationale/action/prevalence/confidence — only status/reviews[]', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const before = { ...set.recommendations[0] };
  recSvc.reviewRecommendation(project.id, set.id, set.recommendations[0].id, { decision: 'ACCEPT', reviewedBy: 'human1' });
  const after = recommendationStore.getRecommendationSet(project.id, set.id).recommendations[0];
  assert.equal(after.statement, before.statement);
  assert.equal(after.rationale, before.rationale);
  assert.equal(after.action, before.action);
  assert.deepEqual(after.prevalence, before.prevalence);
  assert.equal(after.confidence, before.confidence);
});

// --- 18. deterministic generation ---

test('18. identical PatternSet input produces identical recommendation semantics on repeated generation (excluding id/createdAt)', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET(), NUMERIC_MET(), CO_OCCURRENCE_MET(), OUTLIER_PATTERN(), RECURRING_BELOW_THRESHOLD()]);
  const first = recSvc.generateRecommendations(project.id, 'rs1');
  const second = recSvc.generateRecommendations(project.id, 'rs1');
  const normalize = (recs) =>
    recs
      .map((r) => ({ recommendationType: r.recommendationType, derivationType: r.derivationType, category: r.category, statement: r.statement, rationale: r.rationale, action: r.action, confidence: r.confidence, evidenceSufficiency: r.evidenceSufficiency, meetsMinimumEvidenceThreshold: r.meetsMinimumEvidenceThreshold }))
      .sort((a, b) => a.statement.localeCompare(b.statement));
  assert.deepEqual(normalize(first.recommendations), normalize(second.recommendations));
});

// --- 19. repeated generation / idempotency / data safety ---

test('19. repeated generation never mutates the source PatternSet and never duplicates it — only appends a new RecommendationSet', () => {
  const project = newProject();
  const patternSet = persistPatternSet(project.id, 'rs1', [RECURRING_MET()]);
  const before = JSON.stringify(patternStore.getPatternSet(project.id, patternSet.id));
  recSvc.generateRecommendations(project.id, 'rs1');
  recSvc.generateRecommendations(project.id, 'rs1');
  const after = JSON.stringify(patternStore.getPatternSet(project.id, patternSet.id));
  assert.equal(before, after);
  assert.equal(patternStore.listPatternSets(project.id).length, 1);
  assert.equal(recommendationStore.listRecommendationSets(project.id).length, 2);
});

// --- 20. no LLM dependency / security ---

test('20. recommendation-service.js and recommendation-math.js make no network/shell/eval call and import no LLM/interpretation provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'recommendation-service.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /\beval\(/);
  assert.doesNotMatch(source, /new Function\(/);
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)/);
  assert.doesNotMatch(source, /interpretation-provider|claude-interpretation-provider|require\(.*provider.*\)/i);
  const mathSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video', 'recommendation-math.js'), 'utf8');
  assert.doesNotMatch(mathSource, /\bfetch\(/);
  const requireCalls = mathSource.match(/require\([^)]*\)/g) || [];
  assert.deepEqual(requireCalls, []); // truly pure — zero dependencies, not even measurement-math.js
});

// --- guards ---

test('21. generateRecommendations fails structurally for a non-existent project or reference set (no PatternSet)', () => {
  const badProject = recSvc.generateRecommendations('00000000-0000-4000-8000-000000000000', 'rs1');
  assert.equal(badProject.status, 'FAILED');
  const project = newProject();
  const noPatternSet = recSvc.generateRecommendations(project.id, 'no-such-reference-set');
  assert.equal(noPatternSet.status, 'FAILED');
});

test('22. generateRecommendations fails structurally when the PatternSet has zero patterns', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', []);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.status, 'FAILED');
  assert.ok(set.diagnostics.some((d) => d.code === 'INSUFFICIENT_PATTERNS'));
});

test('23. generateRecommendations always operates on the LATEST PatternSet for a reference set', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [RECURRING_MET()], { createdAt: '2020-01-01T00:00:00.000Z' });
  const laterOutlier = OUTLIER_PATTERN();
  persistPatternSet(project.id, 'rs1', [laterOutlier], { createdAt: '2030-01-01T00:00:00.000Z' });
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  assert.equal(set.recommendations.length, 1);
  assert.equal(set.recommendations[0].recommendationType, 'ALTERNATIVE_STRATEGY');
});

test('24. every recommendation carries sourcePatternIds/supportingReferenceVideoIds resolving back to the exact source Pattern (evidence chain, Part 17)', () => {
  const project = newProject();
  const pattern = RECURRING_MET();
  persistPatternSet(project.id, 'rs1', [pattern]);
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.deepEqual(rec.sourcePatternIds, [pattern.id]);
  assert.deepEqual(rec.supportingReferenceVideoIds.sort(), ['rv-1', 'rv-2', 'rv-3']); // support[] entries — 3 real videos
  assert.match(rec.evidenceSummary, /5 of 5/); // evidenceSummary reflects the pattern's own prevalence (5 of 5), not support.length (3) — a fixture-only distinction (real INT-1E patterns always keep the two in sync)
});

test('25. productionConsiderations are derived deterministically from category, never invented per-instance', () => {
  const project = newProject();
  persistPatternSet(project.id, 'rs1', [NUMERIC_MET()]); // category SHOT_RHYTHM
  const set = recSvc.generateRecommendations(project.id, 'rs1');
  const rec = set.recommendations[0];
  assert.deepEqual(rec.productionConsiderations, [{ note: 'May require additional editing complexity (more cut points to produce and align).' }]);
});
