// story-architecture-evaluator.js
//
// STORY ARCHITECTURE ENGINE, Part 11 — evaluates ONE StoryArgument against
// 8 INDEPENDENT structural/editorial dimensions (the exact list the phase
// brief names), each PASS/FAIL/WARN, never a combined score — same locked
// convention as every other evaluator in this codebase (creative-
// evaluation-service.js, idea-engine/idea-evaluation-service.js,
// packaging-engine/packaging-evaluation-service.js).
//
// NEVER a retention/CTR/engagement prediction anywhere in this file
// (phase brief, Part 11 explicit instruction) — every dimension checks a
// STRUCTURAL property of the argument (do referenced ids resolve, is a
// question ever resolved, is a claim distinct from its siblings), never a
// claim about how an audience will behave.

const { findDuplicateBeats, findBeatsWithNoNewInformation, compareClaims } = require('./distinctness-checker');

function result(dimension, code, res, detail) {
  return { dimension, code, result: res, detail };
}

function orderedBeats(storyArgument) {
  return (storyArgument.beats || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

// --- promiseAlignment: does the PAYOFF beat's claim actually relate to
// storyArgument.payoff (the field it was supposed to be bound to)? A real
// intelligent provider could drift; this check exists so drift is caught
// structurally rather than assumed away. ---
function evaluatePromiseAlignment(storyArgument) {
  const payoffBeat = (storyArgument.beats || []).find((b) => b.isPayoff);
  if (!payoffBeat) return [result('promiseAlignment', 'NO_PAYOFF_BEAT', 'FAIL', 'no beat is flagged isPayoff')];
  if (!storyArgument.payoff) return [result('promiseAlignment', 'MISSING_PAYOFF_FIELD', 'FAIL', 'storyArgument.payoff is empty')];
  const { similarity } = compareClaims(payoffBeat.claim, storyArgument.payoff);
  return [result('promiseAlignment', 'PAYOFF_BEAT_DRIFTS_FROM_ARGUMENT', similarity > 0 ? 'PASS' : 'FAIL', similarity > 0 ? `payoff beat's claim shares concept-tokens with storyArgument.payoff (similarity ${Math.round(similarity * 100)}%)` : "payoff beat's claim shares nothing with storyArgument.payoff")];
}

// --- storyProgression: beats must be sequentially ordered with no gaps/
// duplicates, and at least one HOOK-role beat must precede the reveal. ---
function evaluateStoryProgression(storyArgument) {
  const beats = orderedBeats(storyArgument);
  const results = [];
  const orders = beats.map((b) => b.order);
  const expected = beats.map((_, i) => i + 1);
  const wellOrdered = JSON.stringify(orders) === JSON.stringify(expected);
  results.push(result('storyProgression', 'NON_SEQUENTIAL_ORDER', wellOrdered ? 'PASS' : 'FAIL', wellOrdered ? 'beat order is a clean 1..N sequence' : `beat order is not sequential: ${JSON.stringify(orders)}`));

  const revealIndex = beats.findIndex((b) => b.isReveal);
  const setupIndex = beats.findIndex((b) => b.isSetup);
  const revealAfterSetup = revealIndex === -1 || setupIndex === -1 ? null : revealIndex > setupIndex;
  results.push(
    result(
      'storyProgression',
      'REVEAL_BEFORE_SETUP',
      revealAfterSetup === false ? 'FAIL' : 'PASS',
      revealAfterSetup === null ? 'no reveal or setup beat present — not evaluable' : revealAfterSetup ? 'reveal occurs after setup, as required' : 'reveal occurs before setup'
    )
  );
  return results;
}

// --- beatDistinctness: reuses distinctness-checker.js's own pairwise +
// no-new-information detectors verbatim. ---
function evaluateBeatDistinctness(storyArgument) {
  const beats = storyArgument.beats || [];
  const duplicates = findDuplicateBeats(beats);
  const noNewInfo = findBeatsWithNoNewInformation(beats);
  const results = [];
  results.push(
    result(
      'beatDistinctness',
      'DUPLICATE_OR_NEAR_DUPLICATE_BEATS',
      duplicates.length === 0 ? 'PASS' : 'FAIL',
      duplicates.length === 0
        ? 'no two substantive beats share a near-duplicate claim/purpose/visualObjective'
        : duplicates.map((d) => `${d.field}: beat ${d.beatKeyA.slice(0, 8)} vs ${d.beatKeyB.slice(0, 8)} (${Math.round(d.similarity * 100)}% similar${d.exact ? ', EXACT match' : ''})`).join('; ')
    )
  );
  results.push(
    result(
      'beatDistinctness',
      'NO_NEW_INFORMATION',
      noNewInfo.length === 0 ? 'PASS' : 'FAIL',
      noNewInfo.length === 0 ? 'every beat contributes at least one new concept-token beyond every earlier beat combined' : noNewInfo.map((f) => `beat ${f.beatKey.slice(0, 8)} adds nothing new (${Math.round(f.coverage * 100)}% already covered)`).join('; ')
    )
  );
  return results;
}

// --- questionContinuity: every question created is either resolved by
// some beat, or is a genuinely allowed OPEN state — WARN, not FAIL, for a
// question left open (an intentionally unresolved loop is a real,
// legitimate narrative choice, not automatically a defect). FAIL only for
// a structurally broken reference (resolvedByBeatKey/createdByBeatKey that
// doesn't resolve to a real beat). ---
function evaluateQuestionContinuity(storyArgument) {
  const beatKeys = new Set((storyArgument.beats || []).map((b) => b.beatKey));
  const results = [];
  for (const q of storyArgument.questions || []) {
    if (q.createdByBeatKey && !beatKeys.has(q.createdByBeatKey)) {
      results.push(result('questionContinuity', 'DANGLING_QUESTION_REFERENCE', 'FAIL', `question "${q.questionId}" createdByBeatKey does not resolve to a real beat`));
      continue;
    }
    if (q.resolvedByBeatKey && !beatKeys.has(q.resolvedByBeatKey)) {
      results.push(result('questionContinuity', 'DANGLING_QUESTION_REFERENCE', 'FAIL', `question "${q.questionId}" resolvedByBeatKey does not resolve to a real beat`));
      continue;
    }
    if (q.status === 'RESOLVED' && !q.resolvedByBeatKey) {
      results.push(result('questionContinuity', 'RESOLVED_WITHOUT_REFERENCE', 'FAIL', `question "${q.questionId}" is marked RESOLVED but names no resolvedByBeatKey`));
      continue;
    }
    if (q.status === 'OPEN') {
      results.push(result('questionContinuity', 'QUESTION_LEFT_OPEN', 'WARN', `question "${q.questionId}" ("${q.text}") is never resolved — a deliberate open loop, or a gap`));
      continue;
    }
    results.push(result('questionContinuity', 'QUESTION_CONTINUITY_OK', 'PASS', `question "${q.questionId}" is created and resolved by real beats`));
  }
  if ((storyArgument.questions || []).length === 0) {
    results.push(result('questionContinuity', 'NO_QUESTIONS_TRACKED', 'WARN', 'this StoryArgument tracks no questions at all — no open-loop structure to evaluate'));
  }
  return results;
}

// --- revealLinkage: the/each reveal-flagged beat must structurally
// resolve at least one real question. ---
function evaluateRevealLinkage(storyArgument) {
  const revealBeats = (storyArgument.beats || []).filter((b) => b.isReveal);
  if (revealBeats.length === 0) return [result('revealLinkage', 'NO_REVEAL_BEAT', 'FAIL', 'no beat is flagged isReveal')];
  const results = [];
  for (const beat of revealBeats) {
    const resolvesReal = Array.isArray(beat.resolves) && beat.resolves.length > 0;
    results.push(result('revealLinkage', 'REVEAL_RESOLVES_NOTHING', resolvesReal ? 'PASS' : 'FAIL', resolvesReal ? `reveal beat "${beat.beatKey.slice(0, 8)}" resolves ${beat.resolves.length} question(s)` : `reveal beat "${beat.beatKey.slice(0, 8)}" has an empty resolves[] — a reveal that resolves nothing`));
  }
  return results;
}

// --- payoffLinkage: the/each payoff-flagged beat must structurally
// reference (paysOffBeatKeys) at least one real, earlier beat. ---
function evaluatePayoffLinkage(storyArgument) {
  const beats = orderedBeats(storyArgument);
  const beatIndexByKey = new Map(beats.map((b, i) => [b.beatKey, i]));
  const payoffBeats = beats.filter((b) => b.isPayoff);
  if (payoffBeats.length === 0) return [result('payoffLinkage', 'NO_PAYOFF_BEAT', 'FAIL', 'no beat is flagged isPayoff')];
  const results = [];
  for (const beat of payoffBeats) {
    const refs = Array.isArray(beat.paysOffBeatKeys) ? beat.paysOffBeatKeys : [];
    if (refs.length === 0) {
      results.push(result('payoffLinkage', 'PAYOFF_REFERENCES_NOTHING', 'FAIL', `payoff beat "${beat.beatKey.slice(0, 8)}" has an empty paysOffBeatKeys[]`));
      continue;
    }
    const dangling = refs.filter((k) => !beatIndexByKey.has(k));
    const notEarlier = refs.filter((k) => beatIndexByKey.has(k) && beatIndexByKey.get(k) >= beatIndexByKey.get(beat.beatKey));
    if (dangling.length > 0) {
      results.push(result('payoffLinkage', 'DANGLING_PAYOFF_REFERENCE', 'FAIL', `payoff beat "${beat.beatKey.slice(0, 8)}" references non-existent beat(s): ${dangling.join(', ')}`));
    } else if (notEarlier.length > 0) {
      results.push(result('payoffLinkage', 'PAYOFF_REFERENCES_LATER_BEAT', 'FAIL', `payoff beat "${beat.beatKey.slice(0, 8)}" references a beat that is not earlier in sequence`));
    } else {
      results.push(result('payoffLinkage', 'PAYOFF_LINKAGE_OK', 'PASS', `payoff beat "${beat.beatKey.slice(0, 8)}" pays off ${refs.length} real, earlier beat(s)`));
    }
  }
  return results;
}

// --- contentCoverage: every one of the 6 StoryArgument top-level content
// fields must be referenced (concept-token overlap) by at least one
// beat's claim — catches a field the provider generated but no beat ever
// actually used (template drift). ---
const CONTENT_FIELDS = ['coreQuestion', 'stakes', 'startingBelief', 'reframedBelief', 'mechanism', 'payoff'];
function evaluateContentCoverage(storyArgument) {
  const beatClaims = (storyArgument.beats || []).map((b) => b.claim || '');
  const results = [];
  for (const field of CONTENT_FIELDS) {
    const fieldText = storyArgument[field];
    if (!fieldText) {
      results.push(result('contentCoverage', 'EMPTY_CONTENT_FIELD', 'FAIL', `storyArgument.${field} is empty`));
      continue;
    }
    const referenced = beatClaims.some((claim) => compareClaims(claim, fieldText).similarity > 0);
    results.push(result('contentCoverage', 'ORPHANED_CONTENT_FIELD', referenced ? 'PASS' : 'FAIL', referenced ? `storyArgument.${field} is used by at least one beat's claim` : `storyArgument.${field} is generated but no beat's claim references it`));
  }
  return results;
}

// --- visualObjectiveSpecificity: a beat's visual objective must actually
// relate to ITS OWN claim (concept-token overlap > 0), and must not be one
// of Phase 1's old fixed, role-only canned sentences (a regression guard —
// this dimension exists specifically because Phase 1's visualMode/
// visualPriority were found to be role-determined, not content-specific). ---
const PHASE_1_CANNED_VISUAL_PHRASES = [
  'primary — must land in the first beat',
  'supports the hook — should not compete with it',
  'the payoff moment — must be visually distinct',
  'closing — should feel resolved',
];
function evaluateVisualObjectiveSpecificity(storyArgument) {
  const results = [];
  for (const beat of storyArgument.beats || []) {
    const text = beat.visualObjective && beat.visualObjective.visualObjective;
    if (!text) {
      results.push(result('visualObjectiveSpecificity', 'MISSING_VISUAL_OBJECTIVE', 'FAIL', `beat "${beat.beatKey.slice(0, 8)}" has no visualObjective text`));
      continue;
    }
    const { similarity } = compareClaims(text, beat.claim || '');
    const isCanned = PHASE_1_CANNED_VISUAL_PHRASES.some((canned) => text.trim() === canned);
    if (isCanned) {
      results.push(result('visualObjectiveSpecificity', 'CANNED_ROLE_ONLY_PHRASE', 'FAIL', `beat "${beat.beatKey.slice(0, 8)}"'s visualObjective is one of Phase 1's fixed role-only phrases, not content-derived`));
    } else {
      results.push(result('visualObjectiveSpecificity', 'VISUAL_OBJECTIVE_UNRELATED_TO_CLAIM', similarity > 0 ? 'PASS' : 'WARN', similarity > 0 ? `visualObjective shares concept-tokens with this beat's own claim (similarity ${Math.round(similarity * 100)}%)` : 'visualObjective shares no concept-tokens with this beat\'s own claim — may be generic'));
    }
  }
  return results;
}

// Evaluates ONE StoryArgument across all 8 dimensions.
function evaluateStoryArgument(storyArgument) {
  return [
    ...evaluatePromiseAlignment(storyArgument),
    ...evaluateStoryProgression(storyArgument),
    ...evaluateBeatDistinctness(storyArgument),
    ...evaluateQuestionContinuity(storyArgument),
    ...evaluateRevealLinkage(storyArgument),
    ...evaluatePayoffLinkage(storyArgument),
    ...evaluateContentCoverage(storyArgument),
    ...evaluateVisualObjectiveSpecificity(storyArgument),
  ];
}

module.exports = {
  CONTENT_FIELDS,
  PHASE_1_CANNED_VISUAL_PHRASES,
  evaluateStoryArgument,
};
