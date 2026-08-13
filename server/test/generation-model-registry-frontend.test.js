// Tests for Stage 22B-Part-1's Generation Models frontend structure and the
// required static safety check: no generate/submit/approve control
// anywhere in this section, no autonomous polling, and every fetch call
// targets only the read-only /generation-models* REST endpoints.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

function readFrontend(rel) {
  return fs.readFileSync(path.join(repoRoot, 'frontend', rel), 'utf8');
}

test('index.html has a Generation Models tab alongside the other workspace tabs', () => {
  const html = readFrontend('index.html');
  assert.match(html, /id="tab-models"/);
  assert.match(html, />Generation Models</);
  assert.match(html, /id="models-view"/);
});

test('app.js implements the Generation Models render functions', () => {
  const js = readFrontend('app.js');
  for (const fn of ['onEnterModelsView', 'loadGenerationModels', 'renderGenerationModelsList', 'capabilitySummary', 'priceSummary']) {
    assert.match(js, new RegExp(`function ${fn}`));
  }
});

test("switchView routes the 'models' view to onEnterModelsView", () => {
  const js = readFrontend('app.js');
  assert.match(js, /view === 'models'[\s\S]{0,200}onEnterModelsView\(\)/);
});

function getModelsSection(js) {
  const sectionStart = js.indexOf('Stage 22B-Part-1 — Generation Models workspace');
  assert.ok(sectionStart > -1, 'the Stage 22B-Part-1 UI section must exist');
  const sectionEnd = js.indexOf('// --- init ---');
  return js.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);
}

test('the Generation Models section contains no generate/execute/approve control', () => {
  const js = readFrontend('app.js');
  const section = getModelsSection(js);

  for (const forbidden of [
    'GENERATE IMAGE',
    'GENERATE VIDEO',
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

test('the Generation Models section only fetches the read-only /generation-models* endpoints', () => {
  const js = readFrontend('app.js');
  const section = getModelsSection(js);

  const fetchCalls = section.match(/fetch\(`?[^)]*\)/g) || [];
  assert.ok(fetchCalls.length > 0, 'expected at least one fetch call in this section');
  for (const call of fetchCalls) {
    assert.match(call, /\/generation-models/, `unexpected fetch target: ${call}`);
  }

  // never a generation/approval/keyframe endpoint call (checked as an actual
  // fetch target or function call, not as a substring anywhere in prose —
  // this section's own explanatory comments legitimately say things like
  // "no ... approve control", which must not trip this check)
  for (const call of fetchCalls) {
    assert.doesNotMatch(call, /\/generate-keyframe|\/generations['"`]|approve|reject|request_generation/i);
  }
});

test('no autonomous polling exists in the Generation Models section', () => {
  const js = readFrontend('app.js');
  const section = getModelsSection(js);
  assert.doesNotMatch(section, /setInterval|setTimeout/);
});

test('every write control in the Generation Models section is a filter change, never a POST that submits generation', () => {
  const js = readFrontend('app.js');
  const section = getModelsSection(js);
  // The only POST endpoints that exist at all (/search, /validate) are
  // read-only per index.js — but this UI section doesn't even call them;
  // it only ever GETs /generation-models. Confirm no POST call exists here.
  assert.doesNotMatch(section, /method:\s*['"]POST['"]/);
});
