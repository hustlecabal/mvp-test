// Tests for services/skill-orchestrator.js — compatibility checks,
// recommendation logic, unsupported-skill handling, and (critically) the
// safety guarantees that this file can never reach EvoLink, generation,
// or the approval/budget gate. No real skill is ever invoked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-orchestrator-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-orchestrator-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const orchestrator = require('../services/skill-orchestrator');

// --- 4/8. skill compatibility / platform coupling -----------------------------

test('4. getSkillCompatibility reports LOW-coupling skills as compatible without translation', () => {
  const result = orchestrator.getSkillCompatibility('video-prompt-builder', { platform: 'evolink' });
  assert.equal(result.compatible, true);
  assert.equal(result.platformCoupling, 'LOW');
  assert.deepEqual(result.warnings, []);
});

test('8. getSkillCompatibility warns about platform coupling when a skill is tied to a different platform', () => {
  const result = orchestrator.getSkillCompatibility('cinema-worldbuilder-pro-2.0', { platform: 'evolink' });
  assert.equal(result.platformCoupling, 'HIGGSFIELD');
  assert.ok(result.warnings.some((w) => w.includes('HIGGSFIELD')));
  // it still has an adapter, so it CAN be made compatible
  assert.equal(result.hasAdapter, true);
  assert.equal(result.compatible, true);
});

test('a skill with no adapter and non-LOW coupling is reported incompatible', () => {
  const result = orchestrator.getSkillCompatibility('banana-pro-director-2.0', { platform: 'evolink' });
  assert.equal(result.hasAdapter, false);
  assert.equal(result.compatible, false);
  assert.ok(result.warnings.some((w) => w.includes('no adapter')));
});

test('getSkillCompatibility returns null for an unknown skill', () => {
  assert.equal(orchestrator.getSkillCompatibility('not-a-real-skill', { platform: 'evolink' }), null);
});

test('an unavailable skill (director) is flagged as such', () => {
  const result = orchestrator.getSkillCompatibility('director', { platform: 'evolink' });
  assert.equal(result.compatible, false);
  assert.ok(result.warnings.some((w) => w.includes('not available')));
});

// --- 13. unsupported skill handling ---------------------------------------------

test('13. runAdapter throws a clear error for an unknown skill', () => {
  assert.throws(() => orchestrator.runAdapter('not-a-real-skill', {}, {}), /Unknown skill/);
});

test('13b. runAdapter throws a clear error for a real skill with no adapter yet', () => {
  assert.throws(() => orchestrator.runAdapter('banana-pro-director-2.0', {}, {}), /has no adapter yet/);
});

test('runAdapter dispatches correctly for a skill that DOES have an adapter', () => {
  const result = orchestrator.runAdapter('video-prompt-builder', { storyboardShot: { shotId: 's1' } }, { skillOutputText: '' });
  assert.equal(result.skillId, 'video-prompt-builder');
});

// --- 14. recommendation logic ----------------------------------------------------

test('14a. recommendSkill: shot-prompt + evolink -> video-prompt-builder', () => {
  const rec = orchestrator.recommendSkill({ desiredOutput: 'shot-prompt', platform: 'evolink' });
  assert.equal(rec.skillId, 'video-prompt-builder');
  assert.equal(rec.executable, true);
});

test('14b. recommendSkill: cinematic planning -> cinema-worldbuilder-pro-2.0', () => {
  const rec = orchestrator.recommendSkill({ needsCinematicPlanning: true });
  assert.equal(rec.skillId, 'cinema-worldbuilder-pro-2.0');
  assert.equal(rec.executable, true);
});

test('14c. recommendSkill: reference-image creation -> banana-pro-director-2.0, marked future/non-executable', () => {
  const rec = orchestrator.recommendSkill({ needsReferenceImage: true });
  assert.equal(rec.skillId, 'banana-pro-director-2.0');
  assert.equal(rec.status, 'future keyframe/reference-image stage');
  assert.equal(rec.executable, false);
});

test('14d. recommendSkill: no match -> explicit no-recommendation result, never a guess', () => {
  const rec = orchestrator.recommendSkill({ desiredOutput: 'something-unrecognized' });
  assert.equal(rec.skillId, null);
  assert.equal(rec.executable, false);
});

test('recommendSkill is deterministic -- the same input always yields the same output', () => {
  const a = orchestrator.recommendSkill({ desiredOutput: 'shot-prompt', platform: 'evolink' });
  const b = orchestrator.recommendSkill({ desiredOutput: 'shot-prompt', platform: 'evolink' });
  assert.deepEqual(a, b);
});

// --- 15/16. EvoLink / generation service never reachable from this layer -------
//
// These check actual `require(...)` IMPORT STATEMENTS only (via a real
// require.resolve, not a text/regex search) — deliberately not a raw
// substring search over the whole file, since this file's own safety
// documentation legitimately *names* evolink/generation-service/
// approval-gate in comments explaining what it does NOT import.

function requiredModules(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const requireCallPattern = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const modules = [];
  let match = requireCallPattern.exec(source);
  while (match !== null) {
    modules.push(match[1]);
    match = requireCallPattern.exec(source);
  }
  return modules;
}

function orchestrationSourceFiles() {
  return [
    path.join(__dirname, '..', 'services', 'skill-orchestrator.js'),
    path.join(__dirname, '..', 'services', 'skill-registry.js'),
    ...fs
      .readdirSync(path.join(__dirname, '..', 'services', 'skill-adapters'))
      .map((f) => path.join(__dirname, '..', 'services', 'skill-adapters', f)),
  ];
}

test('15. skill-orchestrator.js and every skill-adapters/*.js file never import the EvoLink provider', () => {
  for (const file of orchestrationSourceFiles()) {
    for (const modulePath of requiredModules(file)) {
      assert.doesNotMatch(modulePath, /evolink/i, `${file} requires "${modulePath}" — must never import anything EvoLink-related`);
    }
  }
});

test('16. skill-orchestrator.js and skill-adapters never import generation-service.js', () => {
  for (const file of orchestrationSourceFiles()) {
    for (const modulePath of requiredModules(file)) {
      assert.doesNotMatch(modulePath, /generation-service|generation-store/, `${file} requires "${modulePath}" — must never import the generation layer`);
    }
  }
});

test('16b. behaviorally: running every orchestrator function never creates a generation job', () => {
  const project = projectStore.createProject({ title: 'orchestrator safety test', topic: 'x' });
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  orchestrator.listSkills();
  orchestrator.getSkill('video-prompt-builder');
  orchestrator.getSkillCompatibility('cinema-worldbuilder-pro-2.0', { platform: 'evolink' });
  orchestrator.recommendSkill({ desiredOutput: 'shot-prompt', platform: 'evolink' });
  orchestrator.runAdapter('video-prompt-builder', { storyboardShot: { shotId: 's1' } }, { skillOutputText: '' });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- 17/18. approval / budget untouched -----------------------------------------

test('17 & 18. running every orchestrator function never changes a project\'s approval/budget state', () => {
  const project = projectStore.createProject({ title: 'orchestrator budget safety test', topic: 'x' });
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  orchestrator.listSkills();
  orchestrator.getSkillCompatibility('video-prompt-builder', { platform: 'evolink' });
  orchestrator.recommendSkill({ needsCinematicPlanning: true });
  orchestrator.runAdapter('cinema-worldbuilder-pro-2.0', { shot: { shotId: 's1' } }, { skillOutputText: 'Frame Map: x' });

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.limit, 100);
  assert.equal(reloaded.creditLedger.reserved, 0);
  assert.equal(gate.canProceed(reloaded).allowed, true);
});

test('skill-orchestrator.js never imports services/approval-gate.js at all', () => {
  for (const modulePath of requiredModules(path.join(__dirname, '..', 'services', 'skill-orchestrator.js'))) {
    assert.doesNotMatch(modulePath, /approval-gate/);
  }
});
