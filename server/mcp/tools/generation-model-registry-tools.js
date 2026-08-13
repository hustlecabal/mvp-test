// generation-model-registry-tools.js — Stage 22B-Part-1 read-only MCP
// discovery tools over services/generation-model-registry.js.
//
// Exactly 2 tools, both read-only: list_generation_models,
// find_generation_models. Neither calls a provider, submits a generation,
// creates a job, records an approval, or touches project/credit state —
// they only inspect the in-memory capability registry. See
// docs/architecture/generation-model-registry.md.

const { z } = require('zod');
const registry = require('../../services/generation-model-registry');
const { jsonResult } = require('../lib/respond');

const requirementsShape = z
  .object({
    provider: z.string().optional(),
    modality: z.enum(['image', 'video']).optional(),
    textToImage: z.boolean().optional(),
    imageToImage: z.boolean().optional(),
    textToVideo: z.boolean().optional(),
    imageToVideo: z.boolean().optional(),
    referenceImages: z.boolean().optional(),
    minReferenceImages: z.number().optional(),
    firstFrame: z.boolean().optional(),
    lastFrame: z.boolean().optional(),
    audio: z.boolean().optional(),
    resolution: z.string().optional(),
    aspectRatio: z.string().optional(),
    minDurationSeconds: z.number().optional(),
    maxDurationSeconds: z.number().optional(),
    verificationStatus: z.enum(registry.VERIFICATION_STATUSES).optional(),
    productionReadyOnly: z.boolean().optional(),
  })
  .optional();

function register(server) {
  server.registerTool(
    'list_generation_models',
    {
      title: 'List generation models in the capability registry',
      description:
        'Read-only catalogue listing of every image/video generation model this project has investigated (both ' +
        'EvoLink and Google), with its capabilities, pricing, and verification tier (CATALOGUE_AVAILABLE / ' +
        'CAPABILITY_VERIFIED / REQUEST_SCHEMA_VERIFIED / SAFE_FOR_PRODUCTION). Optionally filter by provider, ' +
        'modality, productionReadyOnly, or verificationStatus. Never calls a provider, never submits anything, ' +
        'never mutates project or credit state.',
      inputSchema: {
        provider: z.string().optional(),
        modality: z.enum(['image', 'video']).optional(),
        productionReadyOnly: z.boolean().optional(),
        verificationStatus: z.enum(registry.VERIFICATION_STATUSES).optional(),
      },
    },
    async (input) => jsonResult(registry.listModels(input || {}))
  );

  server.registerTool(
    'find_generation_models',
    {
      title: 'Find generation models satisfying a set of capability requirements',
      description:
        'Read-only search over the capability registry: given provider-neutral requirements (modality, reference ' +
        'image support, resolution, duration, audio, etc.), returns every registered model that genuinely ' +
        'satisfies them — an unverified (null) capability never satisfies a "true" requirement, and a confirmed ' +
        '"false" capability never does either. Set sortByPrice:true to get results ordered cheapest-first among ' +
        'known prices, with unknown-priced matches listed after every known-priced one (never treated as free). ' +
        'This tool NEVER selects a model for execution, never submits a generation, and never creates a job or ' +
        'approval — it only returns data for a human/caller to decide with.',
      inputSchema: {
        requirements: requirementsShape,
        sortByPrice: z.boolean().optional(),
      },
    },
    async ({ requirements, sortByPrice }) => {
      const results = sortByPrice ? registry.cheapestSatisfying(requirements || {}) : registry.findModelsSatisfying(requirements || {});
      return jsonResult(results);
    }
  );
}

module.exports = register;
