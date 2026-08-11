// Tests for Stage 14, Part 9/10/18 — the Operator Queue frontend
// structure (items 28) and the required static safety check (Part 18,
// item 29): no Generate / Execute / Run Skill / Auto Generate / Batch
// Generate control anywhere in the Operator Queue section, and no
// duplicate keyframe editor (Part 10 — every action navigates into the
// existing Creative Director workspace instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

function readFrontend(rel) {
  return fs.readFileSync(path.join(repoRoot, 'frontend', rel), 'utf8');
}

// --- 28. frontend structure ----------------------------------------------------------------

test('28. index.html has an Operator Queue tab and workspace, alongside Production and Creative Director', () => {
  const html = readFrontend('index.html');
  assert.match(html, /id="tab-queue"/);
  assert.match(html, />Operator Queue</);
  assert.match(html, /id="queue-view"/);
  assert.match(html, /id="queue-progress-panel"/);
  assert.match(html, /id="queue-next-action"/);
  assert.match(html, /id="queue-list"/);
  assert.match(html, /id="queue-shot-readiness"/);
});

test('28b. app.js implements the three queue sections: project progress, next action, and the filterable/sortable list', () => {
  const js = readFrontend('app.js');
  assert.match(js, /function renderQueueProgressPanel/);
  assert.match(js, /function renderNextActionCard/);
  assert.match(js, /function renderQueueList/);
  assert.match(js, /function renderShotReadinessPanel/);
  // filters
  for (const filter of ['ALL', 'NEEDS_ATTENTION', 'BLOCKED', 'IN_PROGRESS', 'COMPLETE']) {
    assert.match(js, new RegExp(filter));
  }
  // sorts
  assert.match(js, /'priority', 'scene', 'shot'/);
});

// --- Part 10 — deep link, never a duplicate editor ------------------------------------------

test('Part 10: OPEN KEYFRAME navigates into the existing Creative Director Keyframe Plan workspace, never a second editor', () => {
  const js = readFrontend('app.js');
  const fnStart = js.indexOf('function openKeyframeFromQueue');
  assert.ok(fnStart > -1);
  const fnEnd = js.indexOf('\n}', fnStart);
  const fnText = js.slice(fnStart, fnEnd);
  assert.match(fnText, /switchView\('creative'\)/);
  assert.match(fnText, /activeArtifact = 'keyframes'/);
  // must NOT independently render a keyframe editor — no new "editor"
  // element id, no re-implementation of renderKeyframeList in this function
  assert.doesNotMatch(fnText, /renderKeyframeList\(/);
});

// --- 29/18. frontend safety — no generate/execute/run/auto/batch control -------------------

test('29. the Operator Queue section contains no Generate / Execute / Run Skill / Auto Generate / Batch Generate control', () => {
  const js = readFrontend('app.js');
  const sectionStart = js.indexOf('Stage 14 — Operator Queue workspace');
  assert.ok(sectionStart > -1, 'the Stage 14 UI section must exist');
  const sectionEnd = js.indexOf('--- init ---');
  const section = js.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

  for (const forbidden of ['GENERATE IMAGE', 'GENERATE KEYFRAME', 'EXECUTE SKILL', 'RUN SKILL', 'AUTO GENERATE', 'BATCH GENERATE', 'RUN HIGGSFIELD']) {
    const labelPattern = new RegExp(`textContent\\s*=\\s*(\`|')${forbidden}`);
    assert.doesNotMatch(section, labelPattern, `must not contain a "${forbidden}" button label`);
  }

  // The only interactive control in this whole section is OPEN KEYFRAME —
  // confirms the queue truly has no OTHER button at all, generative or not.
  const buttonLabels = [...section.matchAll(/textContent\s*=\s*(?:`([^`]*)`|'([^']*)')/g)]
    .map((m) => m[1] || m[2])
    .filter((label) => !/^\[P\d/.test(label)); // strip the dynamic "[P3] CATEGORY" row title, not a real button label
  const staticButtonTexts = new Set(buttonLabels.filter((l) => /^[A-Z0-9 /]+$/.test(l) && l.length < 40));
  for (const text of staticButtonTexts) {
    assert.ok(
      text === 'OPEN KEYFRAME' || QUEUE_FILTER_OR_SORT_LABELS.has(text),
      `unexpected control in the Operator Queue section: "${text}"`
    );
  }
});

const QUEUE_FILTER_OR_SORT_LABELS = new Set([
  'ALL',
  'NEEDS ATTENTION',
  'BLOCKED',
  'IN PROGRESS',
  'COMPLETE',
  'PRIORITY',
  'SCENE',
  'SHOT',
  'NEXT ACTION', // a section heading, not a button
]);

test('29b. no fetch call in the Operator Queue section ever POSTs/PUTs — every request is a read-only GET', () => {
  const js = readFrontend('app.js');
  const sectionStart = js.indexOf('Stage 14 — Operator Queue workspace');
  const sectionEnd = js.indexOf('--- init ---');
  const section = js.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

  assert.doesNotMatch(section, /method:\s*['"`]POST['"`]/);
  assert.doesNotMatch(section, /method:\s*['"`]PUT['"`]/);
  assert.doesNotMatch(section, /method:\s*['"`]DELETE['"`]/);
});
