// Tests closing the remaining Part 16 gaps not already covered by
// creative-director-api.test.js (which covers most of the CRUD/versioning/
// safety items numerically): the static workspace HTML/JS structure, and
// an explicit version-history-through-the-API check. Items that require an
// actually-rendered DOM (workspace loads visually, project selection
// clicks, character/scene/version-history/skill-recommendation *display*,
// and the three responsive widths) are verified with a real browser via
// Playwright as part of the Part 17 manual browser test — see the final
// report — the same split Stage 10 used, since this project has no DOM
// testing library (jsdom, etc.) as a dependency and none is being added.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-frontend-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-frontend-creative-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;

const app = require('../index');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
});

// --- 1. creative workspace loads (static structure) ---------------------------

test('1. the served index.html includes both the Production and Creative Director tabs', async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.match(html, /Production/);
  assert.match(html, /Creative Director/);
  assert.match(html, /id="creative-view"/);
  assert.match(html, /id="production-view"/);
});

test('the served app.js includes the Creative Director view-switch and editor functions', async () => {
  const js = await (await fetch(`${baseUrl}/app.js`)).text();
  for (const fn of ['switchView', 'renderBriefEditor', 'renderSpecEditor', 'renderBibleEditor', 'renderStoryboardView', 'renderShotEditor', 'renderSkillPanel']) {
    assert.match(js, new RegExp(`function ${fn}`), `app.js must define ${fn}`);
  }
});

// --- 19. version history display (API shape) -----------------------------------

test('19. the brief API response carries a full, growing history array a UI can display', async () => {
  const project = await (
    await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', topic: 'y' }) })
  ).json();

  const put = (body) =>
    fetch(`${baseUrl}/projects/${project.id}/creative/brief`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await put({ title: 'v1', changeNote: 'created the brief' });
  await put({ title: 'v2', changeNote: 'renamed' });
  const v3res = await put({ title: 'v3', changeNote: 'renamed again' });
  const v3 = await v3res.json();

  assert.equal(v3.version, 3);
  assert.equal(v3.history.length, 2);
  assert.equal(v3.history[0].changeNote, 'created the brief');
  assert.equal(v3.history[1].changeNote, 'renamed');
  // Everything a "Version N / Updated by X / note" UI row needs is present:
  for (const entry of v3.history) {
    assert.ok('version' in entry && 'updatedAt' in entry && 'updatedBy' in entry && 'changeNote' in entry);
  }
});
