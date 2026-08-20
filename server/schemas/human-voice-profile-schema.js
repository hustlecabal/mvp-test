// human-voice-profile-schema.js
//
// CREATIVE BRAIN — HumanVoiceProfile. Aggregate signals derived from a
// real public-discussion corpus (acquired via services/human-voice/
// discussion-acquisition-provider-interface.js), never a dump of raw
// posts.
//
// THE HARD RULE THIS SCHEMA ENFORCES STRUCTURALLY: individual discussion
// text is evidence FOR a pattern, never a script template. Every pattern
// array below stores a short, ABSTRACTED `pattern` string plus a
// `supportCount` and `exampleThreadIds[]` (references only) — never the
// raw post/comment body. This mirrors schemas/cross-video-pattern-
// schema.js's own Pattern.support[] discipline (recurring signal +
// evidence references, never a copy of the underlying material) applied
// to a discussion corpus instead of a reference-video set.
//
// MIN_ABSOLUTE_SUPPORT_COUNT (services/human-voice-profile-service.js)
// guards against a single post becoming "the voice" — same principle as
// cross-video-pattern-service.js's own MIN_ABSOLUTE_SUPPORT_COUNT for
// ReferenceSet patterns.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const HUMAN_VOICE_PROFILE_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED'];

// Every one of these is a PatternEntry array (createVoicePatternEntry) —
// one shape reused across all 15 dimensions, matching the codebase's own
// "one shape per repeated concept" convention (e.g. reference-video-
// measurement-schema.js reusing one distribution shape everywhere).
const VOICE_PATTERN_DIMENSIONS = [
  'languagePatterns',
  'vocabulary',
  'idioms',
  'emotionalPatterns',
  'emotionalTransitions',
  'recurringExperiences',
  'recurringTensions',
  'conversationPatterns',
  'humour',
  'disagreement',
  'vulnerability',
  'uncertainty',
  'audienceQuestions',
  'recurringFraming',
  'clichesToAvoid',
];

function createVoicePatternEntry(overrides = {}) {
  const { exampleThreadIds, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    pattern: '', // the abstracted signal itself — never a verbatim quote
    supportCount: 0,
    exampleThreadIds: Array.isArray(exampleThreadIds) ? [...exampleThreadIds] : [], // references into the acquired corpus only
  };
  return withDefaults(base, rest);
}

const HUMAN_VOICE_PROFILE_DIAGNOSTIC_CODES = [
  'ACQUISITION_FAILED',
  'ACQUISITION_UNAVAILABLE',
  'INSUFFICIENT_DISCUSSION_VOLUME', // fewer real threads than MIN_THREAD_COUNT — profile still built, marked PARTIAL, never fabricated up to a minimum
  'NORMALIZATION_FAILED',
];

function createHumanVoiceProfileDiagnostic(overrides = {}) {
  return withDefaults({ code: null, message: '' }, overrides);
}

function createHumanVoiceProfile(overrides = {}) {
  const { diagnostics, sourceThreadIds, sourceQueryIds, ...withoutMeta } = overrides;
  const dimensionValues = {};
  for (const dimension of VOICE_PATTERN_DIMENSIONS) {
    if (dimension in withoutMeta) {
      dimensionValues[dimension] = withoutMeta[dimension];
      delete withoutMeta[dimension];
    }
  }
  const rest = withoutMeta;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    topic: '', // the query topic this profile was built for
    platform: null, // e.g. 'REDDIT' — which discussion-acquisition provider produced sourceThreadIds
    status: 'COMPLETE', // one of HUMAN_VOICE_PROFILE_STATUSES
    sourceThreadIds: Array.isArray(sourceThreadIds) ? [...sourceThreadIds] : [], // real, acquired DiscussionThread ids — provenance, never copied content
    sourceQueryIds: Array.isArray(sourceQueryIds) ? [...sourceQueryIds] : [],
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createHumanVoiceProfileDiagnostic(d)) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  for (const dimension of VOICE_PATTERN_DIMENSIONS) {
    base[dimension] = Array.isArray(dimensionValues[dimension]) ? dimensionValues[dimension].map((p) => createVoicePatternEntry(p)) : [];
  }
  return withDefaults(base, rest);
}

module.exports = {
  HUMAN_VOICE_PROFILE_STATUSES,
  VOICE_PATTERN_DIMENSIONS,
  HUMAN_VOICE_PROFILE_DIAGNOSTIC_CODES,
  createVoicePatternEntry,
  createHumanVoiceProfileDiagnostic,
  createHumanVoiceProfile,
};
