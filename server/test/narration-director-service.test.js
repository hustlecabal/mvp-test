// Tests for services/narration-director-service.js — Stage 26.9. A
// deterministic, provider-neutral service: script + beat context ->
// structured NarrationDirection. No LLM, no TTS, no network, no provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { NARRATIVE_ROLES, DIRECTOR_RULES, directNarration } = require('../services/narration-director-service');
const { createVoiceProfile } = require('../schemas/audio-schema');

function stripLineComments(text) {
  return text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

// --- 1. vocabulary -------------------------------------------------------------------

test('1. NARRATIVE_ROLES is a small, closed vocabulary matching Part 11\'s rules', () => {
  assert.deepEqual(NARRATIVE_ROLES, ['HOOK', 'EXPLANATION', 'REVEAL', 'CONCLUSION', 'TRANSITION', 'OTHER']);
});

test('2. DIRECTOR_RULES has an entry for every NARRATIVE_ROLES value', () => {
  for (const role of NARRATIVE_ROLES) assert.ok(DIRECTOR_RULES[role], `DIRECTOR_RULES missing an entry for ${role}`);
});

// --- 3. missing required fields -------------------------------------------------------------------

test('3. missing scriptRefId fails with MISSING_SCRIPT_REF_ID', () => {
  const r = directNarration({ text: 'hello world' });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'MISSING_SCRIPT_REF_ID');
});

test('4. missing script text fails with MISSING_TEXT', () => {
  const r = directNarration({ scriptRefId: 's1' });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'MISSING_TEXT');
});

test('5. blank/whitespace-only text fails with MISSING_TEXT, not silently accepted', () => {
  const r = directNarration({ scriptRefId: 's1', text: '   ' });
  assert.equal(r.diagnostics[0].code, 'MISSING_TEXT');
});

// --- 6. Director Rules — deterministic role-based defaults (Part 11) -------------------------------------------------------------------

test('6. HOOK role defaults to higher energy and curious tone', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'Something amazing is about to happen.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }] });
  assert.equal(r.status, 'COMPLETED');
  assert.ok(r.delivery.energy >= 7);
  assert.equal(r.delivery.emotionalTone, 'CURIOUS');
});

test('7. EXPLANATION role reduces energy and increases confidence relative to HOOK', () => {
  const hook = directNarration({ scriptRefId: 's1', text: 'Hook text.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }] });
  const explanation = directNarration({ scriptRefId: 's1', text: 'Explanation text.', beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }] });
  assert.ok(explanation.delivery.energy < hook.delivery.energy);
  assert.ok(explanation.delivery.confidence > hook.delivery.confidence);
});

test('8. REVEAL role auto-adds an AFTER_REVEAL pause at the end of the text', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'And that is when everything changed.', beats: [{ beatId: 'b1', narrativeRole: 'REVEAL' }] });
  assert.equal(r.status, 'COMPLETED');
  const revealPause = r.pauses.find((p) => p.reason === 'AFTER_REVEAL');
  assert.ok(revealPause, 'expected an AFTER_REVEAL pause');
  assert.equal(revealPause.afterCharOffset, r.text.length);
  assert.ok(revealPause.durationMs > 0);
});

test('9. CONCLUSION role increases confidence and reduces urgency relative to HOOK', () => {
  const hook = directNarration({ scriptRefId: 's1', text: 'Hook text.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }] });
  const conclusion = directNarration({ scriptRefId: 's1', text: 'Conclusion text.', beats: [{ beatId: 'b1', narrativeRole: 'CONCLUSION' }] });
  assert.ok(conclusion.delivery.confidence > hook.delivery.confidence);
  assert.ok(conclusion.delivery.urgency < hook.delivery.urgency);
});

test('10. QUESTION rule — text ending in "?" gets a curious tone regardless of role', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'But what if everything you knew was wrong?', beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }] });
  assert.equal(r.delivery.emotionalTone, 'CURIOUS');
});

test('11. no beats given falls back to the OTHER/system-default role, never crashes', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'A beatless narration line.' });
  assert.equal(r.status, 'COMPLETED');
  assert.deepEqual(r.beatIds, []);
  assert.deepEqual(r.emotionalArc, []);
  assert.equal(r.delivery.emotionalTone, 'CALM');
});

// --- 12. IMPORTANT_NUMBER auto-emphasis (Part 11 item 4) -------------------------------------------------------------------

test('12. important numeric phrases (currency/percentage/comma-grouped) are auto-marked for STRONG emphasis', () => {
  const r = directNarration({ scriptRefId: 's1', text: "That £100,000 isn't actually worth £100,000." });
  const auto = r.emphasis.filter((e) => e.reason === 'IMPORTANT_NUMBER');
  assert.equal(auto.length, 2);
  for (const e of auto) {
    assert.equal(e.text, '£100,000');
    assert.equal(e.level, 'STRONG');
    assert.equal(r.text.slice(e.charStart, e.charEnd), e.text);
  }
});

test('13. auto-detected important-number emphasis never duplicates an explicit emphasis covering the same exact span', () => {
  const r = directNarration({
    scriptRefId: 's1', text: 'Revenue grew by 25% last year.',
    emphasis: [{ text: '25%', level: 'CONTRAST', reason: 'growth figure' }],
  });
  const spans = r.emphasis.filter((e) => e.text === '25%');
  assert.equal(spans.length, 1, 'expected exactly one emphasis entry covering "25%", not a duplicate');
  assert.equal(spans[0].reason, 'growth figure');
});

// --- 14. Emphasis — deterministic, never fuzzy (Part 5) -------------------------------------------------------------------

test('14. explicit emphasis resolves deterministic charStart/charEnd from exact text', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'The quick brown fox.', emphasis: [{ text: 'quick brown', level: 'MODERATE' }] });
  const e = r.emphasis.find((x) => x.text === 'quick brown');
  assert.equal(e.charStart, 4);
  assert.equal(e.charEnd, 15);
});

test('15. invalid emphasis — text not found in narration text fails with EMPHASIS_TEXT_NOT_FOUND', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', emphasis: [{ text: 'goodbye' }] });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'EMPHASIS_TEXT_NOT_FOUND');
});

test('16. invalid emphasis — ambiguous (repeated) text without an explicit charStart fails with AMBIGUOUS_EMPHASIS_TEXT, never silently guesses', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'go go go', emphasis: [{ text: 'go' }] });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'AMBIGUOUS_EMPHASIS_TEXT');
});

test('17. an explicit charStart disambiguates a repeated phrase', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'go go go', emphasis: [{ text: 'go', charStart: 6, level: 'STRONG' }] });
  assert.equal(r.status, 'COMPLETED');
  const e = r.emphasis.find((x) => x.charStart === 6);
  assert.equal(e.charEnd, 8);
});

test('18. invalid emphasis level fails with INVALID_EMPHASIS', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', emphasis: [{ text: 'hello', level: 'MEGA' }] });
  assert.equal(r.diagnostics[0].code, 'INVALID_EMPHASIS');
});

// --- 19. Pauses -------------------------------------------------------------------

test('19. invalid pause duration (negative) fails with INVALID_PAUSE_DURATION, never allowed', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', pauses: [{ afterText: 'hello', durationMs: -100 }] });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'INVALID_PAUSE_DURATION');
});

test('20. non-numeric pause duration fails with INVALID_PAUSE_DURATION', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', pauses: [{ afterText: 'hello', durationMs: 'long' }] });
  assert.equal(r.diagnostics[0].code, 'INVALID_PAUSE_DURATION');
});

test('21. a zero-duration pause is valid (never rejected)', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', pauses: [{ afterText: 'hello', durationMs: 0 }] });
  assert.equal(r.status, 'COMPLETED');
});

test('22. pause afterText not found fails with PAUSE_TEXT_NOT_FOUND', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', pauses: [{ afterText: 'goodbye', durationMs: 200 }] });
  assert.equal(r.diagnostics[0].code, 'PAUSE_TEXT_NOT_FOUND');
});

test('23. pause resolves a deterministic afterCharOffset immediately following the matched text', () => {
  const r = directNarration({ scriptRefId: 's1', text: "And that's when everything changed. The end.", pauses: [{ afterText: "And that's when everything changed.", durationMs: 650, reason: 'DRAMATIC' }] });
  const p = r.pauses.find((x) => x.reason === 'DRAMATIC');
  assert.equal(p.afterCharOffset, "And that's when everything changed.".length);
});

// --- 24. Pronunciation -------------------------------------------------------------------

test('24. pronunciation notes pass through validated, provider-neutral phonetic guides', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'NVIDIA makes GPUs.', pronunciation: [{ text: 'NVIDIA', pronunciation: 'en-VID-ee-uh' }] });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.pronunciation[0].text, 'NVIDIA');
  assert.equal(r.pronunciation[0].pronunciation, 'en-VID-ee-uh');
});

test('25. an empty pronunciation string fails with INVALID_PRONUNCIATION', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'SQL is a query language.', pronunciation: [{ text: 'SQL', pronunciation: '' }] });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'INVALID_PRONUNCIATION');
});

// --- 26. Timing — target vs actual (Part 9) -------------------------------------------------------------------

test('26. targetDuration is stored as the TARGET, never presented as measured — timing.actual stays null', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', targetDuration: 4.5 });
  assert.equal(r.timing.target.duration, 4.5);
  assert.equal(r.timing.actual, null);
});

test('27. targetWordsPerMinute deterministically derives a target duration from word count, still only a TARGET', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'one two three four five', targetWordsPerMinute: 150 });
  assert.equal(r.timing.target.duration, (5 / 150) * 60);
  assert.equal(r.timing.actual, null);
});

test('28. pauseBudgetMs is the deterministic sum of all resolved pauses\' durationMs', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'One. Two. Three.', pauses: [{ afterText: 'One.', durationMs: 200, reason: 'SENTENCE_BREAK' }, { afterText: 'Two.', durationMs: 300, reason: 'SENTENCE_BREAK' }] });
  assert.equal(r.timing.target.pauseBudgetMs, 500);
});

test('29. invalid timing — a negative targetDuration fails with INVALID_TIMING before any other work happens', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', targetDuration: -3 });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'INVALID_TIMING');
});

test('30. invalid timing — a negative targetStartTime fails with INVALID_TIMING', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', targetStartTime: -1 });
  assert.equal(r.diagnostics[0].code, 'INVALID_TIMING');
});

test('31. invalid timing — a non-positive targetWordsPerMinute fails with INVALID_TIMING', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', targetWordsPerMinute: 0 });
  assert.equal(r.diagnostics[0].code, 'INVALID_TIMING');
});

// --- 32. beat association -------------------------------------------------------------------

test('32. beatIds[] is populated in order from the beats[] input', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'Two beats worth of narration.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }, { beatId: 'b2', narrativeRole: 'EXPLANATION' }] });
  assert.deepEqual(r.beatIds, ['b1', 'b2']);
  assert.equal(r.emotionalArc.length, 2);
  assert.equal(r.emotionalArc[0].beatId, 'b1');
  assert.equal(r.emotionalArc[1].beatId, 'b2');
});

test('33. an invalid narrativeRole fails with INVALID_NARRATIVE_ROLE', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'x', beats: [{ beatId: 'b1', narrativeRole: 'MADE_UP_ROLE' }] });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.diagnostics[0].code, 'INVALID_NARRATIVE_ROLE');
});

test('34. a beats[] entry with no beatId fails with INVALID_BEAT_REFERENCE', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'x', beats: [{ narrativeRole: 'HOOK' }] });
  assert.equal(r.diagnostics[0].code, 'INVALID_BEAT_REFERENCE');
});

// --- 35. VoiceProfile compatibility -------------------------------------------------------------------

test('35. a caller-supplied voiceProfile (built via the existing audio-schema.js factory) is preserved through a tier', () => {
  const vp = createVoiceProfile({ speakingStyle: 'conversational', emotionalTone: 'warm' });
  const r = directNarration({ scriptRefId: 's1', text: 'hello world', channelVoiceBible: { voiceProfile: vp } });
  assert.deepEqual(r.voiceProfile, vp);
});

test('36. no voiceProfile supplied by any tier stays null — never an invented default', () => {
  const r = directNarration({ scriptRefId: 's1', text: 'hello world' });
  assert.equal(r.voiceProfile, null);
});

// --- 37. Override precedence (Part 13) -------------------------------------------------------------------

test('37. precedence — beatOverride wins over videoDirection, which wins over channelVoiceBible, which wins over the system/role default', () => {
  const r = directNarration({
    scriptRefId: 's1', text: 'hello world', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }],
    channelVoiceBible: { delivery: { energy: 3, pace: 'SLOW' } },
    videoDirection: { delivery: { energy: 4 } },
    beatOverride: { delivery: { energy: 5 } },
  });
  assert.equal(r.delivery.energy, 5, 'beatOverride should win for energy');
  assert.equal(r.delivery.pace, 'SLOW', 'channelVoiceBible should win for pace (no higher tier set it)');
});

test('38. a beat-level override changes ONLY the field(s) it sets — every other field keeps its system-derived value', () => {
  const base = directNarration({ scriptRefId: 's1', text: 'A hook line.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }] });
  const overridden = directNarration({ scriptRefId: 's1', text: 'A hook line.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }], beatOverride: { delivery: { energy: 2 } } });
  assert.equal(overridden.delivery.energy, 2);
  assert.notEqual(overridden.delivery.energy, base.delivery.energy);
  for (const field of ['pace', 'emotionalTone', 'intensity', 'confidence', 'warmth', 'urgency', 'conversationality']) {
    assert.equal(overridden.delivery[field], base.delivery[field], `field "${field}" should be unchanged by an energy-only override`);
  }
  assert.deepEqual(overridden.voiceProfile, base.voiceProfile);
  assert.deepEqual(overridden.emphasis, base.emphasis);
  assert.deepEqual(overridden.pauses, base.pauses);
});

test('39. channelVoiceBible/videoDirection tiers DO flow into per-beat emotionalArc stages; beatOverride does not (scoped to the top-level direction only)', () => {
  const r = directNarration({
    scriptRefId: 's1', text: 'x', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }, { beatId: 'b2', narrativeRole: 'CONCLUSION' }],
    channelVoiceBible: { delivery: { warmth: 9 } },
    beatOverride: { delivery: { energy: 1 } },
  });
  assert.equal(r.emotionalArc[0].delivery.warmth, 9);
  assert.equal(r.emotionalArc[1].delivery.warmth, 9);
  assert.notEqual(r.emotionalArc[0].delivery.energy, 1, 'beatOverride must not leak into per-beat emotionalArc stages');
});

// --- 40. Determinism (Part 10/16) -------------------------------------------------------------------

test('40. determinism — identical input produces an identical NarrationDirection (id/timestamp aside)', () => {
  const input = {
    scriptRefId: 's1', text: "That £100,000 isn't actually worth £100,000.",
    beats: [{ beatId: 'b1', narrativeRole: 'REVEAL' }],
    emphasis: [{ text: "isn't actually", level: 'CONTRAST' }],
    targetWordsPerMinute: 150,
    channelVoiceBible: { delivery: { warmth: 7 } },
  };
  const a = directNarration(input);
  const b = directNarration(input);
  const strip = ({ narrationId, createdAt, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(b));
});

test('41. determinism holds across many repeated calls, not just two', () => {
  const input = { scriptRefId: 's1', text: 'Repeated deterministic call.', beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }] };
  const strip = ({ narrationId, createdAt, ...rest }) => JSON.stringify(rest);
  const first = strip(directNarration(input));
  for (let i = 0; i < 10; i += 1) {
    assert.equal(strip(directNarration(input)), first);
  }
});

// --- 42. no crash on malformed input -------------------------------------------------------------------

test('42. malformed beats entries (null, non-array) never throw — always a structured FAILED result', () => {
  assert.doesNotThrow(() => {
    const r1 = directNarration({ scriptRefId: 's1', text: 'x', beats: 'not-an-array' });
    assert.equal(r1.status, 'COMPLETED'); // non-array beats is treated as "no beats", same as omitted
  });
  assert.doesNotThrow(() => {
    const r2 = directNarration({ scriptRefId: 's1', text: 'x', beats: [null] });
    assert.equal(r2.status, 'FAILED');
  });
  assert.doesNotThrow(() => directNarration(undefined));
  assert.doesNotThrow(() => directNarration(null));
});

// --- 43. security (Part 17) -------------------------------------------------------------------

test('43. security — no provider name, API key, network call, eval, or child_process anywhere in the service', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'narration-director-service.js'), 'utf8');
  const text = stripLineComments(fullText);
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../schemas/narration-schema']);
  for (const pattern of [
    /\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/,
    /elevenlabs/i, /whisper/i, /openai/i, /\bazure\b/i, /google.*tts/i, /\bssml\b/i, /apiKey/i, /api_key/i,
  ]) {
    assert.doesNotMatch(text, pattern, `narration-director-service.js must not match ${pattern}`);
  }
});

test('44. no network/provider anywhere in the two Stage 26.9 files as a static byte scan (belt-and-suspenders over test 43/schema test 23)', () => {
  for (const file of [path.join('schemas', 'narration-schema.js'), path.join('services', 'narration-director-service.js')]) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//, `${file} must not contain a literal URL`);
  }
});
