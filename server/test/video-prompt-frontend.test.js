// Tests for the Stage 22B-Part-2 Video Prompt Package frontend section and
// its required static safety checks: no GENERATE VIDEO/APPROVE/credit
// control anywhere in this section, no autonomous polling, and every
// fetch call is a read-only GET against /keyframes/:id/video-prompt-package
// only (no build/provider/model selector exists yet — see
// docs/architecture/video-prompt-package.md).

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
    'BUILD VIDEO PACKAGE',
    'BUILD / REFRESH PACKAGE',
  ]) {
    const labelPattern = new RegExp(`textContent\\s*=\\s*(\`|')${forbidden}`);
    assert.doesNotMatch(section, labelPattern, `must not contain a "${forbidden}" control label`);
  }
});

test('the Video Prompt Package section only fetches the read-only video-prompt-package endpoint, and never via POST', () => {
  const js = readFrontend('app.js');
  const section = getVideoPromptSection(js);

  const fetchCalls = section.match(/fetchJson\(`?[^)]*\)/g) || [];
  assert.ok(fetchCalls.length > 0, 'expected at least one fetchJson call in this section');
  for (const call of fetchCalls) {
    assert.match(call, /\/video-prompt-package/, `unexpected fetch target: ${call}`);
  }

  assert.doesNotMatch(section, /method:\s*['"]POST['"]/);
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
