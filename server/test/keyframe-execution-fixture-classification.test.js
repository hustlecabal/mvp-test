// Tests for Stage 13E, Part 3 — classifying the Stage 13C execution-bridge
// tools as INTERNAL TEST/DEVELOPMENT ONLY, never a production generation
// option. Confirms the labeling is actually present (not just described in
// this stage's report) and that nothing production-facing references it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- 12. fixture tool clearly marked ------------------------------------------------------

test('12. both execution-bridge MCP tool titles/descriptions are marked FIXTURE-ONLY', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'tools', 'keyframe-execution-tools.js'), 'utf8');
  const prepareBlock = text.slice(text.indexOf("'prepare_keyframe_execution'"), text.indexOf("'run_fixture_keyframe_execution'"));
  const runBlock = text.slice(text.indexOf("'run_fixture_keyframe_execution'"));

  assert.match(prepareBlock, /FIXTURE-ONLY/);
  assert.match(prepareBlock, /create_keyframe_handoff/, 'must point callers at the real production path');
  assert.match(runBlock, /FIXTURE-ONLY/);
  assert.match(runBlock, /create_keyframe_handoff/);
});

test('12b. the execution-bridge service and doc are labeled INTERNAL TEST/DEVELOPMENT ONLY', () => {
  const serviceText = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-execution-bridge-service.js'), 'utf8');
  assert.match(serviceText, /INTERNAL TEST\/DEVELOPMENT ONLY/);

  const docText = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'architecture', 'keyframe-execution-bridge.md'), 'utf8');
  assert.match(docText, /INTERNAL TEST\/DEVELOPMENT ONLY/);
});

// --- 13. fixture path does not appear as a production provider ---------------------------

test('13. the frontend never calls prepare_keyframe_execution/run_fixture_keyframe_execution or the execution-bridge REST route', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');
  assert.doesNotMatch(appJs, /prepare_keyframe_execution/);
  assert.doesNotMatch(appJs, /run_fixture_keyframe_execution/);
  assert.doesNotMatch(appJs, /prepare-execution/);
});

test('13b. no other service imports the execution-bridge service (its only consumers are its own MCP tools and tests)', () => {
  const serverDir = path.join(__dirname, '..');
  const skip = new Set(['keyframe-execution-bridge-service.js']);
  const servicesDir = path.join(serverDir, 'services');
  for (const file of fs.readdirSync(servicesDir)) {
    if (!file.endsWith('.js') || skip.has(file)) continue;
    const text = fs.readFileSync(path.join(servicesDir, file), 'utf8');
    assert.doesNotMatch(text, /keyframe-execution-bridge-service/, `${file} must not depend on the fixture-only execution bridge`);
  }
});

// --- 14. existing fixture tests remain green (regression guard) --------------------------

test('14. the fixture-execution service and MCP test files still exist and are not empty (not silently gutted)', () => {
  for (const rel of ['keyframe-execution-bridge-service.test.js', 'keyframe-execution-mcp.test.js']) {
    const stat = fs.statSync(path.join(__dirname, rel));
    assert.ok(stat.size > 500, `${rel} should still contain real test coverage`);
  }
});
