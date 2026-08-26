// Tests for services/media-acquisition/media-asset-validator.js.
//
// Image tests run fully offline against the real, already-bundled 1x1 PNG
// fixture (providers/fake-image/fixtures/sample-keyframe.png) — no
// network, no external binary required.
//
// Video tests exercise validateVideo() against whatever ffprobe/ffmpeg
// this environment actually has. Where they are NOT installed (this
// sandbox has neither — confirmed directly, not assumed), this is a
// legitimate, deterministic FFPROBE_UNAVAILABLE outcome, asserted here
// rather than skipped — the same "report, don't hide" discipline this
// codebase's own hyperframes-renderer.js/video-assembly-pipeline tests
// already depend on ffprobe/ffmpeg being present to fully exercise (a
// pre-existing environment requirement, unrelated to this stage).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const validator = require('../services/media-acquisition/media-asset-validator');

const PNG_FIXTURE = path.join(__dirname, '..', 'providers', 'fake-image', 'fixtures', 'sample-keyframe.png');
const MP4_FIXTURE = path.join(__dirname, '..', 'providers', 'fake-video', 'fixtures', 'sample-video.mp4');

// --- E. invalid downloaded asset (images) -------------------------------------------------------------------

test('E. validateImage accepts the real bundled 1x1 PNG fixture and reports its real dimensions', () => {
  const result = validator.validateImage(PNG_FIXTURE);
  assert.equal(result.ok, true);
  assert.equal(result.format, 'png');
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.ok(result.sizeBytes > 0);
});

test('E2. validateImage rejects a file that is not a recognized image format', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-validator-')), 'not-an-image.bin');
  fs.writeFileSync(tmp, 'this is definitely not an image');
  const result = validator.validateImage(tmp);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_FORMAT');
});

test('E3. validateImage rejects an empty file', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-validator-')), 'empty.png');
  fs.writeFileSync(tmp, Buffer.alloc(0));
  const result = validator.validateImage(tmp);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY_FILE');
});

test('E4. validateImage rejects a real PNG below the requested minWidth/minHeight, using its own real IHDR dimensions', () => {
  const result = validator.validateImage(PNG_FIXTURE, { minWidth: 100, minHeight: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BELOW_MIN_WIDTH');
});

test('E5. validateImage reports FILE_NOT_FOUND for a nonexistent path', () => {
  const result = validator.validateImage('/nonexistent/path/x.png');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FILE_NOT_FOUND');
});

test('E6. validateImage trusts candidate-reported dimensions for a non-PNG format it cannot parse itself, and still enforces a floor', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-validator-')), 'x.jpg');
  fs.writeFileSync(tmp, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])); // real JPEG magic bytes, minimal
  const ok = validator.validateImage(tmp, { minWidth: 500, candidateWidth: 1000, candidateHeight: 800 });
  assert.equal(ok.ok, true);
  assert.equal(ok.width, 1000);

  const rejected = validator.validateImage(tmp, { minWidth: 5000, candidateWidth: 1000, candidateHeight: 800 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'BELOW_MIN_WIDTH');

  const unknown = validator.validateImage(tmp, { minWidth: 500 }); // no candidate dimensions supplied at all
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'DIMENSIONS_UNKNOWN');
});

// --- E (videos) -------------------------------------------------------------------

test('E7. validateVideo reports FILE_NOT_FOUND for a nonexistent path', () => {
  const result = validator.validateVideo('/nonexistent/path/x.mp4');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FILE_NOT_FOUND');
});

test('E8. validateVideo reports EMPTY_FILE for a zero-byte file before ever invoking ffprobe', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-validator-')), 'empty.mp4');
  fs.writeFileSync(tmp, Buffer.alloc(0));
  const result = validator.validateVideo(tmp);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY_FILE');
});

test('E9. validateVideo never silently passes a file it cannot actually validate — reports a distinct FFPROBE_UNAVAILABLE (when ffprobe/ffmpeg are absent) or a real pass/fail (when they are present), never a false OK on missing tooling', () => {
  const ffprobeMissing = validator.locateOnPath('ffprobe') === null;
  const result = validator.validateVideo(MP4_FIXTURE, { minDurationSeconds: 1 });
  if (ffprobeMissing) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FFPROBE_UNAVAILABLE');
  } else {
    // ffprobe IS installed in whatever environment runs this — the bundled
    // sample-video.mp4 fixture is a placeholder text file (see
    // providers/fake-video/fake-video-provider.js's own header: "never a
    // real download"), so real ffprobe must genuinely fail to parse it —
    // asserted as a real FAILED outcome, never a pass.
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FFPROBE_VALIDATION_FAILED');
  }
});

// --- checksum -------------------------------------------------------------------

test('checksum. computeChecksum is deterministic and content-addressed', () => {
  const a = validator.computeChecksum(PNG_FIXTURE);
  const b = validator.computeChecksum(PNG_FIXTURE);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});
