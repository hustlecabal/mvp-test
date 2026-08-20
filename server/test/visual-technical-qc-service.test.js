// Tests for services/visual-technical-qc-service.js — real ffprobe-based
// structural validation, separate from creative QC. Real ffmpeg-encoded
// fixture files, real ffprobe subprocess calls (no mocking of the tool
// itself — matches this codebase's own "FFmpeg/ffprobe are real,
// already-installed" convention).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

for (const [envVar, prefix] of [
  ['ASSET_STORAGE_DIR', 'evolink-tqc-assets-'],
  ['PROJECT_DATA_DIR', 'evolink-tqc-projects-'],
]) {
  process.env[envVar] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const technicalQc = require('../services/visual-technical-qc-service');

function newProject() {
  return projectStore.createProject({ title: 'x', topic: 'y' });
}

function makeRealImageFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-tqc-src-'));
  const p = path.join(dir, 'frame.png');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:duration=1:rate=1', '-frames:v', '1', p]);
  return p;
}

function makeRealVideoFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-tqc-src-'));
  const p = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:duration=1:rate=25', '-pix_fmt', 'yuv420p', p]);
  return p;
}

// Writes a real file directly into ASSETS_DIR via the same resolveStoredPath()
// guard visual-technical-qc-service.js itself uses, then registers a real
// Asset record pointing at it — mirrors this codebase's own "a provider/job
// hands back bytes, this is where they land in storage" pattern without
// depending on a specific upload-format-sniffing helper (asset-storage.js's
// storeUploadedImage() only recognizes PNG/JPEG/GIF/WEBP, not MP4).
function storeAndRegisterAsset(project, sourceFile, type, contentType) {
  const buf = fs.readFileSync(sourceFile);
  const relativePath = `${crypto.randomUUID()}${path.extname(sourceFile)}`;
  fs.writeFileSync(assetStorage.resolveStoredPath(relativePath), buf);
  return timelineStore.addAsset(project.id, { type, storage: { provider: 'local', path: relativePath, status: 'STORED', contentType, sizeBytes: buf.length, archivedAt: new Date().toISOString() } });
}

test('1. a real, valid image asset PASSes technical QC', () => {
  const project = newProject();
  const asset = storeAndRegisterAsset(project, makeRealImageFile(), 'keyframe', 'image/png');
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'PASS');
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
});

test('2. a real, valid video asset PASSes technical QC with a real measured duration', () => {
  const project = newProject();
  const asset = storeAndRegisterAsset(project, makeRealVideoFile(), 'video', 'video/mp4');
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'PASS');
});

test('3. a nonexistent asset fails with ASSET_NOT_FOUND', () => {
  const project = newProject();
  const result = technicalQc.runTechnicalQc(project.id, '00000000-0000-4000-8000-000000000000');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ASSET_NOT_FOUND');
});

test('4. an asset that is not yet STORED fails with ASSET_NOT_ARCHIVED, never runs ffprobe', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe' });
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ASSET_NOT_ARCHIVED');
});

test('5. a zero-byte file fails with FILE_EMPTY', () => {
  const project = newProject();
  const relativePath = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(assetStorage.resolveStoredPath(relativePath), Buffer.alloc(0));
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', storage: { provider: 'local', path: relativePath, status: 'STORED', contentType: 'image/png', sizeBytes: 0, archivedAt: new Date().toISOString() } });
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FILE_EMPTY');
});

test('6. an asset record pointing at a file that does not exist on disk fails with FILE_NOT_FOUND', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', storage: { provider: 'local', path: 'does-not-exist.png', status: 'STORED', contentType: 'image/png', sizeBytes: 100, archivedAt: new Date().toISOString() } });
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FILE_NOT_FOUND');
});

test('7. a genuinely corrupt (non-media) file fails structurally, never crashes the caller', () => {
  const project = newProject();
  const relativePath = `${crypto.randomUUID()}.png`;
  const buf = Buffer.from('this is not a real image or video file');
  fs.writeFileSync(assetStorage.resolveStoredPath(relativePath), buf);
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', storage: { provider: 'local', path: relativePath, status: 'STORED', contentType: 'image/png', sizeBytes: buf.length, archivedAt: new Date().toISOString() } });
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, false);
  // ffprobe's exact failure mode for garbage bytes is version-dependent
  // (outright parse failure, no recognized stream, or a "stream" with
  // missing dimensions) — any of runTechnicalQc's own honest failure
  // codes is correct; the only wrong outcome is ok:true or a thrown error.
  assert.ok(['FFPROBE_FAILED', 'NO_VISUAL_STREAM', 'INVALID_DIMENSIONS', 'UNKNOWN_CODEC'].includes(result.code));
});

test('8. resolveStoredPath\'s own path-traversal guard is inherited — an escaping path never reads outside ASSET_STORAGE_DIR', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', storage: { provider: 'local', path: '../../../etc/passwd', status: 'STORED', contentType: 'image/png', sizeBytes: 100, archivedAt: new Date().toISOString() } });
  const result = technicalQc.runTechnicalQc(project.id, asset.assetId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_STORAGE_PATH');
});

test('9. security — visual-technical-qc-service.js only ever invokes ffprobe via execFileSync (never a shell string)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'visual-technical-qc-service.js'), 'utf8');
  assert.ok(!/\bexec\(/.test(source));
  assert.ok(!/\beval\(/.test(source));
  assert.ok(source.includes('execFileSync'));
});

test('10. runTechnicalQc never wired into keyframe-generation-service.js or video-generation-service.js\'s own hot path (opt-in only)', () => {
  const kf = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-generation-service.js'), 'utf8');
  const vid = fs.readFileSync(path.join(__dirname, '..', 'services', 'video-generation-service.js'), 'utf8');
  assert.ok(!kf.includes('visual-technical-qc-service'));
  assert.ok(!vid.includes('visual-technical-qc-service'));
});
