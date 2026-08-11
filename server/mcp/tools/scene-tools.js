// scene-tools.js — MCP tools for scenes. All real work happens in
// services/timeline-store.js.

const { z } = require('zod');
const timelineStore = require('../../services/timeline-store');
const { jsonResult } = require('../lib/respond');

function register(server) {
  server.registerTool(
    'create_scene',
    {
      title: 'Create a scene',
      description: "Creates a new scene within a project, using the existing Production IR structure (schemas/production-schema.js).",
      inputSchema: {
        projectId: z.string(),
        title: z.string(),
        description: z.string(),
      },
    },
    async ({ projectId, title, description }) => {
      const scene = timelineStore.addScene(projectId, { title, description });
      if (!scene) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(scene);
    }
  );

  server.registerTool(
    'list_scenes',
    {
      title: "List a project's scenes",
      description: 'Returns all scenes belonging to a project.',
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => {
      const scenes = timelineStore.listScenes(projectId);
      if (scenes === null) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(scenes);
    }
  );
}

module.exports = register;
