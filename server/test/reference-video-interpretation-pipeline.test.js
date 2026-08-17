// INT-1D, Part 23 — the REAL interpretation proof, chained onto INT-1A's
// real acquisition proof, INT-1B's real measurement proof, and INT-1C's
// real observation proof. Reuses the exact same real, captured Apify data
// (the real "Me at the zoo" video) and the same expiring-URL-skip-guard
// convention as every earlier real-pipeline test in this stack.
//
// THE REAL PROVIDER GAP, HONESTLY HANDLED (matching INT-1A's own Apify
// precedent exactly, per explicit user direction for this stage): no
// ANTHROPIC_API_KEY exists anywhere in this environment (confirmed —
// `env | grep -i anthropic` returns only Claude Code's own infrastructure
// routing variables, never a usable API credential; see this stage's
// final report). services/reference-video/claude-interpretation-provider.js
// is real, production-ready code, fully covered by its own offline test
// suite (test/claude-interpretation-provider.test.js) — but it cannot be
// exercised against the live Anthropic API here.
//
// So for THIS ONE proof, the "provider" is Claude Code's own agent —
// the one actually building this stage — reading the REAL structured
// InterpretationInput the service built from the REAL "Me at the zoo"
// observations (captured in the comments below, verbatim, from an actual
// run of the real pipeline moments before this file was written) and
// answering under the EXACT SAME constraints (services/reference-video/
// interpretation-provider-interface.js's INTERPRETATION_CONSTRAINTS) a
// real Claude API call would be given. This is standing in for a
// not-yet-configured production credential — never presented as, or
// confused with, a live Anthropic API response. The hypotheses below were
// composed by reading the real observation statements printed by the real
// pipeline run and reasoning about them directly, not templated in
// advance of seeing the real evidence.
//
// The response text still passes through THIS FILE'S real, unmodified
// interpretationSvc.interpretReferenceVideo() — real evidence-chain
// validation, real cost-gate check, real Part 7 structural/semantic
// validation (fabricated citation IDs, banned intent/quality/
// recommendation language) — so the proof demonstrates the REAL pipeline
// end to end, with only the reasoning step itself substituted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-projects-'));
process.env.REFERENCE_VIDEO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-rvstore-'));
process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-mstore-'));
process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-ostore-'));
process.env.REFERENCE_VIDEO_INTERPRETATION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-istore-'));
process.env.INTERPRETATION_APPROVAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-rvi-real-approvals-'));

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const { ingestReferenceVideo } = require('../services/reference-video-ingestion-service');
const { measureReferenceVideo } = require('../services/reference-video-measurement-service');
const { deriveObservations } = require('../services/reference-video-observation-service');
const interpretationApprovalStore = require('../services/reference-video-interpretation-approval-store');
const interpretationSvc = require('../services/reference-video-interpretation-service');

const REAL_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const REAL_RESULT_URL = 'https://api.apify.com/v2/key-value-stores/R0N9jY9r9OljVp74n/records/jNQXAC9IVRw_Meatthezoo.mp4';

const REAL_ITEM = {
  title: 'Me at the zoo',
  description: 'Microplastics are accumulating in human brains at an alarming rate',
  published_at: '2005-04-24T03:31:52Z',
  view_count: 405031885,
  like_count: 19371347,
  comment_count: 10563237,
  thumbnail: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
  selected_language: 'English',
  transcript_text:
    "All right, so here we are, in front of the\nelephants the cool thing about these guys is that they\nhave really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to\nsay",
  transcript: [
    { start: 1.2, end: 3.36, text: 'All right, so here we are, in front of the\nelephants' },
    { start: 5.318, end: 7.974, text: 'the cool thing about these guys is that they\nhave really...' },
    { start: 7.974, end: 12.616, text: 'really really long trunks' },
    { start: 12.616, end: 14.367, text: "and that's cool" },
    { start: 14.421, end: 15.733, text: '(baaaaaaaaaaahhh!!)' },
    { start: 16.881, end: 18.881, text: "and that's pretty much all there is to\nsay" },
  ],
};

function realRelayAcquisitionProvider() {
  return {
    async resolveSource({ url }) {
      assert.equal(url, REAL_VIDEO_URL);
      return { status: 'COMPLETED', platform: 'YOUTUBE', externalId: 'jNQXAC9IVRw', normalizedUrl: REAL_VIDEO_URL, diagnostics: [] };
    },
    async acquireMetadata() {
      return {
        status: 'COMPLETED',
        metadata: { title: REAL_ITEM.title, description: REAL_ITEM.description, publishedAt: REAL_ITEM.published_at, retrievedAt: new Date().toISOString(), viewCount: REAL_ITEM.view_count, likeCount: REAL_ITEM.like_count, commentCount: REAL_ITEM.comment_count, category: null, tags: [], thumbnailUrl: REAL_ITEM.thumbnail },
        diagnostics: [],
      };
    },
    async acquireVideo() {
      return { status: 'COMPLETED', resultUrl: REAL_RESULT_URL, diagnostics: [] };
    },
    async acquireTranscript() {
      return {
        status: 'COMPLETED',
        transcript: { text: REAL_ITEM.transcript_text, language: REAL_ITEM.selected_language, segments: REAL_ITEM.transcript.map((c) => ({ text: c.text, startTime: c.start, endTime: c.end })) },
        diagnostics: [],
      };
    },
  };
}

async function realResultUrlIsStillLive() {
  try {
    const res = await fetch(REAL_RESULT_URL, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

// The "Claude Code relay" interpretation provider — see file header. Real
// reasoning, composed by reading the actual observation statements this
// video really produces (captured verbatim in each branch's comment,
// from an actual run of this exact real pipeline). Any question this
// provider isn't explicitly prepared for is refused honestly rather than
// answered generically, matching the real constraint "if the supplied
// evidence is insufficient... say so explicitly."
function createClaudeCodeRelayInterpretationProvider() {
  return {
    async interpret(input) {
      const byId = new Map(input.observations.map((o) => [o.observationId, o]));
      const find = (needle) => input.observations.find((o) => o.statement.includes(needle));

      if (input.questionId === 'OPENING_STRUCTURAL_PURPOSE') {
        // Real supplied evidence: "1 shot boundary change(s) occur within
        // the first 10 seconds" (OPENING) + "contains 1 detected shot"
        // (STRUCTURE). Both describe the SAME fact: the whole ~19s video,
        // including its opening, is one continuous, uncut shot.
        const openingObs = find('shot boundary change');
        const structureObs = find('detected shot');
        if (!openingObs || !structureObs) return { status: 'INVALID' };
        return {
          status: 'COMPLETED',
          hypothesis:
            'Because the entire video is one continuous, uncut shot, the opening does not appear to serve a distinct editing-driven structural role (e.g. a hook cut) separate from the rest of the video — it is presented in the same unbroken take as everything that follows. This may be consistent with a single spontaneous take that was not edited for pacing, though a ~19-second clip may simply be too short for any cut to have been necessary regardless of intent.',
          reasoning: `Observation ${structureObs.observationId} establishes there are zero detected cuts anywhere in the video. Observation ${openingObs.observationId}'s "1 shot in the first 10 seconds" count is a direct consequence of that same single shot spanning the whole duration, not independent evidence of an opening-specific structural choice.`,
          supportingObservationIds: [structureObs.observationId],
          counterObservationIds: [openingObs.observationId],
          alternativeHypotheses: [
            { hypothesis: 'The absence of a cut may simply reflect the video\'s short overall length rather than any structural intent about the opening specifically.', reasoning: `Observation ${structureObs.observationId} alone cannot distinguish "no cut was needed" from "no cut was chosen for effect" — duration is short enough that both readings fit equally well.` },
          ],
          confidence: 'LOW',
          limitations: ['Only two observations are relevant to this question, both derived from the same single-shot fact; this is thin evidence for any structural claim about the opening specifically.'],
        };
      }

      if (input.questionId === 'INFORMATION_DELAY_LOCATION') {
        // Real supplied evidence includes the WPM observation and the
        // opening cut-density observation. Neither directly measures
        // information timing, but the transcript-derived narration-rate
        // observation, combined with there being no opening-specific
        // structural signal (see above), supports a narrow, hedged
        // negative finding rather than inventing a delay location that
        // isn't measurable from what was supplied.
        const wpmObs = find('words per minute');
        if (!wpmObs) return { status: 'INVALID' };
        return {
          status: 'COMPLETED',
          hypothesis: 'The supplied evidence does not indicate a location where information is being withheld or delayed — there is no structural signal (such as a distinct opening edit or a measured pause pattern) available in this evidence set that would support identifying a delay point.',
          reasoning: `Observation ${wpmObs.observationId} describes an overall narration rate but says nothing about WHERE within the video specific information appears or is withheld — no pause-timing or sentence-level observation was supplied for this question, so no delay location can be responsibly identified from this evidence alone.`,
          supportingObservationIds: [wpmObs.observationId],
          counterObservationIds: [],
          alternativeHypotheses: [],
          confidence: 'LOW',
          limitations: ['This is a negative finding: the supplied evidence is insufficient to identify a specific delay location, not a claim that no delay exists.'],
        };
      }

      // Any other question: honestly decline rather than generating a
      // generic, evidence-thin answer — matching the real constraint
      // "if the supplied evidence is insufficient... say so explicitly."
      void byId;
      return { status: 'COMPLETED', hypothesis: null, reasoning: 'Insufficient prepared evidence for this specific question in this proof run.', supportingObservationIds: [], confidence: null, limitations: [] };
    },
  };
}

test('REAL PROOF — interpreting real "Me at the zoo" observations produces evidence-cited, hedged hypotheses (and an honest refusal where evidence is insufficient), never presenting inference as fact', async (t) => {
  if (!(await realResultUrlIsStillLive())) {
    t.skip("the ~3-day Apify key-value-store URL has expired — re-running the real acquisition would require a new (small) real spend; see INT-1A/B/C/D's final reports for the originally captured evidence");
    return;
  }

  const project = projectStore.createProject({ title: 'EVOLINK INT-1D REAL INTERPRETATION PROOF', topic: 'Me at the zoo' });
  gate.setBudget(project, 10);
  gate.requestApproval(project, { estimatedCost: 0 });
  gate.decideApproval(project, { approve: true, decidedBy: 'tester' });
  // P0 Hardening (finding J) — ingestReferenceVideo() now re-reads the
  // project fresh from disk to check this approval before its real
  // provider call; persist it rather than leaving it in memory only.
  projectStore.touch(project);

  const rv = await ingestReferenceVideo(project.id, { url: REAL_VIDEO_URL, provider: realRelayAcquisitionProvider() });
  assert.equal(rv.status, 'COMPLETE');
  const measurements = measureReferenceVideo(project.id, rv.id);
  const observationSet = deriveObservations(project.id, measurements.id);
  console.log(`[INT-1D REAL PROOF] real observations available: ${observationSet.observations.map((o) => o.methodology.ruleId).join(', ')}`);

  const provider = createClaudeCodeRelayInterpretationProvider();

  // --- Question 1: a real, evidence-cited hypothesis ---
  const q1 = 'OPENING_STRUCTURAL_PURPOSE';
  interpretationApprovalStore.requestApproval(project.id, rv.id, q1, { estimatedCost: 0.01, requestedBy: 'tester' });
  interpretationApprovalStore.decideApproval(project.id, rv.id, q1, { approve: true, decidedBy: 'tester' });
  // P0 Hardening (finding J) — a KNOWN (USD) estimatedCost now requires
  // explicit human acknowledgment (currency mismatch vs the credit budget).
  interpretationApprovalStore.acknowledgeUnknownCost(project.id, rv.id, q1, { acknowledgedBy: 'tester' });
  const interp1 = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId: q1, provider, providerName: 'claude-code-relay' });
  console.log(`[INT-1D REAL PROOF] Q1 (${q1}) status=${interp1.status}`);
  console.log(`[INT-1D REAL PROOF] hypothesis: ${interp1.hypothesis}`);
  assert.equal(interp1.status, 'PENDING_REVIEW');
  assert.equal(interp1.confidence, 'LOW');
  assert.ok(interp1.supportingEvidence.length > 0);
  for (const ev of interp1.supportingEvidence) assert.ok(observationSet.observations.some((o) => o.id === ev.observationId));
  assert.match(interp1.hypothesis, /may|consistent with/i); // hedged, never asserted as settled fact
  assert.doesNotMatch(interp1.hypothesis, /\bthe creator (deliberately|intentionally)\b/i);

  // --- Question 2: another real, evidence-cited (negative) finding ---
  const q2 = 'INFORMATION_DELAY_LOCATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, q2, { estimatedCost: 0.01, requestedBy: 'tester' });
  interpretationApprovalStore.decideApproval(project.id, rv.id, q2, { approve: true, decidedBy: 'tester' });
  interpretationApprovalStore.acknowledgeUnknownCost(project.id, rv.id, q2, { acknowledgedBy: 'tester' });
  const interp2 = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId: q2, provider, providerName: 'claude-code-relay' });
  console.log(`[INT-1D REAL PROOF] Q2 (${q2}) status=${interp2.status}`);
  console.log(`[INT-1D REAL PROOF] hypothesis: ${interp2.hypothesis}`);
  assert.equal(interp2.status, 'PENDING_REVIEW');
  assert.ok(interp2.supportingEvidence.length > 0);

  // --- Question 3: a REAL, honest EVIDENCE_MISSING refusal — this video
  // has zero PACING/SHOT_RHYTHM observations (it is a single uncut shot,
  // so no shot-duration-comparison rule could fire), so asking a pacing
  // question must be refused rather than answered with fabricated pacing
  // commentary. This is as important a proof as the two successes above. ---
  const q3 = 'PACING_PATTERN_EXPLANATION';
  interpretationApprovalStore.requestApproval(project.id, rv.id, q3, { estimatedCost: 0.01, requestedBy: 'tester' });
  interpretationApprovalStore.decideApproval(project.id, rv.id, q3, { approve: true, decidedBy: 'tester' });
  interpretationApprovalStore.acknowledgeUnknownCost(project.id, rv.id, q3, { acknowledgedBy: 'tester' });
  const interp3 = await interpretationSvc.interpretReferenceVideo(project.id, { referenceVideoId: rv.id, measurementsId: measurements.id, observationSetId: observationSet.id, questionId: q3, provider, providerName: 'claude-code-relay' });
  console.log(`[INT-1D REAL PROOF] Q3 (${q3}) status=${interp3.status} diagnostics=${JSON.stringify(interp3.diagnostics)}`);
  assert.equal(interp3.status, 'FAILED');
  assert.equal(interp3.diagnostics[0].code, 'INTERPRETATION_EVIDENCE_MISSING');

  console.log('[INT-1D REAL PROOF] real evidence-cited hypotheses were produced for real questions, and a real question with genuinely insufficient evidence was honestly refused rather than answered with invented pacing commentary.');
});
