// asset-placement-renderer.js
//
// Stage 26.8A — the ASSET_PLACEMENT renderer. Consumes the
// PROJECT_ASSET_REUSE executor's existing renderSpec (services/material-
// executors/project-asset-reuse-executor.js) VERBATIM — never
// re-resolves, re-executes, or re-derives anything about WHAT asset to
// place; this renderer only draws it.
//
// Produces a real, self-contained SVG document: the source image's actual
// bytes are read from disk (via the existing, unmodified services/asset-
// storage.js) and embedded as a base64 data URI, positioned/scaled/
// cropped/faded exactly per the renderSpec. Opening the resulting .svg
// file in any browser shows the real image, correctly placed — genuine
// visual output, never another JSON specification.
//
// SCOPE LIMITATION (see Stage 26.8A's final report "Renderers blocked"
// section for the full reasoning): only an IMAGE-type Asset (keyframe/
// character_reference/location_reference) can be rendered here. A VIDEO-
// type Asset reused via PROJECT_ASSET_REUSE would need a real decoded
// preview frame, which requires frame extraction (ffmpeg) — not a
// declared dependency of this repository. That case fails structurally
// with RENDERER_UNAVAILABLE, never a fabricated placeholder frame.
//
// Only PNG source images are supported this stage (services/asset-
// storage.js's own sniffImageFormat already distinguishes PNG/JPEG/GIF/
// WEBP by magic bytes; this renderer additionally needs the image's pixel
// dimensions, and only a dependency-free PNG dimension reader is
// implemented — see svg-utils.js's readPngDimensions).

const fs = require('fs');
const timelineStore = require('../timeline-store');
const assetStorage = require('../asset-storage');
const { createRenderResult, createRenderDiagnostic, createRenderArtifact } = require('../../schemas/render-result-schema');
const { escapeXml, readPngDimensions, toDataUri, writeSvgFile } = require('./svg-utils');

// A canonical output frame — this codebase has no per-project resolution
// field anywhere yet (production-schema.js's outputSettings is declared
// but always empty, confirmed by the Stage 26.6 audit); 1920x1080 matches
// the SAME default services/material-executors/whiteboard-executor.js's
// own renderSpec.canvas already uses, so this renderer stays consistent
// with an existing precedent rather than inventing a new default.
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const OBJECT_FIT_VALUES = ['COVER', 'CONTAIN', 'FILL'];

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'ASSET_PLACEMENT',
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

function render({ projectId, executionResult, outputDir } = {}) {
  if (!executionResult || !executionResult.renderSpec || executionResult.renderSpec.type !== 'ASSET_PLACEMENT') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.type must be ASSET_PLACEMENT');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }
  const spec = executionResult.renderSpec;

  const asset = timelineStore.getAsset(projectId, spec.assetId);
  if (!asset) {
    return fail(executionResult, 'MISSING_ASSET', `no asset found with id "${spec.assetId}" in project "${projectId}"`);
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return fail(executionResult, 'ASSET_NOT_STORED', `asset "${spec.assetId}" storage status is "${storageStatus}", not STORED`);
  }

  if (asset.type === 'video') {
    return fail(executionResult, 'RENDERER_UNAVAILABLE', 'rendering a video-type asset placement requires frame extraction (ffmpeg), which is not a declared dependency of this repository — see Stage 26.8A final report');
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

  const objectFit = OBJECT_FIT_VALUES.includes(spec.objectFit) ? spec.objectFit : 'COVER';
  const scale = typeof spec.scale === 'number' ? spec.scale : 1;
  const opacity = typeof spec.opacity === 'number' ? spec.opacity : 1;
  const position = spec.position && typeof spec.position.x === 'number' && typeof spec.position.y === 'number' ? spec.position : { x: 0, y: 0 };

  const fitScaleX = FRAME_WIDTH / dimensions.width;
  const fitScaleY = FRAME_HEIGHT / dimensions.height;
  let displayWidth;
  let displayHeight;
  if (objectFit === 'FILL') {
    displayWidth = FRAME_WIDTH * scale;
    displayHeight = FRAME_HEIGHT * scale;
  } else {
    const fitScale = objectFit === 'CONTAIN' ? Math.min(fitScaleX, fitScaleY) : Math.max(fitScaleX, fitScaleY);
    displayWidth = dimensions.width * fitScale * scale;
    displayHeight = dimensions.height * fitScale * scale;
  }
  const x = (FRAME_WIDTH - displayWidth) / 2 + position.x * FRAME_WIDTH;
  const y = (FRAME_HEIGHT - displayHeight) / 2 + position.y * FRAME_HEIGHT;

  const dataUri = toDataUri(buffer, sniffed.contentType);
  const clipId = `clip-${executionResult.executionId || 'r'}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}">`,
    `<defs><clipPath id="${escapeXml(clipId)}"><rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}"/></clipPath></defs>`,
    `<rect x="0" y="0" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="#000000"/>`,
    `<g clip-path="url(#${escapeXml(clipId)})">`,
    `<image x="${x}" y="${y}" width="${displayWidth}" height="${displayHeight}" opacity="${opacity}" href="${dataUri}"/>`,
    `</g>`,
    `</svg>`,
  ].join('');

  const filePath = writeSvgFile(outputDir, executionResult.executionId || 'asset-placement', svg);

  return createRenderResult({
    rendererType: 'ASSET_PLACEMENT',
    beatId: executionResult.beatId,
    materialId: executionResult.materialId,
    executionId: executionResult.executionId,
    status: 'COMPLETED',
    artifact: createRenderArtifact({ format: 'SVG', path: filePath, width: FRAME_WIDTH, height: FRAME_HEIGHT, duration: null }),
    diagnostics: [],
  });
}

module.exports = { render, FRAME_WIDTH, FRAME_HEIGHT };
