// Tests for services/story-architecture/distinctness-checker.js — STORY
// ARCHITECTURE ENGINE, Part 4. Pure functions, no store/env setup needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareClaims, findDuplicateBeats, findBeatsWithNoNewInformation, NEAR_DUPLICATE_THRESHOLD } = require('../services/story-architecture/distinctness-checker');

test('1. compareClaims: identical strings are exact matches', () => {
  const { similarity, exact } = compareClaims('More options make decisions harder.', 'More options make decisions harder.');
  assert.equal(exact, true);
  assert.equal(similarity, 1);
});

test('2. THE PHASE BRIEF\'S OWN WORKED EXAMPLE: "More options make decisions harder." vs "Having more options makes choosing difficult." are flagged as near-duplicates via concept normalization, not literal string equality', () => {
  const a = 'More options make decisions harder.';
  const b = 'Having more options makes choosing difficult.';
  const { similarity, exact } = compareClaims(a, b);
  assert.equal(exact, false, 'these are NOT literally identical strings');
  assert.ok(similarity >= NEAR_DUPLICATE_THRESHOLD, `expected similarity >= ${NEAR_DUPLICATE_THRESHOLD}, got ${similarity}`);
});

test('3. THE PHASE BRIEF\'S OWN GOOD EXAMPLE: two beats that genuinely advance the argument score LOW similarity', () => {
  const a = 'More options increase the number of comparisons the brain must make.';
  const b = 'That comparison burden continues after the decision, increasing doubt about whether another option was better.';
  const { similarity } = compareClaims(a, b);
  assert.ok(similarity < NEAR_DUPLICATE_THRESHOLD, `expected similarity < ${NEAR_DUPLICATE_THRESHOLD}, got ${similarity}`);
});

test('4. genuinely unrelated sentences score near-zero similarity', () => {
  const { similarity } = compareClaims('The mechanism behind choice overload.', 'Supermarkets place milk at the back of the store.');
  assert.ok(similarity < 0.3);
});

test('5. findDuplicateBeats flags a claim/purpose/visualObjective pair above threshold, across three fields', () => {
  const beats = [
    { beatKey: 'b1', order: 1, claim: 'More options make decisions harder.', purpose: 'setup', visualObjective: { visualObjective: 'show a shelf of products' } },
    { beatKey: 'b2', order: 2, claim: 'Having more options makes choosing difficult.', purpose: 'setup', visualObjective: { visualObjective: 'show a shelf full of products' } },
  ];
  const findings = findDuplicateBeats(beats);
  const fields = new Set(findings.map((f) => f.field));
  assert.ok(fields.has('claim'), 'claim duplication must be flagged');
  assert.ok(fields.has('purpose'), 'identical purpose must be flagged');
});

test('6. findDuplicateBeats finds nothing for genuinely distinct beats', () => {
  const beats = [
    { beatKey: 'b1', order: 1, claim: 'More options increase the number of comparisons the brain must make.', purpose: 'mechanism', visualObjective: { visualObjective: 'a decision tree branching' } },
    { beatKey: 'b2', order: 2, claim: 'That comparison burden continues after the decision, increasing doubt about whether another option was better.', purpose: 'consequence', visualObjective: { visualObjective: 'reactivating rejected options after a choice' } },
  ];
  assert.deepEqual(findDuplicateBeats(beats), []);
});

test('7. beats with no claim (non-substantive) are never compared at all', () => {
  const beats = [
    { beatKey: 'b1', order: 1, claim: null, purpose: 'x' },
    { beatKey: 'b2', order: 2, claim: null, purpose: 'x' },
  ];
  assert.deepEqual(findDuplicateBeats(beats), []);
});

test('8. findBeatsWithNoNewInformation flags a beat whose claim is fully covered by earlier beats and creates no new question', () => {
  const beats = [
    { beatKey: 'b1', order: 1, claim: 'More options increase the number of comparisons the brain must make.', creates: ['q1'] },
    { beatKey: 'b2', order: 2, claim: 'Options increase comparisons the brain has to make.', creates: [] },
  ];
  const findings = findBeatsWithNoNewInformation(beats);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].beatKey, 'b2');
});

test('9. a beat that creates a new question is never flagged, even with high textual overlap', () => {
  const beats = [
    { beatKey: 'b1', order: 1, claim: 'More options increase the number of comparisons the brain must make.', creates: ['q1'] },
    { beatKey: 'b2', order: 2, claim: 'Options increase comparisons the brain has to make.', creates: ['q2'] },
  ];
  assert.deepEqual(findBeatsWithNoNewInformation(beats), []);
});
