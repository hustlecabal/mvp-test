// keyframe-handoff-tools.js — Stage 13D MCP tools for the human keyframe
// execution handoff. All real work happens in
// services/keyframe-handoff-service.js.
//
// Deliberately only 4 tools (Part 4): create/get/list/cancel. There is
// NO execute_handoff, run_handoff, run_skill, or generate_from_handoff
// tool — the handoff is intentionally human-controlled, and image
// ingestion (a binary file upload) is a REST-only concern (Part 6),
// never an MCP tool.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const handoffService = require('../../services/keyframe-handoff-service');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function register(server) {
  server.registerTool(
    'create_keyframe_handoff',
    {
      title: 'Create a human execution handoff for a keyframe',
      description:
        'Creates a FROZEN execution instruction for a human to carry out in Higgsfield — never generates an ' +
        'image itself. Requires a CURRENT prompt package and an explicit APPROVED keyframe generation approval ' +
        'matching that exact package version; blocked otherwise. The resulting handoff\'s package version, skill, ' +
        'and instructions never change even if the prompt package is later rebuilt.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), createdBy: z.string().optional(), notes: z.string().optional() },
    },
    async ({ projectId, keyframeId, createdBy, notes }) => {
      requireProject(projectId);
      const result = handoffService.createHandoff(projectId, keyframeId, { createdBy, notes });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result.handoff);
    }
  );

  server.registerTool(
    'get_keyframe_handoff',
    {
      title: 'Get a keyframe execution handoff',
      description: 'Reads one handoff by id, including its frozen instructions and current status. Read-only.',
      inputSchema: { projectId: z.string(), handoffId: z.string() },
    },
    async ({ projectId, handoffId }) => {
      requireProject(projectId);
      const handoff = handoffService.getHandoff(projectId, handoffId);
      if (!handoff) throw new Error(`No handoff found with id "${handoffId}" in project "${projectId}"`);
      return jsonResult(handoff);
    }
  );

  server.registerTool(
    'list_keyframe_handoffs',
    {
      title: 'List execution handoffs for a project',
      description: 'Lists every handoff for a project, optionally filtered by keyframeId and/or status. Read-only.',
      inputSchema: {
        projectId: z.string(),
        keyframeId: z.string().optional(),
        status: z.enum(['READY', 'IN_PROGRESS', 'INGESTED', 'CANCELLED']).optional(),
      },
    },
    async ({ projectId, keyframeId, status }) => {
      requireProject(projectId);
      return jsonResult(handoffService.listHandoffs(projectId, { keyframeId, status }));
    }
  );

  server.registerTool(
    'cancel_keyframe_handoff',
    {
      title: 'Cancel a keyframe execution handoff',
      description:
        'Cancels a handoff that has not yet received an image (READY or IN_PROGRESS). Refuses to cancel an ' +
        'already-INGESTED handoff. Never deletes anything — the record remains, marked CANCELLED.',
      inputSchema: { projectId: z.string(), handoffId: z.string(), decidedBy: z.string().optional(), reason: z.string().optional() },
    },
    async ({ projectId, handoffId, decidedBy, reason }) => {
      requireProject(projectId);
      const result = handoffService.cancelHandoff(projectId, handoffId, { decidedBy, reason });
      if (!result) throw new Error(`No handoff found with id "${handoffId}" in project "${projectId}"`);
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result.handoff);
    }
  );
}

module.exports = register;
