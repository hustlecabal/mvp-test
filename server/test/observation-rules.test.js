// Tests for services/reference-video/observation-rules.js — the rule
// registry. Every rule is exercised against hand-crafted, minimal
// measurement fixtures (not the schema factory's defaults) so each
// assertion is about an EXACT expected statement/confidence/evidence
// value, never merely "a result exists" (Part 21).

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, getRule } = require('../services/reference-video/observation-rules');

function rule(id) {
  const r = getRule(id);
  assert.ok(r, `expected a registered rule "${id}"`);
  return r;
}

test('1. the registry has exactly 20 rules, one per required category, plus the two capability-diagnostic rules', () => {
  assert.equal(rules.length, 20);
  const categories = new Set(rules.map((r) => r.category));
  for (const c of ['TIMING', 'PACING', 'SHOT_RHYTHM', 'NARRATION', 'SPEECH_DENSITY', 'SILENCE', 'OPENING', 'VISUAL_CHANGE', 'TEXT_PRESENCE', 'STRUCTURE']) {
    assert.ok(categories.has(c), `expected at least one rule in category "${c}"`);
  }
});

test('2. every rule declares requiredMeasurementPaths and a non-empty limitations string (Part 15)', () => {
  for (const r of rules) {
    assert.ok(Array.isArray(r.requiredMeasurementPaths) && r.requiredMeasurementPaths.length > 0, `${r.id} must declare requiredMeasurementPaths`);
    assert.ok(typeof r.limitations === 'string' && r.limitations.length > 5, `${r.id} must declare limitations`);
  }
});

// --- VIDEO_DURATION_MEASURED ---
test('3. VIDEO_DURATION_MEASURED reports the exact measured duration and is HIGH confidence', () => {
  const result = rule('VIDEO_DURATION_MEASURED').evaluate({ video: { technical: { duration: 18.947483 } } });
  assert.equal(result.statement, 'The reference video is 18.95 seconds long.');
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.evidence[0].value, 18.947483);
});
test('4. VIDEO_DURATION_MEASURED returns null when duration is missing (negative test)', () => {
  assert.equal(rule('VIDEO_DURATION_MEASURED').evaluate({ video: { technical: { duration: null } } }), null);
  assert.equal(rule('VIDEO_DURATION_MEASURED').evaluate({}), null);
});
test('5. changing the measured duration changes the observation\'s statement accordingly (Part 21 required proof)', () => {
  const a = rule('VIDEO_DURATION_MEASURED').evaluate({ video: { technical: { duration: 10 } } });
  const b = rule('VIDEO_DURATION_MEASURED').evaluate({ video: { technical: { duration: 60 } } });
  assert.notEqual(a.statement, b.statement);
  assert.match(a.statement, /10 seconds/);
  assert.match(b.statement, /60 seconds/);
});

// --- SHOT_COUNT_OBSERVED ---
test('6. SHOT_COUNT_OBSERVED reports LOW confidence for a single detected shot, MEDIUM for multiple', () => {
  const one = rule('SHOT_COUNT_OBSERVED').evaluate({ shots: [{ duration: 5 }], shotRhythm: { shotCount: 1 } });
  assert.equal(one.confidence, 'LOW');
  assert.match(one.statement, /1 detected shot\b/);
  const many = rule('SHOT_COUNT_OBSERVED').evaluate({ shots: [{ duration: 2 }, { duration: 3 }], shotRhythm: { shotCount: 2 } });
  assert.equal(many.confidence, 'MEDIUM');
  assert.match(many.statement, /2 detected shots/);
});
test('7. SHOT_COUNT_OBSERVED returns null for an empty/missing shots array', () => {
  assert.equal(rule('SHOT_COUNT_OBSERVED').evaluate({ shots: [] }), null);
  assert.equal(rule('SHOT_COUNT_OBSERVED').evaluate({}), null);
});

// --- SCENE_OBSERVATION_UNAVAILABLE (diagnostic) ---
test('8. SCENE_OBSERVATION_UNAVAILABLE fires with the real reason text when capability is unavailable, and is silent when available', () => {
  const fired = rule('SCENE_OBSERVATION_UNAVAILABLE').evaluate({ sceneDetectionCapability: { available: false, reason: 'because X' } });
  assert.equal(fired.message, 'because X');
  assert.equal(rule('SCENE_OBSERVATION_UNAVAILABLE').evaluate({ sceneDetectionCapability: { available: true } }), null);
});

// --- SHOT_DURATION_BELOW_THRESHOLD ---
test('9. SHOT_DURATION_BELOW_THRESHOLD computes the exact percentage of shots under 3s from real per-shot durations', () => {
  const shots = [{ duration: 1, confidence: 'MEDIUM' }, { duration: 2, confidence: 'MEDIUM' }, { duration: 5, confidence: 'MEDIUM' }, { duration: 8, confidence: 'MEDIUM' }];
  const result = rule('SHOT_DURATION_BELOW_THRESHOLD').evaluate({ shots, shotRhythm: { durationDistribution: { median: 3.5 } } });
  assert.match(result.statement, /^50% of detected shots \(2 of 4\) are shorter than 3 seconds/);
});
test('10. SHOT_DURATION_BELOW_THRESHOLD returns null with fewer than 3 shots (documented minimum for a meaningful percentage)', () => {
  assert.equal(rule('SHOT_DURATION_BELOW_THRESHOLD').evaluate({ shots: [{ duration: 1 }, { duration: 2 }] }), null);
});
test('11. SHOT_DURATION_BELOW_THRESHOLD confidence is the weakest of its per-shot confidences', () => {
  const shots = [{ duration: 1, confidence: 'MEDIUM' }, { duration: 2, confidence: 'LOW' }, { duration: 5, confidence: 'MEDIUM' }];
  const result = rule('SHOT_DURATION_BELOW_THRESHOLD').evaluate({ shots, shotRhythm: { durationDistribution: { median: 2 } } });
  assert.equal(result.confidence, 'LOW');
});

// --- SHOT_DURATION_SKEW ---
test('12. SHOT_DURATION_SKEW correctly labels right-skew, left-skew, and symmetric distributions from real mean/median comparisons', () => {
  const right = rule('SHOT_DURATION_SKEW').evaluate({ shotRhythm: { durationDistribution: { count: 5, mean: 4, median: 2 } } });
  assert.match(right.statement, /right-skewed/);
  const left = rule('SHOT_DURATION_SKEW').evaluate({ shotRhythm: { durationDistribution: { count: 5, mean: 2, median: 4 } } });
  assert.match(left.statement, /left-skewed/);
  const symmetric = rule('SHOT_DURATION_SKEW').evaluate({ shotRhythm: { durationDistribution: { count: 5, mean: 3, median: 3 } } });
  assert.match(symmetric.statement, /roughly symmetric/);
});
test('13. SHOT_DURATION_SKEW returns null below the 3-shot minimum', () => {
  assert.equal(rule('SHOT_DURATION_SKEW').evaluate({ shotRhythm: { durationDistribution: { count: 2, mean: 3, median: 3 } } }), null);
});

// --- SHOT_COUNT_QUARTER_COMPARISON ---
test('14. SHOT_COUNT_QUARTER_COMPARISON reports the real first/last quarter counts and the correct comparative word', () => {
  const q = [{ shotCount: 3 }, { shotCount: 1 }, { shotCount: 1 }, { shotCount: 1 }];
  const result = rule('SHOT_COUNT_QUARTER_COMPARISON').evaluate({ shotRhythm: { quarterShotCounts: q }, shots: [1, 2, 3, 4, 5, 6] });
  assert.match(result.statement, /first quarter of the video contains 3/);
  assert.match(result.statement, /last quarter contains 1/);
  assert.match(result.statement, /more detected shots than the last/);
});
test('15. SHOT_COUNT_QUARTER_COMPARISON returns null with fewer than 2 total shots', () => {
  assert.equal(rule('SHOT_COUNT_QUARTER_COMPARISON').evaluate({ shotRhythm: { quarterShotCounts: [{ shotCount: 1 }, { shotCount: 0 }, { shotCount: 0 }, { shotCount: 0 }] }, shots: [1] }), null);
});

// --- SPEECH_DENSITY_OVER_VIDEO ---
test('16. SPEECH_DENSITY_OVER_VIDEO reports the exact percentage and copies the source measurement\'s own confidence', () => {
  const result = rule('SPEECH_DENSITY_OVER_VIDEO').evaluate({ transcript: { speechPercentageOfVideo: { value: 76.638, confidence: 'LOW' } } });
  assert.match(result.statement, /76\.6%/);
  assert.equal(result.confidence, 'LOW');
});
test('17. SPEECH_DENSITY_OVER_VIDEO returns null when the value is null', () => {
  assert.equal(rule('SPEECH_DENSITY_OVER_VIDEO').evaluate({ transcript: { speechPercentageOfVideo: { value: null } } }), null);
});

// --- WORDS_PER_MINUTE_OBSERVED ---
test('18. WORDS_PER_MINUTE_OBSERVED reports the exact real WPM value', () => {
  const result = rule('WORDS_PER_MINUTE_OBSERVED').evaluate({ transcript: { wordsPerMinute: { value: 123.499, confidence: 'MEDIUM' } } });
  assert.match(result.statement, /123\.5 words per minute/);
  assert.equal(result.confidence, 'MEDIUM');
});

// --- PAUSE_CONCENTRATION ---
test('19. PAUSE_CONCENTRATION reports real pause count/mean/max and returns null when zero pauses were detected', () => {
  const result = rule('PAUSE_CONCENTRATION').evaluate({ transcript: { pauseCount: { value: 2, confidence: 'MEDIUM' }, pauseDurationDistribution: { mean: 0.9, max: 1.4 } } });
  assert.equal(result.statement, 'The transcript contains 2 detected pause(s), averaging 0.9s (longest: 1.4s).');
  assert.equal(rule('PAUSE_CONCENTRATION').evaluate({ transcript: { pauseCount: { value: 0 }, pauseDurationDistribution: { mean: null, max: null } } }), null);
});

// --- SENTENCE_LENGTH_VARIATION ---
test('20. SENTENCE_LENGTH_VARIATION reports real min/max/median and appends the substantial-variation clause only when range exceeds median', () => {
  const substantial = rule('SENTENCE_LENGTH_VARIATION').evaluate({ transcript: { sentenceLengthDistribution: { count: 3, min: 1, max: 10, median: 3 } } });
  assert.match(substantial.statement, /substantial variation/);
  const notSubstantial = rule('SENTENCE_LENGTH_VARIATION').evaluate({ transcript: { sentenceLengthDistribution: { count: 3, min: 4, max: 6, median: 5 } } });
  assert.doesNotMatch(notSubstantial.statement, /substantial variation/);
});
test('21. SENTENCE_LENGTH_VARIATION returns null with fewer than 2 sentences', () => {
  assert.equal(rule('SENTENCE_LENGTH_VARIATION').evaluate({ transcript: { sentenceLengthDistribution: { count: 1, min: 3, max: 3, median: 3 } } }), null);
});

// --- NARRATION_ONSET ---
test('22. NARRATION_ONSET reports the exact real first-word startTime', () => {
  const result = rule('NARRATION_ONSET').evaluate({ wordTiming: [{ startTime: 1.2, word: 'All' }] });
  assert.match(result.statement, /1\.2 seconds/);
});
test('23. NARRATION_ONSET returns null with no word-level timing at all', () => {
  assert.equal(rule('NARRATION_ONSET').evaluate({ wordTiming: [] }), null);
});

// --- FIRST_SHOT_BOUNDARY ---
test('24. FIRST_SHOT_BOUNDARY reports the exact second shot\'s startTime as the first cut, and returns null for a single shot', () => {
  const result = rule('FIRST_SHOT_BOUNDARY').evaluate({ shots: [{ startTime: 0, endTime: 2 }, { startTime: 2, endTime: 4, confidence: 'MEDIUM' }] });
  assert.match(result.statement, /2 seconds/);
  assert.equal(result.confidence, 'MEDIUM');
  assert.equal(rule('FIRST_SHOT_BOUNDARY').evaluate({ shots: [{ startTime: 0, endTime: 4 }] }), null);
});

// --- OPENING_CUT_DENSITY ---
test('25. OPENING_CUT_DENSITY reports the exact first10s count', () => {
  const result = rule('OPENING_CUT_DENSITY').evaluate({ hook: { openingCutCounts: { first10s: 3 } } });
  assert.equal(result.statement, '3 shot boundary change(s) occur within the first 10 seconds of the video.');
});

// --- OPENING_QUESTION_DETECTED (Part 15's own worked example, verbatim limitation) ---
test('26. OPENING_QUESTION_DETECTED reports the real timestamp/text and states the exact Part-15 limitation wording', () => {
  const r = rule('OPENING_QUESTION_DETECTED');
  const result = r.evaluate({ hook: { firstQuestionMarkTime: 4.7, firstQuestionMarkText: 'Really?' } });
  assert.equal(result.statement, 'The first detected question occurs at 4.7 seconds ("Really?").');
  assert.match(r.limitations, /not a psychological curiosity gap/);
});
test('27. OPENING_QUESTION_DETECTED returns null when no word carries the question mark (time is null even if text is present)', () => {
  assert.equal(rule('OPENING_QUESTION_DETECTED').evaluate({ hook: { firstQuestionMarkTime: null, firstQuestionMarkText: 'Is this real?' } }), null);
});

// --- FIRST_SILENCE_OBSERVED ---
test('28. FIRST_SILENCE_OBSERVED reports the real first interval\'s start/duration', () => {
  const result = rule('FIRST_SILENCE_OBSERVED').evaluate({ audio: { silenceIntervals: [{ startTime: 1.5, endTime: 3, duration: 1.5 }], totalSilenceDuration: { confidence: 'MEDIUM' } } });
  assert.equal(result.statement, 'The first detected audio silence interval begins at 1.5 seconds and lasts 1.5 seconds.');
});
test('29. FIRST_SILENCE_OBSERVED returns null when zero silence intervals were detected (e.g. "Me at the zoo"\'s real result)', () => {
  assert.equal(rule('FIRST_SILENCE_OBSERVED').evaluate({ audio: { silenceIntervals: [] } }), null);
});

// --- SILENCE_PROPORTION ---
test('30. SILENCE_PROPORTION computes silence% as the complement of speech% and reports the weakest confidence', () => {
  const result = rule('SILENCE_PROPORTION').evaluate({ audio: { totalSilenceDuration: { value: 4.4, confidence: 'MEDIUM' }, speechPercentage: { value: 76.6, confidence: 'HIGH' } } });
  assert.match(result.statement, /23\.4%/);
  assert.equal(result.confidence, 'MEDIUM');
});

// --- VISUAL_CHANGE_QUARTER_COMPARISON ---
test('31. VISUAL_CHANGE_QUARTER_COMPARISON compares real sampled means in the first vs last quarter', () => {
  const samples = [
    { time: 0.5, frameDifference: 10 }, { time: 1, frameDifference: 10 }, // first quarter (duration=8, q=2)
    { time: 6.5, frameDifference: 2 }, { time: 7, frameDifference: 2 }, // last quarter (>= 6)
  ];
  const result = rule('VISUAL_CHANGE_QUARTER_COMPARISON').evaluate({ visual: { samples }, video: { technical: { duration: 8 } } });
  assert.match(result.statement, /first quarter \(10\)/);
  assert.match(result.statement, /higher than the last quarter \(2\)/);
});
test('32. VISUAL_CHANGE_QUARTER_COMPARISON returns null with too few samples in a compared quarter', () => {
  const samples = [{ time: 0.5, frameDifference: 10 }];
  assert.equal(rule('VISUAL_CHANGE_QUARTER_COMPARISON').evaluate({ visual: { samples }, video: { technical: { duration: 8 } } }), null);
});

// --- VISUAL_CHANGE_CONSISTENCY ---
test('33. VISUAL_CHANGE_CONSISTENCY correctly labels consistent vs variable from the real IQR/mean ratio', () => {
  const consistent = rule('VISUAL_CHANGE_CONSISTENCY').evaluate({ visual: { frameDifferenceDistribution: { count: 10, mean: 10, p25: 9, p75: 11 } } }); // (11-9)/10 = 0.2 < 0.5
  assert.match(consistent.statement, /relatively consistent/);
  const variable = rule('VISUAL_CHANGE_CONSISTENCY').evaluate({ visual: { frameDifferenceDistribution: { count: 10, mean: 10, p25: 2, p75: 14 } } }); // (14-2)/10 = 1.2 > 0.5
  assert.match(variable.statement, /relatively variable/);
});

// --- SPOKEN_QUESTION_COUNT (Part 10's own worked example) ---
test('34. SPOKEN_QUESTION_COUNT counts real question-ending sentences and NEVER claims on-screen text', () => {
  const result = rule('SPOKEN_QUESTION_COUNT').evaluate({ transcript: { sentences: [{ text: 'Is this real?' }, { text: 'Yes it is.' }, { text: 'Are you sure?' }] } });
  assert.equal(result.statement, 'Spoken narration contains 2 question sentences.');
  assert.doesNotMatch(result.statement, /displays|screen|on-screen/i);
});
test('35. SPOKEN_QUESTION_COUNT returns null when there are no question sentences', () => {
  assert.equal(rule('SPOKEN_QUESTION_COUNT').evaluate({ transcript: { sentences: [{ text: 'Hello there.' }] } }), null);
});

// --- TEXT_PRESENCE_OCR_UNAVAILABLE (diagnostic, Part 10's explicit requirement) ---
test('36. TEXT_PRESENCE_OCR_UNAVAILABLE fires with an explicit statement that on-screen text cannot be observed', () => {
  const result = rule('TEXT_PRESENCE_OCR_UNAVAILABLE').evaluate({ ocrCapability: { available: false } });
  assert.match(result.message, /on-screen text presence cannot be observed/i);
  assert.equal(rule('TEXT_PRESENCE_OCR_UNAVAILABLE').evaluate({ ocrCapability: { available: true } }), null);
});

// --- no rule ever emits a judgment word ---
test('37. no rule\'s statement template can ever contain a banned judgment adjective, checked across a battery of realistic fixtures', () => {
  const banned = /\b(excellent|great|good|bad|poor|strong|weak|engaging|boring|effective|impressive|amazing|compelling)\b/i;
  const fixture = {
    video: { technical: { duration: 20 } },
    shots: [{ duration: 1, confidence: 'MEDIUM', startTime: 0, endTime: 1 }, { duration: 2, confidence: 'MEDIUM', startTime: 1, endTime: 3 }, { duration: 8, confidence: 'MEDIUM', startTime: 3, endTime: 11 }, { duration: 9, confidence: 'MEDIUM', startTime: 11, endTime: 20 }],
    shotRhythm: { shotCount: 4, durationDistribution: { count: 4, mean: 5, median: 5, p25: 1, p75: 8 }, quarterShotCounts: [{ shotCount: 2 }, { shotCount: 1 }, { shotCount: 0 }, { shotCount: 1 }] },
    audio: { silenceIntervals: [{ startTime: 5, endTime: 6, duration: 1 }], totalSilenceDuration: { value: 1, confidence: 'MEDIUM' }, speechPercentage: { value: 90, confidence: 'MEDIUM' } },
    transcript: {
      speechPercentageOfVideo: { value: 80, confidence: 'MEDIUM' },
      wordsPerMinute: { value: 130, confidence: 'MEDIUM' },
      pauseCount: { value: 1, confidence: 'MEDIUM' },
      pauseDurationDistribution: { mean: 0.6, max: 0.6 },
      sentenceLengthDistribution: { count: 2, min: 2, max: 8, median: 5 },
      sentences: [{ text: 'Is this a test?' }, { text: 'Yes it is.' }],
    },
    wordTiming: [{ startTime: 0.5, word: 'Hi' }],
    hook: { openingCutCounts: { first10s: 2 }, firstQuestionMarkTime: 0.9, firstQuestionMarkText: 'Ready?' },
    visual: { samples: [{ time: 1, frameDifference: 5 }, { time: 2, frameDifference: 6 }, { time: 16, frameDifference: 3 }, { time: 17, frameDifference: 2 }], frameDifferenceDistribution: { count: 10, mean: 5, p25: 3, p75: 7 } },
    sceneDetectionCapability: { available: false, reason: 'shots only' },
    ocrCapability: { available: false },
  };
  for (const r of rules) {
    const result = r.evaluate(fixture);
    if (result && result.statement) assert.doesNotMatch(result.statement, banned, `rule ${r.id} statement must never contain a judgment word: "${result.statement}"`);
  }
});

// --- weakest() confidence combinator ---
test('38. weakest() picks the lowest confidence among its inputs, ignoring nulls', () => {
  const { weakest } = require('../services/reference-video/observation-rules');
  assert.equal(weakest('HIGH', 'MEDIUM', 'LOW'), 'LOW');
  assert.equal(weakest('HIGH', 'HIGH'), 'HIGH');
  assert.equal(weakest('MEDIUM', null, 'HIGH'), 'MEDIUM');
});
