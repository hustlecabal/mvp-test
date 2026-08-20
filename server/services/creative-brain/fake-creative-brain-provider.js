// fake-creative-brain-provider.js
//
// CREATIVE BRAIN — a deterministic, offline CreativeBrainProvider for
// tests, mirroring services/reference-video/fake-interpretation-provider
// .js's own role. Produces genuinely DIFFERENT candidates (never 3 copies
// of the same text) by deriving each candidate from the topic + recommendation
// evidence + a distinct angle-shape template, so evaluation-service tests
// have real variance to select among rather than 3 identical strings.

const { createAngleCandidatesResult, createAngleCandidate, createDirectionSynthesisResult } = require('./creative-brain-provider-interface');

const ANGLE_SHAPES = [
  (topic, rec) => ({
    concept: `The hidden cost of ${topic}`,
    corePromise: `${topic} looks like a simple choice, but the real cost only shows up months later — ${rec ? rec.statement : 'a pattern the evidence keeps surfacing'}.`,
    hookStrategy: `Open on the moment someone realizes the cost they didn't see coming.`,
    rationale: 'Reframes the topic around a delayed consequence rather than the topic itself.',
  }),
  (topic, rec) => ({
    concept: `What ${topic} actually requires that nobody says out loud`,
    corePromise: `Everyone talks about ${topic} in terms of the decision — almost nobody talks about the specific skill it demands afterward.`,
    hookStrategy: `Start with the unglamorous detail that separates who succeeds from who doesn't.`,
    rationale: 'Shifts from decision framing to a concrete, specific skill/requirement.',
  }),
  (topic, rec) => ({
    concept: `The wrong reason people pursue ${topic}`,
    corePromise: `The most common reason people give for ${topic} is rarely the real one — and the gap explains why so many regret it.`,
    hookStrategy: `Open with the stated reason, then the quiet contradiction.`,
    rationale: 'Uses a stated-vs-real-motive contrast for tension.',
  }),
];

function createFakeCreativeBrainProvider({ candidateShapes = ANGLE_SHAPES, forceStatus = null, forceDirectionStatus = null } = {}) {
  return {
    async generateAngleCandidates(input) {
      if (forceStatus) return createAngleCandidatesResult({ status: forceStatus, model: 'fake-creative-brain', diagnostics: forceStatus !== 'COMPLETED' ? [{ code: 'FORCED', message: `forced status ${forceStatus}` }] : [] });
      const count = input.candidateCount || 3;
      const rec = input.recommendations && input.recommendations[0];
      const candidates = [];
      for (let i = 0; i < count; i += 1) {
        const shape = candidateShapes[i % candidateShapes.length];
        candidates.push(createAngleCandidate(shape(input.topic, rec)));
      }
      return createAngleCandidatesResult({ status: 'COMPLETED', model: 'fake-creative-brain', usage: { inputTokens: 200, outputTokens: 150 }, candidates });
    },

    async synthesizeDirection(input) {
      if (forceDirectionStatus) return createDirectionSynthesisResult({ status: forceDirectionStatus, model: 'fake-creative-brain', diagnostics: forceDirectionStatus !== 'COMPLETED' ? [{ code: 'FORCED', message: `forced status ${forceDirectionStatus}` }] : [] });
      const angle = input.selectedAngle || {};
      return createDirectionSynthesisResult({
        status: 'COMPLETED',
        model: 'fake-creative-brain',
        usage: { inputTokens: 300, outputTokens: 400 },
        narrativeStrategy: `Build from the everyday moment in "${angle.hookStrategy || 'the hook'}" toward the reframed promise in "${angle.corePromise || 'the core promise'}".`,
        pacingStrategy: 'Slow open on a concrete scene, accelerate through evidence, land on the reframed insight.',
        tone: 'Grounded, specific, slightly wry',
        emotionalArc: 'Curiosity at the open, quiet unease through the middle, clarity at the close',
        visualDirection: 'Handheld-feeling still images with warm, slightly desaturated color, cutting to a cleaner composition at the reframe',
        visualSpecification: {
          composition: 'Off-center subject placement, negative space favoring the direction of implied motion',
          palette: 'Warm neutral base, one cool accent introduced at the reframe',
          lighting: 'Low, directional, practical-source-motivated',
          texture: 'Slight grain, avoid glossy/synthetic sheen',
          depth: 'Shallow depth of field on close subjects, deeper on wide establishing frames',
          cameraLanguage: 'Mostly static/locked, one slow push-in at the emotional turn',
          subjectTreatment: 'Naturalistic, unposed-feeling',
          environmentalTreatment: 'Lived-in, specific locations rather than generic backdrops',
          visualDensity: 'Sparse — one clear focal element per frame',
          motionLanguage: 'Minimal, deliberate; no gratuitous camera movement',
          typography: 'Understated, used only for the reframe moment',
          negativeConstraints: 'No stock-photo composition, no centered-subject-with-blurred-background cliche',
        },
        narrationStrategy: 'First-person-adjacent, conversational but precise, no rhetorical-question openers',
        narrationText: `${angle.hookStrategy || 'It starts small.'} ${angle.corePromise || ''}`.trim(),
      });
    },
  };
}

module.exports = { createFakeCreativeBrainProvider, ANGLE_SHAPES };
