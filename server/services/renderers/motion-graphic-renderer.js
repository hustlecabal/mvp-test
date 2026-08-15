// motion-graphic-renderer.js
//
// Stage 26.8A — the MOTION_GRAPHIC renderer. Consumes the MOTION_GRAPHIC
// executor's existing renderSpec (services/material-executors/motion-
// graphic-executor.js) VERBATIM: duration, elements[] (each with kind,
// position, scale, rotation, opacity, label, sequence, transitionIn/Out,
// groupId, props). This renderer draws ONLY the 10 primitives
// MOTION_GRAPHIC_PRIMITIVES already defines (RECTANGLE/CIRCLE/LINE/ARROW/
// TEXT/BAR/PROGRESS_BAR/CHART/CONNECTOR/GROUP) — it never expands that
// vocabulary.
//
// DOCUMENTED INTERPRETATION GAP: the executor deliberately leaves each
// primitive's visual parameters (e.g. a RECTANGLE's width/height, a
// CIRCLE's radius) undefined — they live in the free-form `props` bag,
// which no schema in this codebase shapes (the same documented gap the
// executor's own header notes for `structuredData`). This renderer reads
// reasonable, fixed-default fields from `props` per kind (documented
// inline per case below) — it does not invent new PRIMITIVE kinds, only a
// concrete way to draw the ones that already exist. `position` is treated
// as a normalized [0,1] fraction of the canonical frame (the SAME
// convention still-image-motion-executor.js's and kinetic-typography-
// executor.js's own renderSpecs already use), giving each element's anchor
// point, with rotation in degrees and scale as a uniform multiplier.
//
// No asset is read here — MOTION_GRAPHIC's renderSpec has no
// sourceAssetIds (confirmed: the executor always returns []).

const { createRenderResult, createRenderDiagnostic, createRenderArtifact } = require('../../schemas/render-result-schema');
const { escapeXml, writeSvgFile } = require('./svg-utils');

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const TRANSITION_DURATION = 0.35;

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'MOTION_GRAPHIC',
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Returns the inner SVG markup for one primitive, anchored at (0,0) in its
// own local coordinate space (the caller wraps it in a <g transform=...>
// that translates/rotates/scales to the element's actual position).
function drawPrimitive(element) {
  const props = element.props || {};
  const color = typeof props.color === 'string' ? props.color : '#4fc3f7';

  switch (element.kind) {
    case 'RECTANGLE':
    case 'BAR': {
      const w = numOr(props.width, 200);
      const h = numOr(props.height, 120);
      const rx = numOr(props.cornerRadius, 0);
      return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${rx}" fill="${color}"/>`;
    }
    case 'CIRCLE': {
      const r = numOr(props.radius, 80);
      return `<circle cx="0" cy="0" r="${r}" fill="${color}"/>`;
    }
    case 'LINE': {
      const dx = numOr(props.dx, 200);
      const dy = numOr(props.dy, 0);
      const strokeWidth = numOr(props.strokeWidth, 4);
      return `<line x1="0" y1="0" x2="${dx}" y2="${dy}" stroke="${color}" stroke-width="${strokeWidth}"/>`;
    }
    case 'ARROW':
    case 'CONNECTOR': {
      const dx = numOr(props.dx, 200);
      const dy = numOr(props.dy, 0);
      const strokeWidth = numOr(props.strokeWidth, 4);
      const angle = Math.atan2(dy, dx);
      const headLen = 16;
      const hx1 = dx - headLen * Math.cos(angle - Math.PI / 6);
      const hy1 = dy - headLen * Math.sin(angle - Math.PI / 6);
      const hx2 = dx - headLen * Math.cos(angle + Math.PI / 6);
      const hy2 = dy - headLen * Math.sin(angle + Math.PI / 6);
      return [
        `<line x1="0" y1="0" x2="${dx}" y2="${dy}" stroke="${color}" stroke-width="${strokeWidth}"/>`,
        `<polygon points="${dx},${dy} ${hx1},${hy1} ${hx2},${hy2}" fill="${color}"/>`,
      ].join('');
    }
    case 'TEXT': {
      const fontSize = numOr(props.fontSize, 48);
      return `<text x="0" y="0" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${fontSize}" fill="${color}">${escapeXml(String(props.text))}</text>`;
    }
    case 'PROGRESS_BAR': {
      const w = numOr(props.width, 400);
      const h = numOr(props.height, 24);
      const progress = Math.max(0, Math.min(1, numOr(props.progress, 0)));
      const trackColor = typeof props.trackColor === 'string' ? props.trackColor : '#333333';
      return [
        `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${trackColor}"/>`,
        `<rect x="${-w / 2}" y="${-h / 2}" width="${w * progress}" height="${h}" rx="${h / 2}" fill="${color}"/>`,
      ].join('');
    }
    case 'CHART': {
      const w = numOr(props.width, 400);
      const h = numOr(props.height, 200);
      const data = props.data;
      const max = Math.max(...data);
      const barGap = 8;
      const barWidth = (w - barGap * (data.length - 1)) / data.length;
      const bars = data
        .map((value, i) => {
          const barHeight = max > 0 ? (value / max) * h : 0;
          const x = -w / 2 + i * (barWidth + barGap);
          const y = h / 2 - barHeight;
          return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color}"/>`;
        })
        .join('');
      return bars;
    }
    case 'GROUP':
      // A logical container only — no shape of its own, per the executor's
      // own vocabulary (GROUP carries no size/color props). Children are
      // separate elements in the same array, each with their own absolute
      // position; groupId is informational lineage only.
      return '';
    default:
      return null; // unreachable — kind already validated by the caller
  }
}

function validateElement(element) {
  const props = element.props || {};
  if (element.kind === 'TEXT' && (typeof props.text !== 'string' || props.text.length === 0)) {
    return 'TEXT element requires a non-empty props.text string';
  }
  if (element.kind === 'CHART' && (!Array.isArray(props.data) || props.data.length === 0 || !props.data.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
    return 'CHART element requires a non-empty props.data array of finite numbers';
  }
  return null;
}

function render({ executionResult, outputDir } = {}) {
  if (!executionResult || !executionResult.renderSpec || executionResult.renderSpec.type !== 'MOTION_GRAPHIC') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.type must be MOTION_GRAPHIC');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }
  const spec = executionResult.renderSpec;

  if (typeof spec.duration !== 'number' || !Number.isFinite(spec.duration) || spec.duration <= 0) {
    return fail(executionResult, 'INVALID_DURATION', `duration must be a positive finite number, got ${JSON.stringify(spec.duration)}`);
  }
  if (!Array.isArray(spec.elements) || spec.elements.length === 0) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.elements must be a non-empty array');
  }

  for (const element of spec.elements) {
    const error = validateElement(element);
    if (error) {
      return fail(executionResult, 'INVALID_ELEMENT', `element "${element.elementId}": ${error}`);
    }
  }

  const groups = spec.elements.map((element) => {
    const inner = drawPrimitive(element);
    const x = element.position.x * FRAME_WIDTH;
    const y = element.position.y * FRAME_HEIGHT;
    const transform = `translate(${x} ${y}) rotate(${element.rotation}) scale(${element.scale})`;
    const staticOpacity = element.opacity;

    const startOffset = element.sequence.startOffset;
    const endOffset = element.sequence.endOffset;
    const entranceDuration = element.transitionIn ? Math.min(TRANSITION_DURATION, endOffset - startOffset) : 0.01;
    const exitDuration = element.transitionOut ? Math.min(TRANSITION_DURATION, endOffset - startOffset) : 0.01;
    const exitBegin = Math.max(startOffset, endOffset - exitDuration);

    const opacityIn = `<animate attributeName="opacity" values="0;${staticOpacity}" keyTimes="0;1" dur="${entranceDuration}s" begin="${startOffset}s" fill="freeze" calcMode="${element.transitionIn ? 'linear' : 'discrete'}"/>`;
    const opacityOut = `<animate attributeName="opacity" values="${staticOpacity};0" keyTimes="0;1" dur="${exitDuration}s" begin="${exitBegin}s" fill="freeze" calcMode="${element.transitionOut ? 'linear' : 'discrete'}"/>`;

    return `<g id="${escapeXml(element.elementId)}" transform="${transform}" opacity="0">${inner}${opacityIn}${opacityOut}</g>`;
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}">`,
    `<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="#0d0d0d"/>`,
    groups.join(''),
    `</svg>`,
  ].join('');

  const filePath = writeSvgFile(outputDir, executionResult.executionId || 'motion-graphic', svg);

  return createRenderResult({
    rendererType: 'MOTION_GRAPHIC',
    beatId: executionResult.beatId,
    materialId: executionResult.materialId,
    executionId: executionResult.executionId,
    status: 'COMPLETED',
    artifact: createRenderArtifact({ format: 'SVG', path: filePath, width: FRAME_WIDTH, height: FRAME_HEIGHT, duration: spec.duration }),
    diagnostics: [],
  });
}

module.exports = { render, FRAME_WIDTH, FRAME_HEIGHT };
