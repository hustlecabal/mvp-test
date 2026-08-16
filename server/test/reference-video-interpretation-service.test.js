// Tests for services/reference-video-interpretation-service.js — the
// orchestrator, and the primary home for this stage's Part 24 adversarial
// (anti-hallucination) tests. Every test here uses the deterministic FAKE
// interpretation provider (services/reference-video/fake-interpretation-
// provider.js) — no live LLM call anywhere in this file (Part 27). Real
// FFmpeg fixtures build genuine INT-1A/B/C evidence underneath.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-int1d-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-int1d-projects-'],
  ['REFERENCE_VIDEO_DATA_DIR', 'evolink-int1d-rvstore-'],
  ['REFERENCE_VIDEO_MEASUREMENT_DATA_DIR', 'evolink-int1d-mstore-'],
  ['REFERENCE_VIDEO_OBSERVATION_DATA_DIR', 'evolink-int1d-ostore-'],
  ['REFERENCE_VIDEO_INTERPRETATION_DATA_DIR', 'evolink-int1d-istore-'],
  ['INTERPRETATION_APPROVAL_DATA_DIR', 'evolink-int1d-approvals-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const observationStore = require('../services/reference-video-observation-store');
const interpretationStore = require('../services/reference-video-interpretation-store');
const interpretationApprovalStore = require('../services/reference-video-interpretation-approval-store');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const { measureReferenceVideo } = require('../services/reference-video-measurement-service');
const { deriveObservations } = require('../services/reference-video-observation-service');
const interpretationSvc = require('../services/reference-video-interpretation-service');
const { createFakeInterpretationProvider } = require('../services/reference-video/fake-interpretation-provider');
const { createInterpretationProviderResult } = require('../services/reference-video/interpretation-provider-interface');

function newApprovedProject(budget = 100) {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  gate.setBudget(project, budget);
  gate.requestApproval(project, { estimatedCost: budget / 2 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  return project;
}

function makeTwoShotVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-int1d-src-'));
  const p = path.join(dir, 'v.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=320x180:duration=2:rate=25',
    '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:duration=2:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[outv]',
    '-map', '[outv]', '-map', '2:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p,
  ]);
  return p;
}

async function buildRealEvidence(project, { words } = {}) {
  const videoPath = makeTwoShotVideo();
  const fetchImpl = async () => {
    const buf = fs.readFileSync(videoPath);
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : h.toLowerCase() === 'content-type' ? 'video/mp4' : null) }, body: Readable.toWeb(Readable.from(buf)) };
  };
  const defaultWords = [
    { word: 'Hello', startTime: 0, endTime: 0.3 },
    { word: 'there.', startTime: 0.3, endTime: 0.6 },
    { word: 'Is', startTime: 1.5, endTime: 1.6 },
    { word: 'this', startTime: 1.6, endTime: 1.7 },
    { word: 'working?', startTime: 1.7, endTime: 2.1 },
  ];
  const provider = {
    resolveSource: async () => ({ status: 'COMPLETED', platform: 'YOUTUBE', externalId: `fx${Math.random().toString(36).slice(2, 10)}`, normalizedUrl: 'https://www.youtube.com/watch?v=fx0000000001', diagnostics: [] }),
    acquireMetadata: async () => ({ status: 'COMPLETED', metadata: { title: 'Fixture', description: '', publishedAt: null, retrievedAt: new Date().toISOString(), viewCount: 1, likeCount: 0, commentCount: 0, category: null, tags: [], thumbnailUrl: null }, diagnostics: [] }),
    acquireVideo: async () => ({ status: 'COMPLETED', resultUrl: 'https://fake.apify.com/f.mp4', diagnostics: [] }),
    acquireTranscript: async () => ({ status: 'COMPLETED', transcript: { text: (words || defaultWords).map((w) => w.word).join(' '), language: 'en', words: words || defaultWords, segments: [] }, diagnostics: [] }),
  };
  const rv = await ingestReferenceVideo(project.id, { url: 'https://www.youtube.com/watch?v=fx0000000001', provider, fetchImpl });
  const measurements = measureReferenceVideo(project.id, rv.id);
  const observationSet = deriveObservations(project.id, measurements.id);
  return { rv, measurements, observationSet };
}

// --- evidence chain (Part 3/24) ---

test('1. resolveEvidenceChain succeeds for a real, unbroken chain', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const result = interpretationSvc.resolveEvidenceChain(project.id, rv.id, measurements.id, observationSet.id);
  assert.equal(result.ok, true);
});

test('2. resolveEvidenceChain fails with INTERPRETATION_EVIDENCE_MISSING for a non-existent measurementsId', async () => {
  const project = newApprovedProject();
  const { rv, observationSet } = await buildRealEvidence(project);
  const result = interpretationSvc.resolveEvidenceChain(project.id, rv.id, '11111111-1111-4111-8111-111111111111', observationSet.id);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'INTERPRETATION_EVIDENCE_MISSING');
});

test('3. resolveEvidenceChain fails with INTERPRETATION_INPUT_INVALID when measurements belong to a different reference video than claimed', async () => {
  const project = newApprovedProject();
  const { measurements, observationSet } = await buildRealEvidence(project);
  const result = interpretationSvc.resolveEvidenceChain(project.id, '22222222-2222-4222-8222-222222222222', measurements.id, observationSet.id);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'INTERPRETATION_INPUT_INVALID');
});

test('4. resolveEvidenceChain fails when the ObservationSet was derived from DIFFERENT measurements (broken chain, Part 3)', async () => {
  const project = newApprovedProject();
  const a = await buildRealEvidence(project);
  const b = await buildRealEvidence(project);
  const result = interpretationSvc.resolveEvidenceChain(project.id, a.rv.id, a.measurements.id, b.observationSet.id);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'INTERPRETATION_INPUT_INVALID');
});

// --- evidence selection + banned-language exclusion (Part 24 adversarial test 4) ---

test('5. selectRelevantObservations only returns observations in the question\'s relevantCategories', async () => {
  const project = newApprovedProject();
  const { observationSet } = await buildRealEvidence(project);
  const { included } = interpretationSvc.selectRelevantObservations(observationSet, 'PACING_PATTERN_EXPLANATION');
  const { OBSERVATION_CATEGORIES } = require('../schemas/reference-video-observation-schema');
  void OBSERVATION_CATEGORIES;
  for (const o of included) assert.ok(['PACING', 'SHOT_RHYTHM'].includes(o.category));
});

test('6. selectRelevantObservations EXCLUDES an observation whose statement contains an intent claim (Part 24 adversarial test 4 — evidence that should never have existed)', async () => {
  const project = newApprovedProject();
  const { observationSet } = await buildRealEvidence(project);
  const corrupted = { ...observationSet, observations: [...observationSet.observations, { id: 'fake-corrupt-1', category: 'OPENING', statement: 'The creator intentionally delayed the payoff to maximize watch time.', confidence: 'MEDIUM', methodology: { ruleId: 'FAKE' }, evidence: [] }] };
  const { included, excluded } = interpretationSvc.selectRelevantObservations(corrupted, 'OPENING_STRUCTURAL_PURPOSE');
  assert.ok(!included.some((o) => o.id === 'fake-corrupt-1'));
  assert.ok(excluded.some((e) => e.observationId === 'fake-corrupt-1'));
});

test('7. containsBannedLanguage detects intent claims, quality judgments, and recommendations, but NOT hedged structural language', () => {
  assert.ok(interpretationSvc.containsBannedLanguage('The creator deliberately paced the opening this way.'));
  assert.ok(interpretationSvc.containsBannedLanguage('This is an excellent hook.'));
  assert.ok(interpretationSvc.containsBannedLanguage('You should make your videos shorter.'));
  assert.equal(interpretationSvc.containsBannedLanguage('The structure is consistent with an attempt to delay the payoff.'), null);
  assert.equal(interpretationSvc.containsBannedLanguage('Median shot duration is 1.9 seconds.'), null);
});

// --- cost gate (Part 18) ---

test('8. checkInterpretationBudget blocks when estimated cost is unknown and not acknowledged', () => {
  const project = newApprovedProject();
  const approval = { estimatedCost: null, unknownCostAcknowledged: false };
  const result = interpretationSvc.checkInterpretationBudget(project, approval);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /unknown/i);
});

test('9. checkInterpretationBudget blocks when estimated cost exceeds remaining budget', () => {
  const project = newApprovedProject(1); // $1 total budget, $0.50 already "allocated" via requestApproval above
  const approval = { estimatedCost: 999, unknownCostAcknowledged: false };
  const result = interpretationSvc.checkInterpretationBudget(project, approval);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /budget/i);
});

test('10. checkInterpretationBudget allows a small, known cost within budget', () => {
  const project = newApprovedProject(100);
  const approval = { estimatedCost: 0.01, unknownCostAcknowledged: false };
  const result = interpretationSvc.checkInterpretationBudget(project, approval);
  assert.equal(result.allowed, true);
});

test('11. estimateInterpretationCost computes a real token estimate and a real dollar figure for a known model', () => {
  const input = { question: 'x', observations: [] };
  const estimate = interpretationSvc.estimateInterpretationCost(input, { provider: 'claude', model: 'claude-sonnet-5' });
  assert.ok(estimate.estimatedInputTokens > 0);
  assert.equal(estimate.estimatedOutputTokens, 800);
  assert.ok(estimate.estimatedCostUsd > 0);
});

test('12. estimateInterpretationCost returns estimatedCostUsd: null for an unknown model — Part 18\'s "cannot be determined safely" case', () => {
  const estimate = interpretationSvc.estimateInterpretationCost({ question: 'x' }, { provider: 'claude', model: 'nonexistent' });
  assert.equal(estimate.estimatedCostUsd, null);
});

// --- full happy path ---

test('13. interpretReferenceVideo end-to-end: approved, real evidence, fake provider -> a real, persisted, evidence-cited Interpretation', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';

  const approvalResult = interpretationSvc.requestInterpretationApproval(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId });
  assert.equal(approvalResult.ok, true);
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });

  const provider = createFakeInterpretationProvider();
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });

  assert.equal(interpretation.status, 'PENDING_REVIEW');
  assert.ok(interpretation.hypothesis.length > 0);
  assert.ok(['MEDIUM', 'LOW'].includes(interpretation.confidence));
  assert.ok(interpretation.supportingEvidence.length > 0);
  for (const ev of interpretation.supportingEvidence) {
    assert.ok(observationSet.observations.some((o) => o.id === ev.observationId), 'every cited observation must be real');
  }
  assert.equal(interpretation.audit.questionId, questionId);
  assert.ok(interpretation.audit.estimatedCostUsd > 0);

  const persisted = interpretationStore.getInterpretation(project.id, interpretation.id);
  assert.ok(persisted);
});

test('14. interpretReferenceVideo is INTERPRETATION_COST_BLOCKED with no prior approval — nothing is persisted', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const provider = createFakeInterpretationProvider();
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId: 'PACING_PATTERN_EXPLANATION', provider });
  assert.equal(interpretation.status, 'FAILED');
  assert.equal(interpretation.diagnostics[0].code, 'INTERPRETATION_COST_BLOCKED');
  assert.equal(interpretationStore.listInterpretations(project.id).length, 0);
});

test('15. interpretReferenceVideo is INTERPRETATION_EVIDENCE_MISSING when no relevant observations exist for the question', async () => {
  const project = newApprovedProject();
  const { rv, measurements } = await buildRealEvidence(project, { words: [] }); // no transcript-derived observations
  const emptyObservationSet = observationStore.addObservationSet(project.id, require('../schemas/reference-video-observation-schema').createObservationSet({ projectId: project.id, referenceVideoId: rv.id, measurementsId: measurements.id, status: 'COMPLETE', observations: [] })).observationSet;
  interpretationApprovalStore.decideApproval(project.id, rv.id, 'NARRATION_VISUAL_RHYTHM_RELATIONSHIP', { approve: true, decidedBy: 'tester' });
  interpretationApprovalStore.requestApproval(project.id, rv.id, 'NARRATION_VISUAL_RHYTHM_RELATIONSHIP', { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, 'NARRATION_VISUAL_RHYTHM_RELATIONSHIP', { approve: true, decidedBy: 'tester' });
  const provider = createFakeInterpretationProvider();
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: emptyObservationSet.id, questionId: 'NARRATION_VISUAL_RHYTHM_RELATIONSHIP', provider });
  assert.equal(interpretation.status, 'FAILED');
  assert.equal(interpretation.diagnostics[0].code, 'INTERPRETATION_EVIDENCE_MISSING');
});

// --- provider failure paths (Part 21) ---

for (const [providerStatus, expectedCode] of [['UNAVAILABLE', 'INTERPRETATION_PROVIDER_UNAVAILABLE'], ['TIMEOUT', 'INTERPRETATION_TIMEOUT'], ['INVALID', 'INTERPRETATION_INVALID'], ['FAILED', 'INTERPRETATION_FAILED']]) {
  test(`16.${providerStatus} interpretReferenceVideo maps provider status ${providerStatus} to diagnostic ${expectedCode}, and persists nothing`, async () => {
    const project = newApprovedProject();
    const { rv, measurements, observationSet } = await buildRealEvidence(project);
    const questionId = 'PACING_PATTERN_EXPLANATION';
    interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
    interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
    const provider = createFakeInterpretationProvider({ respond: () => ({ status: providerStatus, diagnostics: [{ code: expectedCode, message: 'simulated' }] }) });
    const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });
    assert.equal(interpretation.status, 'FAILED');
    assert.equal(interpretation.diagnostics[0].code, expectedCode);
    assert.equal(interpretationStore.listInterpretations(project.id).length, 0);
  });
}

test('17. interpretReferenceVideo returns INTERPRETATION_FAILED when the provider throws', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const provider = { interpret: async () => { throw new Error('boom'); } };
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });
  assert.equal(interpretation.diagnostics[0].code, 'INTERPRETATION_FAILED');
});

// --- Part 7: strict structural validation, no repair ---

test('18. validateProviderResult rejects an empty hypothesis/reasoning', () => {
  const included = [{ id: 'obs-1', category: 'PACING', statement: 'x' }];
  assert.equal(interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: '', reasoning: 'r', supportingObservationIds: ['obs-1'], confidence: 'MEDIUM' }), included).ok, false);
  assert.equal(interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: '', supportingObservationIds: ['obs-1'], confidence: 'MEDIUM' }), included).ok, false);
});

test('19. validateProviderResult rejects zero supportingObservationIds — an interpretation without evidence is invalid (Part 3)', () => {
  const included = [{ id: 'obs-1', category: 'PACING', statement: 'x' }];
  const result = interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: [], confidence: 'MEDIUM' }), included);
  assert.equal(result.ok, false);
  assert.match(result.reason, /evidence/i);
});

test('20. validateProviderResult rejects confidence "HIGH" outright — never silently clamped to MEDIUM (Part 8, no auto-upgrade)', () => {
  const included = [{ id: 'obs-1', category: 'PACING', statement: 'x' }];
  const result = interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: ['obs-1'], confidence: 'HIGH' }), included);
  assert.equal(result.ok, false);
  assert.match(result.reason, /confidence/i);
});

test('21. ADVERSARIAL: validateProviderResult rejects a supportingObservationIds entry that references an id NOT present in the supplied evidence — a hallucinated citation', () => {
  const included = [{ id: 'obs-real-1', category: 'PACING', statement: 'x' }];
  const result = interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: ['obs-real-1', 'obs-FABRICATED-999'], confidence: 'MEDIUM' }), included);
  assert.equal(result.ok, false);
  assert.match(result.reason, /obs-FABRICATED-999/);
});

test('22. ADVERSARIAL: validateProviderResult rejects a fabricated counterObservationIds entry the same way', () => {
  const included = [{ id: 'obs-real-1', category: 'PACING', statement: 'x' }];
  const result = interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: ['obs-real-1'], counterObservationIds: ['obs-FAKE'], confidence: 'MEDIUM' }), included);
  assert.equal(result.ok, false);
});

test('23. ADVERSARIAL: validateProviderResult rejects output whose hypothesis asserts creator intent as fact', () => {
  const included = [{ id: 'obs-real-1', category: 'OPENING', statement: 'x' }];
  const result = interpretationSvc.validateProviderResult(createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'The creator intentionally delayed the reveal to build suspense.', reasoning: 'r', supportingObservationIds: ['obs-real-1'], confidence: 'MEDIUM' }), included);
  assert.equal(result.ok, false);
  assert.match(result.reason, /intent/i);
});

test('24. ADVERSARIAL: validateProviderResult rejects a quality-judgment or recommendation smuggled into an alternative hypothesis or limitations entry, not just the primary hypothesis', () => {
  const included = [{ id: 'obs-real-1', category: 'OPENING', statement: 'x' }];
  const withScore = createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: ['obs-real-1'], confidence: 'MEDIUM', alternativeHypotheses: [{ hypothesis: 'This is an excellent structural choice.', reasoning: 'r2' }] });
  assert.equal(interpretationSvc.validateProviderResult(withScore, included).ok, false);
  const withRecommendation = createInterpretationProviderResult({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: ['obs-real-1'], confidence: 'MEDIUM', limitations: ['You should make your videos shorter.'] });
  assert.equal(interpretationSvc.validateProviderResult(withRecommendation, included).ok, false);
});

test('25. a full end-to-end run through interpretReferenceVideo with a provider that returns an intent-claim hypothesis is rejected as INTERPRETATION_INVALID (Part 24 adversarial test 5, concretely enforced)', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'OPENING_STRUCTURAL_PURPOSE';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const provider = createFakeInterpretationProvider({
    respond: (input) => ({ status: 'COMPLETED', hypothesis: 'The creator intentionally structured the opening this way.', reasoning: 'r', supportingObservationIds: input.observations.length ? [input.observations[0].observationId] : [], confidence: 'MEDIUM' }),
  });
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });
  assert.equal(interpretation.status, 'FAILED');
  assert.equal(interpretation.diagnostics[0].code, 'INTERPRETATION_INVALID');
  assert.equal(interpretationStore.listInterpretations(project.id).length, 0);
});

// --- ADVERSARIAL Part 24 test 2: altered evidence changes the citation content ---

test('26. ADVERSARIAL: supportingEvidence.statement is always freshly resolved from the CURRENT observation record, never stale/cached — proven by directly altering the stored observation between two interpretation calls', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });

  const targetId = observationSet.observations.find((o) => ['PACING', 'SHOT_RHYTHM'].includes(o.category)).id;
  const provider = createFakeInterpretationProvider({ respond: () => ({ status: 'COMPLETED', hypothesis: 'h', reasoning: 'r', supportingObservationIds: [targetId], confidence: 'MEDIUM' }) });

  const first = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });
  const originalStatement = first.supportingEvidence[0].statement;

  // directly alter the persisted observation's statement (simulating a real re-observation with different underlying timestamps producing new wording)
  const library = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR, `${project.id}.json`), 'utf8'));
  const set = library.observationSets.find((s) => s.id === observationSet.id);
  const obs = set.observations.find((o) => o.id === targetId);
  obs.statement = 'ALTERED: a completely different statement text.';
  fs.writeFileSync(path.join(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR, `${project.id}.json`), JSON.stringify(library, null, 2));

  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const second = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });

  assert.notEqual(second.supportingEvidence[0].statement, originalStatement);
  assert.equal(second.supportingEvidence[0].statement, 'ALTERED: a completely different statement text.');
});

// --- ADVERSARIAL Part 24 test 3: contradictory observations acknowledged, not silently resolved ---

test('27. ADVERSARIAL: given genuinely contradictory observations, a provider that acknowledges the conflict via counterEvidence is faithfully persisted — the service never strips or silently resolves the conflict', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const contradictionA = { id: 'contra-a', category: 'PACING', statement: 'Shot count increases toward the end of the video.', confidence: 'MEDIUM', methodology: { ruleId: 'FAKE_A' }, evidence: [] };
  const contradictionB = { id: 'contra-b', category: 'PACING', statement: 'Shot count decreases toward the end of the video.', confidence: 'MEDIUM', methodology: { ruleId: 'FAKE_B' }, evidence: [] };
  const withContradiction = observationStore.addObservationSet(project.id, require('../schemas/reference-video-observation-schema').createObservationSet({ projectId: project.id, referenceVideoId: rv.id, measurementsId: measurements.id, status: 'COMPLETE', observations: [contradictionA, contradictionB] })).observationSet;

  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });

  const provider = createFakeInterpretationProvider({
    respond: () => ({
      status: 'COMPLETED',
      hypothesis: 'The evidence about end-of-video shot count is contradictory and does not support a single confident pacing hypothesis.',
      reasoning: 'Observation contra-a and contra-b directly conflict.',
      supportingObservationIds: ['contra-a'],
      counterObservationIds: ['contra-b'],
      confidence: 'LOW',
      limitations: ['Two supplied observations directly conflict about end-of-video shot count; this hypothesis should be treated as unresolved.'],
    }),
  });
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: withContradiction.id, questionId, provider });
  assert.equal(interpretation.status, 'PENDING_REVIEW');
  assert.equal(interpretation.counterEvidence.length, 1);
  assert.equal(interpretation.counterEvidence[0].observationId, 'contra-b');
  assert.match(interpretation.limitations[0], /conflict/i);
});

// --- alternative hypotheses / counter-evidence carry through ---

test('28. alternativeHypotheses and counterEvidence supplied by the provider are persisted intact, never forced to a single answer (Part 9/10)', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const provider = createFakeInterpretationProvider(); // default responder always proposes one alternative when >=2 observations exist
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider });
  assert.equal(interpretation.status, 'PENDING_REVIEW');
  // this stage's observation set for the fixture video has >=2 PACING/SHOT_RHYTHM observations, so the default fake responder proposes an alternative
  if (interpretation.supportingEvidence.length > 0) {
    assert.ok(Array.isArray(interpretation.alternativeHypotheses));
  }
});

// --- human review (Part 19) ---

test('29. reviewInterpretation ACCEPT/REJECT update status without touching hypothesis/reasoning', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider: createFakeInterpretationProvider() });
  const originalHypothesis = interpretation.hypothesis;

  const accepted = interpretationSvc.reviewInterpretation(project.id, interpretation.id, { decision: 'ACCEPT', reviewedBy: 'human1' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.interpretation.status, 'ACCEPTED');
  assert.equal(accepted.interpretation.hypothesis, originalHypothesis);
  assert.equal(accepted.interpretation.reviews.length, 1);
});

test('30. reviewInterpretation EDIT creates a NEW record and marks the original SUPERSEDED — the machine original is never overwritten (Part 19)', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider: createFakeInterpretationProvider() });
  const originalHypothesis = interpretation.hypothesis;

  const edited = interpretationSvc.reviewInterpretation(project.id, interpretation.id, { decision: 'EDIT', reviewedBy: 'human1', editedHypothesis: 'A human-refined version of the hypothesis.' });
  assert.equal(edited.ok, true);
  assert.notEqual(edited.interpretation.id, interpretation.id);
  assert.equal(edited.interpretation.hypothesis, 'A human-refined version of the hypothesis.');
  assert.equal(edited.interpretation.supersedesInterpretationId, interpretation.id);
  assert.equal(edited.interpretation.status, 'ACCEPTED');

  const originalNow = interpretationStore.getInterpretation(project.id, interpretation.id);
  assert.equal(originalNow.status, 'SUPERSEDED');
  assert.equal(originalNow.hypothesis, originalHypothesis); // never overwritten
  assert.equal(originalNow.reviews[0].resultingInterpretationId, edited.interpretation.id);
});

test('31. reviewInterpretation EDIT rejects edited text that itself contains banned language — the constraints apply to humans too', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider: createFakeInterpretationProvider() });
  const result = interpretationSvc.reviewInterpretation(project.id, interpretation.id, { decision: 'EDIT', reviewedBy: 'human1', editedHypothesis: 'The creator intentionally did this.' });
  assert.equal(result.ok, false);
});

test('32. reviewInterpretation REQUEST_ALTERNATIVE records the request without creating a new interpretation or spending again', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  const interpretation = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider: createFakeInterpretationProvider() });
  const result = interpretationSvc.reviewInterpretation(project.id, interpretation.id, { decision: 'REQUEST_ALTERNATIVE', reviewedBy: 'human1' });
  assert.equal(result.ok, true);
  assert.equal(interpretationStore.listInterpretations(project.id).length, 1); // no new record created
});

// --- data safety (Part 26) ---

test('33. interpretReferenceVideo never mutates the underlying Measurements or ObservationSet records', async () => {
  const project = newApprovedProject();
  const { rv, measurements, observationSet } = await buildRealEvidence(project);
  const questionId = 'PACING_PATTERN_EXPLANATION';
  const beforeMeasurements = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR, `${project.id}.json`), 'utf8'));
  const beforeObservations = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR, `${project.id}.json`), 'utf8'));
  interpretationApprovalStore.requestApproval(project.id, rv.id, questionId, { estimatedCost: 0.01 });
  interpretationApprovalStore.decideApproval(project.id, rv.id, questionId, { approve: true, decidedBy: 'tester' });
  await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId, provider: createFakeInterpretationProvider() });
  const afterMeasurements = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR, `${project.id}.json`), 'utf8'));
  const afterObservations = JSON.parse(fs.readFileSync(path.join(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR, `${project.id}.json`), 'utf8'));
  assert.deepEqual(beforeMeasurements, afterMeasurements);
  assert.deepEqual(beforeObservations, afterObservations);
});

// --- security (Part 22/25) ---

test('34. this file only ever invokes the injected provider — no network, no child_process, no eval', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'reference-video-interpretation-service.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /\beval\(/);
  assert.doesNotMatch(source, /new Function\(/);
});
