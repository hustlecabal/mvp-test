// Tests for Stage 13E, Part 6 — docs/architecture/control-surfaces.md's
// claims are actually true of the codebase, not just documented. These
// are structural/static checks: they confirm business rules exist in
// exactly one place (services/schemas) and that MCP, REST, and the
// frontend only ever call into it, never re-implement it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const repoRoot = path.join(serverDir, '..');

function read(relToServer) {
  return fs.readFileSync(path.join(serverDir, relToServer), 'utf8');
}

// --- the doc itself exists and states the six layers --------------------------------------

test('docs/architecture/control-surfaces.md exists and names all six layers', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'docs', 'architecture', 'control-surfaces.md'), 'utf8');
  for (const layer of ['MCP', 'REST', 'Frontend', 'Services', 'Stores', 'Providers']) {
    assert.match(text, new RegExp(layer));
  }
  assert.match(text, /orchestration/i);
  assert.match(text, /application interface/i);
  assert.match(text, /human interface/i);
  assert.match(text, /business logic/i);
  assert.match(text, /persistence/i);
  assert.match(text, /external execution boundary/i);
});

// --- 26. services remain the source of business logic ---------------------------------------

test('26. the state-machine TRANSITIONS graph is defined in exactly one place', () => {
  let definitions = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'data') continue;
        walk(full);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/const TRANSITIONS\s*=\s*\{/.test(text)) definitions += 1;
      }
    }
  };
  walk(serverDir);
  assert.equal(definitions, 1, 'the state transition graph must be defined in schemas/state-machine.js only');
});

test('26b. creditLedger.blocked is only ever set (true or false) from services/approval-gate.js', () => {
  const walk = (dir, results) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'data') continue;
        walk(full, results);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/\.blocked\s*=\s*(true|false)/.test(text)) results.push(full);
      }
    }
  };
  const results = [];
  walk(serverDir, results);
  const outsideGate = results.filter((f) => !f.endsWith(path.join('services', 'approval-gate.js')));
  assert.deepEqual(outsideGate, [], 'only approval-gate.js may flip creditLedger.blocked');
});

// --- 27. MCP uses services, never re-implements a rule ---------------------------------------

test('27. transition_project (MCP) calls schemas/state-machine.js\'s transition(), not a re-implementation', () => {
  const text = read(path.join('mcp', 'tools', 'project-tools.js'));
  assert.match(text, /stateMachine\.transition\(/);
  assert.doesNotMatch(text, /const TRANSITIONS/);
});

test('27b. acknowledge_budget_overage (MCP) calls gate.acknowledgeOverage, not a re-implementation', () => {
  const text = read(path.join('mcp', 'tools', 'approval-tools.js'));
  assert.match(text, /gate\.acknowledgeOverage\(/);
  assert.doesNotMatch(text, /overage\.acknowledged\s*=\s*true/, 'must call the service, not mutate the overage object directly');
});

// --- 28. REST uses services, never re-implements a rule --------------------------------------

test('28. POST /projects/:id/transition (REST) calls schemas/state-machine.js\'s transition(), not a re-implementation', () => {
  const text = read('index.js');
  const routeStart = text.indexOf("app.post('/projects/:id/transition'");
  assert.ok(routeStart > -1);
  const routeText = text.slice(routeStart, routeStart + 600);
  assert.match(routeText, /stateMachine\.transition\(/);
});

test('28b. POST /projects/:id/budget/overage/acknowledge (REST) calls gate.acknowledgeOverage, not a re-implementation', () => {
  const text = read('index.js');
  const routeStart = text.indexOf("app.post('/projects/:id/budget/overage/acknowledge'");
  assert.ok(routeStart > -1);
  const routeText = text.slice(routeStart, routeStart + 1200);
  assert.match(routeText, /gate\.acknowledgeOverage\(/);
  assert.doesNotMatch(routeText, /overage\.acknowledged\s*=\s*true/);
});

test('28c. PUT /keyframes/:keyframeId/canonical-asset (REST) calls keyframeStore.selectCanonicalKeyframeAsset, not a re-implementation', () => {
  const text = read('index.js');
  const routeStart = text.indexOf("app.put('/keyframes/:keyframeId/canonical-asset'");
  assert.ok(routeStart > -1);
  const routeText = text.slice(routeStart, routeStart + 600);
  assert.match(routeText, /keyframeStore\.selectCanonicalKeyframeAsset\(/);
});

// --- 29. frontend contains no business-rule implementation -----------------------------------

test('29. frontend/app.js never re-implements the state-machine transition graph or budget arithmetic', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'frontend', 'app.js'), 'utf8');
  assert.doesNotMatch(text, /const TRANSITIONS/);
  assert.doesNotMatch(text, /PLANNING.*:\s*\[.*RESEARCH/s, 'must not hardcode the transition graph');
  // Budget figures are only ever displayed from server-provided fields —
  // never recomputed with the ledger's own limit/reserved arithmetic.
  assert.doesNotMatch(text, /budgetLimit\s*-\s*reservedCredits/);
  assert.doesNotMatch(text, /\.limit\s*-\s*.*\.reserved/);
});

test('29b. the one place the frontend computes eligibility, it is explicitly documented as a convenience, not a security boundary', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'frontend', 'app.js'), 'utf8');
  const idx = text.indexOf('function computeKeyframeGenerationEligibility');
  assert.ok(idx > -1);
  const before = text.slice(Math.max(0, idx - 700), idx);
  assert.match(before, /convenience, not a security boundary/);
});

test('29c. canonical-asset selection in the frontend never decides eligibility itself — it always calls the server and re-loads', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'frontend', 'app.js'), 'utf8');
  const idx = text.indexOf("selectBtn.addEventListener('click'");
  const nearCanonical = text.slice(text.indexOf('renderCanonicalAssetPanel'), text.indexOf('renderCanonicalAssetPanel') + 4000);
  assert.match(nearCanonical, /fetchJson\(`\/keyframes\/\$\{kf\.keyframeId\}\/canonical-asset`/);
  assert.doesNotMatch(nearCanonical, /approvalStatus\s*===\s*'REJECTED'\s*\?\s*false/, 'eligibility must not be pre-computed client-side');
});
