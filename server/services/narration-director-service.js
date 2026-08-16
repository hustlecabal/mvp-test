// narration-director-service.js
//
// Stage 26.9 — the NARRATION DIRECTOR. Consumes script text and (optional)
// beat context and turns them into a structured, deterministic, provider-
// neutral schemas/narration-schema.js NarrationDirection — describing HOW
// narration should be PERFORMED, never WHICH TTS PROVIDER generates it.
//
// LAYERING, restated because it is the one rule this whole stage exists to
// enforce: this file answers "how should this be performed" — pace,
// energy, emphasis, pauses, pronunciation, emotional arc. It never answers
// "which TTS provider/voice ID generates the audio." No provider is
// required, called, or named anywhere in this file. No network call, no
// API key, no LLM call — this service is PURE and DETERMINISTIC: given
// identical input, it always produces a structurally identical
// NarrationDirection (narrationId/createdAt aside), the same discipline
// every other *-service.js in this codebase already applies to its own
// deterministic output (material-execution-service.js, timeline-compiler-
// service.js, render-service.js).
//
// It never calls Material Resolution, Material Execution, the Timeline
// Compiler, or HyperFrames — it consumes the SAME VisualBeat concept those
// stages already use (a beat's own `id` and, optionally, a caller-supplied
// `narrativeRole` hint — see below), but never re-decides, re-resolves, or
// re-executes anything about a beat's VISUAL material.
//
// ---------------------------------------------------------------------------
// WHY narrativeRole IS AN EXPLICIT INPUT, NEVER INFERRED FROM TEXT/NLP
// ---------------------------------------------------------------------------
// Part 11's rules ("HOOK -> higher energy", "EXPLANATION -> lower energy",
// etc.) need to know a beat's narrative function. schemas/visual-beat-
// schema.js's own `narrativePurpose` field is free text with no fixed
// vocabulary — classifying it into HOOK/EXPLANATION/REVEAL/etc. via
// keyword-matching would be exactly the "fuzzy string matching" Part 5
// explicitly forbids for emphasis, and would silently vary its own
// classification if the free text changes wording without changing
// meaning, breaking determinism in spirit even where it holds in fact.
// Instead, `narrativeRole` is an explicit, caller-supplied hint per beat
// (NARRATIVE_ROLES below) — a human/future Director decides "beat 3 is the
// REVEAL," this service only applies deterministic rules to that decision.
// Two things ARE derived directly from `text` itself, deterministically,
// via plain non-fuzzy pattern matching (never NLP): a trailing '?' (Part
// 11 item 5, QUESTION) and currency/percentage/comma-grouped numeric
// phrases (Part 11 item 4, IMPORTANT_NUMBER) — both exact, reproducible
// regex matches over the literal text, not judgment calls.
//
// ---------------------------------------------------------------------------
// PART 13 — CHANNEL VOICE BIBLE COMPATIBILITY (chosen precedence)
// ---------------------------------------------------------------------------
// No Channel Voice Bible store/schema is built this stage (explicitly out
// of scope). directNarration() accepts three OPTIONAL, caller-supplied
// tier objects — { voiceProfile, delivery } each — representing where a
// future Channel Voice Bible, a video-level direction, and a human beat
// override would eventually come from. Chosen precedence, exactly as
// specified:
//
//   beatOverride  >  videoDirection  >  channelVoiceBible  >  system default
//
// Only fields a tier actually defines (not null/undefined) override the
// tier below it — this is a per-field shallow merge, not a whole-object
// replace (Part 12's explicit requirement: a human overriding `energy`
// alone must never blank out `pace`/`emotionalTone`/etc.). `voiceProfile`
// has NO system default (inventing one would be exactly the
// "over-automation" Part 12 forbids) — it stays null unless at least one
// tier supplies it. `emotionalArc` stages use the role-baseline + channel
// + video tiers only, deliberately NOT beatOverride — beatOverride scopes
// to the NarrationDirection's own top-level `delivery` (Part 12's own
// worked example is a flat override of "the" direction, not a rewrite of
// every per-beat arc stage).

const {
  EMPHASIS_LEVELS,
  PAUSE_REASONS,
  createEmphasis,
  createPause,
  createPronunciationNote,
  createNarrationTargetTiming,
  createNarrationTiming,
  createNarrationDiagnostic,
  createNarrationDirection,
} = require('../schemas/narration-schema');

// Part 11's closed vocabulary — an explicit input, never inferred (see file header).
const NARRATIVE_ROLES = ['HOOK', 'EXPLANATION', 'REVEAL', 'CONCLUSION', 'TRANSITION', 'OTHER'];

// Deterministic starting rules (Part 11) — "starting rules, not immutable
// creative truth," kept as one small, easily-replaceable table.
const SYSTEM_DEFAULT_DELIVERY = { pace: 'MODERATE', emotionalTone: 'CALM', energy: 5, intensity: 5, confidence: 5, warmth: 5, urgency: 3, conversationality: 5 };

const DIRECTOR_RULES = {
  HOOK: { pace: 'MODERATELY_FAST', emotionalTone: 'CURIOUS', energy: 8, intensity: 7, confidence: 6, warmth: 5, urgency: 6, conversationality: 7 },
  EXPLANATION: { pace: 'MODERATE', emotionalTone: 'CONFIDENT', energy: 5, intensity: 4, confidence: 8, warmth: 6, urgency: 3, conversationality: 6 },
  REVEAL: { pace: 'MODERATE', emotionalTone: 'SURPRISED', energy: 8, intensity: 8, confidence: 7, warmth: 5, urgency: 5, conversationality: 6 },
  CONCLUSION: { pace: 'MODERATE', emotionalTone: 'RESOLVED', energy: 6, intensity: 5, confidence: 9, warmth: 6, urgency: 2, conversationality: 5 },
  TRANSITION: { pace: 'MODERATE', emotionalTone: 'CALM', energy: 5, intensity: 4, confidence: 6, warmth: 5, urgency: 3, conversationality: 5 },
  OTHER: SYSTEM_DEFAULT_DELIVERY,
};

function deliveryForRole(role) {
  return { ...(DIRECTOR_RULES[role] || SYSTEM_DEFAULT_DELIVERY) };
}

// Part 11 item 5 — QUESTION: a deterministic, exact check (trailing '?'),
// never NLP/sentiment inference.
function applyQuestionRule(text, delivery) {
  if (!text.trim().endsWith('?')) return delivery;
  const energy = typeof delivery.energy === 'number' ? Math.min(10, delivery.energy + 1) : delivery.energy;
  return { ...delivery, emotionalTone: 'CURIOUS', energy };
}

// Part 11 item 4 — IMPORTANT NUMBER: currency amounts, percentages, and
// comma-grouped numbers, all via exact regex — never fuzzy/NLP detection.
const IMPORTANT_NUMBER_PATTERN = /[£$€¥]\s?\d[\d,]*(\.\d+)?|\b\d{1,3}(,\d{3})+(\.\d+)?\b|\b\d+(\.\d+)?%/g;

function autoDetectImportantNumbers(text) {
  const found = [];
  const re = new RegExp(IMPORTANT_NUMBER_PATTERN.source, 'g');
  let match;
  while ((match = re.exec(text)) !== null) {
    found.push(createEmphasis({ text: match[0], charStart: match.index, charEnd: match.index + match[0].length, level: 'STRONG', reason: 'IMPORTANT_NUMBER' }));
  }
  return found;
}

function mergeDefined(base, ...overrides) {
  const result = { ...base };
  for (const o of overrides) {
    if (!o || typeof o !== 'object') continue;
    for (const [k, v] of Object.entries(o)) {
      if (v !== undefined && v !== null) result[k] = v;
    }
  }
  return result;
}

function mergeDefinedOrNull(...tiers) {
  let result = null;
  for (const o of tiers) {
    if (!o || typeof o !== 'object') continue;
    const defined = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
    if (Object.keys(defined).length === 0) continue;
    result = { ...(result || {}), ...defined };
  }
  return result;
}

function fail(scriptRefId, text, code, message) {
  return createNarrationDirection({
    scriptRefId: typeof scriptRefId === 'string' ? scriptRefId : null,
    text: typeof text === 'string' ? text : '',
    status: 'FAILED',
    diagnostics: [createNarrationDiagnostic({ code, message })],
  });
}

// Deterministic, non-fuzzy exact-substring resolution (Part 5's explicit
// requirement) — an explicit charStart disambiguates a repeated phrase;
// otherwise the phrase must occur EXACTLY once in `text`.
function resolveEmphasisEntry(text, entry) {
  if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) {
    return { error: { code: 'INVALID_EMPHASIS', message: 'each emphasis entry requires a non-empty text string' } };
  }
  const level = entry.level || 'STRONG';
  if (!EMPHASIS_LEVELS.includes(level)) {
    return { error: { code: 'INVALID_EMPHASIS', message: `emphasis level "${level}" is not one of ${EMPHASIS_LEVELS.join(', ')}` } };
  }
  if (typeof entry.charStart === 'number') {
    const charStart = entry.charStart;
    const charEnd = charStart + entry.text.length;
    if (charStart < 0 || charEnd > text.length || text.slice(charStart, charEnd) !== entry.text) {
      return { error: { code: 'INVALID_EMPHASIS', message: `emphasis text "${entry.text}" does not match narration text at the given charStart ${charStart}` } };
    }
    return { ok: true, value: createEmphasis({ text: entry.text, charStart, charEnd, level, reason: entry.reason || null }) };
  }
  const firstIndex = text.indexOf(entry.text);
  if (firstIndex === -1) {
    return { error: { code: 'EMPHASIS_TEXT_NOT_FOUND', message: `emphasis text "${entry.text}" was not found in the narration text` } };
  }
  if (text.indexOf(entry.text, firstIndex + 1) !== -1) {
    return { error: { code: 'AMBIGUOUS_EMPHASIS_TEXT', message: `emphasis text "${entry.text}" occurs more than once — supply an explicit charStart to disambiguate` } };
  }
  return { ok: true, value: createEmphasis({ text: entry.text, charStart: firstIndex, charEnd: firstIndex + entry.text.length, level, reason: entry.reason || null }) };
}

function resolvePauseEntry(text, entry) {
  if (!entry || typeof entry.durationMs !== 'number' || !Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
    return { error: { code: 'INVALID_PAUSE_DURATION', message: `pause durationMs must be a non-negative number, got ${JSON.stringify(entry && entry.durationMs)}` } };
  }
  const reason = entry.reason || 'SENTENCE_BREAK';
  if (!PAUSE_REASONS.includes(reason)) {
    return { error: { code: 'INVALID_PAUSE_REASON', message: `pause reason "${reason}" is not one of ${PAUSE_REASONS.join(', ')}` } };
  }
  const afterText = entry.afterText;
  if (afterText === undefined || afterText === null || afterText === '') {
    return { ok: true, value: createPause({ afterCharOffset: 0, afterText: '', durationMs: entry.durationMs, reason }) };
  }
  if (typeof afterText !== 'string') {
    return { error: { code: 'INVALID_PAUSE', message: 'pause afterText must be a string' } };
  }
  const firstIndex = text.indexOf(afterText);
  if (firstIndex === -1) {
    return { error: { code: 'PAUSE_TEXT_NOT_FOUND', message: `pause afterText "${afterText}" was not found in the narration text` } };
  }
  if (text.indexOf(afterText, firstIndex + 1) !== -1) {
    return { error: { code: 'AMBIGUOUS_PAUSE_TEXT', message: `pause afterText "${afterText}" occurs more than once — supply a more specific match to disambiguate` } };
  }
  return { ok: true, value: createPause({ afterCharOffset: firstIndex + afterText.length, afterText, durationMs: entry.durationMs, reason }) };
}

function buildTiming({ targetStartTime, targetDuration, targetWordsPerMinute, text, pauses }) {
  const pauseBudgetMs = pauses.reduce((sum, p) => sum + (typeof p.durationMs === 'number' ? p.durationMs : 0), 0);
  let duration = null;
  if (typeof targetDuration === 'number') {
    duration = targetDuration; // caller-supplied target — never presented as measured
  } else if (typeof targetWordsPerMinute === 'number' && targetWordsPerMinute > 0) {
    const wordCount = text.trim().length > 0 ? text.trim().split(/\s+/).length : 0;
    duration = (wordCount / targetWordsPerMinute) * 60; // deterministic derivation from word count — still a TARGET, never measured audio
  }
  return createNarrationTiming({
    target: createNarrationTargetTiming({
      startTime: typeof targetStartTime === 'number' ? targetStartTime : null,
      duration,
      wordsPerMinute: typeof targetWordsPerMinute === 'number' ? targetWordsPerMinute : null,
      pauseBudgetMs,
    }),
    // `actual` is never set here — createNarrationTiming's own default
    // (null) is left untouched; there is no real audio to measure yet.
  });
}

// Public entry point.
//   input — {
//     scriptRefId (required, non-empty string),
//     text (required, non-empty string — the narration text itself),
//     beats — optional [{ beatId, narrativeRole? }], in order; drives
//       beatIds[]/emotionalArc[] and the primary role baseline (the FIRST
//       beat's narrativeRole, or 'OTHER' if omitted/no beats given),
//     targetDuration / targetWordsPerMinute / targetStartTime — optional
//       TARGET timing inputs (never measured audio — see file header),
//     emphasis / pauses / pronunciation — optional caller-supplied arrays,
//       resolved deterministically against `text` (never fuzzy-matched),
//     notes — optional free text,
//     channelVoiceBible / videoDirection / beatOverride — optional
//       { voiceProfile, delivery } tiers, see Part 13 precedence above.
//   }
function directNarration(input) {
  // A default parameter (`input = {}`) only covers `undefined` — an
  // explicit `null` call must be just as safe, matching every other
  // service in this codebase's "never crash the caller" discipline.
  const {
    scriptRefId, text, beats, targetDuration, targetWordsPerMinute, targetStartTime,
    emphasis, pauses, pronunciation, notes, channelVoiceBible, videoDirection, beatOverride,
  } = input || {};

  if (typeof scriptRefId !== 'string' || scriptRefId.trim().length === 0) {
    return fail(scriptRefId, text, 'MISSING_SCRIPT_REF_ID', 'scriptRefId is required and must be a non-empty string');
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return fail(scriptRefId, text, 'MISSING_TEXT', 'text is required and must be a non-empty string');
  }
  if (targetDuration !== undefined && (typeof targetDuration !== 'number' || !Number.isFinite(targetDuration) || targetDuration <= 0)) {
    return fail(scriptRefId, text, 'INVALID_TIMING', `targetDuration must be a positive number, got ${JSON.stringify(targetDuration)}`);
  }
  if (targetWordsPerMinute !== undefined && (typeof targetWordsPerMinute !== 'number' || !Number.isFinite(targetWordsPerMinute) || targetWordsPerMinute <= 0)) {
    return fail(scriptRefId, text, 'INVALID_TIMING', `targetWordsPerMinute must be a positive number, got ${JSON.stringify(targetWordsPerMinute)}`);
  }
  if (targetStartTime !== undefined && (typeof targetStartTime !== 'number' || !Number.isFinite(targetStartTime) || targetStartTime < 0)) {
    return fail(scriptRefId, text, 'INVALID_TIMING', `targetStartTime must be a non-negative number, got ${JSON.stringify(targetStartTime)}`);
  }

  const beatList = Array.isArray(beats) ? beats : [];
  for (const b of beatList) {
    if (!b || typeof b.beatId !== 'string' || b.beatId.length === 0) {
      return fail(scriptRefId, text, 'INVALID_BEAT_REFERENCE', 'each beats[] entry requires a non-empty beatId string');
    }
    if (b.narrativeRole !== undefined && b.narrativeRole !== null && !NARRATIVE_ROLES.includes(b.narrativeRole)) {
      return fail(scriptRefId, text, 'INVALID_NARRATIVE_ROLE', `narrativeRole "${b.narrativeRole}" is not one of ${NARRATIVE_ROLES.join(', ')}`);
    }
  }

  const beatIds = beatList.map((b) => b.beatId);
  const primaryRole = beatList.length > 0 ? (beatList[0].narrativeRole || 'OTHER') : 'OTHER';

  // --- delivery: role baseline -> deterministic text rules -> tiered creative override precedence (Part 13) ---
  const roleDelivery = applyQuestionRule(text, deliveryForRole(primaryRole));
  const delivery = mergeDefined(
    roleDelivery,
    channelVoiceBible && channelVoiceBible.delivery,
    videoDirection && videoDirection.delivery,
    beatOverride && beatOverride.delivery
  );

  // --- voiceProfile: no invented system default (Part 12) ---
  const voiceProfile = mergeDefinedOrNull(
    channelVoiceBible && channelVoiceBible.voiceProfile,
    videoDirection && videoDirection.voiceProfile,
    beatOverride && beatOverride.voiceProfile
  );

  // --- emotionalArc: role baseline + channel/video tiers per beat (never beatOverride — see file header) ---
  const emotionalArc = beatList.map((b) => {
    const stageBase = applyQuestionRule(text, deliveryForRole(b.narrativeRole || 'OTHER'));
    const stageDelivery = mergeDefined(stageBase, channelVoiceBible && channelVoiceBible.delivery, videoDirection && videoDirection.delivery);
    return { beatId: b.beatId, label: b.narrativeRole || null, delivery: stageDelivery };
  });

  // --- emphasis: explicit entries, then deterministic auto-detected numbers, deduplicated by exact span ---
  const resolvedEmphasis = [];
  for (const entry of Array.isArray(emphasis) ? emphasis : []) {
    const result = resolveEmphasisEntry(text, entry);
    if (result.error) return fail(scriptRefId, text, result.error.code, result.error.message);
    resolvedEmphasis.push(result.value);
  }
  for (const auto of autoDetectImportantNumbers(text)) {
    const alreadyCovered = resolvedEmphasis.some((e) => e.charStart === auto.charStart && e.charEnd === auto.charEnd);
    if (!alreadyCovered) resolvedEmphasis.push(auto);
  }

  // --- pauses: explicit entries, then a deterministic end-of-text pause for REVEAL beats ---
  const resolvedPauses = [];
  for (const entry of Array.isArray(pauses) ? pauses : []) {
    const result = resolvePauseEntry(text, entry);
    if (result.error) return fail(scriptRefId, text, result.error.code, result.error.message);
    resolvedPauses.push(result.value);
  }
  if (primaryRole === 'REVEAL' && !resolvedPauses.some((p) => p.afterCharOffset === text.length)) {
    resolvedPauses.push(createPause({ afterCharOffset: text.length, afterText: text.slice(Math.max(0, text.length - 40)), durationMs: 650, reason: 'AFTER_REVEAL' }));
  }

  // --- pronunciation: explicit only, validated ---
  const resolvedPronunciation = [];
  for (const entry of Array.isArray(pronunciation) ? pronunciation : []) {
    if (!entry || typeof entry.text !== 'string' || entry.text.length === 0 || typeof entry.pronunciation !== 'string' || entry.pronunciation.length === 0) {
      return fail(scriptRefId, text, 'INVALID_PRONUNCIATION', 'each pronunciation entry requires non-empty text and pronunciation strings');
    }
    resolvedPronunciation.push(createPronunciationNote({ text: entry.text, pronunciation: entry.pronunciation, notes: entry.notes || null }));
  }

  const timing = buildTiming({ targetStartTime, targetDuration, targetWordsPerMinute, text, pauses: resolvedPauses });

  return createNarrationDirection({
    scriptRefId,
    beatIds,
    text,
    voiceProfile,
    delivery,
    timing,
    emphasis: resolvedEmphasis,
    pauses: resolvedPauses,
    pronunciation: resolvedPronunciation,
    emotionalArc,
    notes: typeof notes === 'string' ? notes : null,
    status: 'COMPLETED',
    diagnostics: [],
  });
}

module.exports = {
  NARRATIVE_ROLES,
  SYSTEM_DEFAULT_DELIVERY,
  DIRECTOR_RULES,
  directNarration,
};
