// generation-tools.js — MCP tools for generation jobs. estimate_generation
// and request_generation delegate entirely to services/generation-service.js
// (which owns every safety check and the approval/budget gate); this file
// adds no logic of its own beyond input validation and shaping output.
//
// request_generation is the FIRST MCP tool in this whole project allowed
// to cause real spending — and even it can only do so if
// generation-service.js's safety checks all pass first.

const { z } = require('zod');
const generationStore = require('../../services/generation-store');
const generationService = require('../../services/generation-service');
const generationPoller = require('../../services/generation-poller');
const { jsonResult } = require('../lib/respond');

const referenceShape = z.object({ type: z.string(), url: z.string() });

const generationInputShape = {
  projectId: z.string(),
  shotId: z.string(),
  provider: z.string(),
  model: z.string(),
  task: z.string(),
  prompt: z.string(),
  references: z.array(referenceShape).optional(),
  parameters: z.record(z.string(), z.any()).optional(),
};

function register(server) {
  server.registerTool(
    'estimate_generation',
    {
      title: 'Check whether a generation would be allowed',
      description:
        'Runs every safety check (project exists, shot exists, project is in a generation state, approval and budget allow it) WITHOUT submitting anything to a provider or creating a job. Use this before request_generation.',
      inputSchema: generationInputShape,
    },
    async (input) => jsonResult(generationService.estimateGeneration(input))
  );

  server.registerTool(
    'request_generation',
    {
      title: 'Submit a real generation request',
      description:
        'Submits a real generation to the configured provider — but ONLY if project/shot lookups, state validation, and the approval/budget gate all pass. This is the first tool that can cause real provider spending. Calling it again for the same project/shot/provider/model/task/prompt/parameters while a matching job is still in flight returns the existing job instead of submitting a duplicate.',
      inputSchema: generationInputShape,
    },
    async (input) => jsonResult(await generationService.requestGeneration(input))
  );

  server.registerTool(
    'get_generation_status',
    {
      title: "Get a generation job's current stored status",
      description:
        'Reads the current stored state of a generation job — status, provider, model, progress, reserved/actual cost, error, result, and asset id. Does not contact the provider; use poll_generation for that.',
      inputSchema: { generationId: z.string() },
    },
    async ({ generationId }) => {
      const job = generationStore.getGenerationJob(generationId);
      if (!job) {
        throw new Error(`No generation job found with id "${generationId}"`);
      }
      return jsonResult({
        id: job.id,
        status: job.status,
        provider: job.provider,
        model: job.model,
        progress: job.progress,
        reservedCost: job.reservedCost,
        actualCost: job.actualCost,
        error: job.error,
        result: job.result,
        assetId: job.assetId,
      });
    }
  );

  server.registerTool(
    'poll_generation',
    {
      title: 'Poll a generation job until it settles (or times out)',
      description:
        'Checks the provider for the latest status of an existing generation job, repeating a few times with a short delay while it is still pending/processing. Stops on completed, failed, or after reaching the maximum number of attempts. Never creates a new generation.',
      inputSchema: { generationId: z.string() },
    },
    async ({ generationId }) => jsonResult(await generationPoller.pollGenerationJob(generationId))
  );
}

module.exports = register;
