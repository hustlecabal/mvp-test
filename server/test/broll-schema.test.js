// Tests for schemas/broll-schema.js — the BRollSegment record shape.
// Schema-only: plain object factories, no file I/O, no persistence, no
// policy/eligibility logic (that belongs to a later stage).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  SOURCE_TYPES,
  LICENSING_STATUSES,
  MATERIAL_ROLES,
  BROLL_STATUSES,
  createBrollSource,
  createBrollMedia,
  createBrollDescriptiveMetadata,
  createBrollLicensing,
  createBrollUsage,
  createBrollSegment,
} = require('../schemas/broll-schema');

// --- 1. defaults -------------------------------------------------------------------

test('1. createBrollSegment defaults — every top-level field present with sane defaults', () => {
  const seg = createBrollSegment();
  assert.equal(typeof seg.id, 'string');
  assert.equal(seg.projectId, null);
  assert.equal(seg.assetId, null);
  assert.deepEqual(seg.source, { type: null, provider: null, originalReference: null, importedAt: seg.source.importedAt });
  assert.deepEqual(seg.media, { duration: null, width: null, height: null, fps: null, aspectRatio: null, mimeType: null, fileSize: null });
  assert.deepEqual(seg.descriptiveMetadata, { title: '', description: '', tags: [], subjects: [], environments: [], actions: [], mood: '', visualStyle: '' });
  assert.deepEqual(seg.licensing, { status: null, source: '', attribution: '', restrictions: [] });
  assert.deepEqual(seg.usage, { eligibleRoles: [], allowedTreatments: ['BROLL_CLIP'] });
  assert.equal(seg.status, 'ACTIVE');
  assert.equal(typeof seg.createdAt, 'string');
});

// --- 2. overrides -------------------------------------------------------------------

test('2. createBrollSegment overrides — top-level and nested partial overrides both apply, unspecified nested fields keep their defaults', () => {
  const seg = createBrollSegment({
    projectId: 'proj-1',
    assetId: 'asset-1',
    licensing: { status: 'LICENSED' },
    descriptiveMetadata: { tags: ['city', 'street'] },
  });
  assert.equal(seg.projectId, 'proj-1');
  assert.equal(seg.assetId, 'asset-1');
  assert.equal(seg.licensing.status, 'LICENSED');
  assert.equal(seg.licensing.source, ''); // untouched nested default preserved
  assert.deepEqual(seg.descriptiveMetadata.tags, ['city', 'street']);
  assert.equal(seg.descriptiveMetadata.title, ''); // untouched nested default preserved
});

// --- 3. unique IDs -------------------------------------------------------------------

test('3. every createBrollSegment call gets a unique id', () => {
  const a = createBrollSegment();
  const b = createBrollSegment();
  assert.notEqual(a.id, b.id);
});

// --- 4. licensing enum -------------------------------------------------------------------

test('4. LICENSING_STATUSES is exactly LICENSED/UNKNOWN/RESTRICTED/REJECTED', () => {
  assert.deepEqual(LICENSING_STATUSES, ['LICENSED', 'UNKNOWN', 'RESTRICTED', 'REJECTED']);
});

// --- 5. role enum -------------------------------------------------------------------

test('5. MATERIAL_ROLES matches the existing visual-beat-schema.js vocabulary exactly', () => {
  const { MATERIAL_ROLES: visualBeatRoles } = require('../schemas/visual-beat-schema');
  assert.deepEqual(MATERIAL_ROLES, visualBeatRoles);
  assert.deepEqual(MATERIAL_ROLES, ['PRIMARY', 'OVERLAY', 'BACKGROUND', 'INSERT']);
});

// --- 6. media metadata can be null -------------------------------------------------------------------

test('6. every media field defaults to null — unknown metadata is represented, not guessed', () => {
  const media = createBrollMedia();
  assert.equal(media.duration, null);
  assert.equal(media.width, null);
  assert.equal(media.height, null);
  assert.equal(media.fps, null);
  assert.equal(media.aspectRatio, null);
  assert.equal(media.mimeType, null);
  assert.equal(media.fileSize, null);

  const seg = createBrollSegment();
  assert.equal(seg.media.duration, null);
  assert.equal(seg.media.width, null);
  assert.equal(seg.media.height, null);
});

// --- 7. descriptive metadata defaults -------------------------------------------------------------------

test('7. descriptive metadata defaults to empty strings/arrays, never null, never invented content', () => {
  const meta = createBrollDescriptiveMetadata();
  assert.equal(meta.title, '');
  assert.equal(meta.description, '');
  assert.deepEqual(meta.tags, []);
  assert.deepEqual(meta.subjects, []);
  assert.deepEqual(meta.environments, []);
  assert.deepEqual(meta.actions, []);
  assert.equal(meta.mood, '');
  assert.equal(meta.visualStyle, '');
});

// --- 8. source defaults -------------------------------------------------------------------

test('8. source defaults — type/provider/originalReference null, importedAt an ISO timestamp, type is one of SOURCE_TYPES when set', () => {
  const source = createBrollSource();
  assert.equal(source.type, null);
  assert.equal(source.provider, null);
  assert.equal(source.originalReference, null);
  assert.equal(typeof source.importedAt, 'string');
  assert.doesNotThrow(() => new Date(source.importedAt).toISOString());

  assert.deepEqual(SOURCE_TYPES, ['LOCAL_UPLOAD', 'LIBRARY_IMPORT', 'EXTERNAL_REFERENCE']);
  for (const type of SOURCE_TYPES) {
    const s = createBrollSource({ type });
    assert.equal(s.type, type);
  }
});

// --- 9. assetId/projectId lineage -------------------------------------------------------------------

test('9. assetId and projectId are the only lineage fields — the record traces back to an existing Asset, never invents one', () => {
  const seg = createBrollSegment({ projectId: 'proj-1', assetId: 'asset-abc' });
  assert.equal(seg.projectId, 'proj-1');
  assert.equal(seg.assetId, 'asset-abc');
  // no separate id-like fields duplicating the Asset relationship
  assert.equal(seg.sourceAssetId, undefined);
  assert.equal(seg.originalAssetId, undefined);
});

// --- 10. no binary/path duplication fields -------------------------------------------------------------------

test('10. no path/url/storage field anywhere on a BRollSegment — the underlying binary is never duplicated or re-referenced by path', () => {
  const seg = createBrollSegment();
  assert.equal(seg.path, undefined);
  assert.equal(seg.url, undefined);
  assert.equal(seg.storage, undefined);
  assert.equal(seg.filePath, undefined);
  assert.equal(seg.source.path, undefined);
  assert.equal(seg.source.url, undefined);
});

// --- 11. provider-neutrality -------------------------------------------------------------------

test('11. no generation-provider/model field anywhere, and no provider name is hardcoded into the file itself', () => {
  const seg = createBrollSegment();
  assert.equal(seg.provider, undefined);
  assert.equal(seg.model, undefined);
  assert.equal(seg.source.model, undefined);

  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'broll-schema.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'veo', 'openai', 'runway']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `broll-schema.js must not mention provider "${forbidden}"`);
  }
});

// --- 12. deterministic object shape -------------------------------------------------------------------

test('12. identical overrides produce structurally identical output (ids/timestamps aside)', () => {
  const a = createBrollSegment({ projectId: 'p', assetId: 'a', licensing: { status: 'LICENSED' } });
  const b = createBrollSegment({ projectId: 'p', assetId: 'a', licensing: { status: 'LICENSED' } });
  const { id: idA, createdAt: createdAtA, source: sourceA, ...restA } = a;
  const { id: idB, createdAt: createdAtB, source: sourceB, ...restB } = b;
  assert.deepEqual(restA, restB);
});

// --- 13. no unexpected fields -------------------------------------------------------------------

test('13. createBrollSegment produces exactly the documented top-level and nested field set, nothing more', () => {
  const seg = createBrollSegment();
  assert.deepEqual(
    Object.keys(seg).sort(),
    ['assetId', 'createdAt', 'descriptiveMetadata', 'id', 'licensing', 'media', 'projectId', 'source', 'status', 'usage', 'archivedAt', 'archivedBy', 'archiveReason'].sort()
  );
  assert.deepEqual(Object.keys(seg.source).sort(), ['type', 'provider', 'originalReference', 'importedAt'].sort());
  assert.deepEqual(Object.keys(seg.media).sort(), ['duration', 'width', 'height', 'fps', 'aspectRatio', 'mimeType', 'fileSize'].sort());
  assert.deepEqual(Object.keys(seg.descriptiveMetadata).sort(), ['title', 'description', 'tags', 'subjects', 'environments', 'actions', 'mood', 'visualStyle'].sort());
  assert.deepEqual(Object.keys(seg.licensing).sort(), ['status', 'source', 'attribution', 'restrictions'].sort());
  assert.deepEqual(Object.keys(seg.usage).sort(), ['eligibleRoles', 'allowedTreatments'].sort());
});

// --- 14. UNKNOWN/RESTRICTED/REJECTED are represented without automatically becoming eligible -------------------------------------------------------------------

test('14. setting licensing.status to UNKNOWN, RESTRICTED, or REJECTED is faithfully represented and never mutated into an eligible state by the schema itself', () => {
  for (const status of ['UNKNOWN', 'RESTRICTED', 'REJECTED']) {
    const seg = createBrollSegment({ licensing: { status } });
    assert.equal(seg.licensing.status, status);
    // the schema assigns no eligibility as a side effect of licensing status
    assert.deepEqual(seg.usage.eligibleRoles, []);
  }
});

// --- LICENSED !== CLEARED, and CLEARED is not part of the new canonical enum -------------------------------------------------------------------

test('15. LICENSED !== CLEARED, and CLEARED is not part of the new canonical licensing vocabulary', () => {
  assert.notEqual('LICENSED', 'CLEARED');
  assert.equal(LICENSING_STATUSES.includes('CLEARED'), false);
});

// --- BROLL_STATUSES -------------------------------------------------------------------

test('16. BROLL_STATUSES is exactly ACTIVE/ARCHIVED, and a segment defaults to ACTIVE', () => {
  assert.deepEqual(BROLL_STATUSES, ['ACTIVE', 'ARCHIVED']);
  assert.equal(createBrollSegment().status, 'ACTIVE');
});

// --- usage defaults -------------------------------------------------------------------

test('17. createBrollUsage defaults — no eligible roles assumed, allowedTreatments always includes BROLL_CLIP', () => {
  const usage = createBrollUsage();
  assert.deepEqual(usage.eligibleRoles, []);
  assert.deepEqual(usage.allowedTreatments, ['BROLL_CLIP']);
});

// --- safety: no I/O, no network, no provider/LLM/eval imports -------------------------------------------------------------------

test('18. broll-schema.js performs no file I/O, no network calls, no eval, and requires nothing but crypto', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'broll-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
  for (const forbidden of ['fetch(', 'axios', 'http.request', 'https.request', 'eval(', 'new Function(', 'child_process', 'fs.readFile', 'fs.writeFile']) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `broll-schema.js must not contain "${forbidden}"`);
  }
});
