// Tests for the Stage 22B-Part-3 Controlled Video Generation frontend
// section and its required static safety checks: GENERATE VIDEO must be
// disabled unless eligibility.allowed (server-fetched, never computed
// client-side), no automatic generation/approval/model selection, and no
// autonomous polling.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

function readFrontend(rel) {
  return fs.readFileSync(path.join(repoRoot, 'frontend', rel), 'utf8');
}

function getVideoGenerationSection(js) {
  const sectionStart = js.indexOf('Controlled Video Generation (Stage 22B-Part-3)');
  assert.ok(sectionStart > -1, 'the Stage 22B-Part-3 UI section must exist');
  const sectionEnd = js.indexOf('// --- Human Keyframe Execution Handoff (Stage 13D)', sectionStart);
  assert.ok(sectionEnd > -1, 'the next section marker must exist to bound this search');
  return js.slice(sectionStart, sectionEnd);
}

test('app.js implements the Controlled Video Generation render functions', () => {
  const js = readFrontend('app.js');
  for (const fn of ['renderVideoGenerationControls', 'renderVideoGenerationPanel', 'loadVideoGenerationData']) {
    assert.match(js, new RegExp(`(async )?function ${fn}`));
  }
});

test('the keyframe card list wires up the Video Generation controls', () => {
  const js = readFrontend('app.js');
  assert.match(js, /card\.appendChild\(renderVideoGenerationControls\(kf\)\)/);
});

test('the Video Generation section shows package, approval, eligibility, and budget status', () => {
  const js = readFrontend('app.js');
  const section = getVideoGenerationSection(js);
  for (const field of [
    'videoPkg.provider',
    'videoPkg.model',
    'verification.verificationStatus',
    'verification.productionReady',
    'approval.status',
    'approval.estimatedCost',
    'eligibility.allowed',
    'budget.remainingBudget',
    'budget.blocked',
  ]) {
    assert.ok(section.includes(field), `expected the panel to reference ${field}`);
  }
});

test('GENERATE VIDEO is disabled unless the server-fetched eligibility.allowed is true (never a client-computed rule)', () => {
  const js = readFrontend('app.js');
  const section = getVideoGenerationSection(js);
  assert.match(section, /generateBtn\.disabled\s*=\s*!eligibility\.allowed/);
  // Confirm this section never independently RE-DERIVES an eligibility
  // rule of its own (e.g. its own budget/model/provider check) — the only
  // eligibility value used is the one returned by the eligibility fetch.
  assert.doesNotMatch(section, /function compute\w*Eligibility/);
});

test('every control in the section performs at most one clearly-labelled action, never a batch/auto action', () => {
  const js = readFrontend('app.js');
  const section = getVideoGenerationSection(js);
  for (const forbidden of ['AUTO GENERATE', 'BATCH GENERATE', 'AUTO APPROVE', 'SELECT MODEL', 'SELECT PROVIDER', 'FORCE GENERATE']) {
    const labelPattern = new RegExp(`textContent\\s*=\\s*(\`|')${forbidden}`);
    assert.doesNotMatch(section, labelPattern, `must not contain a "${forbidden}" control label`);
  }
});

test('no autonomous polling or auto-generation on load exists in the Video Generation section', () => {
  const js = readFrontend('app.js');
  const section = getVideoGenerationSection(js);
  assert.doesNotMatch(section, /setInterval|setTimeout/);
});

test('every write in the section is an explicit fetchJson POST tied to a click handler, never fired outside addEventListener', () => {
  const js = readFrontend('app.js');
  const section = getVideoGenerationSection(js);
  const postCalls = section.match(/method:\s*['"]POST['"]/g) || [];
  // REQUEST APPROVAL, APPROVE, REJECT, GENERATE VIDEO = 4 POST calls.
  assert.equal(postCalls.length, 4, `expected exactly 4 POST calls (request/approve/reject/generate), found ${postCalls.length}`);
  assert.doesNotMatch(section, /\bwindow\.onload\b|\bDOMContentLoaded\b/);
});

test('the Video Generation section only fetches video-generation/video-prompt-package/budget endpoints', () => {
  const js = readFrontend('app.js');
  const section = getVideoGenerationSection(js);
  const fetchCalls = section.match(/fetchJson\(`?[^)]*\)/g) || [];
  assert.ok(fetchCalls.length > 0, 'expected at least one fetchJson call in this section');
  for (const call of fetchCalls) {
    assert.match(call, /\/video-generation|\/video-prompt-package|\/budget/, `unexpected fetch target: ${call}`);
  }
});
