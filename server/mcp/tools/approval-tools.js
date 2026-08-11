// approval-tools.js — MCP tools for the approval/budget gate. All real
// rules live in services/approval-gate.js (Stage 3) — these tools only
// read from it and call its request/decide functions. Nothing here can
// generate anything; it only manages the approval checkpoint in front of
// generation.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const gate = require('../../services/approval-gate');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  return project;
}

function register(server) {
  server.registerTool(
    'get_approval_status',
    {
      title: 'Get approval and budget status',
      description:
        "Returns a project's current approval status, budget limit, amount spent, estimated cost (if any), whether generation is currently allowed, and why not if it's blocked. Uses the existing Stage 3 approval-gate service.",
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => {
      const project = requireProject(projectId);
      gate.ensureShape(project);
      const { allowed, reason } = gate.canProceed(project);

      return jsonResult({
        approvalStatus: project.approvals.status,
        estimatedCost: project.approvals.estimatedCost,
        budgetLimit: project.creditLedger.limit,
        spent: project.creditLedger.spent,
        generationAllowed: allowed,
        reason,
      });
    }
  );

  server.registerTool(
    'request_generation_approval',
    {
      title: 'Request approval before generating anything',
      description:
        'Requests human approval for an upcoming generation step, with an estimated credit cost. This does NOT generate anything — it only starts the approval process, via the existing approval-gate service.',
      inputSchema: {
        projectId: z.string(),
        estimatedCost: z.number().nonnegative(),
        note: z.string().optional(),
      },
    },
    async ({ projectId, estimatedCost, note }) => {
      const project = requireProject(projectId);
      gate.requestApproval(project, { estimatedCost, note });
      projectStore.touch(project);
      return jsonResult(project.approvals);
    }
  );

  server.registerTool(
    'record_approval_decision',
    {
      title: 'Approve or reject a pending approval request',
      description:
        'Records a human decision (approve or reject) on the most recent pending approval request, via the existing approval-gate service.',
      inputSchema: {
        projectId: z.string(),
        approve: z.boolean(),
        decidedBy: z.string().optional(),
      },
    },
    async ({ projectId, approve, decidedBy }) => {
      const project = requireProject(projectId);
      const updated = gate.decideApproval(project, { approve, decidedBy });

      if (!updated) {
        return jsonResult({ ok: false, reason: 'No pending approval request for this project' });
      }

      projectStore.touch(project);
      return jsonResult({ ok: true, approvals: updated.approvals });
    }
  );
}

module.exports = register;
