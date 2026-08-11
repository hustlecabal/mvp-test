// skill-orchestration-tools.js — Stage 11B read-only MCP tools for
// discovering the audited Claude skills and their compatibility with a
// target platform. All real logic lives in services/skill-orchestrator.js.
//
// IMPORTANT: no execute_skill tool exists yet, deliberately (Part 7/9 of
// the stage brief) — these tools can only look things up, never run a
// skill, generate anything, call EvoLink, or touch approval/budget.

const { z } = require('zod');
const orchestrator = require('../../services/skill-orchestrator');
const { jsonResult } = require('../lib/respond');

function register(server) {
  server.registerTool(
    'list_creative_skills',
    {
      title: 'List the audited creative skills',
      description:
        'Returns the full skill registry: every Claude skill audited for the creative production workflow, its ' +
        'role, purpose, input/output types, platform coupling, generation risk, and whether an adapter exists ' +
        'yet. Read-only — never runs a skill or generates anything.',
      inputSchema: {},
    },
    async () => jsonResult(orchestrator.listSkills())
  );

  server.registerTool(
    'get_creative_skill',
    {
      title: 'Get one skill\'s registry record',
      description: "Returns a single skill's full registry record by id. Read-only.",
      inputSchema: { skillId: z.string() },
    },
    async ({ skillId }) => {
      const skill = orchestrator.getSkill(skillId);
      if (!skill) {
        throw new Error(`Unknown skill "${skillId}". Use list_creative_skills to see the registered skills.`);
      }
      return jsonResult(skill);
    }
  );

  server.registerTool(
    'get_skill_compatibility',
    {
      title: 'Check a skill\'s compatibility with a target platform',
      description:
        "Reports whether a skill's output can be used with a given platform (e.g. \"evolink\") without further " +
        'translation, whether an adapter exists to do that translation, and any warnings. Read-only — never runs ' +
        'a skill, and never itself decides which skill to use (see the separate recommendation logic for that).',
      inputSchema: { skillId: z.string(), platform: z.string().optional() },
    },
    async ({ skillId, platform }) => {
      const result = orchestrator.getSkillCompatibility(skillId, { platform });
      if (!result) {
        throw new Error(`Unknown skill "${skillId}". Use list_creative_skills to see the registered skills.`);
      }
      return jsonResult(result);
    }
  );
}

module.exports = register;
