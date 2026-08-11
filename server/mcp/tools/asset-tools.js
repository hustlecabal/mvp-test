// asset-tools.js — MCP tools for reading asset metadata/lineage, and
// (Stage 9A) archiving an already-completed generation result into
// permanent local storage. Real work happens in services/timeline-store.js
// and services/asset-archive-service.js — nothing here talks to EvoLink or
// generates anything.

const { z } = require('zod');
const timelineStore = require('../../services/timeline-store');
const archiveService = require('../../services/asset-archive-service');
const { jsonResult } = require('../lib/respond');

// A concise summary for list_assets, mirroring project-tools.js's
// summarizeProject — the full asset record (including its provider URL)
// is available via get_asset.
function summarizeAsset(asset) {
  return {
    assetId: asset.assetId,
    projectId: asset.projectId,
    sceneId: asset.sceneId,
    shotId: asset.shotId,
    generationId: asset.generationId,
    provider: asset.provider,
    model: asset.model,
    type: asset.type,
    storageStatus: asset.storage ? asset.storage.status : 'NOT_ARCHIVED',
    createdAt: asset.createdAt,
  };
}

function register(server) {
  server.registerTool(
    'list_assets',
    {
      title: "List a project's assets",
      description:
        'Returns a concise summary of each asset in a project (id, lineage, type, storage status, createdAt), ' +
        'optionally filtered to one shot. Use get_asset for the full record, including the provider result URL.',
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
      return jsonResult(assets.map(summarizeAsset));
    }
  );

  server.registerTool(
    'get_asset',
    {
      title: 'Get an asset',
      description:
        "Retrieves one asset's full metadata by id, including lineage, its provider result URL, and its " +
        'permanent local storage status (Stage 9A) — not the file contents themselves.',
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

  server.registerTool(
    'archive_asset',
    {
      title: 'Archive a completed asset to permanent local storage',
      description:
        "Downloads an already-completed generation's result from its (temporary) provider URL into this " +
        'project\'s permanent local storage (server/data/assets/). Does NOT generate anything and never calls a ' +
        'generation endpoint — it only downloads a result that already exists. Safe to call more than once: ' +
        'already-archived assets are returned as-is, and a missing stored file is safely re-downloaded from the ' +
        'original provider URL when still known.',
      inputSchema: {
        assetId: z.string(),
      },
    },
    async ({ assetId }) => jsonResult(await archiveService.archiveGenerationAsset(assetId))
  );

  server.registerTool(
    'get_asset_download',
    {
      title: 'Get download/preview links and storage status for an asset',
      description:
        "Returns an asset's storage status plus its download and preview URL paths and whether a provider URL " +
        'is still available — never the internal filesystem path.',
      inputSchema: {
        assetId: z.string(),
      },
    },
    async ({ assetId }) => {
      const found = timelineStore.findAssetById(assetId);
      if (!found) {
        throw new Error(`No asset found with id "${assetId}"`);
      }
      const { asset } = found;
      return jsonResult({
        assetId: asset.assetId,
        storageStatus: asset.storage ? asset.storage.status : 'NOT_ARCHIVED',
        downloadUrl: `/assets/${asset.assetId}/download`,
        previewUrl: `/assets/${asset.assetId}/preview`,
        providerUrlAvailable: Boolean(asset.url),
      });
    }
  );
}

module.exports = register;
