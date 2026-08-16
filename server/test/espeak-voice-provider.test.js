// Tests for services/voice/espeak-voice-provider.js — Stage 26.9B, Part
// 6/16. Real generation against real, disposable NarrationDirection
// fixtures (never mocked) — REAL audio files, validated via ffprobe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { directNarration } = require('../services/narration-director-service');
const { generateVoice, buildSSML, mapPace, mapPitch, mapVoice } = require('../services/voice/espeak-voice-provider');

function outPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'espeak-provider-test-')), `${crypto.randomUUID()}.wav`);
}

function ffprobeAudio(filePath) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', filePath]).toString('utf8');
  return JSON.parse(raw);
}

// --- 1. buildSSML — deterministic, pure, no subprocess -------------------------------------------------------------------

test('1. buildSSML wraps the task\'s own worked example correctly — emphasis spans, a break at the end, well-formed XML', () => {
  const nd = directNarration({
    scriptRefId: 's1', text: "That £100,000 isn't actually worth £100,000.",
    beats: [{ beatId: 'b1', narrativeRole: 'REVEAL' }],
    emphasis: [{ text: "isn't actually", level: 'CONTRAST' }],
  });
  const ssml = buildSSML(nd);
  assert.match(ssml, /^<speak>.*<\/speak>$/);
  assert.match(ssml, /<emphasis level="strong">£100,000<\/emphasis>/);
  assert.match(ssml, /<emphasis level="strong">isn&apos;t actually<\/emphasis>/);
  assert.match(ssml, /<break time="650ms"\/><\/speak>$/); // AFTER_REVEAL, right before the closing tag
});

test('2. buildSSML XML-escapes narration text — no raw "&"/"<"/">" ever appears outside the tags this file itself inserts', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'Rock & Roll < 100% > everything.' });
  const ssml = buildSSML(nd).replace(/<speak>|<\/speak>|<break[^>]*\/>|<emphasis[^>]*>|<\/emphasis>|<sub[^>]*>|<\/sub>/g, '');
  assert.doesNotMatch(ssml, /&(?!amp;|lt;|gt;|quot;|apos;)/);
  assert.doesNotMatch(ssml, /<(?!\/?(speak|break|emphasis|sub))/);
});

test('3. buildSSML pronunciation substitution wraps every occurrence of the word with <sub alias>', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'SQL is great. I love SQL.', pronunciation: [{ text: 'SQL', pronunciation: 'sequel' }] });
  const ssml = buildSSML(nd);
  const matches = ssml.match(/<sub alias="sequel">SQL<\/sub>/g);
  assert.equal(matches.length, 2);
});

test('4. buildSSML is deterministic — identical NarrationDirection produces identical SSML', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'Deterministic SSML output.', beats: [{ beatId: 'b1', narrativeRole: 'HOOK' }] });
  assert.equal(buildSSML(nd), buildSSML(nd));
});

// --- 5. mapping helpers -------------------------------------------------------------------

test('5. mapPace/mapPitch/mapVoice are small, deterministic, closed-vocabulary mappings', () => {
  assert.equal(mapPace({ pace: 'FAST' }), 220);
  assert.equal(mapPace({ pace: 'SLOW' }), 120);
  assert.equal(mapPace(null), mapPace({ pace: 'MODERATE' }));
  assert.equal(mapPitch({ pitch: 'low' }), 30);
  assert.equal(mapPitch({ pitch: 'high' }), 70);
  assert.equal(mapPitch(null), 50);
  assert.equal(mapVoice({ accent: 'British' }), 'en-gb');
  assert.equal(mapVoice({ language: 'en-US' }), 'en-us');
  assert.equal(mapVoice(null), 'en-us');
});

// --- 6. real generation (happy path) -------------------------------------------------------------------

test('6. real generation — a real NarrationDirection produces a real, ffprobe-verified WAV file', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'This is a real test of the espeak voice provider.', beats: [{ beatId: 'b1', narrativeRole: 'EXPLANATION' }] });
  const output = outPath();
  const result = generateVoice({ narrationDirection: nd, outputPath: output });
  assert.equal(result.status, 'COMPLETED', result.diagnostics[0] && result.diagnostics[0].message);
  assert.equal(result.audioPath, output);
  assert.ok(result.duration > 0);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(fs.existsSync(output));

  const probe = ffprobeAudio(output);
  const stream = probe.streams.find((s) => s.codec_type === 'audio');
  assert.ok(stream, 'expected a real audio stream');
  assert.ok(Number(probe.format.duration) > 0);
  assert.ok(Number(stream.sample_rate) > 0);
  assert.ok(Number(stream.channels) >= 1);
});

test('7. real generation — duration is never guessed; it comes from ffprobe, and differs meaningfully between a SLOW and a FAST pace of the same text', () => {
  const text = 'The quick brown fox jumps over the lazy dog every single morning without fail.';
  const slow = directNarration({ scriptRefId: 's1', text, beatOverride: undefined });
  const fast = directNarration({ scriptRefId: 's1', text });
  // Force pace via channelVoiceBible tier (Stage 26.9's own override precedence)
  const slowDirection = directNarration({ scriptRefId: 's1', text, channelVoiceBible: { delivery: { pace: 'SLOW' } } });
  const fastDirection = directNarration({ scriptRefId: 's1', text, channelVoiceBible: { delivery: { pace: 'FAST' } } });

  const slowOut = outPath();
  const fastOut = outPath();
  const slowResult = generateVoice({ narrationDirection: slowDirection, outputPath: slowOut });
  const fastResult = generateVoice({ narrationDirection: fastDirection, outputPath: fastOut });
  assert.equal(slowResult.status, 'COMPLETED');
  assert.equal(fastResult.status, 'COMPLETED');
  assert.ok(slowResult.duration > fastResult.duration, `SLOW pace (${slowResult.duration}s) should produce longer real audio than FAST pace (${fastResult.duration}s)`);
});

// --- 8. failure handling -------------------------------------------------------------------

test('8. an incomplete/invalid NarrationDirection fails with INVALID_NARRATION_DIRECTION, never attempts generation', () => {
  const result = generateVoice({ narrationDirection: { status: 'FAILED', text: 'x' }, outputPath: outPath() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_NARRATION_DIRECTION');
});

test('9. a missing outputPath fails with INVALID_NARRATION_DIRECTION', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  const result = generateVoice({ narrationDirection: nd });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_NARRATION_DIRECTION');
});

test('10. a bogus ESPEAK_NG_PATH override fails safely with VOICE_GENERATION_FAILED (a candidate existed, invoking it failed), never crashes', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  const prev = process.env.ESPEAK_NG_PATH;
  process.env.ESPEAK_NG_PATH = '/nonexistent/espeak-ng-binary';
  try {
    const result = generateVoice({ narrationDirection: nd, outputPath: outPath() });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'VOICE_GENERATION_FAILED');
  } finally {
    if (prev === undefined) delete process.env.ESPEAK_NG_PATH;
    else process.env.ESPEAK_NG_PATH = prev;
  }
});

test('10b. missing provider — no ESPEAK_NG_PATH override and an empty PATH fails with VOICE_PROVIDER_UNAVAILABLE, never crashes', () => {
  const nd = directNarration({ scriptRefId: 's1', text: 'x' });
  const prevEnvPath = process.env.ESPEAK_NG_PATH;
  const prevPath = process.env.PATH;
  delete process.env.ESPEAK_NG_PATH;
  process.env.PATH = '';
  try {
    const result = generateVoice({ narrationDirection: nd, outputPath: outPath() });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'VOICE_PROVIDER_UNAVAILABLE');
  } finally {
    process.env.PATH = prevPath;
    if (prevEnvPath === undefined) delete process.env.ESPEAK_NG_PATH;
    else process.env.ESPEAK_NG_PATH = prevEnvPath;
  }
});

// --- 11. security -------------------------------------------------------------------

test('11. security — espeak-voice-provider.js only uses execFileSync with argument arrays; no shell, no eval, no leaked env values', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'voice', 'espeak-voice-provider.js'), 'utf8');
  const text = fullText.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(text, /\bexecSync\(/);
  assert.doesNotMatch(text, /\bexec\(/);
  assert.doesNotMatch(text, /\bspawn\(/);
  assert.doesNotMatch(text, /shell\s*:\s*true/);
  assert.doesNotMatch(text, /\beval\(/);
  assert.doesNotMatch(text, /new\s+Function\(/);
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.doesNotMatch(text, /\baxios\b/);
  assert.doesNotMatch(text, /https?\.request\(/);
  assert.doesNotMatch(text, /message:\s*`[^`]*\$\{process\.env/);
  const execFileSyncCalls = [...text.matchAll(/execFileSync\(\s*[^,]+,\s*(\[|[^\[])/g)];
  assert.ok(execFileSyncCalls.length > 0);
  for (const call of execFileSyncCalls) {
    assert.equal(call[1], '[', `execFileSync call must pass an argument array literal, found: ${call[0]}`);
  }
});
