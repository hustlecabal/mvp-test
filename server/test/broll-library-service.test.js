// Tests for services/broll-library-service.js — Stage 26.5B, Part 3.
// Registers/reads/lists/archives BRollSegment records against EXISTING,
// already-stored video assets. No ranking, no selection, no Material
// Resolution integration, no network, no provider calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-projects-'));
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-library-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const brollLibraryService = require('../services/broll-library-service');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

// A ready-to-register video asset: STORED, type 'video'.
function makeStoredVideoAsset(projectId, overrides = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video', ...overrides });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.mp4` });
  return timelineStore.getAsset(projectId, asset.assetId);
}

const VALID_SOURCE = { type: 'LOCAL_UPLOAD', originalReference: 'city-street.mp4' };
const VALID_LICENSING = { status: 'LICENSED', source: 'stock library subscription' };

// --- 1. valid registration -------------------------------------------------------------------

test('1. valid registration — a STORED video asset registers successfully and the segment references it exactly', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);

  const result = brollLibraryService.registerBrollSegment(project.id, {
    assetId: asset.assetId,
    source: VALID_SOURCE,
    licensing: VALID_LICENSING,
    descriptiveMetadata: { tags: ['city', 'street'] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyExisted, false);
  assert.equal(result.segment.projectId, project.id);
  assert.equal(result.segment.assetId, asset.assetId);
  assert.equal(result.segment.status, 'ACTIVE');
  assert.equal(result.segment.licensing.status, 'LICENSED');
  assert.deepEqual(result.segment.descriptiveMetadata.tags, ['city', 'street']);
});

// --- 2. missing project -------------------------------------------------------------------

test('2. missing project — registration against a nonexistent project fails structurally, never throws', () => {
  const result = brollLibraryService.registerBrollSegment(crypto.randomUUID(), {
    assetId: crypto.randomUUID(),
    source: VALID_SOURCE,
    licensing: VALID_LICENSING,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no project found/i);
});

// --- 3. missing asset -------------------------------------------------------------------

test('3. missing asset — registration against a nonexistent assetId in a real project fails structurally', () => {
  const project = makeProject();
  const result = brollLibraryService.registerBrollSegment(project.id, {
    assetId: crypto.randomUUID(),
    source: VALID_SOURCE,
    licensing: VALID_LICENSING,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no asset found/i);
});

// --- 4. wrong asset type -------------------------------------------------------------------

test('4. wrong asset type — a keyframe (image) asset cannot become a B-roll segment', () => {
  const project = makeProject();
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });

  const result = brollLibraryService.registerBrollSegment(project.id, {
    assetId: asset.assetId,
    source: VALID_SOURCE,
    licensing: VALID_LICENSING,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /type "keyframe"/);
  assert.match(result.reason, /"video"/);
});

// --- 5. asset not STORED -------------------------------------------------------------------

test('5. asset not STORED — a video asset that has not finished archiving cannot become a B-roll segment', () => {
  const project = makeProject();
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' }); // storage.status defaults to NOT_ARCHIVED

  const result = brollLibraryService.registerBrollSegment(project.id, {
    assetId: asset.assetId,
    source: VALID_SOURCE,
    licensing: VALID_LICENSING,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /NOT_ARCHIVED/);
  assert.match(result.reason, /"STORED"/);
});

test('5b. asset with storage status FAILED also cannot become a B-roll segment', () => {
  const project = makeProject();
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'FAILED', error: 'download failed' });

  const result = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });
  assert.equal(result.ok, false);
  assert.match(result.reason, /FAILED/);
});

// --- required source/licensing metadata -------------------------------------------------------------------

test('6. missing source.type is rejected — never defaulted', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const result = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, licensing: VALID_LICENSING });
  assert.equal(result.ok, false);
  assert.match(result.reason, /source\.type is required/);
});

test('7. missing licensing.status is rejected — licensing is never inferred', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const result = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE });
  assert.equal(result.ok, false);
  assert.match(result.reason, /licensing\.status is required/);
});

test('8. an invalid source.type or licensing.status value is rejected', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);

  const badSource = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: { type: 'DOWNLOADED_FROM_INTERNET' }, licensing: VALID_LICENSING });
  assert.equal(badSource.ok, false);
  assert.match(badSource.reason, /not a recognized source type/);

  const badLicensing = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: { status: 'CLEARED' } });
  assert.equal(badLicensing.ok, false);
  assert.match(badLicensing.reason, /not a recognized licensing status/);
});

// --- 9. duplicate registration protection -------------------------------------------------------------------

test('9. duplicate registration protection — registering the same (project, asset) twice returns the existing record, never a second one', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);

  const first = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });
  const second = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: { status: 'RESTRICTED' } });

  assert.equal(first.ok, true);
  assert.equal(first.alreadyExisted, false);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.segment.id, first.segment.id);
  // the second call's differing licensing was never applied — the ORIGINAL record wins
  assert.equal(second.segment.licensing.status, 'LICENSED');

  const all = brollLibraryService.listBrollSegments(project.id, { assetId: asset.assetId });
  assert.equal(all.length, 1);
});

// --- 10. project isolation -------------------------------------------------------------------

test('10. project isolation — a segment registered in one project never appears when listing another', () => {
  const projectA = makeProject({ title: 'A' });
  const projectB = makeProject({ title: 'B' });
  const assetA = makeStoredVideoAsset(projectA.id);

  brollLibraryService.registerBrollSegment(projectA.id, { assetId: assetA.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  assert.equal(brollLibraryService.listBrollSegments(projectA.id).length, 1);
  assert.equal(brollLibraryService.listBrollSegments(projectB.id).length, 0);
});

// --- 11. listing/filtering -------------------------------------------------------------------

test('11. listing/filtering — status, licensingStatus, sourceType, and assetId filters each work independently', () => {
  const project = makeProject();
  const assetLicensed = makeStoredVideoAsset(project.id);
  const assetUnknown = makeStoredVideoAsset(project.id);
  const assetImport = makeStoredVideoAsset(project.id);

  brollLibraryService.registerBrollSegment(project.id, { assetId: assetLicensed.assetId, source: { type: 'LOCAL_UPLOAD' }, licensing: { status: 'LICENSED' } });
  brollLibraryService.registerBrollSegment(project.id, { assetId: assetUnknown.assetId, source: { type: 'LOCAL_UPLOAD' }, licensing: { status: 'UNKNOWN' } });
  const importResult = brollLibraryService.registerBrollSegment(project.id, { assetId: assetImport.assetId, source: { type: 'LIBRARY_IMPORT' }, licensing: { status: 'LICENSED' } });

  assert.equal(brollLibraryService.listBrollSegments(project.id).length, 3);
  assert.equal(brollLibraryService.listBrollSegments(project.id, { licensingStatus: 'LICENSED' }).length, 2);
  assert.equal(brollLibraryService.listBrollSegments(project.id, { licensingStatus: 'UNKNOWN' }).length, 1);
  assert.equal(brollLibraryService.listBrollSegments(project.id, { sourceType: 'LIBRARY_IMPORT' }).length, 1);
  assert.deepEqual(brollLibraryService.listBrollSegments(project.id, { assetId: assetImport.assetId }).map((s) => s.id), [importResult.segment.id]);
  assert.equal(brollLibraryService.listBrollSegments(project.id, { status: 'ARCHIVED' }).length, 0);
});

// --- 12. archive behavior -------------------------------------------------------------------

test('12. archive behavior — archiving sets status/archivedAt/archivedBy and is idempotent-safe (second archive fails structurally)', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  const archived = brollLibraryService.archiveBrollSegment(project.id, reg.segment.id, { archivedBy: 'operator-1', reason: 'stale footage' });
  assert.equal(archived.ok, true);
  assert.equal(archived.segment.status, 'ARCHIVED');
  assert.equal(archived.segment.archivedBy, 'operator-1');
  assert.equal(archived.segment.archiveReason, 'stale footage');
  assert.equal(typeof archived.segment.archivedAt, 'string');

  const again = brollLibraryService.archiveBrollSegment(project.id, reg.segment.id);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already archived/);
});

test('12b. archiving a nonexistent segment or in a nonexistent project returns null, never throws', () => {
  const project = makeProject();
  assert.equal(brollLibraryService.archiveBrollSegment(project.id, crypto.randomUUID()), null);
  assert.equal(brollLibraryService.archiveBrollSegment(crypto.randomUUID(), crypto.randomUUID()), null);
});

// --- 13. archived segment cannot be returned as an active candidate -------------------------------------------------------------------

test('13. archived segment cannot be returned as an active candidate — getBrollCandidatesForResolution and status=ACTIVE listing both exclude it', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  assert.equal(brollLibraryService.getBrollCandidatesForResolution(project.id).length, 1);

  brollLibraryService.archiveBrollSegment(project.id, reg.segment.id);

  assert.equal(brollLibraryService.getBrollCandidatesForResolution(project.id).length, 0);
  assert.equal(brollLibraryService.listBrollSegments(project.id, { status: 'ACTIVE' }).length, 0);
  assert.equal(brollLibraryService.listBrollSegments(project.id, { status: 'ARCHIVED' }).length, 1);

  const resolved = brollLibraryService.resolveBrollSegmentForMaterialResolution(project.id, reg.segment.id);
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /not "ACTIVE"/);
});

// --- resolveBrollSegmentForMaterialResolution -------------------------------------------------------------------

test('14. resolveBrollSegmentForMaterialResolution — an ACTIVE segment resolves ok; a nonexistent one fails structurally', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  const ok = brollLibraryService.resolveBrollSegmentForMaterialResolution(project.id, reg.segment.id);
  assert.equal(ok.ok, true);
  assert.equal(ok.segment.id, reg.segment.id);

  const missing = brollLibraryService.resolveBrollSegmentForMaterialResolution(project.id, crypto.randomUUID());
  assert.equal(missing.ok, false);
});

// --- 15. licensing status is preserved exactly -------------------------------------------------------------------

test('15. licensing status is preserved exactly across registration, get, and list — never upgraded, downgraded, or translated', () => {
  const project = makeProject();
  for (const status of ['LICENSED', 'UNKNOWN', 'RESTRICTED', 'REJECTED']) {
    const asset = makeStoredVideoAsset(project.id);
    const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: { status } });
    assert.equal(reg.segment.licensing.status, status);
    assert.equal(brollLibraryService.getBrollSegment(project.id, reg.segment.id).licensing.status, status);
    assert.equal(brollLibraryService.listBrollSegments(project.id, { licensingStatus: status }).length, 1);
  }
});

// --- 16. referenced Asset remains byte-for-byte/state-for-state unchanged -------------------------------------------------------------------

test('16. registering, listing, and archiving a B-roll segment never mutates the referenced Asset', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));

  const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });
  brollLibraryService.getBrollSegment(project.id, reg.segment.id);
  brollLibraryService.listBrollSegments(project.id);
  brollLibraryService.archiveBrollSegment(project.id, reg.segment.id);

  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(after, before);
});

// --- 17. no binary duplication -------------------------------------------------------------------

test('17. no binary duplication — the B-roll segment stores no path/url/storage field, and no file is written under asset storage', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  assert.equal(reg.segment.path, undefined);
  assert.equal(reg.segment.url, undefined);
  assert.equal(reg.segment.storage, undefined);
});

// --- 18. no network/provider imports -------------------------------------------------------------------

test('18. broll-library-service.js requires no network/provider/approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'broll-library-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['./project-store', './timeline-store', 'fs', 'path', '../schemas/broll-schema'].sort());
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*approval-gate[^'"`]*['"`]\s*\)/);
  for (const forbidden of ['fetch(', 'axios', 'http.request', 'https.request', 'eval(', 'new Function(', 'child_process']) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `must not contain "${forbidden}"`);
  }
});

// --- 19. deterministic results -------------------------------------------------------------------

test('19. deterministic results — repeated getBrollCandidatesForResolution calls return identical data without mutating anything', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  const first = JSON.stringify(brollLibraryService.getBrollCandidatesForResolution(project.id));
  const second = JSON.stringify(brollLibraryService.getBrollCandidatesForResolution(project.id));
  assert.equal(first, second);
});

// --- findBrollSegmentById -------------------------------------------------------------------

test('20. findBrollSegmentById locates a segment across projects without already knowing which project it belongs to', () => {
  const project = makeProject();
  const asset = makeStoredVideoAsset(project.id);
  const reg = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: VALID_SOURCE, licensing: VALID_LICENSING });

  const found = brollLibraryService.findBrollSegmentById(reg.segment.id);
  assert.ok(found);
  assert.equal(found.project.id, project.id);
  assert.equal(found.segment.id, reg.segment.id);

  assert.equal(brollLibraryService.findBrollSegmentById(crypto.randomUUID()), null);
});

// --- getBrollSegment / listBrollSegments on a project with no library yet -------------------------------------------------------------------

test('21. getBrollSegment/listBrollSegments on a real project with no B-roll registered yet return empty/null appropriately, never throw', () => {
  const project = makeProject();
  assert.deepEqual(brollLibraryService.listBrollSegments(project.id), []);
  assert.equal(brollLibraryService.getBrollSegment(project.id, crypto.randomUUID()), null);
  assert.equal(brollLibraryService.listBrollSegments(crypto.randomUUID()), null);
  assert.equal(brollLibraryService.getBrollCandidatesForResolution(project.id).length, 0);
});
