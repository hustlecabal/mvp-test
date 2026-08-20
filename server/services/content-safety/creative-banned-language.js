// creative-banned-language.js
//
// CREATIVE BRAIN, Part 8/26 — a targeted, documented pattern registry for
// generic/synthetic "AI YouTube" writing, scoped to Creative Brain output
// only. Deliberately a NEW, SEPARATE file rather than a refactor of
// services/reference-video-interpretation-service.js's containsBanned
// Language() or services/recommendation-service.js's containsUnsupported
// Language(): both are already-shipped, fully-tested files, and this
// codebase's own established Hard Rule (every stage this session) is
// "don't rewrite working services merely for refactoring convenience."
// This file follows the SAME discipline those two established (a small,
// documented, non-exhaustive marker list — never a brittle universal
// banned-word list as the SOLE mechanism; defense-in-depth alongside the
// specificity/originality/coherence checks in creative-evaluation-
// service.js, never the only anti-slop signal).

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Generic hook/opener phrasing this codebase's own creative quality bar
// (Part 12's worked example) explicitly rejects — "have you ever
// wondered", "in this video", "let's dive in" and their close variants.
const GENERIC_HOOK_PATTERN = /\b(have you ever wondered|in this video[, ]|today we('re| are) (going to|gonna) talk about|let'?s dive (in|into)|without further ado|buckle up|stick around|by the end of this video)\b/i;

// Corporate/filler language — flat, safe, meaningless phrasing.
const CORPORATE_FILLER_PATTERN = /\b(in today'?s (fast-paced|ever-changing) world|it'?s important to note that|at the end of the day|when it comes to|in conclusion|needless to say|it is what it is)\b/i;

// Reuses the EXACT causal/certainty vocabulary already established by
// recommendation-service.js's own containsUnsupportedLanguage() (Part 12
// of INT-1F) — this file does not import that one (different file, same
// discipline, per this file's own header) but the phrase set is
// deliberately identical so a Creative Brain claim is held to the same
// bar an evidence-backed Recommendation already is.
const UNSUPPORTED_CLAIM_PATTERN = /\b(causes?|leads? to|results? in|guarantees?d?|proven to work|will make (you|viewers?)|always (works?|guarantees?)|never fails?|definitely works?)\b/i;

function scanGenericHook(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return GENERIC_HOOK_PATTERN.test(text) ? 'generic hook opener phrasing' : null;
}

function scanCorporateFiller(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return CORPORATE_FILLER_PATTERN.test(text) ? 'corporate/filler language' : null;
}

function scanUnsupportedClaim(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return UNSUPPORTED_CLAIM_PATTERN.test(text) ? 'an unsupported causal/certainty claim' : null;
}

function createBannedLanguageFinding(overrides = {}) {
  return withDefaults({ field: null, reason: null }, overrides);
}

module.exports = {
  GENERIC_HOOK_PATTERN,
  CORPORATE_FILLER_PATTERN,
  UNSUPPORTED_CLAIM_PATTERN,
  scanGenericHook,
  scanCorporateFiller,
  scanUnsupportedClaim,
  createBannedLanguageFinding,
};
