// keyframe-execution-tools.js — Stage 13C MCP tools for the keyframe
// execution bridge investigation (see
// docs/architecture/keyframe-execution-bridge.md). All real work happens
// in services/keyframe-execution-bridge-service.js.
//
// prepare_keyframe_execution is READ-ONLY and never executes anything.
// run_fixture_keyframe_execution exists only to prove the pipeline with a
// local, deterministic fixture (Stage 13B's fake-image provider) — it
// enforces the exact same approval/staleness/budget/duplicate checks as
// generate_keyframe, via the same underlying service call, never a
// bypass. There is deliberately no raw_skill_execution, execute_any_skill,
// raw_command, or arbitrary_shell tool here, and no tool that can reach a
// real image provider or a real Claude skill.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const keyframeStore = require('../../services/keyframe-store');
const bridgeService = require('../../services/keyframe-execution-bridge-service');
const { jsonResult } = require('../lib/respond');

function requireKeyframe(projectId, keyframeId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) {
    throw new Error(`No keyframe found with id "${keyframeId}" in project "${projectId}"`);
  }
  return keyframe;
}

function register(server) {
  server.registerTool(
    'prepare_keyframe_execution',
    {
      title: 'Prepare (but do not run) a keyframe execution',
      description:
        'Read-only. Returns the keyframe, its current prompt package, the recommended skill, resolved reference ' +
        'assets, plain-language execution instructions, and a safety verdict (reusing the exact same approval/' +
        'staleness/budget check generate_keyframe enforces). NEVER generates or executes anything — no installed ' +
        'skill can be run programmatically today (see docs/architecture/keyframe-execution-bridge.md).',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(bridgeService.prepareKeyframeExecution(projectId, keyframeId));
    }
  );

  server.registerTool(
    'run_fixture_keyframe_execution',
    {
      title: 'Run a LOCAL FIXTURE keyframe execution (no real provider, no real skill)',
      description:
        'Proves the package -> execution -> asset -> archive -> lineage pipeline end-to-end using Stage 13B\'s ' +
        'local fake-image provider — never a real image API, never a real Claude skill, never the network. ' +
        'Enforces every keyframe generation safety check (approval, package currency, budget, duplicate ' +
        'protection) via the same service generate_keyframe uses; returns a normalized BLOCKED/COMPLETED/FAILED ' +
        'KeyframeExecutionResult. This is a fixture/investigation tool, not a path to real generation.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(await bridgeService.runFixtureKeyframeExecution(projectId, keyframeId));
    }
  );
}

module.exports = register;
