// espeak-voice-provider.js
//
// Stage 26.9B, Part 2/3 — the ONE concrete voice-generation adapter this
// stage installs, chosen after auditing the repository/environment (no
// existing capability — see this stage's final report) and confirming
// espeak-ng is installable from Ubuntu's already-trusted `universe`
// component (the exact same trust boundary Stage 26.8B-R already used for
// FFmpeg — no new/untrusted repository, no API key, no network call at
// generation time, no per-call cost). The choice of espeak-ng specifically
// (over festival/pico2wave) plus the choice of the 'base' Whisper model
// for alignment (services/voice/whisper-alignment-provider.js) were
// presented to, and confirmed by, the user before this file was written.
//
// HONESTY ABOUT CAPABILITY: espeak-ng is a formant/rule-based synthesizer,
// not a modern expressive neural TTS engine. It genuinely supports SSML
// <break> (pauses), <emphasis> (coarse pitch/stress adjustment), <sub
// alias="..."> (pronunciation substitution), speaking rate, and pitch —
// this adapter translates NarrationDirection's pauses/emphasis/
// pronunciation/pace/pitch into exactly those controls. It does NOT
// meaningfully express emotional nuance (delivery.energy/intensity/
// warmth/urgency/conversationality) — there is no honest SSML mapping for
// those with this engine, so they are NOT translated into any control
// here rather than being faked. A future, more expressive provider
// adapter can map them; this one never pretends to.
//
// SECURITY (Part 15): the ONLY subprocess this file spawns is
// execFileSync('espeak-ng', [...argv array...]) — never a shell string,
// never shell:true. Narration text is written to a temp SSML file (never
// passed as a long/unescaped argv value) and read via `-f`, matching this
// codebase's established "argument arrays + temp files over long argv"
// discipline (services/renderers/hyperframes-renderer.js's own
// runHyperframesRender). No environment variable value is ever logged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createVoiceGenerationResult, createVoiceDiagnostic } = require('./voice-provider-interface');

const GENERATION_TIMEOUT_MS = Number(process.env.VOICE_GENERATION_TIMEOUT_MS) || 60000;

// ---------------------------------------------------------------------------
// Binary resolution — same dependency-free PATH-scan + env-var-override
// convention already established by services/renderers/hyperframes-
// renderer.js's resolveHyperframesEnv()/locateOnPath(), duplicated here
// (not imported — that file is a renderer, a different layer) rather than
// hardcoding any one sandbox's path as if it were universal.
// ---------------------------------------------------------------------------
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

function resolveEspeakBin() {
  return process.env.ESPEAK_NG_PATH || locateOnPath('espeak-ng');
}

function resolveFfprobeBin() {
  return process.env.HYPERFRAMES_FFPROBE_PATH || process.env.FFPROBE_PATH || locateOnPath('ffprobe') || 'ffprobe';
}

// ---------------------------------------------------------------------------
// Delivery/VoiceProfile -> espeak-ng CLI controls (Part 3's "may translate
// voice profile/pace/pitch/... into provider-specific controls").
// ---------------------------------------------------------------------------
const PACE_TO_WPM = { SLOW: 120, MODERATE: 170, MODERATELY_FAST: 195, FAST: 220 };
const PITCH_TO_ESPEAK = { low: 30, medium: 50, high: 70 };

function mapPace(delivery) {
  return (delivery && PACE_TO_WPM[delivery.pace]) || PACE_TO_WPM.MODERATE;
}

function mapPitch(voiceProfile) {
  const raw = voiceProfile && typeof voiceProfile.pitch === 'string' ? voiceProfile.pitch.toLowerCase() : null;
  return PITCH_TO_ESPEAK[raw] || 50;
}

function mapVoice(voiceProfile) {
  const language = (voiceProfile && voiceProfile.language) || '';
  const accent = (voiceProfile && voiceProfile.accent) || '';
  const haystack = `${language} ${accent}`.toLowerCase();
  if (haystack.includes('gb') || haystack.includes('british') || haystack.includes('uk')) return 'en-gb';
  if (haystack.includes('us') || haystack.includes('american')) return 'en-us';
  return 'en-us';
}

// ---------------------------------------------------------------------------
// SSML construction — deterministic, offset-driven, never fuzzy (same
// discipline schemas/narration-schema.js's own Emphasis/Pause already
// established for THEIR own offsets; this just renders those offsets into
// markup rather than re-deriving them).
// ---------------------------------------------------------------------------
const SSML_EMPHASIS_LEVEL = { LIGHT: 'reduced', MODERATE: 'moderate', STRONG: 'strong', CONTRAST: 'strong' };

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function findAllOccurrences(text, needle) {
  const out = [];
  if (!needle) return out;
  let from = 0;
  let idx;
  while ((idx = text.indexOf(needle, from)) !== -1) {
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length; // non-overlapping
  }
  return out;
}

// Builds the <speak>...</speak> body for a NarrationDirection's own text,
// weaving in emphasis spans, pronunciation substitutions, and pause
// break-points at their already-resolved character offsets — a single
// left-to-right walk over a sorted, deduplicated set of boundary offsets,
// so overlapping/adjacent markup is always well-formed XML.
function buildSSML(narrationDirection) {
  const text = narrationDirection.text;
  const spans = [];
  for (const e of narrationDirection.emphasis || []) {
    if (typeof e.charStart === 'number' && typeof e.charEnd === 'number' && e.charEnd > e.charStart) {
      spans.push({ start: e.charStart, end: e.charEnd, kind: 'emphasis', level: SSML_EMPHASIS_LEVEL[e.level] || 'moderate' });
    }
  }
  for (const p of narrationDirection.pronunciation || []) {
    for (const occ of findAllOccurrences(text, p.text)) {
      spans.push({ start: occ.start, end: occ.end, kind: 'sub', alias: p.pronunciation });
    }
  }
  const points = [];
  for (const pause of narrationDirection.pauses || []) {
    if (typeof pause.afterCharOffset === 'number' && typeof pause.durationMs === 'number' && pause.durationMs > 0) {
      points.push({ offset: pause.afterCharOffset, tag: `<break time="${Math.round(pause.durationMs)}ms"/>` });
    }
  }

  const boundarySet = new Set([0, text.length]);
  for (const s of spans) {
    boundarySet.add(s.start);
    boundarySet.add(s.end);
  }
  for (const p of points) boundarySet.add(p.offset);
  const boundaries = [...boundarySet].sort((a, b) => a - b);

  let body = '';
  for (let i = 0; i < boundaries.length; i += 1) {
    const at = boundaries[i];
    if (i > 0) {
      const closes = spans.filter((s) => s.end === at).sort((x, y) => y.start - x.start);
      for (const s of closes) body += s.kind === 'emphasis' ? '</emphasis>' : '</sub>';
    }
    for (const p of points.filter((pt) => pt.offset === at)) body += p.tag;
    if (i < boundaries.length - 1) {
      const opens = spans.filter((s) => s.start === at).sort((x, y) => y.end - x.end);
      for (const s of opens) body += s.kind === 'emphasis' ? `<emphasis level="${s.level}">` : `<sub alias="${xmlEscape(s.alias)}">`;
      body += xmlEscape(text.slice(at, boundaries[i + 1]));
    }
  }
  return `<speak>${body}</speak>`;
}

// ---------------------------------------------------------------------------
// Output validation — never trust espeak-ng's own exit code alone; ffprobe
// the real file, same discipline services/renderers/hyperframes-
// renderer.js's ffprobeValidate() already established for MP4.
// ---------------------------------------------------------------------------
function ffprobeValidateAudio(outputPath) {
  if (!fs.existsSync(outputPath)) return { ok: false, message: 'output file does not exist after generation' };
  const ffprobeBin = resolveFfprobeBin();
  let raw;
  try {
    raw = execFileSync(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', outputPath],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString('utf8');
  } catch (error) {
    return { ok: false, message: `ffprobe validation failed to run: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'ffprobe returned unparseable output' };
  }
  const duration = parsed.format && Number(parsed.format.duration);
  const audioStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
  if (!audioStream) return { ok: false, message: 'ffprobe found no audio stream in the output' };
  if (!duration || duration <= 0) return { ok: false, message: `ffprobe reported an invalid duration: ${JSON.stringify(parsed.format)}` };
  if (!audioStream.sample_rate || !audioStream.channels) return { ok: false, message: 'ffprobe reported invalid/missing sample rate or channel count' };
  return { ok: true, duration, sampleRate: Number(audioStream.sample_rate), channels: audioStream.channels, codec: audioStream.codec_name };
}

function fail(code, message) {
  return createVoiceGenerationResult({ status: 'FAILED', audioPath: null, duration: null, diagnostics: [createVoiceDiagnostic({ code, message })] });
}

// Public entry point (the ONE method voice-provider-interface.js requires).
//   { narrationDirection, outputPath }
function generateVoice({ narrationDirection, outputPath } = {}) {
  if (!narrationDirection || narrationDirection.status !== 'COMPLETED' || typeof narrationDirection.text !== 'string' || narrationDirection.text.trim().length === 0) {
    return fail('INVALID_NARRATION_DIRECTION', 'narrationDirection must be a COMPLETED NarrationDirection with non-empty text');
  }
  if (!outputPath) {
    return fail('INVALID_NARRATION_DIRECTION', 'an outputPath is required');
  }

  const espeakBin = resolveEspeakBin();
  if (!espeakBin) {
    return fail('VOICE_PROVIDER_UNAVAILABLE', 'espeak-ng was not found on PATH and ESPEAK_NG_PATH is not set');
  }

  const ssml = buildSSML(narrationDirection);
  const wpm = mapPace(narrationDirection.delivery);
  const pitch = mapPitch(narrationDirection.voiceProfile);
  const voice = mapVoice(narrationDirection.voiceProfile);

  const ssmlPath = path.join(os.tmpdir(), `espeak-ssml-${crypto.randomUUID()}.xml`);
  try {
    fs.writeFileSync(ssmlPath, ssml, 'utf8');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    try {
      execFileSync(espeakBin, ['-m', '-f', ssmlPath, '-w', outputPath, '-s', String(wpm), '-p', String(pitch), '-v', voice], {
        timeout: GENERATION_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = error.stderr ? error.stderr.toString('utf8').slice(-2000) : '';
      return fail('VOICE_GENERATION_FAILED', `espeak-ng failed: ${error.message}${stderr ? ` | stderr: ${stderr}` : ''}`);
    }

    const validation = ffprobeValidateAudio(outputPath);
    if (!validation.ok) {
      return fail('AUDIO_FILE_INVALID', validation.message);
    }

    return createVoiceGenerationResult({ status: 'COMPLETED', audioPath: outputPath, duration: validation.duration, diagnostics: [] });
  } catch (error) {
    return fail('VOICE_GENERATION_FAILED', `provider threw: ${error && error.message ? error.message : String(error)}`);
  } finally {
    fs.rmSync(ssmlPath, { force: true });
  }
}

module.exports = { generateVoice, buildSSML, mapPace, mapPitch, mapVoice };
