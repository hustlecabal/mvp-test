// Tests for services/skill-registry.js — pure static data, no I/O, no
// network, no skill invocation.

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../services/skill-registry');

// --- 1. skill registry -------------------------------------------------------

test('1. the registry contains all 8 audited skills', () => {
  const skills = registry.listSkills();
  const ids = skills.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'banana-pro-director-2.0',
    'brand-video-editor',
    'cinema-worldbuilder-pro-2.0',
    'director',
    'ugc-builder',
    'ugc-decoder',
    'video-prompt-builder',
    'xianxia-visual-director',
  ]);
});

test('every registry entry has the full required shape', () => {
  for (const skill of registry.listSkills()) {
    for (const field of ['id', 'name', 'role', 'inputType', 'outputType', 'platformCoupling', 'generationRisk', 'enabled', 'adapter']) {
      assert.ok(field in skill, `${skill.id} is missing field "${field}"`);
    }
  }
});

// --- 2. skill lookup ----------------------------------------------------------

test('2. getSkill looks up a known skill by id', () => {
  const skill = registry.getSkill('video-prompt-builder');
  assert.equal(skill.role, 'SPECIALIST');
  assert.equal(skill.platformCoupling, 'LOW');
  assert.equal(skill.generationRisk, 'NONE');
  assert.equal(skill.adapter, 'video-prompt-builder');
});

// --- 3. unknown skill -----------------------------------------------------------

test('3. getSkill returns null for an unknown skill id', () => {
  assert.equal(registry.getSkill('not-a-real-skill'), null);
});

// --- no audited skill is an orchestrator; the two unavailable skills are UNKNOWN

test('no registered skill has role ORCHESTRATOR — Claude Code remains the orchestrator', () => {
  for (const skill of registry.listSkills()) {
    assert.notEqual(skill.role, 'ORCHESTRATOR');
  }
});

test('director and xianxia-visual-director are recorded as unavailable, not guessed', () => {
  for (const id of ['director', 'xianxia-visual-director']) {
    const skill = registry.getSkill(id);
    assert.equal(skill.enabled, false);
    assert.equal(skill.role, 'UNKNOWN');
    assert.equal(skill.purpose, null, 'nothing should be invented for an unavailable skill');
  }
});

test('brand-video-editor is the only skill with a non-NONE generationRisk, and is marked EDITOR', () => {
  const editor = registry.getSkill('brand-video-editor');
  assert.equal(editor.role, 'EDITOR');
  assert.equal(editor.generationRisk, 'INDIRECT_GATED');

  for (const skill of registry.listSkills().filter((s) => s.id !== 'brand-video-editor' && s.enabled)) {
    assert.equal(skill.generationRisk, 'NONE', `${skill.id} should be NONE`);
  }
});
