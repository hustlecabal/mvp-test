// shot-tools.js — MCP tools for shots. All real work happens in
// services/timeline-store.js.

const { z } = require('zod');
const timelineStore = require('../../services/timeline-store');
const { jsonResult } = require('../lib/respond');

function register(server) {
  server.registerTool(
    'create_shot',
    {
      title: 'Create a shot',
      description:
        'Creates a new shot within a project and scene. Only projectId and sceneId are required — every other field is optional and can be filled in later, or by a different step.',
      inputSchema: {
        projectId: z.string(),
        sceneId: z.string(),
        startTime: z.number().optional(),
        duration: z.number().optional(),
        narrativePurpose: z.string().optional(),
        camera: z.string().optional(),
        composition: z.string().optional(),
        subjectAction: z.string().optional(),
        environmentAction: z.string().optional(),
        audio: z.string().optional(),
        screenText: z.string().optional(),
        mustPreserve: z.array(z.string()).optional(),
        mustChange: z.array(z.string()).optional(),
        keyframePrompt: z.string().optional(),
        motionPrompt: z.string().optional(),
      },
    },
    async ({ projectId, ...shotFields }) => {
      const shot = timelineStore.addShot(projectId, shotFields);
      if (!shot) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(shot);
    }
  );

  server.registerTool(
    'get_shot',
    {
      title: 'Get a shot',
      description: 'Retrieves a single shot by id from a project.',
      inputSchema: {
        projectId: z.string(),
        shotId: z.string(),
      },
    },
    async ({ projectId, shotId }) => {
      const shot = timelineStore.getShot(projectId, shotId);
      if (!shot) {
        throw new Error(`No shot found with id "${shotId}" in project "${projectId}"`);
      }
      return jsonResult(shot);
    }
  );

  server.registerTool(
    'list_shots',
    {
      title: "List a project's shots",
      description: 'Returns all shots for a project, optionally filtered to one scene.',
      inputSchema: {
        projectId: z.string(),
        sceneId: z.string().optional(),
      },
    },
    async ({ projectId, sceneId }) => {
      const shots = timelineStore.listShots(projectId, { sceneId });
      if (shots === null) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(shots);
    }
  );
}

module.exports = register;
