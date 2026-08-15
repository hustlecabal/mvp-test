// Tests for Stage 19's Reference Library / Identity Lock frontend
// structure (Part 6) and the required static safety check: no Generate /
// Execute / Run Skill / Auto Generate / Batch Generate control anywhere
// in the Reference Library section, and every write action is a single,
// explicit human button click mapping 1:1 onto one REST call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

function readFrontend(rel) {
  return fs.readFileSync(path.join(repoRoot, 'frontend', rel), 'utf8');
}

test('index.html has a Reference Library nav item alongside the other Creative Director tabs', () => {
  const html = readFrontend('index.html');
  assert.match(html, /data-artifact="references"/);
  assert.match(html, />Reference Library</);
});

test('app.js implements the Reference Library render functions', () => {
  const js = readFrontend('app.js');
  for (const fn of [
    'loadReferenceLibrary',
    'renderReferenceLibraryView',
    'renderReferenceEntityCard',
    'renderIdentityLockPanel',
    'renderReferenceAssetsPanel',
    'renderReferenceAssetCard',
    'renderIdentityReviewForm',
  ]) {
    assert.match(js, new RegExp(`function ${fn}`));
  }
});

test("selectCreativeArtifact routes the 'references' key to loadReferenceLibrary", () => {
  const js = readFrontend('app.js');
  assert.match(js, /key === 'references'\)\s*\{\s*loadReferenceLibrary\(\)/);
});

test('the Reference Library section contains no Generate / Execute / Run Skill / Auto Generate / Batch Generate control', () => {
  const js = readFrontend('app.js');
  const sectionStart = js.indexOf('Stage 19 — Reference Library / Identity Lock workspace');
  assert.ok(sectionStart > -1, 'the Stage 19 UI section must exist');
  const sectionEnd = js.indexOf('Stage 14 — Operator Queue workspace');
  const section = js.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

  for (const forbidden of ['GENERATE IMAGE', 'GENERATE KEYFRAME', 'EXECUTE SKILL', 'RUN SKILL', 'AUTO GENERATE', 'BATCH GENERATE', 'RUN HIGGSFIELD']) {
    const labelPattern = new RegExp(`textContent\\s*=\\s*(\`|')${forbidden}`);
    assert.doesNotMatch(section, labelPattern, `must not contain a "${forbidden}" button label`);
  }
});

test('every write in the Reference Library section is a real REST call (PUT canonical, POST reference-assets, POST identity-review) — never a generation endpoint', () => {
  const js = readFrontend('app.js');
  const sectionStart = js.indexOf('Stage 19 — Reference Library / Identity Lock workspace');
  const sectionEnd = js.indexOf('Stage 14 — Operator Queue workspace');
  const section = js.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

  assert.doesNotMatch(section, /\/generate-keyframe|\/generations['"`]/);
  assert.match(section, /reference-library\/\$\{entity\.entityType\}\/\$\{entity\.entityId\}\/canonical/);
  assert.match(section, /assets\/\$\{assetId\}\/identity-review/);
});

test('no background polling / setInterval / setTimeout exists in the Reference Library section', () => {
  const js = readFrontend('app.js');
  const sectionStart = js.indexOf('Stage 19 — Reference Library / Identity Lock workspace');
  const sectionEnd = js.indexOf('Stage 14 — Operator Queue workspace');
  const section = js.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

  assert.doesNotMatch(section, /setInterval|setTimeout/);
});

test('canonical selection always requires an explicit assetId from a human click, never auto-picks the newest/only asset', () => {
  const js = readFrontend('app.js');
  const fnStart = js.indexOf('function renderReferenceAssetCard');
  const fnEnd = js.indexOf('\n}\n', fnStart);
  const fnText = js.slice(fnStart, fnEnd);
  // the PUT body must reference the SPECIFIC asset this card renders,
  // never an index-0 / "first" / "latest" selection.
  assert.match(fnText, /assetId: asset\.assetId/);
});

// Stage 24 — found during the UI acceptance audit: this card used to gate
// SELECT AS CANONICAL on approvalStatus === 'APPROVED', but the backend
// (creative-store.js selectCanonicalReferenceAsset) only ever blocks
// REJECTED assets — a freshly uploaded, unreviewed (NONE) candidate was
// always backend-eligible but could never be selected through the UI.
test('SELECT AS CANONICAL is offered for any non-REJECTED asset, not only APPROVED ones', () => {
  const js = readFrontend('app.js');
  const fnStart = js.indexOf('function renderReferenceAssetCard');
  const fnEnd = js.indexOf('\n}\n', fnStart);
  const fnText = js.slice(fnStart, fnEnd);
  assert.match(fnText, /asset\.approvalStatus !== 'REJECTED'/);
  assert.doesNotMatch(fnText, /asset\.approvalStatus === 'APPROVED'/);
});
