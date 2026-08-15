// kinetic-typography-renderer.js
//
// Stage 26.8A — the KINETIC_TYPOGRAPHY renderer. Consumes the
// KINETIC_TYPOGRAPHY executor's existing renderSpec (services/material-
// executors/kinetic-typography-executor.js) VERBATIM: text, sequencing,
// units, timeline (per-unit startOffset/endOffset — already computed
// deterministically by the executor, never recomputed here), font, size,
// alignment, position, lineWrapWidth, duration, entrance, exit, emphasis.
// This renderer never invents new text or new timing — it only lays the
// existing units out on the canonical frame and animates each unit's
// existing timeline window.
//
// SCOPE LIMITATION (documented, not silently ignored): this codebase has
// no font-metrics library, so word-wrap uses a fixed average-glyph-width
// estimate (size * 0.6) rather than real font metrics. Line-wrapping is
// therefore approximate, not pixel-exact — acceptable for proving "text
// appears, sequencing respected, entrance/exit represented, emphasis
// represented where supported, deterministic dimensions", which is this
// stage's actual requirement, not typographic precision.
//
// No asset is read here — KINETIC_TYPOGRAPHY's renderSpec has no
// sourceAssetIds (confirmed: the executor always returns []), so this
// renderer needs no asset-storage lookup at all.

const { createRenderResult, createRenderDiagnostic, createRenderArtifact } = require('../../schemas/render-result-schema');
const { escapeXml, writeSvgFile } = require('./svg-utils');

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

const GLYPH_WIDTH_FACTOR = 0.6; // average-glyph-width estimate, documented above
const WORD_GAP_FACTOR = 0.3;
const LINE_HEIGHT_FACTOR = 1.3;
const TRANSITION_DURATION = 0.35; // seconds, fixed — entrance/exit transition length

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'KINETIC_TYPOGRAPHY',
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

function estimateWidth(text, size) {
  return text.length * size * GLYPH_WIDTH_FACTOR;
}

// Builds a flat atom list from the executor's own units/sequencing —
// never re-splits `text` independently (units already IS the split).
function buildAtoms(spec) {
  if (spec.sequencing === 'LINE_BY_LINE') {
    return spec.units.map((u, i) => ({ unitIndex: i, text: u, forceNewLine: true }));
  }
  if (spec.sequencing === 'LETTER_BY_LETTER') {
    return spec.units.map((u, i) => (u === '\n' ? { unitIndex: i, text: '', forceNewLine: true, skipGlyph: true } : { unitIndex: i, text: u }));
  }
  if (spec.sequencing === 'ALL_AT_ONCE') {
    // units.length === 1 (the whole text) — split only for wrap layout;
    // all atoms still belong to unitIndex 0 so they animate as one group.
    return spec.units[0].split(/\s+/).filter((w) => w.length > 0).map((w) => ({ unitIndex: 0, text: w }));
  }
  return spec.units.map((u, i) => ({ unitIndex: i, text: u })); // WORD_BY_WORD (default)
}

// Deterministic word-wrap into lines of positioned atoms. Pure function of
// the atom list + size/lineWrapWidth/alignment/position — same input
// always produces the same layout.
function layoutAtoms(atoms, spec) {
  const lineHeight = spec.size * LINE_HEIGHT_FACTOR;
  const maxLineWidth = spec.lineWrapWidth * FRAME_WIDTH;
  const contiguous = spec.sequencing === 'LETTER_BY_LETTER';
  const gap = contiguous ? 0 : spec.size * WORD_GAP_FACTOR;

  const lines = [[]];
  for (const atom of atoms) {
    if (atom.forceNewLine && lines[lines.length - 1].length > 0) {
      lines.push([]);
    }
    if (atom.skipGlyph) continue;
    const width = estimateWidth(atom.text, spec.size);
    const current = lines[lines.length - 1];
    const currentWidth = current.reduce((sum, a) => sum + a.width, 0) + (current.length > 0 ? current.length * gap : 0);
    if (!contiguous && !atom.forceNewLine && current.length > 0 && currentWidth + gap + width > maxLineWidth) {
      lines.push([{ ...atom, width }]);
    } else {
      current.push({ ...atom, width });
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();

  const blockCenterX = (spec.position && typeof spec.position.x === 'number' ? spec.position.x : 0.5) * FRAME_WIDTH;
  const blockCenterY = (spec.position && typeof spec.position.y === 'number' ? spec.position.y : 0.5) * FRAME_HEIGHT;
  const totalHeight = lines.length * lineHeight;
  const top = blockCenterY - totalHeight / 2 + lineHeight * 0.8;

  const positioned = [];
  lines.forEach((line, lineIndex) => {
    const lineWidth = line.reduce((sum, a) => sum + a.width, 0) + (line.length > 1 ? (line.length - 1) * gap : 0);
    let startX;
    if (spec.alignment === 'LEFT') startX = blockCenterX - maxLineWidth / 2;
    else if (spec.alignment === 'RIGHT') startX = blockCenterX + maxLineWidth / 2 - lineWidth;
    else startX = blockCenterX - lineWidth / 2; // CENTER

    let cursor = startX;
    const y = top + lineIndex * lineHeight;
    for (const atom of line) {
      positioned.push({ unitIndex: atom.unitIndex, text: atom.text, x: cursor, y });
      cursor += atom.width + gap;
    }
  });
  return positioned;
}

function opacityAnimate(fromValue, toValue, begin, duration, discrete) {
  if (discrete) {
    return `<animate attributeName="opacity" values="${fromValue};${toValue}" keyTimes="0;1" dur="0.05s" begin="${begin}s" fill="freeze" calcMode="discrete"/>`;
  }
  return `<animate attributeName="opacity" values="${fromValue};${toValue}" keyTimes="0;1" dur="${duration}s" begin="${begin}s" fill="freeze" calcMode="linear"/>`;
}

function transformAnimate(type, fromValue, toValue, begin, duration) {
  return `<animateTransform attributeName="transform" type="${type}" values="${fromValue};${toValue}" keyTimes="0;1" dur="${duration}s" begin="${begin}s" fill="freeze" calcMode="linear"/>`;
}

// Entrance transform, per ENTRANCE_KINDS. Returns { opacity:[from,to], transform:{type,from,to} } or null transform.
function entranceMotion(entrance) {
  switch (entrance) {
    case 'SLIDE_UP':
      return { opacityFrom: 0, opacityTo: 1, transform: { type: 'translate', from: '0 24', to: '0 0' } };
    case 'SLIDE_IN':
      return { opacityFrom: 0, opacityTo: 1, transform: { type: 'translate', from: '-40 0', to: '0 0' } };
    case 'POP_IN':
      return { opacityFrom: 0, opacityTo: 1, transform: { type: 'scale', from: '0.5', to: '1' } };
    case 'TYPE_ON':
      return { opacityFrom: 0, opacityTo: 1, discrete: true };
    default: // FADE_IN
      return { opacityFrom: 0, opacityTo: 1 };
  }
}

function exitMotion(exit) {
  switch (exit) {
    case 'SLIDE_DOWN':
      return { opacityFrom: 1, opacityTo: 0, transform: { type: 'translate', from: '0 0', to: '0 24' } };
    case 'SLIDE_OUT':
      return { opacityFrom: 1, opacityTo: 0, transform: { type: 'translate', from: '0 0', to: '40 0' } };
    case 'POP_OUT':
      return { opacityFrom: 1, opacityTo: 0, transform: { type: 'scale', from: '1', to: '0.5' } };
    case 'NONE':
      return null;
    default: // FADE_OUT
      return { opacityFrom: 1, opacityTo: 0 };
  }
}

function render({ executionResult, outputDir } = {}) {
  if (!executionResult || !executionResult.renderSpec || executionResult.renderSpec.type !== 'KINETIC_TYPOGRAPHY') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.type must be KINETIC_TYPOGRAPHY');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }
  const spec = executionResult.renderSpec;

  if (typeof spec.text !== 'string' || spec.text.trim().length === 0) {
    return fail(executionResult, 'MISSING_TEXT', 'renderSpec.text must be a non-empty string');
  }
  if (typeof spec.duration !== 'number' || !Number.isFinite(spec.duration) || spec.duration <= 0) {
    return fail(executionResult, 'INVALID_DURATION', `duration must be a positive finite number, got ${JSON.stringify(spec.duration)}`);
  }
  if (!Array.isArray(spec.timeline) || spec.timeline.length === 0) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.timeline must be a non-empty array');
  }

  const atoms = buildAtoms(spec);
  const positioned = layoutAtoms(atoms, spec);

  const emphasisSet = new Set((Array.isArray(spec.emphasis) ? spec.emphasis : []).map((e) => e.wordIndex));

  // Group positioned glyphs by unitIndex so each executor-defined timeline
  // window animates its own group exactly once.
  const byUnit = new Map();
  for (const p of positioned) {
    if (!byUnit.has(p.unitIndex)) byUnit.set(p.unitIndex, []);
    byUnit.get(p.unitIndex).push(p);
  }

  const entrance = entranceMotion(spec.entrance);
  const exit = exitMotion(spec.exit);
  const exitBegin = Math.max(0, spec.duration - TRANSITION_DURATION);

  const groups = spec.timeline.map((window) => {
    const glyphs = byUnit.get(window.index) || [];
    if (glyphs.length === 0) return '';
    const emphasized = emphasisSet.has(window.index);
    const fill = emphasized ? '#ffd54a' : '#ffffff';
    const weight = emphasized ? 'bold' : (spec.font && spec.font.weight) || 'bold';
    const family = escapeXml((spec.font && spec.font.family) || 'sans-serif');

    const texts = glyphs
      .map((g) => `<text x="${g.x}" y="${g.y}" font-family="${family}" font-weight="${escapeXml(weight)}" font-size="${spec.size}" fill="${fill}">${escapeXml(g.text)}</text>`)
      .join('');

    const entranceDuration = Math.min(TRANSITION_DURATION, Math.max(0.01, window.endOffset - window.startOffset));
    const animations = [opacityAnimate(entrance.opacityFrom, entrance.opacityTo, window.startOffset, entranceDuration, entrance.discrete)];
    if (entrance.transform) {
      animations.push(transformAnimate(entrance.transform.type, entrance.transform.from, entrance.transform.to, window.startOffset, entranceDuration));
    }
    if (exit) {
      animations.push(opacityAnimate(exit.opacityFrom, exit.opacityTo, exitBegin, TRANSITION_DURATION, false));
      if (exit.transform) {
        animations.push(transformAnimate(exit.transform.type, exit.transform.from, exit.transform.to, exitBegin, TRANSITION_DURATION));
      }
    }

    return `<g opacity="0">${texts}${animations.join('')}</g>`;
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}">`,
    `<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="#000000"/>`,
    groups.join(''),
    `</svg>`,
  ].join('');

  const filePath = writeSvgFile(outputDir, executionResult.executionId || 'kinetic-typography', svg);

  return createRenderResult({
    rendererType: 'KINETIC_TYPOGRAPHY',
    beatId: executionResult.beatId,
    materialId: executionResult.materialId,
    executionId: executionResult.executionId,
    status: 'COMPLETED',
    artifact: createRenderArtifact({ format: 'SVG', path: filePath, width: FRAME_WIDTH, height: FRAME_HEIGHT, duration: spec.duration }),
    diagnostics: [],
  });
}

module.exports = { render, FRAME_WIDTH, FRAME_HEIGHT };
