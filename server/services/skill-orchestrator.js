// skill-orchestrator.js
//
// Stage 11B — the thin coordination layer between our Creative IR (Stage
// 11A: Creative Brief -> Master Creative Spec -> Visual Bible -> Storyboard)
// and the audited Claude skills. See docs/architecture/skill-orchestration.md
// for the full architecture and the execution-boundary explanation.
//
// THIS FILE NEVER CALLS A PROVIDER. It has no import of, or path to,
// providers/evolink/*, services/generation-service.js, or
// services/approval-gate.js. It coordinates *creative planning* only —
// looking up skills, checking compatibility, recommending a specialist,
// and (for testing/future use) dispatching to an adapter's pure
// `adapt(input, context)` function. Nothing here invokes a Claude skill,
// makes a network call, or creates a generation job. Skill EXECUTION
// (actually running a skill) is explicitly out of scope for this stage —
// see Part 9 of the stage brief: no autonomy yet.

const registry = require('./skill-registry');
const adapters = require('./skill-adapters');

function listSkills() {
  return registry.listSkills();
}

function getSkill(skillId) {
  return registry.getSkill(skillId);
}

// Part 7's get_skill_compatibility: does this skill's output require
// translation before it can be used with a given target platform, and do
// we even have the adapter to do that translation?
function getSkillCompatibility(skillId, { platform } = {}) {
  const skill = getSkill(skillId);
  if (!skill) return null;

  const hasAdapter = Boolean(skill.adapter);
  // LOW coupling means the skill's output is already close to
  // provider-agnostic text; anything else needs its own adapter to reach
  // a specific target platform (e.g. "evolink").
  const compatibleWithoutTranslation = skill.platformCoupling === 'LOW';
  const warnings = [];

  if (!skill.enabled) {
    warnings.push(`"${skillId}" is not available in this environment.`);
  }
  if (!compatibleWithoutTranslation && platform && skill.platformCoupling !== platform) {
    warnings.push(
      `"${skillId}" output is coupled to ${skill.platformCoupling}; it must go through its adapter before use with "${platform}".`
    );
  }
  if (!hasAdapter && !compatibleWithoutTranslation) {
    warnings.push(`"${skillId}" has no adapter yet — its output cannot be normalized into our canonical creative model.`);
  }

  return {
    skillId: skill.id,
    platform: platform || null,
    platformCoupling: skill.platformCoupling,
    hasAdapter,
    compatible: skill.enabled && (compatibleWithoutTranslation || hasAdapter),
    warnings,
  };
}

// Part 8 — a small, deterministic (no LLM call, no fuzzy matching) rule
// table. Each rule is checked in order; the first match wins. Skills
// without an adapter are still recommendable (`executable: false`) so the
// orchestrator can say "here's the right specialist for this, but we
// can't run it yet" rather than staying silent about it.
function recommendSkill({ desiredOutput, platform, needsCinematicPlanning, needsReferenceImage } = {}) {
  if (needsReferenceImage) {
    const skill = getSkill('banana-pro-director-2.0');
    return {
      skillId: skill.id,
      reason: 'Character/reference-image creation requested.',
      status: 'future keyframe/reference-image stage',
      executable: Boolean(skill.adapter),
    };
  }

  if (needsCinematicPlanning) {
    const skill = getSkill('cinema-worldbuilder-pro-2.0');
    return {
      skillId: skill.id,
      reason: 'Cinematic shot planning (frame map / subject lock / movement / camera) requested.',
      status: skill.adapter ? 'adapter available' : 'no adapter yet',
      executable: Boolean(skill.adapter),
    };
  }

  if (desiredOutput === 'shot-prompt' && platform === 'evolink') {
    const skill = getSkill('video-prompt-builder');
    return {
      skillId: skill.id,
      reason: 'Shot-prompt output requested for the evolink platform; lowest platform coupling of the audited specialists.',
      status: skill.adapter ? 'adapter available' : 'no adapter yet',
      executable: Boolean(skill.adapter),
    };
  }

  return {
    skillId: null,
    reason: `No deterministic recommendation for desiredOutput="${desiredOutput || 'unset'}", platform="${platform || 'unset'}".`,
    status: 'no recommendation',
    executable: false,
  };
}

// Internal dispatcher — NOT exposed via MCP yet (Part 6/Part 9: skill
// execution is a future stage). Exists so the Part 4/5 adapters are
// testable end-to-end through the same lookup path a future orchestrator
// would use, without that path being reachable from outside this module
// yet. `context.skillOutputText` must already exist (a fixture in tests;
// eventually the text Claude Code got back from actually running a
// skill) — this function never runs a skill itself.
function runAdapter(skillId, input, context) {
  const skill = getSkill(skillId);
  if (!skill) {
    throw new Error(`Unknown skill "${skillId}". See list_creative_skills for the registered skills.`);
  }
  const adapter = adapters[skillId];
  if (!adapter) {
    throw new Error(
      `"${skillId}" has no adapter yet — its output cannot be normalized into our canonical creative model. See docs/architecture/skill-orchestration.md.`
    );
  }
  return adapter.adapt(input, context);
}

module.exports = {
  listSkills,
  getSkill,
  getSkillCompatibility,
  recommendSkill,
  runAdapter,
};
