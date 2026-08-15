// motion-graphic-executor.js
//
// Stage 26.5A — the MOTION_GRAPHIC deterministic executor. Produces
// deterministic graphics for explanatory content from a small, intentionally
// closed set of primitives — never a general-purpose After Effects
// replacement (pie charts/diagrams/maps/code animation are explicitly
// deferred to a later stage, per this stage's own scope).
//
// VisualBeat has no `structuredData` field yet (documented gap — see
// docs/architecture/stage-26.2-visual-production-master-spec.md, Part 10.3,
// "structuredData... the source of truth, NEVER inferred by the renderer").
// This executor reads its element list from options.elements, explicitly
// supplied by the caller — it never infers chart data from beat text.

const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

const MOTION_GRAPHIC_PRIMITIVES = ['RECTANGLE', 'CIRCLE', 'LINE', 'ARROW', 'TEXT', 'BAR', 'PROGRESS_BAR', 'CHART', 'CONNECTOR', 'GROUP'];

function fail(beat, materialId, code, message) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'MOTION_GRAPHIC',
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds: [],
    diagnostics: [createDiagnostic({ code, message })],
  });
}

// input: { projectId, beat, selectedMaterial, options }
//   options — { elements: [{ elementId?, kind, position, scale, rotation,
//     opacity, label, sequence?: {startOffset, endOffset}, transitionIn,
//     transitionOut, groupId, props }], duration }
function execute({ beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;

  const duration = options.duration !== undefined ? options.duration : beat && beat.duration;
  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return fail(beat, materialId, 'INVALID_DURATION', `duration must be a positive number, got ${JSON.stringify(duration)}`);
  }

  if (!Array.isArray(options.elements) || options.elements.length === 0) {
    return fail(beat, materialId, 'MISSING_ELEMENTS', 'options.elements must be a non-empty array of primitive descriptors — motion graphics cannot be inferred from beat text alone');
  }

  const elements = [];
  for (let index = 0; index < options.elements.length; index += 1) {
    const input = options.elements[index];
    if (!input || !MOTION_GRAPHIC_PRIMITIVES.includes(input.kind)) {
      return fail(beat, materialId, 'INVALID_PRIMITIVE', `element at index ${index} has kind ${JSON.stringify(input && input.kind)}, not one of ${MOTION_GRAPHIC_PRIMITIVES.join(', ')}`);
    }

    // Deterministic default id — NEVER crypto.randomUUID() here: an
    // executor must produce identical output for identical input, and an
    // input that omits elementId is still "identical" across repeated
    // calls, so the fallback id must be derived from the input's own
    // position (index) rather than randomly generated.
    const elementId = input.elementId || `element-${index}`;

    const sequence = input.sequence !== undefined ? input.sequence : { startOffset: 0, endOffset: duration };
    if (
      typeof sequence.startOffset !== 'number' ||
      typeof sequence.endOffset !== 'number' ||
      sequence.startOffset < 0 ||
      sequence.endOffset > duration ||
      sequence.startOffset >= sequence.endOffset
    ) {
      return fail(beat, materialId, 'INVALID_SEQUENCE', `element "${elementId}" has an invalid sequence window ${JSON.stringify(sequence)} for duration ${duration}`);
    }

    elements.push({
      elementId,
      kind: input.kind,
      position: input.position || { x: 0, y: 0 },
      scale: typeof input.scale === 'number' ? input.scale : 1,
      rotation: typeof input.rotation === 'number' ? input.rotation : 0,
      opacity: typeof input.opacity === 'number' ? input.opacity : 1,
      label: input.label || null,
      sequence,
      transitionIn: input.transitionIn || null,
      transitionOut: input.transitionOut || null,
      groupId: input.groupId || null,
      props: input.props || {},
    });
  }

  const renderSpec = {
    type: 'MOTION_GRAPHIC',
    duration,
    elements,
  };

  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'MOTION_GRAPHIC',
    status: 'COMPLETED',
    duration,
    renderSpec,
    sourceAssetIds: [],
    diagnostics: [],
  });
}

module.exports = { execute, MOTION_GRAPHIC_PRIMITIVES };
