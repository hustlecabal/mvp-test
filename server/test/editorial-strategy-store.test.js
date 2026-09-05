// Tests for services/editorial-strategy-store.js — PHASE 1 EDITORIAL
// SPINE, Part 1. Strategy validation/CRUD: creation, the "one ACTIVE at a
// time, prior ones RETIRED" append-only rule, and the optional Project-seed
// convenience.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PROJECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-strategy-projects-'));
process.env.EDITORIAL_STRATEGY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-strategy-strategies-'));

const projectStore = require('../services/project-store');
const editorialStrategyStore = require('../services/editorial-strategy-store');

function newProject() {
  return projectStore.createProject({ title: 'strategy test', topic: 'x', audience: 'busy professionals' });
}

test('1. addStrategy fails for a nonexistent project', () => {
  const result = editorialStrategyStore.addStrategy('00000000-0000-4000-8000-000000000000', {});
  assert.equal(result.ok, false);
});

test('2. addStrategy persists a real, structured EditorialStrategy with the exact worked-example shape', () => {
  const project = newProject();
  const result = editorialStrategyStore.addStrategy(project.id, {
    targetAudience: 'early-career software engineers',
    positioning: 'the channel that explains the "why," not just the "how"',
    audienceNeed: 'feeling stuck without knowing why',
    contentPromise: 'a specific, named reason and a concrete next step',
    preferredCharacteristics: ['concrete', 'contrarian'],
    avoid: ['generic productivity advice'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.strategy.status, 'ACTIVE');
  assert.equal(result.strategy.projectId, project.id);
  assert.deepEqual(result.strategy.preferredCharacteristics, ['concrete', 'contrarian']);
  assert.deepEqual(result.strategy.avoid, ['generic productivity advice']);

  const fetched = editorialStrategyStore.getStrategy(project.id, result.strategy.id);
  assert.deepEqual(fetched, result.strategy);
});

test('3. getActiveStrategy returns null when none exists, and the single ACTIVE one once created', () => {
  const project = newProject();
  assert.equal(editorialStrategyStore.getActiveStrategy(project.id), null);
  const { strategy } = editorialStrategyStore.addStrategy(project.id, { targetAudience: 'a' });
  assert.deepEqual(editorialStrategyStore.getActiveStrategy(project.id), strategy);
});

test('4. a new addStrategy retires the previous ACTIVE one — never deleted, always RETIRED', () => {
  const project = newProject();
  const first = editorialStrategyStore.addStrategy(project.id, { targetAudience: 'first' }).strategy;
  const second = editorialStrategyStore.addStrategy(project.id, { targetAudience: 'second' }).strategy;

  const list = editorialStrategyStore.listStrategies(project.id);
  assert.equal(list.length, 2);
  const refetchedFirst = list.find((s) => s.id === first.id);
  assert.equal(refetchedFirst.status, 'RETIRED');

  const active = editorialStrategyStore.getActiveStrategy(project.id);
  assert.equal(active.id, second.id);
});

test('5. createStrategyFromProject seeds targetAudience from Project.audience when not overridden', () => {
  const project = newProject();
  const result = editorialStrategyStore.createStrategyFromProject(project.id, { positioning: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.strategy.targetAudience, 'busy professionals');
  assert.equal(result.strategy.positioning, 'x');
});

test('6. createStrategyFromProject respects an explicit targetAudience override over the Project seed', () => {
  const project = newProject();
  const result = editorialStrategyStore.createStrategyFromProject(project.id, { targetAudience: 'a narrower audience' });
  assert.equal(result.strategy.targetAudience, 'a narrower audience');
});
