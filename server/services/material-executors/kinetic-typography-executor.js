// kinetic-typography-executor.js
//
// Stage 26.5A — the KINETIC_TYPOGRAPHY deterministic executor. Turns text
// into a deterministic animated-text instruction set — never an LLM call,
// never an AI image/video model. VisualBeat has no dedicated on-screen-text
// field yet (only narrationSegment.text, which is narration/VO, not
// necessarily identical to on-screen caption text) — this is a documented
// gap, not silently worked around: callers pass the text to display
// explicitly via options.text, falling back to beat.narrationSegment.text
// only when options.text is omitted, and failing structurally when neither
// exists.

const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

const TEXT_SEQUENCING = ['WORD_BY_WORD', 'LETTER_BY_LETTER', 'LINE_BY_LINE', 'ALL_AT_ONCE'];
const ENTRANCE_KINDS = ['FADE_IN', 'SLIDE_UP', 'SLIDE_IN', 'POP_IN', 'TYPE_ON'];
const EXIT_KINDS = ['FADE_OUT', 'SLIDE_DOWN', 'SLIDE_OUT', 'POP_OUT', 'NONE'];
const ALIGNMENTS = ['CENTER', 'LEFT', 'RIGHT'];

function fail(beat, materialId, code, message) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'KINETIC_TYPOGRAPHY',
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds: [],
    diagnostics: [createDiagnostic({ code, message })],
  });
}

// Splits `text` into units for the given sequencing mode. Deterministic and
// pure — the same text + sequencing always yields the same unit list, in
// the same order.
function splitIntoUnits(text, sequencing) {
  if (sequencing === 'LETTER_BY_LETTER') return text.split('');
  if (sequencing === 'LINE_BY_LINE') return text.split('\n').filter((line) => line.length > 0);
  if (sequencing === 'ALL_AT_ONCE') return [text];
  return text.split(/\s+/).filter((word) => word.length > 0); // WORD_BY_WORD (default)
}

// input: { projectId, beat, selectedMaterial, options }
//   options — { text, font: {family, weight}, size, alignment, position,
//     lineWrapWidth, duration, entrance, exit, sequencing,
//     emphasis: [{wordIndex, style}] }
function execute({ beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;

  const text = options.text !== undefined ? options.text : beat && beat.narrationSegment && beat.narrationSegment.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return fail(beat, materialId, 'MISSING_TEXT', 'options.text (or beat.narrationSegment.text as a fallback) must be a non-empty string');
  }

  const duration = options.duration !== undefined ? options.duration : beat && beat.duration;
  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return fail(beat, materialId, 'INVALID_DURATION', `duration must be a positive number, got ${JSON.stringify(duration)}`);
  }

  const sequencing = options.sequencing || 'WORD_BY_WORD';
  if (!TEXT_SEQUENCING.includes(sequencing)) {
    return fail(beat, materialId, 'INVALID_SEQUENCING', `sequencing "${sequencing}" is not one of ${TEXT_SEQUENCING.join(', ')}`);
  }

  const entrance = options.entrance || 'FADE_IN';
  if (!ENTRANCE_KINDS.includes(entrance)) {
    return fail(beat, materialId, 'INVALID_ENTRANCE', `entrance "${entrance}" is not one of ${ENTRANCE_KINDS.join(', ')}`);
  }

  const exit = options.exit || 'FADE_OUT';
  if (!EXIT_KINDS.includes(exit)) {
    return fail(beat, materialId, 'INVALID_EXIT', `exit "${exit}" is not one of ${EXIT_KINDS.join(', ')}`);
  }

  const alignment = options.alignment || 'CENTER';
  if (!ALIGNMENTS.includes(alignment)) {
    return fail(beat, materialId, 'INVALID_ALIGNMENT', `alignment "${alignment}" is not one of ${ALIGNMENTS.join(', ')}`);
  }

  const units = splitIntoUnits(text, sequencing);
  if (units.length === 0) {
    return fail(beat, materialId, 'MISSING_TEXT', 'text produced zero renderable units after splitting');
  }

  const emphasis = Array.isArray(options.emphasis) ? options.emphasis : [];
  for (const entry of emphasis) {
    if (typeof entry.wordIndex !== 'number' || entry.wordIndex < 0 || entry.wordIndex >= units.length) {
      return fail(beat, materialId, 'INVALID_EMPHASIS', `emphasis wordIndex ${JSON.stringify(entry.wordIndex)} is out of range for ${units.length} unit(s)`);
    }
  }

  // Deterministic, evenly-spaced entrance timeline: unit i occupies
  // [i * (duration / unitCount), (i + 1) * (duration / unitCount)] — the
  // same text + sequencing + duration always produces the same timeline.
  const unitWindow = duration / units.length;
  const timeline = units.map((unit, index) => ({
    unit,
    index,
    startOffset: index * unitWindow,
    endOffset: (index + 1) * unitWindow,
  }));

  const renderSpec = {
    type: 'KINETIC_TYPOGRAPHY',
    text,
    sequencing,
    units,
    timeline,
    font: { family: (options.font && options.font.family) || 'sans-serif', weight: (options.font && options.font.weight) || 'bold' },
    size: typeof options.size === 'number' ? options.size : 64,
    alignment,
    position: options.position || { x: 0.5, y: 0.5 },
    lineWrapWidth: typeof options.lineWrapWidth === 'number' ? options.lineWrapWidth : 0.8,
    duration,
    entrance,
    exit,
    emphasis,
  };

  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'KINETIC_TYPOGRAPHY',
    status: 'COMPLETED',
    duration,
    renderSpec,
    sourceAssetIds: [],
    diagnostics: [],
  });
}

module.exports = { execute, TEXT_SEQUENCING, ENTRANCE_KINDS, EXIT_KINDS, ALIGNMENTS };
