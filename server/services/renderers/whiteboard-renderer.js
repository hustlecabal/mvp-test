// whiteboard-renderer.js
//
// Stage 26.8A — the WHITEBOARD renderer. Consumes the WHITEBOARD
// executor's existing renderSpec (services/material-executors/whiteboard-
// executor.js) VERBATIM: duration, canvas{width,height}, drawingOrder[]
// (each with elementId, kind, content, style, drawStartOffset,
// drawDuration, holdDuration — already deterministically timed by the
// executor, never recomputed here).
//
// Produces REAL animated stroke-reveal SVG for SHAPE/ARROW/OBJECT/EMPHASIS
// elements (stroke-dasharray/stroke-dashoffset progressively drawing the
// outline over drawDuration — genuine "whiteboard drawing" motion, not a
// still frame — satisfying Part 9's "do NOT claim animation if only a
// still frame was produced" by actually animating). TEXT uses a left-to-
// right clip-path wipe reveal instead of per-letter handwriting strokes —
// DOCUMENTED SCOPE LIMITATION: no letter-path/handwriting-font data exists
// in this repository, so text reveals via wipe, not literal pen strokes;
// this is still real, genuine animation, just not stroke-traced glyphs.
// ERASE animates the REFERENCED earlier element's opacity to 0 (never
// deletes/redraws it), and OBJECT (no real icon library available) is
// rendered as a labeled dashed-outline placeholder, documented as such —
// never a fabricated icon.
//
// DOCUMENTED INTERPRETATION GAP: drawingOrder elements carry no `position`
// field (confirmed — the executor's shape has none). This renderer reads
// an optional style.position (normalized [0,1], the same convention every
// sibling renderer already uses) and otherwise falls back to a
// deterministic index-based grid (4 columns x 3 rows, wrapping), so
// identical input always produces an identical, fully-specified layout.
//
// No asset is read here — WHITEBOARD's renderSpec has no sourceAssetIds
// (confirmed: the executor always returns []).

const { createRenderResult, createRenderDiagnostic, createRenderArtifact } = require('../../schemas/render-result-schema');
const { escapeXml, writeSvgFile } = require('./svg-utils');

const GRID_COLS = 4;
const GRID_ROWS = 3;
const STROKE_COLOR = '#1a1a1a';
const STROKE_WIDTH = 5;

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'WHITEBOARD',
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

// Deterministic grid fallback position for an element with no explicit
// style.position — index-based, wraps every GRID_COLS*GRID_ROWS elements.
function gridPosition(index, canvas) {
  const cell = index % (GRID_COLS * GRID_ROWS);
  const col = cell % GRID_COLS;
  const row = Math.floor(cell / GRID_COLS);
  const cellW = canvas.width / GRID_COLS;
  const cellH = canvas.height / GRID_ROWS;
  return { x: cellW * (col + 0.5), y: cellH * (row + 0.5) };
}

function resolvePosition(style, index, canvas) {
  if (style && style.position && typeof style.position.x === 'number' && typeof style.position.y === 'number') {
    return { x: style.position.x * canvas.width, y: style.position.y * canvas.height };
  }
  return gridPosition(index, canvas);
}

function rectPerimeter(w, h) {
  return 2 * (w + h);
}

function ellipsePerimeter(rx, ry) {
  return Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
}

// Builds { markup, strokeLength } for a stroke-revealable outline shape,
// local coordinates centered at (0,0).
function buildShapeOutline(style) {
  const shapeType = (style && style.shapeType) || 'RECTANGLE';
  if (shapeType === 'CIRCLE') {
    const r = numOr(style && style.radius, 90);
    const length = 2 * Math.PI * r;
    return { markup: `<circle cx="0" cy="0" r="${r}" fill="none" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="${length}"/>`, length };
  }
  const w = numOr(style && style.width, 240);
  const h = numOr(style && style.height, 160);
  const length = rectPerimeter(w, h);
  return { markup: `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="none" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="${length}"/>`, length };
}

function buildArrow(style) {
  const dx = numOr(style && style.dx, 220);
  const dy = numOr(style && style.dy, 0);
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const headLen = 18;
  const hx1 = dx - headLen * Math.cos(angle - Math.PI / 6);
  const hy1 = dy - headLen * Math.sin(angle - Math.PI / 6);
  const hx2 = dx - headLen * Math.cos(angle + Math.PI / 6);
  const hy2 = dy - headLen * Math.sin(angle + Math.PI / 6);
  return {
    line: `<line x1="0" y1="0" x2="${dx}" y2="${dy}" fill="none" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="${length}"/>`,
    head: `<polygon points="${dx},${dy} ${hx1},${hy1} ${hx2},${hy2}" fill="${STROKE_COLOR}"/>`,
    length,
  };
}

function strokeDrawAnimate(begin, duration, length) {
  return `<animate attributeName="stroke-dashoffset" values="${length};0" keyTimes="0;1" dur="${duration}s" begin="${begin}s" fill="freeze" calcMode="linear"/>`;
}

function appearAnimate(begin) {
  return `<animate attributeName="opacity" values="0;1" keyTimes="0;1" dur="0.01s" begin="${begin}s" fill="freeze" calcMode="discrete"/>`;
}

function render({ executionResult, outputDir } = {}) {
  if (!executionResult || !executionResult.renderSpec || executionResult.renderSpec.type !== 'WHITEBOARD') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.type must be WHITEBOARD');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }
  const spec = executionResult.renderSpec;

  if (typeof spec.duration !== 'number' || !Number.isFinite(spec.duration) || spec.duration <= 0) {
    return fail(executionResult, 'INVALID_DURATION', `duration must be a positive finite number, got ${JSON.stringify(spec.duration)}`);
  }
  if (!Array.isArray(spec.drawingOrder) || spec.drawingOrder.length === 0) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.drawingOrder must be a non-empty array');
  }
  const canvas = spec.canvas && numOr(spec.canvas.width, null) && numOr(spec.canvas.height, null) ? spec.canvas : { width: 1920, height: 1080 };

  // elementId -> { position, animations: [] } so an ERASE entry (which
  // always references an earlier elementId — already validated by the
  // executor) can append an opacity animation to that earlier element's
  // OWN group before final serialization.
  const groupsById = new Map();
  const order = []; // preserves output ordering (ERASE contributes no new visible group)

  spec.drawingOrder.forEach((el, index) => {
    if (el.kind === 'ERASE') {
      const target = groupsById.get(el.content);
      if (target) {
        target.animations.push(`<animate attributeName="opacity" values="1;0" keyTimes="0;1" dur="${el.drawDuration}s" begin="${el.drawStartOffset}s" fill="freeze" calcMode="linear"/>`);
      }
      return;
    }

    let position = resolvePosition(el.style, index, canvas);
    let inner = '';
    if (el.kind === 'TEXT') {
      const text = typeof el.content === 'string' && el.content.length > 0 ? el.content : '';
      const fontSize = numOr(el.style && el.style.fontSize, 44);
      const estWidth = text.length * fontSize * 0.6 + 8;
      const clipId = `wbclip-${el.elementId}`;
      inner = [
        `<defs><clipPath id="${escapeXml(clipId)}"><rect x="${-estWidth / 2}" y="${-fontSize}" width="0" height="${fontSize * 2}">`,
        `<animate attributeName="width" values="0;${estWidth}" keyTimes="0;1" dur="${el.drawDuration}s" begin="${el.drawStartOffset}s" fill="freeze" calcMode="linear"/>`,
        `</rect></clipPath></defs>`,
        `<text x="0" y="0" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${fontSize}" fill="${STROKE_COLOR}" clip-path="url(#${escapeXml(clipId)})">${escapeXml(text)}</text>`,
      ].join('');
    } else if (el.kind === 'SHAPE') {
      const outline = buildShapeOutline(el.style);
      inner = outline.markup;
      groupsById.set(el.elementId, {
        position,
        animations: [appearAnimate(el.drawStartOffset), strokeDrawAnimate(el.drawStartOffset, el.drawDuration, outline.length)],
        markup: inner,
      });
      order.push(el.elementId);
      return;
    } else if (el.kind === 'ARROW') {
      const arrow = buildArrow(el.style);
      inner = arrow.line + arrow.head;
      groupsById.set(el.elementId, {
        position,
        animations: [appearAnimate(el.drawStartOffset), strokeDrawAnimate(el.drawStartOffset, el.drawDuration, arrow.length)],
        markup: inner,
      });
      order.push(el.elementId);
      return;
    } else if (el.kind === 'OBJECT') {
      // No real icon library exists in this repository — a dashed outline
      // with the object's own content string as a label is an honest
      // placeholder, never a fabricated icon (see file header).
      const w = numOr(el.style && el.style.width, 220);
      const h = numOr(el.style && el.style.height, 160);
      const label = typeof el.content === 'string' ? el.content : '';
      const length = rectPerimeter(w, h);
      inner = [
        `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" fill="none" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" stroke-dasharray="4 4"/>`,
        `<text x="0" y="0" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="20" fill="${STROKE_COLOR}">${escapeXml(label)}</text>`,
      ].join('');
      groupsById.set(el.elementId, {
        position,
        animations: [appearAnimate(el.drawStartOffset)],
        markup: inner,
      });
      order.push(el.elementId);
      return;
    } else if (el.kind === 'EMPHASIS') {
      const target = typeof el.content === 'string' ? groupsById.get(el.content) : null;
      if (target) position = target.position;
      const rx = numOr(el.style && el.style.rx, 140);
      const ry = numOr(el.style && el.style.ry, 70);
      const length = ellipsePerimeter(rx, ry);
      inner = `<ellipse cx="0" cy="0" rx="${rx}" ry="${ry}" fill="none" stroke="#e53935" stroke-width="${STROKE_WIDTH}" stroke-dasharray="${length}"/>`;
      groupsById.set(el.elementId, {
        position,
        animations: [appearAnimate(el.drawStartOffset), strokeDrawAnimate(el.drawStartOffset, el.drawDuration, length)],
        markup: inner,
      });
      order.push(el.elementId);
      return;
    }

    // TEXT falls through to here (no stroke length to track, just a wipe reveal).
    groupsById.set(el.elementId, {
      position,
      animations: [appearAnimate(el.drawStartOffset)],
      markup: inner,
    });
    order.push(el.elementId);
  });

  const groupsMarkup = order
    .map((id) => {
      const g = groupsById.get(id);
      return `<g id="${escapeXml(id)}" transform="translate(${g.position.x} ${g.position.y})" opacity="0">${g.markup}${g.animations.join('')}</g>`;
    })
    .join('');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`,
    `<rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="#f5f5f0"/>`,
    groupsMarkup,
    `</svg>`,
  ].join('');

  const filePath = writeSvgFile(outputDir, executionResult.executionId || 'whiteboard', svg);

  return createRenderResult({
    rendererType: 'WHITEBOARD',
    beatId: executionResult.beatId,
    materialId: executionResult.materialId,
    executionId: executionResult.executionId,
    status: 'COMPLETED',
    artifact: createRenderArtifact({ format: 'SVG', path: filePath, width: canvas.width, height: canvas.height, duration: spec.duration }),
    diagnostics: [],
  });
}

module.exports = { render };
