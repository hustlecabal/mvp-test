// svg-utils.js
//
// Stage 26.8A — small, shared, dependency-free helpers every SVG-producing
// renderer in this directory uses. No canvas/sharp/svg library is
// installed or required anywhere in this file — only Node's own built-in
// `fs`/`path`/`crypto` modules. See the Stage 26.8A final report's
// "capabilities audit" for why SVG (a plain, hand-constructed XML text
// format) was chosen as this stage's output format: it requires zero new
// dependencies, is natively viewable/verifiable in any browser or image
// tool, and supports real deterministic animation (SMIL) without any
// rendering engine.
//
// SECURITY (Part 15): every value written into the SVG text below MUST go
// through escapeXml() or be a value THIS module itself computed (never a
// caller-supplied string placed raw into markup). No <script> element is
// ever emitted anywhere in this directory. renderSpec is DATA — nothing
// here ever evaluates it as code, and no renderer in this directory writes
// a <script>/onload/onclick/href="javascript:" attribute under any
// circumstance.

const fs = require('fs');
const path = require('path');

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// PNG-only, pure JS, no dependency. PNG's IHDR chunk always sits at a fixed
// offset: 8-byte signature, 4-byte chunk length, 4-byte "IHDR" tag, then a
// 4-byte big-endian width and a 4-byte big-endian height. Returns null for
// anything that isn't a well-formed PNG (including a valid JPEG/GIF/WEBP —
// see this stage's final report for why only PNG dimension-reading is
// implemented: every fixture and every currently-storable image asset in
// this codebase is sniffed by services/asset-storage.js's own
// sniffImageFormat, and PNG is this stage's only tested/proven format).
function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function toDataUri(buffer, contentType) {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

// Writes `svgText` to `<outputDir>/<renderId>.svg` and returns the
// absolute path. `outputDir` is always caller-supplied (services/render-
// service.js never picks or persists a default location itself — see that
// file's own header comment).
function writeSvgFile(outputDir, renderId, svgText) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${renderId}.svg`);
  fs.writeFileSync(filePath, svgText, 'utf8');
  return filePath;
}

// A fixed, small set of named cubic-bezier keySplines approximating common
// CSS-style easing curves for SMIL's calcMode="spline" — never derived
// from caller input, never eval'd, just a lookup table.
const EASING_KEY_SPLINES = {
  LINEAR: null, // calcMode stays "linear" — no keySplines needed
  EASE_IN_OUT: '0.42 0 0.58 1',
  EASE_IN: '0.42 0 1 1',
  EASE_OUT: '0 0 0.58 1',
};

module.exports = {
  escapeXml,
  readPngDimensions,
  toDataUri,
  writeSvgFile,
  EASING_KEY_SPLINES,
};
