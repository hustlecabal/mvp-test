// operator-queue-tools.js — Stage 14 MCP tools for the Operator Queue.
// All real work happens in services/operator-queue-service.js, which is
// itself compute-on-read and only ever READS existing stores. See
// docs/architecture/operator-queue.md.
//
// Exactly 3 tools, all read-only: get_operator_queue,
// get_operator_queue_summary, get_next_operator_action. There is
// deliberately NO execute_queue, run_queue, generate_queue, or
// auto_process_queue — the queue is an information/control surface, not
// an automation engine. Nothing registered here can create, approve,
// generate, or ingest anything.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const operatorQueueService = require('../../services/operator-queue-service');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function register(server) {
  server.registerTool(
    'get_operator_queue',
    {
      title: 'Get the operator queue for a project',
      description:
        'Lists every keyframe (and every shot with no keyframes planned yet) that could use operator attention, ' +
        'each with a deterministic category, priority, blocking reason, and next action — computed fresh from ' +
        'existing state (keyframes, prompt packages, generation approvals, handoffs, assets, canonical asset, ' +
        'budget) every call. Read-only; never generates, approves, or mutates anything.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(operatorQueueService.buildProjectQueue(projectId));
    }
  );

  server.registerTool(
    'get_operator_queue_summary',
    {
      title: "Get a project's operator queue summary",
      description:
        'Returns the project-level rollup: totalKeyframes, complete, needsAttention, blocked, inProgress, ' +
        'needsApproval, readyForHandoff, assetsAwaitingReview, and completionPercentage. completionPercentage ' +
        'counts ONLY keyframes with an APPROVED canonical asset as complete — never "an image exists." Read-only.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(operatorQueueService.getQueueSummary(projectId));
    }
  );

  server.registerTool(
    'get_next_operator_action',
    {
      title: 'Get the single highest-priority operator action',
      description:
        'Returns the one highest-priority actionable queue item, or { nextAction: null } if nothing needs ' +
        'attention. Never invents work — a project with everything COMPLETE (or truly empty) returns null. ' +
        'Read-only.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(operatorQueueService.getNextAction(projectId));
    }
  );
}

module.exports = register;
