// media-acquisition-tools.js — MCP wrappers over the existing, unmodified
// services/media-acquisition-service.js and services/media-acquisition-
// store.js. Same discipline as every other *-tools.js file in this
// directory: nothing here decides anything the service doesn't already
// decide — this file only calls it and formats the result.
//
// acquire_stock_media is the ONE tool that actually performs a real
// network call and downloads bytes — every other tool here is read-only.
// It never picks a provider on the caller's behalf (this stage's own
// explicit "no automatic provider fallback" rule) and never runs inside
// start_production/resumeProduction itself — see services/media-
// acquisition-service.js's own header for why. It is the tool
// services/material-executors/stock-media-executor.js's own
// NO_ACQUIRED_STOCK_MEDIA_EXISTS escalation names as the required next
// step.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const mediaAcquisitionService = require('../../services/media-acquisition-service');
const mediaAcquisitionStore = require('../../services/media-acquisition-store');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function register(server) {
  server.registerTool(
    'acquire_stock_media',
    {
      title: 'Acquire one stock image or video from an external provider for a beat',
      description:
        'Calls media-acquisition-service.js\'s acquireMedia() — searches the named provider (Pexels or Pixabay; both ' +
        'require their own API key, PEXELS_API_KEY/PIXABAY_API_KEY, configured as an environment variable, never ' +
        'passed as a tool argument), deterministically picks the top search result, downloads it through the existing ' +
        'asset-storage.js, validates it (image: real format/dimension check; video: real ffprobe + ffmpeg decode ' +
        'check), registers it as a project Asset, and records a full provenance record. Never falls back to a second ' +
        'provider on failure — call this again explicitly with a different provider if that\'s what you want. This is ' +
        'the tool services/material-executors/stock-media-executor.js\'s NO_ACQUIRED_STOCK_MEDIA_EXISTS escalation ' +
        'names as the required next step before re-running material execution / start_production for that beat.',
      inputSchema: {
        projectId: z.string(),
        provider: z.enum(['pexels', 'pixabay']),
        mediaType: z.enum(['image', 'video']),
        searchQuery: z.string(),
        beatId: z.string().optional(),
        sceneId: z.string().optional(),
        orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
        minDurationSeconds: z.number().optional(),
        maxDurationSeconds: z.number().optional(),
        minWidth: z.number().optional(),
        minHeight: z.number().optional(),
        maxCandidates: z.number().optional(),
      },
    },
    async ({ projectId, provider, mediaType, searchQuery, beatId, sceneId, orientation, minDurationSeconds, maxDurationSeconds, minWidth, minHeight, maxCandidates }) => {
      requireProject(projectId);
      const result = await mediaAcquisitionService.acquireMedia({
        projectId,
        provider,
        mediaType,
        searchQuery,
        beatId: beatId || null,
        sceneId: sceneId || null,
        orientation: orientation || null,
        minDurationSeconds: typeof minDurationSeconds === 'number' ? minDurationSeconds : null,
        maxDurationSeconds: typeof maxDurationSeconds === 'number' ? maxDurationSeconds : null,
        minWidth: typeof minWidth === 'number' ? minWidth : null,
        minHeight: typeof minHeight === 'number' ? minHeight : null,
        maxCandidates: typeof maxCandidates === 'number' ? maxCandidates : 5,
      });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'list_stock_media_providers',
    {
      title: 'List which stock-media providers have a credential configured',
      description:
        'Read-only. Calls media-acquisition-service.js\'s listAvailableProviders() — the exact same check ' +
        'services/production-orchestrator-service.js uses to decide whether Material Resolution may offer a ' +
        'STOCK_MEDIA candidate at all. Never makes a network call; only checks whether PEXELS_API_KEY/' +
        'PIXABAY_API_KEY are set in this environment.',
      inputSchema: {},
    },
    async () => jsonResult({ availableProviders: mediaAcquisitionService.listAvailableProviders() })
  );

  server.registerTool(
    'list_media_acquisitions',
    {
      title: 'List every Media Acquisition record for a project',
      description:
        'Read-only. Every acquisition attempt ever recorded for this project (successful or not), including full ' +
        'provenance for each — provider, providerAssetId, source/download URL, search query, checksum, and the ' +
        'Asset id it produced when status is ACQUIRED. Calls media-acquisition-store.js\'s listAcquisitions() verbatim.',
      inputSchema: {
        projectId: z.string(),
        beatId: z.string().optional(),
        sceneId: z.string().optional(),
        provider: z.enum(['pexels', 'pixabay', 'fake-stock-media']).optional(),
        mediaType: z.enum(['image', 'video']).optional(),
        status: z.string().optional(),
      },
    },
    async ({ projectId, beatId, sceneId, provider, mediaType, status }) => {
      requireProject(projectId);
      return jsonResult(mediaAcquisitionStore.listAcquisitions(projectId, { beatId, sceneId, provider, mediaType, status }));
    }
  );
}

module.exports = register;
