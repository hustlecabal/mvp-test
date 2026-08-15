// whiteboard-executor.js
//
// Stage 26.5A — the WHITEBOARD deterministic executor. Converts a
// structured whiteboard specification into deterministic ordered drawing
// instructions — progressive reveal, text, simple shapes, arrows,
// emphasis, and erase/replace, all timed.
//
// The external srt-whiteboard-animation repository (studied in
// docs/architecture/stage-26.2-visual-production-master-spec.md, Part 3.3)
// is research/inspiration ONLY — its `annotation.json` region-and-reveal
// schema is the origin of this executor's drawingOrder shape, but nothing
// here depends on its Python/OpenCV implementation, and no new runtime
// dependency is introduced. This is a pure JS structured-spec generator,
// matching this stage's "SVG stroke animation is the cleanest
// implementation, use SVG" guidance conceptually (drawingOrder is exactly
// the instruction set an SVG-stroke-animation renderer would consume) —
// no SVG library is required to PRODUCE that instruction set.
//
// VisualBeat has no dedicated whiteboard-content field yet — callers supply
// the drawing elements explicitly via options.elements, mirroring
// schemas/... (a future WhiteboardScene schema, not built this stage) —
// see the master spec's Part 11.2 for the shape this deliberately mirrors.

const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

const WHITEBOARD_ELEMENT_KINDS = ['OBJECT', 'TEXT', 'SHAPE', 'ARROW', 'EMPHASIS', 'ERASE'];

function fail(beat, materialId, code, message) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'WHITEBOARD',
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds: [],
    diagnostics: [createDiagnostic({ code, message })],
  });
}

// input: { projectId, beat, selectedMaterial, options }
//   options — { elements: [{ elementId?, kind, content, style,
//     drawStartOffset?, drawDuration, holdDuration? }], duration,
//     canvas?: {width, height} }
//
// drawStartOffset, when omitted, is computed deterministically by
// accumulating prior elements' own drawDuration in ARRAY ORDER (a simple,
// documented "draw the next thing as soon as the previous stroke
// finishes" progression) — never randomized, never dependent on anything
// but the input array itself.
function execute({ beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;

  const duration = options.duration !== undefined ? options.duration : beat && beat.duration;
  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return fail(beat, materialId, 'INVALID_DURATION', `duration must be a positive number, got ${JSON.stringify(duration)}`);
  }

  if (!Array.isArray(options.elements) || options.elements.length === 0) {
    return fail(beat, materialId, 'MISSING_ELEMENTS', 'options.elements must be a non-empty array of whiteboard drawing elements');
  }

  const drawingOrder = [];
  const seenElementIds = new Set();
  let cursor = 0;

  for (let index = 0; index < options.elements.length; index += 1) {
    const input = options.elements[index];
    if (!input || !WHITEBOARD_ELEMENT_KINDS.includes(input.kind)) {
      return fail(beat, materialId, 'INVALID_ELEMENT_KIND', `element at index ${index} has kind ${JSON.stringify(input && input.kind)}, not one of ${WHITEBOARD_ELEMENT_KINDS.join(', ')}`);
    }
    if (typeof input.drawDuration !== 'number' || Number.isNaN(input.drawDuration) || input.drawDuration <= 0) {
      return fail(beat, materialId, 'INVALID_DRAW_DURATION', `element at index ${index} has drawDuration ${JSON.stringify(input.drawDuration)}, must be a positive number`);
    }
    if (input.kind === 'ERASE' && (!input.content || !seenElementIds.has(input.content))) {
      return fail(beat, materialId, 'INVALID_ERASE_TARGET', `ERASE element at index ${index} must reference an earlier element's id in "content" — got ${JSON.stringify(input.content)}`);
    }

    const elementId = input.elementId || `wb-element-${index}`;
    const drawStartOffset = input.drawStartOffset !== undefined ? input.drawStartOffset : cursor;
    const holdDuration = typeof input.holdDuration === 'number' ? input.holdDuration : 0;
    const drawEnd = drawStartOffset + input.drawDuration;

    if (drawStartOffset < 0 || drawEnd > duration) {
      return fail(beat, materialId, 'EXCEEDS_DURATION', `element "${elementId}" draws from ${drawStartOffset}s to ${drawEnd}s, outside the beat's ${duration}s duration`);
    }

    drawingOrder.push({
      elementId,
      kind: input.kind,
      content: input.content || null,
      style: input.style || null,
      drawStartOffset,
      drawDuration: input.drawDuration,
      holdDuration,
    });

    seenElementIds.add(elementId);
    if (input.drawStartOffset === undefined) {
      cursor = drawStartOffset + input.drawDuration;
    }
  }

  const renderSpec = {
    type: 'WHITEBOARD',
    duration,
    canvas: options.canvas || { width: 1920, height: 1080 },
    drawingOrder,
  };

  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'WHITEBOARD',
    status: 'COMPLETED',
    duration,
    renderSpec,
    sourceAssetIds: [],
    diagnostics: [],
  });
}

module.exports = { execute, WHITEBOARD_ELEMENT_KINDS };
