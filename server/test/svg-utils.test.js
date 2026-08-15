// Tests for services/renderers/svg-utils.js — Stage 26.8A shared,
// dependency-free SVG helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { escapeXml, readPngDimensions, toDataUri, writeSvgFile, EASING_KEY_SPLINES } = require('../services/renderers/svg-utils');
const { makeTinyPng } = require('./fixtures/png-fixture');

// --- escapeXml -------------------------------------------------------------------

test('1. escapeXml escapes all 5 XML-significant characters', () => {
  assert.equal(escapeXml('<script>&"\'</script>'), '&lt;script&gt;&amp;&quot;&apos;&lt;/script&gt;');
});

test('2. escapeXml coerces non-string input to a string first', () => {
  assert.equal(escapeXml(42), '42');
  assert.equal(escapeXml(null), 'null');
});

test('3. escapeXml never emits a raw "<" or ">" for any input — prevents markup injection', () => {
  const malicious = '"><script>alert(1)</script>';
  const escaped = escapeXml(malicious);
  assert.doesNotMatch(escaped, /[<>]/);
});

// --- readPngDimensions -------------------------------------------------------------------

test('4. readPngDimensions reads width/height from a real, well-formed PNG', () => {
  const png = makeTinyPng(8, 4);
  assert.deepEqual(readPngDimensions(png), { width: 8, height: 4 });
});

test('5. readPngDimensions reads non-square dimensions correctly (width != height)', () => {
  const png = makeTinyPng(400, 100);
  assert.deepEqual(readPngDimensions(png), { width: 400, height: 100 });
});

test('6. readPngDimensions returns null for a non-Buffer', () => {
  assert.equal(readPngDimensions('not a buffer'), null);
  assert.equal(readPngDimensions(null), null);
  assert.equal(readPngDimensions(undefined), null);
});

test('7. readPngDimensions returns null for a too-short buffer', () => {
  assert.equal(readPngDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
});

test('8. readPngDimensions returns null for a buffer that is not IHDR at the expected offset (e.g. a JPEG)', () => {
  const jpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0)]);
  assert.equal(readPngDimensions(jpegLike), null);
});

// --- toDataUri -------------------------------------------------------------------

test('9. toDataUri produces a correctly-formatted base64 data URI', () => {
  const buf = Buffer.from([1, 2, 3, 4]);
  const uri = toDataUri(buf, 'image/png');
  assert.equal(uri, `data:image/png;base64,${buf.toString('base64')}`);
});

test('10. toDataUri round-trips the exact original bytes', () => {
  const png = makeTinyPng(8, 4);
  const uri = toDataUri(png, 'image/png');
  const b64 = uri.split(',')[1];
  const roundTripped = Buffer.from(b64, 'base64');
  assert.ok(roundTripped.equals(png));
});

// --- writeSvgFile -------------------------------------------------------------------

test('11. writeSvgFile writes a real file to <outputDir>/<renderId>.svg and returns its absolute path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-svg-utils-test-'));
  const filePath = writeSvgFile(dir, 'render-abc', '<svg></svg>');
  assert.equal(filePath, path.join(dir, 'render-abc.svg'));
  assert.ok(fs.existsSync(filePath));
  assert.equal(fs.readFileSync(filePath, 'utf8'), '<svg></svg>');
});

test('12. writeSvgFile creates outputDir recursively if it does not exist yet', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-svg-utils-test-')), 'nested', 'deep');
  assert.equal(fs.existsSync(dir), false);
  const filePath = writeSvgFile(dir, 'r1', '<svg/>');
  assert.ok(fs.existsSync(filePath));
});

test('13. writeSvgFile never writes outside the caller-supplied outputDir (no second persistent storage location)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-svg-utils-test-'));
  const filePath = writeSvgFile(dir, 'r2', '<svg/>');
  assert.ok(filePath.startsWith(dir));
});

// --- EASING_KEY_SPLINES -------------------------------------------------------------------

test('14. EASING_KEY_SPLINES has exactly the 4 documented easing keys', () => {
  assert.deepEqual(Object.keys(EASING_KEY_SPLINES).sort(), ['EASE_IN', 'EASE_IN_OUT', 'EASE_OUT', 'LINEAR'].sort());
  assert.equal(EASING_KEY_SPLINES.LINEAR, null);
  assert.equal(typeof EASING_KEY_SPLINES.EASE_IN_OUT, 'string');
});

// --- safety -------------------------------------------------------------------

test('15. services/renderers/svg-utils.js never eval()s or new Function()s anything, and no template/string literal in the file builds a <script> tag (comments discussing its deliberate absence are fine)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'svg-utils.js'), 'utf8');
  assert.doesNotMatch(text, /\beval\(/);
  assert.doesNotMatch(text, /new Function\(/);
  const codeOnly = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(codeOnly, /<script/i);
});

test('16. services/renderers/svg-utils.js requires only fs and path — no canvas/sharp/svg library, no network', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'svg-utils.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['fs', 'path'].sort());
});
