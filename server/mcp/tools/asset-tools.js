// asset-tools.js — MCP tools for reading asset metadata/lineage. All real
// work happens in services/timeline-store.js. Nothing in this stage
// generates real assets, so these will typically return empty lists.

const { z } = require('zod');
const timelineStore = require('../../services/timeline-store');
const { jsonResult } = require('../lib/respond');

function register(server) {
  server.registerTool(
    'list_assets',
    {
      title: "List a project's assets",
      description:
        'Returns asset metadata and lineage information for a project, optionally filtered to one shot. No generation exists yet at this stage, so this is usually empty.',
      inputSchema: {
        projectId: z.string(),
        shotId: z.string().optional(),
      },
    },
    async ({ projectId, shotId }) => {
      const assets = timelineStore.listAssets(projectId, { shotId });
      if (assets === null) {
        throw new Error(`No project found with id "${projectId}"`);
      }
      return jsonResult(assets);
    }
  );

  server.registerTool(
    'get_asset',
    {
      title: 'Get an asset',
      description: "Retrieves one asset's metadata (not file contents) by id.",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string(),
      },
    },
    async ({ projectId, assetId }) => {
      const asset = timelineStore.getAsset(projectId, assetId);
      if (!asset) {
        throw new Error(`No asset found with id "${assetId}" in project "${projectId}"`);
      }
      return jsonResult(asset);
    }
  );
}

module.exports = register;
