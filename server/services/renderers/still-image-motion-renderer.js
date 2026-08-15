// still-image-motion-renderer.js
//
// Stage 26.8A — the STILL_IMAGE_MOTION renderer. Consumes the
// STILL_IMAGE_MOTION executor's existing renderSpec (services/material-
// executors/still-image-motion-executor.js) VERBATIM: assetId, motionKind,
// duration, startScale/endScale, startPosition/endPosition (normalized
// frame-fraction offsets), fadeIn/fadeOut, easing. This renderer never
// re-derives a motion transform — MOTION_TRANSFORMS already lives in the
// executor; this file only draws the two keyframes it was given and
// animates between them.
//
// Produces a real, self-contained, ANIMATED SVG: the source image's actual
// bytes are embedded as a base64 data URI, and the <image> element's own
// x/y/width/height attributes are animated (via SMIL <animate>, calcMode
// "spline" for eased motion) from the start keyframe to the end keyframe
// over renderSpec.duration seconds — a real Ken-Burns-style motion, not a
// second JSON description of one. Opacity is animated the same way for
// fadeIn/fadeOut when requested.
//
// SCOPE LIMITATION — identical to asset-placement-renderer.js: only a
// STORED, PNG, IMAGE-type asset can be rendered here (no video-frame
// extraction/ffmpeg, no non-PNG dimension reading this stage). See that
// file's header and this stage's final report for the full reasoning.

const fs = require('fs');
const timelineStore = require('../timeline-store');
const assetStorage = require('../asset-storage');
const { createRenderResult, createRenderDiagnostic, createRenderArtifact } = require('../../schemas/render-result-schema');
const { escapeXml, readPngDimensions, toDataUri, writeSvgFile, EASING_KEY_SPLINES } = require('./svg-utils');

// Same canonical frame as asset-placement-renderer.js — see that file's
// header for why 1920x1080 (whiteboard-executor.js's own existing default),
// not a new invented convention.
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'STILL_IMAGE_MOTION',
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

// Cover-fit display rect for a given scale/position — the exact same math
// asset-placement-renderer.js uses for its static COVER case, applied here
// twice (once per keyframe) since STILL_IMAGE_MOTION has no objectFit field
// of its own (the executor's renderSpec only ever describes a cover-style
// Ken Burns frame — see MOTION_TRANSFORMS's own normalized-offset comment).
function coverRect(dimensions, scale, position) {
  const fitScale = Math.max(FRAME_WIDTH / dimensions.width, FRAME_HEIGHT / dimensions.height);
  const width = dimensions.width * fitScale * scale;
  const height = dimensions.height * fitScale * scale;
  const x = (FRAME_WIDTH - width) / 2 + position.x * FRAME_WIDTH;
  const y = (FRAME_HEIGHT - height) / 2 + position.y * FRAME_HEIGHT;
  return { x, y, width, height };
}

function buildAnimate(attributeName, fromValue, toValue, duration, keySplines) {
  const common = `attributeName="${attributeName}" values="${fromValue};${toValue}" keyTimes="0;1" dur="${duration}s" begin="0s" fill="freeze"`;
  if (keySplines) {
    return `<animate ${common} calcMode="spline" keySplines="${keySplines}"/>`;
  }
  return `<animate ${common} calcMode="linear"/>`;
}

// Opacity keyframes for fadeIn/fadeOut, clamped so keyTimes stay strictly
// increasing even if fadeIn+fadeOut would otherwise exceed duration —
// a rendering-time defensive clamp, never a semantic reinterpretation of
// the requested fade lengths.
function buildOpacityAnimate(fadeIn, fadeOut, duration) {
  const safeIn = Math.max(0, Math.min(fadeIn, duration / 2));
  const safeOut = Math.max(0, Math.min(fadeOut, duration / 2));
  if (safeIn <= 0 && safeOut <= 0) return '';
  const keyTimes = [0];
  const values = [safeIn > 0 ? 0 : 1];
  if (safeIn > 0) {
    keyTimes.push(safeIn / duration);
    values.push(1);
  }
  if (safeOut > 0) {
    keyTimes.push((duration - safeOut) / duration);
    values.push(1);
  }
  keyTimes.push(1);
  values.push(safeOut > 0 ? 0 : 1);
  return `<animate attributeName="opacity" values="${values.join(';')}" keyTimes="${keyTimes.join(';')}" dur="${duration}s" begin="0s" fill="freeze" calcMode="linear"/>`;
}

function render({ projectId, executionResult, outputDir } = {}) {
  if (!executionResult || !executionResult.renderSpec || executionResult.renderSpec.type !== 'STILL_IMAGE_MOTION') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.type must be STILL_IMAGE_MOTION');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }
  const spec = executionResult.renderSpec;

  if (typeof spec.duration !== 'number' || !Number.isFinite(spec.duration) || spec.duration <= 0) {
    return fail(executionResult, 'INVALID_DURATION', `duration must be a positive finite number, got ${JSON.stringify(spec.duration)}`);
  }

  const asset = timelineStore.getAsset(projectId, spec.assetId);
  if (!asset) {
    return fail(executionResult, 'MISSING_ASSET', `no asset found with id "${spec.assetId}" in project "${projectId}"`);
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return fail(executionResult, 'ASSET_NOT_STORED', `asset "${spec.assetId}" storage status is "${storageStatus}", not STORED`);
  }
  if (asset.type === 'video') {
    return fail(executionResult, 'RENDERER_UNAVAILABLE', 'animating a video-type asset requires frame extraction (ffmpeg), which is not a declared dependency of this repository — see Stage 26.8A final report');
  }

  let buffer;
  try {
    buffer = fs.readFileSync(assetStorage.resolveStoredPath(asset.storage.path));
  } catch (error) {
    return fail(executionResult, 'MISSING_ASSET', `could not read stored file for asset "${spec.assetId}": ${error.message}`);
  }

  const sniffed = assetStorage.sniffImageFormat(buffer);
  if (!sniffed || sniffed.ext !== '.png') {
    return fail(executionResult, 'RENDERER_UNAVAILABLE', 'only PNG source images are supported by this stage\'s dependency-free renderer — see svg-utils.js\'s readPngDimensions');
  }
  const dimensions = readPngDimensions(buffer);
  if (!dimensions) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'source image is not a well-formed PNG');
  }

  const startRect = coverRect(dimensions, spec.startScale, spec.startPosition);
  const endRect = coverRect(dimensions, spec.endScale, spec.endPosition);
  const keySplines = EASING_KEY_SPLINES[spec.easing] || null;

  const xAnim = buildAnimate('x', startRect.x, endRect.x, spec.duration, keySplines);
  const yAnim = buildAnimate('y', startRect.y, endRect.y, spec.duration, keySplines);
  const wAnim = buildAnimate('width', startRect.width, endRect.width, spec.duration, keySplines);
  const hAnim = buildAnimate('height', startRect.height, endRect.height, spec.duration, keySplines);
  const opacityAnim = buildOpacityAnimate(spec.fadeIn, spec.fadeOut, spec.duration);

  const dataUri = toDataUri(buffer, sniffed.contentType);
  const clipId = `clip-${executionResult.executionId || 'r'}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}">`,
    `<defs><clipPath id="${escapeXml(clipId)}"><rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}"/></clipPath></defs>`,
    `<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="#000000"/>`,
    `<g clip-path="url(#${escapeXml(clipId)})">`,
    `<image x="${startRect.x}" y="${startRect.y}" width="${startRect.width}" height="${startRect.height}" opacity="${opacityAnim ? (spec.fadeIn > 0 ? 0 : 1) : 1}" href="${dataUri}">`,
    xAnim,
    yAnim,
    wAnim,
    hAnim,
    opacityAnim,
    `</image>`,
    `</g>`,
    `</svg>`,
  ].join('');

  const filePath = writeSvgFile(outputDir, executionResult.executionId || 'still-image-motion', svg);

  return createRenderResult({
    rendererType: 'STILL_IMAGE_MOTION',
    beatId: executionResult.beatId,
    materialId: executionResult.materialId,
    executionId: executionResult.executionId,
    status: 'COMPLETED',
    artifact: createRenderArtifact({ format: 'SVG', path: filePath, width: FRAME_WIDTH, height: FRAME_HEIGHT, duration: spec.duration }),
    diagnostics: [],
  });
}

module.exports = { render, FRAME_WIDTH, FRAME_HEIGHT };
