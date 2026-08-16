// whisper-alignment-provider.js
//
// Stage 26.9B, Part 8 — the ONE concrete alignment adapter this stage
// installs: faster-whisper's 'base' model (chosen over 'tiny' after a
// real side-by-side comparison on the task's own worked example — 'base'
// correctly heard "isn't/actually/worth" where 'tiny' mis-heard them as
// "didn't/work"; confirmed with the user before this file was written).
// Runs entirely offline after a one-time model download (already
// provisioned into server/.whisper-models/ — see this stage's final
// report for the exact provisioning commands); no API key, no per-call
// cost, no network call at alignment time.
//
// These are REAL, MEASURED timestamps from the actual generated audio —
// never word-count/WPM estimation (Stage 26.9 Part 9's target timing is a
// completely different, earlier, PRE-audio number; this file only ever
// produces ACTUAL/post-audio timing).
//
// SECURITY (Part 15): the ONLY subprocess this file spawns is
// execFileSync(pythonBin, [alignScriptPath, ...] ) — an explicit argument
// array, never a shell string. align.py itself always prints exactly one
// line of JSON and exits 0; this file never trusts a bare exit code and
// never scrapes stderr for the actual result.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createAlignmentResult, createAlignmentDiagnostic } = require('./alignment-provider-interface');

const ALIGNMENT_TIMEOUT_MS = Number(process.env.VOICE_ALIGNMENT_TIMEOUT_MS) || 120000;
const DEFAULT_MODEL_SIZE = process.env.VOICE_ALIGNMENT_MODEL_SIZE || 'base';

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function locateOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// Provisioning convention (documented, never hardcoded as a sandbox fact):
// `python3 -m venv server/.venv && server/.venv/bin/pip install
// faster-whisper` — see this stage's final report for the full command.
// VOICE_ALIGNMENT_PYTHON_PATH always wins when set; otherwise this repo's
// own venv is tried first, then a bare `python3` on PATH (for a real
// deployment that installed faster-whisper into its system interpreter).
function resolvePythonBin() {
  if (process.env.VOICE_ALIGNMENT_PYTHON_PATH) return process.env.VOICE_ALIGNMENT_PYTHON_PATH;
  const repoVenvPython = path.join(__dirname, '..', '..', '.venv', 'bin', 'python3');
  if (isExecutable(repoVenvPython)) return repoVenvPython;
  return locateOnPath('python3');
}

function resolveModelDir() {
  if (process.env.VOICE_ALIGNMENT_MODEL_DIR) return process.env.VOICE_ALIGNMENT_MODEL_DIR;
  return path.join(__dirname, '..', '..', '.whisper-models');
}

function fail(code, message) {
  return createAlignmentResult({ status: 'FAILED', words: [], diagnostics: [createAlignmentDiagnostic({ code, message })] });
}

// Public entry point (the ONE method alignment-provider-interface.js requires).
//   { audioPath, modelSize? }
function alignAudio({ audioPath, modelSize } = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    return fail('ALIGNMENT_FAILED', `audio file does not exist: ${audioPath}`);
  }

  const pythonBin = resolvePythonBin();
  if (!pythonBin) {
    return fail('ALIGNMENT_UNAVAILABLE', 'no Python interpreter with faster-whisper installed was found (checked VOICE_ALIGNMENT_PYTHON_PATH, server/.venv/bin/python3, and PATH)');
  }

  const alignScript = path.join(__dirname, 'align.py');
  const modelDir = resolveModelDir();
  fs.mkdirSync(modelDir, { recursive: true });

  let raw;
  try {
    raw = execFileSync(pythonBin, [alignScript, audioPath, modelSize || DEFAULT_MODEL_SIZE, modelDir], {
      timeout: ALIGNMENT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').slice(-2000) : '';
    return fail('ALIGNMENT_FAILED', `alignment subprocess failed: ${error.message}${stderr ? ` | stderr: ${stderr}` : ''}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().split('\n').pop());
  } catch {
    return fail('ALIGNMENT_FAILED', 'alignment subprocess produced unparseable output');
  }

  if (!parsed.ok) {
    const unavailable = typeof parsed.error === 'string' && /not installed/i.test(parsed.error);
    return fail(unavailable ? 'ALIGNMENT_UNAVAILABLE' : 'ALIGNMENT_FAILED', parsed.error || 'alignment failed for an unknown reason');
  }

  if (!Array.isArray(parsed.words) || parsed.words.length === 0) {
    return fail('ALIGNMENT_FAILED', 'alignment produced zero words — never fabricated, always reported as a failure');
  }

  return createAlignmentResult({
    status: 'COMPLETED',
    language: parsed.language || null,
    words: parsed.words.map((w) => ({ word: w.word, start: w.start, end: w.end, confidence: w.confidence })),
    diagnostics: [],
  });
}

module.exports = { alignAudio };
