// project-tools.js — MCP tools for creating, reading, listing, updating,
// and moving projects through their production state. Every tool here is
// a thin wrapper: the real logic lives in services/project-store.js,
// services/approval-gate.js, and schemas/state-machine.js.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const gate = require('../../services/approval-gate');
const stateMachine = require('../../schemas/state-machine');
const { jsonResult } = require('../lib/respond');

function summarizeProject(project) {
  return {
    id: project.id,
    title: project.title,
    topic: project.topic,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function requireProject(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  return project;
}

function register(server) {
  server.registerTool(
    'create_project',
    {
      title: 'Create a new video project',
      description:
        'Creates a new video project with a title and topic, and optional audience/tone/creativeMode. Returns the created project.',
      inputSchema: {
        title: z.string().describe('The project title'),
        topic: z.string().describe('What the video is about'),
        audience: z.string().optional().describe('Who this video is for'),
        tone: z.string().optional().describe('The emotional register, e.g. "nostalgic"'),
        creativeMode: z.string().optional().describe('The overall creative approach, e.g. "documentary"'),
      },
    },
    async ({ title, topic, audience, tone, creativeMode }) => {
      const project = projectStore.createProject({ title, topic, audience, tone, creativeMode });
      return jsonResult(project);
    }
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project by id',
      description: 'Retrieves the complete project record for a given project id.',
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => jsonResult(requireProject(projectId))
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List all projects',
      description: 'Lists every saved project as a concise summary: id, title, topic, status, createdAt, updatedAt.',
      inputSchema: {},
    },
    async () => jsonResult(projectStore.listProjects().map(summarizeProject))
  );

  server.registerTool(
    'update_project',
    {
      title: 'Update safe project fields',
      description:
        "Updates a project's title, topic, audience, tone, and/or creativeMode. Does not accept or change status — use transition_project for that, so state changes always go through the state machine.",
      inputSchema: {
        projectId: z.string(),
        title: z.string().optional(),
        topic: z.string().optional(),
        audience: z.string().optional(),
        tone: z.string().optional(),
        creativeMode: z.string().optional(),
      },
    },
    async ({ projectId, title, topic, audience, tone, creativeMode }) => {
      const updated = projectStore.updateProject(projectId, { title, topic, audience, tone, creativeMode });
      if (!updated) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(updated);
    }
  );

  server.registerTool(
    'get_project_status',
    {
      title: "Get a beginner-friendly summary of a project's status",
      description:
        "Summarizes where a project currently stands: its state, what that state means in plain English, what states it can move to next, whether human approval is required before generating, and whether generation is currently allowed right now.",
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => {
      const project = requireProject(projectId);
      const nextStates = stateMachine.getNextStates(project.status);
      const { allowed, reason } = gate.canProceed(project);

      return jsonResult({
        projectId: project.id,
        title: project.title,
        currentState: project.status,
        whatThisMeans: stateMachine.describeState(project.status),
        nextAllowedStates: nextStates,
        approvalRequired: nextStates.some(stateMachine.isGenerationState),
        generationCurrentlyAllowed: allowed,
        reason,
      });
    }
  );

  server.registerTool(
    'transition_project',
    {
      title: 'Move a project to a new production state',
      description:
        'Moves a project from its current state to targetState, using the existing production state machine (schemas/state-machine.js). Generation states are blocked unless the approval/budget gate currently allows it. Invalid moves are reported back with a clear reason rather than an error.',
      inputSchema: {
        projectId: z.string(),
        targetState: z.enum(stateMachine.STATES),
      },
    },
    async ({ projectId, targetState }) => {
      const project = requireProject(projectId);
      const result = stateMachine.transition(project, targetState);

      if (!result.ok) {
        return jsonResult({ ok: false, reason: result.reason, currentState: project.status });
      }

      projectStore.touch(project);
      return jsonResult({ ok: true, project: result.project });
    }
  );
}

module.exports = register;
