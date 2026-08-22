// Tests for schemas/human-voice-profile-schema.js and services/human-
// voice-profile-service.js — CREATIVE BRAIN, Part 6/7. Real deterministic
// aggregation over a real (synthetic-but-real-text) discussion corpus —
// never a mocked aggregator.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHumanVoiceProfile, VOICE_PATTERN_DIMENSIONS, createVoicePatternEntry } = require('../schemas/human-voice-profile-schema');
const { buildHumanVoiceProfile, MIN_ABSOLUTE_SUPPORT_COUNT, MIN_DISCUSSION_ITEM_COUNT, isBoilerplateItem } = require('../services/human-voice-profile-service');

function makeItems(n, textFn) {
  return Array.from({ length: n }, (_, i) => ({ externalId: `t${i}`, platform: 'REDDIT', kind: 'POST', text: textFn(i), score: 5, retrievedAt: new Date().toISOString() }));
}

// --- schema ---------------------------------------------------------------

test('1. createHumanVoiceProfile() produces all 15 pattern dimensions as empty arrays by default', () => {
  const p = createHumanVoiceProfile({ projectId: 'p1', topic: 't' });
  assert.equal(VOICE_PATTERN_DIMENSIONS.length, 15);
  for (const dim of VOICE_PATTERN_DIMENSIONS) assert.deepEqual(p[dim], []);
  assert.equal(p.status, 'COMPLETE');
  assert.deepEqual(p.sourceThreadIds, []);
});

test('2. createVoicePatternEntry never stores raw text fields — only pattern/supportCount/exampleThreadIds', () => {
  const entry = createVoicePatternEntry({ pattern: 'abstracted signal', supportCount: 5, exampleThreadIds: ['a', 'b'] });
  assert.deepEqual(Object.keys(entry).sort(), ['exampleThreadIds', 'id', 'pattern', 'supportCount'].sort());
});

test('3. a supplied dimension array is correctly mapped through createVoicePatternEntry, not overwritten by raw input', () => {
  const p = createHumanVoiceProfile({ projectId: 'p1', vocabulary: [{ pattern: 'x', supportCount: 3, exampleThreadIds: ['a'] }] });
  assert.equal(p.vocabulary.length, 1);
  assert.equal(p.vocabulary[0].pattern, 'x');
  assert.ok(p.vocabulary[0].id);
});

// --- aggregation service ---------------------------------------------------

test('4. buildHumanVoiceProfile FAILS with no items', () => {
  const p = buildHumanVoiceProfile('proj', { topic: 't', items: [] });
  assert.equal(p.status, 'FAILED');
  assert.equal(p.diagnostics[0].code, 'ACQUISITION_FAILED');
});

test('5. fewer than MIN_DISCUSSION_ITEM_COUNT items -> PARTIAL, never fabricated up to a minimum', () => {
  const items = makeItems(2, () => 'I struggled with this for years. Honestly, does anyone else feel this way?');
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.status, 'PARTIAL');
  assert.equal(p.diagnostics[0].code, 'INSUFFICIENT_DISCUSSION_VOLUME');
});

test('6. a vulnerability marker repeated across >= MIN_ABSOLUTE_SUPPORT_COUNT items produces a real pattern entry with real exampleThreadIds', () => {
  const items = makeItems(6, (i) => `I struggled with this for years, item ${i}.`);
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.status, 'COMPLETE');
  const entry = p.vulnerability.find((e) => e.pattern === 'i struggled');
  assert.ok(entry, 'expected an "i struggled" vulnerability pattern');
  assert.ok(entry.supportCount >= MIN_ABSOLUTE_SUPPORT_COUNT);
  assert.ok(entry.exampleThreadIds.every((id) => items.some((it) => it.externalId === id)));
});

test('7. a pattern appearing fewer than MIN_ABSOLUTE_SUPPORT_COUNT times across the corpus is EXCLUDED — "one post is not a voice"', () => {
  const items = [
    ...makeItems(1, () => 'lol this is hilarious'),
    ...makeItems(6, (i) => `just a plain statement number ${i} with no markers`).map((it, idx) => ({ ...it, externalId: `p${idx}` })),
  ];
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.humour.length, 0, 'a single "lol" post must not become a pattern');
});

test('8. audienceQuestions groups by the DISTINCT question text, not by "any question"', () => {
  const items = [
    ...makeItems(4, () => 'Does anyone else feel this way?'),
    ...makeItems(2, () => 'Is this normal for everyone?'),
  ].map((it, idx) => ({ ...it, externalId: `q${idx}` }));
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  const q1 = p.audienceQuestions.find((e) => e.pattern === 'Does anyone else feel this way?');
  assert.ok(q1);
  assert.equal(q1.supportCount, 4);
  assert.ok(!p.audienceQuestions.find((e) => e.pattern === 'Is this normal for everyone?'), '2 occurrences is below MIN_ABSOLUTE_SUPPORT_COUNT (3)');
});

test('9. clichesToAvoid detects a repeated filler phrase across the corpus', () => {
  const items = makeItems(5, () => 'At the end of the day, it just is what it is for me.');
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.ok(p.clichesToAvoid.find((e) => e.pattern === 'at the end of the day'));
});

test('10. vocabulary counts a term at most ONCE per item — a verbose single post cannot dominate supportCount', () => {
  const items = [
    { externalId: 'verbose', platform: 'REDDIT', kind: 'POST', text: 'quit quit quit quit quit quit quit quit quit quit', score: 1, retrievedAt: new Date().toISOString() },
    ...makeItems(4, () => 'quit once and mean it').map((it, idx) => ({ ...it, externalId: `v${idx}` })),
  ];
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  const quitEntry = p.vocabulary.find((e) => e.pattern === 'quit');
  assert.ok(quitEntry);
  assert.equal(quitEntry.supportCount, 5, 'one verbose post contributes exactly 1 toward supportCount, not 10');
});

test('11. sourceThreadIds contains every distinct real externalId in the corpus, deduplicated', () => {
  const items = makeItems(5, () => 'a real post');
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.sourceThreadIds.length, 5);
  assert.equal(new Set(p.sourceThreadIds).size, 5);
});

test('12. emotionalPatterns and vulnerability are genuinely DISTINCT marker sets, not the same extraction reused', () => {
  const items = makeItems(6, () => 'I felt so frustrated about this whole thing honestly.');
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.ok(p.emotionalPatterns.find((e) => e.pattern === 'frustrated'));
});

// --- P0 Golden Run Blocker Repair, Part 4 — bot/moderator boilerplate filtering ---
//
// Golden Run #001's real, live Reddit corpus for "Got any hobbies?" had
// languagePatterns/idioms/recurringFraming dominated by Reddit's own
// standard AutoModerator footer text, not genuine human voice. These
// tests use the ACTUAL boilerplate text observed live (near-verbatim).

const AUTOMOD_TEXT =
  "I am a bot, and this action was performed automatically. Please contact the moderators of this subreddit if you have any questions or concerns. This subreddit is powered entirely by volunteers, please be patient.";

test('14. isBoilerplateItem recognizes the real, observed AutoModerator footer text', () => {
  assert.equal(isBoilerplateItem({ text: AUTOMOD_TEXT }), true);
  assert.equal(isBoilerplateItem({ text: 'I struggled with this for years, honestly.' }), false);
});

test('15. a corpus containing bot/moderator boilerplate never lets it dominate vocabulary/idioms/recurringFraming — a real human pattern still surfaces cleanly', () => {
  const items = [
    ...makeItems(7, () => AUTOMOD_TEXT),
    ...makeItems(6, (i) => `I struggled with this for years, item ${i}.`),
  ].map((it, idx) => ({ ...it, externalId: `b${idx}` }));
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.status, 'COMPLETE');
  assert.ok(
    !p.idioms.some((e) => e.pattern.includes('performed automatically') || e.pattern.includes('contact the moderators')),
    'bot boilerplate n-grams must never appear in idioms'
  );
  assert.ok(
    !p.recurringFraming.some((e) => e.pattern.includes('performed automatically') || e.pattern.includes('contact the moderators')),
    'bot boilerplate n-grams must never appear in recurringFraming'
  );
  assert.ok(p.vulnerability.find((e) => e.pattern === 'i struggled'), 'the genuine human pattern must still surface');
  assert.ok(!p.sourceThreadIds.some((id) => id.startsWith('b') && Number(id.slice(1)) < 7), 'boilerplate items must be excluded from sourceThreadIds too');
});

test('16. a corpus that is ENTIRELY bot/moderator boilerplate fails honestly (ACQUISITION_FAILED), never builds a hollow profile', () => {
  const items = makeItems(6, () => AUTOMOD_TEXT);
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.status, 'FAILED');
  assert.equal(p.diagnostics[0].code, 'ACQUISITION_FAILED');
});

test('17. INSUFFICIENT_DISCUSSION_VOLUME is computed from GENUINE items only, not the raw acquired count (padding with boilerplate must not hide a real shortage)', () => {
  const items = [
    ...makeItems(20, () => AUTOMOD_TEXT), // plenty of raw items...
    ...makeItems(2, (i) => `real human comment number ${i} about hobbies.`).map((it, idx) => ({ ...it, externalId: `real${idx}` })), // ...but only 2 genuine
  ];
  const p = buildHumanVoiceProfile('proj', { topic: 't', items });
  assert.equal(p.status, 'PARTIAL');
  assert.equal(p.diagnostics[0].code, 'INSUFFICIENT_DISCUSSION_VOLUME');
  assert.match(p.diagnostics[0].message, /only 2 real discussion items/);
});

test('13. security — human-voice-profile-service.js has no network call, no eval, no shell exec', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/human-voice-profile-service.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/\beval\s*\(/.test(src));
  assert.ok(!/child_process/.test(src));
});
