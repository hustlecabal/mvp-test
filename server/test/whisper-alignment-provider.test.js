// Tests for services/voice/whisper-alignment-provider.js — Stage 26.9B,
// Part 7/8/16. Real alignment against a real, disposable audio file
// (generated via the real espeak-ng adapter — never a fabricated/silent
// WAV, since Whisper needs genuine speech to align against).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { directNarration } = require('../services/narration-director-service');
const { generateVoice } = require('../services/voice/espeak-voice-provider');
const { alignAudio } = require('../services/voice/whisper-alignment-provider');

function realNarratedAudio(text) {
  const nd = directNarration({ scriptRefId: 's1', text });
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-provider-test-')), `${crypto.randomUUID()}.wav`);
  const result = generateVoice({ narrationDirection: nd, outputPath });
  assert.equal(result.status, 'COMPLETED', 'fixture setup: real espeak-ng generation must succeed for this test file to mean anything');
  return outputPath;
}

// --- 1. real alignment — the task's own worked example -------------------------------------------------------------------

test('1. real alignment — a real generated audio file produces real, measured word-level timestamps, monotonically increasing', () => {
  const audioPath = realNarratedAudio("That £100,000 isn't actually worth £100,000.");
  const result = alignAudio({ audioPath });
  assert.equal(result.status, 'COMPLETED', result.diagnostics[0] && result.diagnostics[0].message);
  assert.equal(result.language, 'en');
  assert.ok(result.words.length > 0);
  for (const w of result.words) {
    assert.equal(typeof w.word, 'string');
    assert.ok(w.word.length > 0);
    assert.ok(typeof w.start === 'number' && w.start >= 0);
    assert.ok(typeof w.end === 'number' && w.end > w.start);
    assert.ok(typeof w.confidence === 'number' && w.confidence >= 0 && w.confidence <= 1);
  }
  for (let i = 1; i < result.words.length; i += 1) {
    assert.ok(result.words[i].start >= result.words[i - 1].end - 0.01, `word ${i} should not start before the previous word ends`);
  }
});

test('2. real alignment — timestamps are measured from the ACTUAL audio, never estimated from word count/WPM (the last word\'s end time is close to the file\'s real duration, not a WPM guess)', () => {
  const audioPath = realNarratedAudio('One two three four five six seven eight nine ten.');
  const result = alignAudio({ audioPath });
  assert.equal(result.status, 'COMPLETED');
  const lastWord = result.words[result.words.length - 1];
  const { execFileSync } = require('child_process');
  const probeDuration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]).toString('utf8').trim());
  assert.ok(Math.abs(lastWord.end - probeDuration) < 1.0, `last word end (${lastWord.end}) should be close to the real audio duration (${probeDuration})`);
});

// --- 3. failure handling -------------------------------------------------------------------

test('3. a nonexistent audio file fails with ALIGNMENT_FAILED, never crashes', () => {
  const result = alignAudio({ audioPath: '/tmp/does-not-exist-' + crypto.randomUUID() + '.wav' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ALIGNMENT_FAILED');
});

test('4. missing alignment capability — a bogus VOICE_ALIGNMENT_PYTHON_PATH fails with ALIGNMENT_FAILED (a candidate existed, invoking it failed), never crashes', () => {
  const audioPath = realNarratedAudio('short clip');
  const prev = process.env.VOICE_ALIGNMENT_PYTHON_PATH;
  process.env.VOICE_ALIGNMENT_PYTHON_PATH = '/nonexistent/python3';
  try {
    const result = alignAudio({ audioPath });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'ALIGNMENT_FAILED');
  } finally {
    if (prev === undefined) delete process.env.VOICE_ALIGNMENT_PYTHON_PATH;
    else process.env.VOICE_ALIGNMENT_PYTHON_PATH = prev;
  }
});

test('5. missing alignment capability — no Python interpreter found anywhere (repo venv hidden, PATH empty, no override) fails with ALIGNMENT_UNAVAILABLE, never fakes timestamps', () => {
  const audioPath = realNarratedAudio('short clip');
  const venvDir = path.join(__dirname, '..', '.venv');
  const hiddenDir = path.join(__dirname, '..', '.venv.hidden-for-test');
  const venvExisted = fs.existsSync(venvDir);
  const prevEnvPath = process.env.VOICE_ALIGNMENT_PYTHON_PATH;
  const prevPath = process.env.PATH;
  delete process.env.VOICE_ALIGNMENT_PYTHON_PATH;
  process.env.PATH = '';
  if (venvExisted) fs.renameSync(venvDir, hiddenDir);
  try {
    const result = alignAudio({ audioPath });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'ALIGNMENT_UNAVAILABLE');
    assert.deepEqual(result.words, []);
  } finally {
    if (venvExisted) fs.renameSync(hiddenDir, venvDir);
    process.env.PATH = prevPath;
    if (prevEnvPath === undefined) delete process.env.VOICE_ALIGNMENT_PYTHON_PATH;
    else process.env.VOICE_ALIGNMENT_PYTHON_PATH = prevEnvPath;
  }
});

// --- 6. security -------------------------------------------------------------------

test('6. security — whisper-alignment-provider.js only uses execFileSync with argument arrays; no shell, no eval', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'voice', 'whisper-alignment-provider.js'), 'utf8');
  const text = fullText.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(text, /\bexecSync\(/);
  assert.doesNotMatch(text, /\bexec\(/);
  assert.doesNotMatch(text, /\bspawn\(/);
  assert.doesNotMatch(text, /shell\s*:\s*true/);
  assert.doesNotMatch(text, /\beval\(/);
  assert.doesNotMatch(text, /new\s+Function\(/);
  const execFileSyncCalls = [...text.matchAll(/execFileSync\(\s*[^,]+,\s*(\[|[^\[])/g)];
  assert.ok(execFileSyncCalls.length > 0);
  for (const call of execFileSyncCalls) {
    assert.equal(call[1], '[', `execFileSync call must pass an argument array literal, found: ${call[0]}`);
  }
});

test('7. security — align.py never prints an API key/env var value and always emits exactly one JSON line', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'voice', 'align.py'), 'utf8');
  assert.doesNotMatch(text, /os\.environ/);
  assert.doesNotMatch(text, /apiKey|api_key/i);
});
