// Tests for the Stage 22B-Part-2 / Stage 23 Video Prompt Package frontend
// section. Stage 23 added an explicit model selector and BUILD control to
// this section (previously view-only) — see docs/architecture/video-prompt-
// package.md. Required static safety checks: still no GENERATE VIDEO/
// APPROVE/credit control anywhere in this section (those remain the
// separate Video Generation panel's job), no autonomous polling, every
// fetch/POST call targets only /video-prompt-package or /generation-models,
// and the model is always an explicit human click — never auto-selected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

function readFrontend(rel) {
  return fs.readFileSync(path.join(repoRoot, 'frontend', rel), 'utf8');
}

function getVideoPromptSection(js) {
  const sectionStart = js.indexOf('Video Prompt Package inspection (Stage 22B-Part-2)');
  assert.ok(sectionStart > -1, 'the Stage 22B-Part-2 UI section must exist');
  const sectionEnd = js.indexOf('// --- Controlled Keyframe Generation (Stage 13B)', sectionStart);
  assert.ok(sectionEnd > -1, 'the next section marker must exist to bound this search');
  return js.slice(sectionStart, sectionEnd);
}

test('app.js implements the Video Prompt Package render functions', () => {
  const js = readFrontend('app.js');
  for (const fn of ['renderVideoPromptPackageControls', 'renderVideoPromptPackagePanel']) {
    assert.match(js, new RegExp(`function ${fn}`));
  }
});

test('the keyframe card list wires up the Video Prompt Package controls', () => {
  const js = readFrontend('app.js');
  assert.match(js, /card\.appendChild\(renderVideoPromptPackageControls\(kf\)\)/);
});

test('the Video Prompt Package section contains no generate/approve/credit control', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);

  for (const forbidden of [
    'GENERATE VIDEO',
    'GENERATE IMAGE',
    'GENERATE KEYFRAME',
    'EXECUTE SKILL',
    'RUN SKILL',
    'AUTO GENERATE',
    'BATCH GENERATE',
    'APPROVE',
    'SUBMIT GENERATION',
  ]) {
    const labelPattern = new RegExp(`textContent\\s*=\\s*(\`|')${forbidden}`);
    assert.doesNotMatch(section, labelPattern, `must not contain a "${forbidden}" control label`);
  }
});

// Stage 23 — the model selector added a legitimate BUILD control and a POST
// to /keyframes/:id/video-prompt-package (the existing endpoint, unchanged)
// plus a read of /generation-models for the registry listing. Both are now
// expected; anything else is still forbidden.
test('the Video Prompt Package section only fetches video-prompt-package/generation-models endpoints, and only POSTs to build a package', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);

  const fetchCalls = section.match(/fetchJson\(`?[^)]*\)/g) || [];
  assert.ok(fetchCalls.length > 0, 'expected at least one fetchJson call in this section');
  for (const call of fetchCalls) {
    assert.match(call, /\/video-prompt-package|\/generation-models/, `unexpected fetch target: ${call}`);
  }

  const postCalls = section.match(/method:\s*['"]POST['"]/g) || [];
  assert.equal(postCalls.length, 1, 'expected exactly one POST call (build the video prompt package)');
});

test('the model selector never pre-selects or auto-submits a model — selection is an explicit click, building requires a further explicit click', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);
  // The build button starts disabled until a model has been explicitly
  // clicked (state.creative.videoBuildForm.provider/model set only inside
  // a row's own click handler).
  assert.match(section, /submitBtn\.disabled\s*=\s*!selected\.provider\s*\|\|\s*!selected\.model/);
  assert.doesNotMatch(section, /setInterval|setTimeout/);
});

test('the model list is built dynamically from the fetched registry response, never a hardcoded model name', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);
  for (const hardcoded of ['seedance-2.5', 'seedance-1.0', 'doubao-seedance', 'gpt-image-2', 'gemini-3']) {
    assert.doesNotMatch(section, new RegExp(hardcoded), `must not hardcode the model id "${hardcoded}" — models must come only from the fetched registry list`);
  }
});

test('no autonomous polling exists in the Video Prompt Package section', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);
  assert.doesNotMatch(section, /setInterval|setTimeout/);
});

test('the Video Prompt Package panel renders provider/model/verification/spec/version/status fields', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);
  for (const field of [
    'pkg.provider',
    'pkg.model',
    'verification.verificationStatus',
    'verification.productionReady',
    'verification.requestSchemaVerified',
    'pkg.creativeSpecification',
    'pkg.executionParameters',
    'pkg.version',
    'pkg.status',
    'pkg.sourceShotVersion',
    'pkg.sourceKeyframePlanVersion',
    'pkg.canonicalKeyframeAssetId',
    'pkg.referenceLineage',
  ]) {
    assert.ok(section.includes(field), `expected the panel to reference ${field}`);
  }
});
