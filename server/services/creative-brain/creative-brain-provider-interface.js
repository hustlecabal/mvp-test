// creative-brain-provider-interface.js
//
// CREATIVE BRAIN, Part 21 — the contract every CREATIVE SYNTHESIS
// (reasoning) provider adapter must implement. Mirrors services/
// reference-video/interpretation-provider-interface.js's exact
// convention (REQUIRED_METHODS + assert helper + provider-neutral
// request/result shapes) — the same LLM boundary discipline applied to
// creative generation instead of evidence interpretation.
//
// TWO REQUIRED METHODS, matching Part 24's own "candidate generation is
// ONE call, direction/narration synthesis is a SEPARATE call conditioned
// on the winning angle" design — never a single variable-shape method
// whose result validation would have to branch on an input flag.
//
//   generateAngleCandidates(input) -> AngleCandidatesResult
//   synthesizeDirection(input)     -> DirectionSynthesisResult
//
// PART 21's LLM BOUNDARY, enforced by this file's own shape exactly like
// its interpretation-provider precedent: a provider receives ONLY
// already-abstracted RecommendationSet/HumanVoiceProfile evidence (Part
// 23's "input starvation" — never raw shot timestamps, never raw
// discussion post text) — there is no field anywhere here through which a
// provider could receive network access, a file path, or a tool-call
// capability.

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const REQUIRED_METHODS = ['generateAngleCandidates', 'synthesizeDirection'];

const PROVIDER_RESULT_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'INVALID', 'TIMEOUT', 'FAILED'];

// Part 8/10/12 — the fixed constraint list every provider is told to
// follow, restated here as the one canonical source (mirrors
// INTERPRETATION_CONSTRAINTS's own role exactly).
const CREATIVE_BRAIN_CONSTRAINTS = [
  'Use ONLY the supplied recommendation evidence and human-voice patterns — never invent a statistic, a reference-video detail, or a discussion quote that was not provided.',
  'The angle must say something SPECIFIC about the topic, not restate the topic itself.',
  'Never copy a reference video\'s specific structure (e.g. "close-up then overhead shot at 0:13") — translate any observed PATTERN into an ORIGINAL application, never a template.',
  'Never use an individual discussion post/comment as a script line — human-voice patterns are aggregate signals to inform tone, never verbatim material to insert.',
  'Never introduce a causal or certainty claim ("this causes...", "this guarantees...") that is not directly present in the supplied recommendation evidence.',
  'Never produce a virality/engagement/quality score of any kind.',
  'Never produce a shot-by-shot breakdown — that belongs to Storyboard, out of scope here.',
  'If the supplied evidence is too thin to produce a genuinely specific angle, say so explicitly (via a low-confidence/short rationale) rather than fabricating specificity.',
];

function createCreativeBrainDiagnostic(overrides = {}) {
  return withDefaults({ code: null, message: '' }, overrides);
}

// A single already-abstracted Recommendation's fields — never the full
// record, never its own underlying Pattern/Observation ids beyond what
// the recommendation itself already carries as evidenceSufficiency.
function createRecommendationEvidence(overrides = {}) {
  const base = { recommendationId: null, statement: '', rationale: '', evidenceSufficiency: null };
  return withDefaults(base, overrides);
}

// A single already-abstracted HumanVoiceProfile pattern — the `pattern`
// string only, never exampleThreadIds/raw text (Part 7's own hard rule).
function createVoicePatternEvidence(overrides = {}) {
  const base = { dimension: null, pattern: '', supportCount: 0 };
  return withDefaults(base, overrides);
}

function createAngleCandidatesInput(overrides = {}) {
  const { recommendations, voicePatterns, constraints, ...rest } = overrides;
  const base = {
    topic: '',
    format: null,
    targetDuration: null,
    candidateCount: 3,
    recommendations: Array.isArray(recommendations) ? recommendations.map((r) => createRecommendationEvidence(r)) : [],
    voicePatterns: Array.isArray(voicePatterns) ? voicePatterns.map((v) => createVoicePatternEvidence(v)) : [],
    constraints: Array.isArray(constraints) ? [...constraints] : [...CREATIVE_BRAIN_CONSTRAINTS],
  };
  return withDefaults(base, rest);
}

function createAngleCandidate(overrides = {}) {
  const base = { concept: '', corePromise: '', hookStrategy: '', rationale: '' };
  return withDefaults(base, overrides);
}

function createAngleCandidatesResult(overrides = {}) {
  const { candidates, diagnostics, usage, ...rest } = overrides;
  const base = {
    status: null, // one of PROVIDER_RESULT_STATUSES
    candidates: Array.isArray(candidates) ? candidates.map((c) => createAngleCandidate(c)) : [],
    model: null,
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createCreativeBrainDiagnostic(d)) : [],
    usage: usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null,
  };
  return withDefaults(base, rest);
}

function createDirectionSynthesisInput(overrides = {}) {
  const { recommendations, voicePatterns, constraints, ...rest } = overrides;
  const base = {
    topic: '',
    format: null,
    targetDuration: null,
    selectedAngle: createAngleCandidate(),
    recommendations: Array.isArray(recommendations) ? recommendations.map((r) => createRecommendationEvidence(r)) : [],
    voicePatterns: Array.isArray(voicePatterns) ? voicePatterns.map((v) => createVoicePatternEvidence(v)) : [],
    constraints: Array.isArray(constraints) ? [...constraints] : [...CREATIVE_BRAIN_CONSTRAINTS],
  };
  return withDefaults(base, rest);
}

function createDirectionSynthesisResult(overrides = {}) {
  const { visualSpecification, diagnostics, usage, ...rest } = overrides;
  const base = {
    status: null, // one of PROVIDER_RESULT_STATUSES
    narrativeStrategy: '',
    pacingStrategy: '',
    tone: '',
    emotionalArc: '',
    visualDirection: '',
    visualSpecification: visualSpecification || {
      composition: '',
      palette: '',
      lighting: '',
      texture: '',
      depth: '',
      cameraLanguage: '',
      subjectTreatment: '',
      environmentalTreatment: '',
      visualDensity: '',
      motionLanguage: '',
      typography: '',
      negativeConstraints: '',
    },
    narrationStrategy: '',
    narrationText: '', // the actual narration script text this synthesis call produces (Part 18/19 — no separate script engine exists; this IS the one)
    model: null,
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createCreativeBrainDiagnostic(d)) : [],
    usage: usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null,
  };
  return withDefaults(base, rest);
}

function assertImplementsCreativeBrainProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Creative Brain provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  PROVIDER_RESULT_STATUSES,
  CREATIVE_BRAIN_CONSTRAINTS,
  createCreativeBrainDiagnostic,
  createRecommendationEvidence,
  createVoicePatternEvidence,
  createAngleCandidatesInput,
  createAngleCandidate,
  createAngleCandidatesResult,
  createDirectionSynthesisInput,
  createDirectionSynthesisResult,
  assertImplementsCreativeBrainProviderInterface,
};
