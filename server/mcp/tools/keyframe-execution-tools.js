// keyframe-execution-tools.js — Stage 13C MCP tools for the keyframe
// execution bridge investigation (see
// docs/architecture/keyframe-execution-bridge.md). All real work happens
// in services/keyframe-execution-bridge-service.js.
//
// ============================================================================
// STAGE 13E, PART 3 — CLASSIFICATION: INTERNAL TEST/DEVELOPMENT ONLY.
//
// Stage 13D's Human Keyframe Execution Handoff (services/keyframe-handoff-
// service.js, mcp/tools/keyframe-handoff-tools.js) is the real production
// path for getting a keyframe image today. This file's tools were Stage
// 13C's investigation into whether a programmatic path existed at all
// (it doesn't — see docs/architecture/keyframe-execution-bridge.md); they
// exist only to exercise the package -> execution -> asset -> archive ->
// lineage pipeline against a local, deterministic fixture, for automated
// tests and manual investigation. A verified-zero-consumer check for this
// stage (grepping the whole repo for prepareKeyframeExecution/
// runFixtureKeyframeExecution/prepare_keyframe_execution/
// run_fixture_keyframe_execution) found exactly three references outside
// this module's own service/schema/tests: docs/architecture/keyframe-
// execution-bridge.md and test/mcp.test.js's tool-discoverability list.
// frontend/app.js and index.js never call either tool — neither is
// reachable from the Creative Director UI, and neither should ever be
// wired to it. Kept (not removed) because the existing automated tests
// depend on it and it remains a legitimate local fixture-testing tool.
// ============================================================================
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
      title: '[FIXTURE-ONLY] Prepare (but do not run) a keyframe execution',
      description:
        '[FIXTURE-ONLY / INTERNAL TEST-DEVELOPMENT TOOL — not a production generation path. For real keyframe ' +
        'execution use create_keyframe_handoff instead.] Read-only. Returns the keyframe, its current prompt ' +
        'package, the recommended skill, resolved reference assets, plain-language execution instructions, and a ' +
        'safety verdict (reusing the exact same approval/staleness/budget check generate_keyframe enforces). ' +
        'NEVER generates or executes anything — no installed skill can be run programmatically today (see ' +
        'docs/architecture/keyframe-execution-bridge.md).',
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
      title: '[FIXTURE-ONLY] Run a LOCAL FIXTURE keyframe execution (no real provider, no real skill)',
      description:
        '[FIXTURE-ONLY / INTERNAL TEST-DEVELOPMENT TOOL — never presents as, or should be wired to, a real ' +
        'generation option. For real keyframe execution use create_keyframe_handoff instead.] Proves the ' +
        'package -> execution -> asset -> archive -> lineage pipeline end-to-end using Stage 13B\'s local ' +
        'fake-image provider — never a real image API, never a real Claude skill, never the network. Enforces ' +
        'every keyframe generation safety check (approval, package currency, budget, duplicate protection) via ' +
        'the same service generate_keyframe uses; returns a normalized BLOCKED/COMPLETED/FAILED ' +
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
