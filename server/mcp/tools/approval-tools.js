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
        reservedCredits: project.creditLedger.reserved,
        actualSpent: project.creditLedger.actualSpent,
        remainingBudget: gate.getRemainingBudget(project),
        generationAllowed: allowed,
        reason,
      });
    }
  );

  server.registerTool(
    'get_project_budget',
    {
      title: "Get a project's full budget/ledger state (read-only)",
      description:
        'Returns the complete budget picture for a project: budget limit, reserved credits, actual spent (if the ' +
        'provider ever reports one), remaining budget, any overage event, and whether further generation is ' +
        'currently allowed. Read-only — never submits or changes anything. Uses the existing Stage 3/8.1 ' +
        'approval-gate service (services/approval-gate.js).',
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => jsonResult(gate.getBudgetView(requireProject(projectId)))
  );

  // P0 Hardening (finding J) — the primary agent-facing interface (MCP) had
  // no way to establish a budget ceiling at all: REST's POST /projects/:id/
  // budget has existed since Stage 3, but none of this file's 5 tools could
  // call gate.setBudget(). An MCP-only caller could therefore never set a
  // spend limit greater than the schema default before requesting
  // generation approval — mirrors the REST route's own validation exactly
  // (limit must be a positive, finite number).
  server.registerTool(
    'set_project_budget',
    {
      title: "Set a project's total spend budget (credits)",
      description:
        'Sets (or changes) the total number of credits this project is allowed to spend. Mirrors the existing ' +
        'REST route POST /projects/:id/budget exactly, via the existing Stage 3 approval-gate service ' +
        '(services/approval-gate.js\'s setBudget). This is the ONLY MCP tool that can establish or change the ' +
        'budget ceiling that canProceed()/checkKeyframeBudget()/checkVideoBudget() enforce elsewhere.',
      inputSchema: {
        projectId: z.string(),
        limit: z.number(),
      },
    },
    async ({ projectId, limit }) => {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        return jsonResult({ ok: false, reason: 'limit must be a positive number' });
      }
      const project = requireProject(projectId);
      gate.setBudget(project, limit);
      projectStore.touch(project);
      return jsonResult({ ok: true, budget: gate.getBudgetView(project) });
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

  server.registerTool(
    'acknowledge_budget_overage',
    {
      title: 'Acknowledge a budget overage',
      description:
        'Records a human acknowledgement of an existing budget overage, via the existing approval-gate service ' +
        '(Stage 8.1\'s acknowledgeOverage, exposed here in Stage 13E). This lifts the hard stop that follows an ' +
        'overage so canProceed() can be re-evaluated on its own merits — it never raises the budget limit, never ' +
        'touches approvals.status, and never modifies any generation job or historical record. Fails clearly if ' +
        'no overage exists; returns alreadyAcknowledged: true (not an error) if this overage was already ' +
        'acknowledged, without overwriting who/when it was first acknowledged.',
      inputSchema: {
        projectId: z.string(),
        acknowledgedBy: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async ({ projectId, acknowledgedBy, note }) => {
      const project = requireProject(projectId);
      gate.ensureShape(project);
      const { overage } = project.creditLedger;

      if (!overage) {
        return jsonResult({ ok: false, reason: 'No active budget overage exists for this project.' });
      }
      if (overage.acknowledged) {
        return jsonResult({ ok: true, alreadyAcknowledged: true, overage });
      }

      gate.acknowledgeOverage(project, { acknowledgedBy, note });
      projectStore.touch(project);
      return jsonResult({ ok: true, alreadyAcknowledged: false, overage: project.creditLedger.overage, budget: gate.getBudgetView(project) });
    }
  );
}

module.exports = register;
