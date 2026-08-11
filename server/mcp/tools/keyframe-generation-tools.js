// keyframe-generation-tools.js — Stage 13B MCP tools for controlled
// keyframe image generation. All real work happens in
// services/keyframe-generation-approval-store.js and
// services/keyframe-generation-service.js — this file only validates
// input and shapes output.
//
// generate_keyframe is the ONLY tool here allowed to cause a real provider
// call, and even it can only do so if keyframe-generation-service.js's
// safety checks (prompt package CURRENT, explicit keyframe generation
// approval, budget gate, no in-flight duplicate) ALL pass first — those
// checks run server-side and cannot be skipped or overridden by the
// caller. There is deliberately no raw_image_request, raw_http_request,
// bypass_budget, or force_generate tool anywhere in this file.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const keyframeStore = require('../../services/keyframe-store');
const keyframePromptService = require('../../services/keyframe-prompt-service');
const approvalStore = require('../../services/keyframe-generation-approval-store');
const generationStore = require('../../services/generation-store');
const keyframeGenerationService = require('../../services/keyframe-generation-service');
const { jsonResult } = require('../lib/respond');

function requireKeyframe(projectId, keyframeId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) {
    throw new Error(`No keyframe found with id "${keyframeId}" in project "${projectId}"`);
  }
  return keyframe;
}

function register(server) {
  server.registerTool(
    'request_keyframe_generation_approval',
    {
      title: 'Request explicit approval to generate one keyframe image',
      description:
        'Starts (or restarts) the KEYFRAME_GENERATION_APPROVAL process for one keyframe — separate from, and not ' +
        'satisfied by, approving the storyboard, the keyframe plan, or the prompt package. Resolves the current ' +
        'built prompt package automatically if promptPackageId/Version are not given. Never generates anything.',
      inputSchema: {
        projectId: z.string(),
        keyframeId: z.string(),
        promptPackageId: z.string().optional(),
        promptPackageVersion: z.number().optional(),
        estimatedCost: z.number().nonnegative().optional(),
        reason: z.string().optional(),
        requestedBy: z.string().optional(),
      },
    },
    async ({ projectId, keyframeId, promptPackageId, promptPackageVersion, estimatedCost, reason, requestedBy }) => {
      requireKeyframe(projectId, keyframeId);

      let resolvedPackageId = promptPackageId;
      let resolvedPackageVersion = promptPackageVersion;
      if (!resolvedPackageId) {
        const pkg = keyframePromptService.getKeyframePromptPackage(projectId, keyframeId);
        if (!pkg) {
          throw new Error('No prompt package has been built for this keyframe yet. Call build_keyframe_prompt_package first, or pass promptPackageId/promptPackageVersion explicitly.');
        }
        resolvedPackageId = pkg.packageId;
        resolvedPackageVersion = pkg.version;
      }

      const approval = approvalStore.requestApproval(projectId, keyframeId, {
        promptPackageId: resolvedPackageId,
        promptPackageVersion: resolvedPackageVersion,
        estimatedCost,
        reason,
        requestedBy,
      });
      return jsonResult(approval);
    }
  );

  server.registerTool(
    'get_keyframe_generation_approval',
    {
      title: "Get a keyframe's generation approval status",
      description: 'Reads the current KEYFRAME_GENERATION_APPROVAL for one keyframe. Read-only.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(approvalStore.getApproval(projectId, keyframeId));
    }
  );

  server.registerTool(
    'approve_keyframe_generation',
    {
      title: 'Approve a pending keyframe generation request',
      description:
        'Records an explicit human APPROVED decision on the pending KEYFRAME_GENERATION_APPROVAL for one ' +
        'keyframe, and marks the keyframe GENERATION_APPROVED. This is the ONLY thing that satisfies Part 5\'s ' +
        '"explicit approval" requirement — never generates anything itself.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), approvedBy: z.string().optional() },
    },
    async ({ projectId, keyframeId, approvedBy }) => {
      requireKeyframe(projectId, keyframeId);
      const approval = approvalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: approvedBy });
      if (!approval) {
        return jsonResult({ ok: false, reason: 'No pending keyframe generation approval request to approve.' });
      }
      const keyframe = keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'GENERATION_APPROVED');
      return jsonResult({ ok: true, approval, keyframe });
    }
  );

  server.registerTool(
    'reject_keyframe_generation',
    {
      title: 'Reject a pending keyframe generation request',
      description: 'Records an explicit human REJECTED decision on the pending KEYFRAME_GENERATION_APPROVAL for one keyframe.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), decidedBy: z.string().optional(), reason: z.string().optional() },
    },
    async ({ projectId, keyframeId, decidedBy, reason }) => {
      requireKeyframe(projectId, keyframeId);
      const approval = approvalStore.decideApproval(projectId, keyframeId, { approve: false, decidedBy, reason });
      if (!approval) {
        return jsonResult({ ok: false, reason: 'No pending keyframe generation approval request to reject.' });
      }
      return jsonResult({ ok: true, approval });
    }
  );

  server.registerTool(
    'generate_keyframe',
    {
      title: 'Generate one keyframe image (controlled, approval-gated)',
      description:
        'Submits ONE controlled image generation for a keyframe via the configured image provider — but ONLY if ' +
        'every safety check passes server-side: the prompt package is CURRENT, an explicit ' +
        'KEYFRAME_GENERATION_APPROVAL is APPROVED for the exact package version, the shared project budget gate ' +
        'allows it, and no identical generation is already in flight (in which case the existing job is returned ' +
        'instead of submitting a duplicate). Polls to completion, archives the result, creates a fully-traceable ' +
        'asset, and marks the keyframe GENERATED. The resulting asset\'s approval status starts at NONE — a human ' +
        'must separately call approve_generated_keyframe or reject_generated_keyframe.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(await keyframeGenerationService.generateKeyframe(projectId, keyframeId));
    }
  );

  server.registerTool(
    'get_keyframe_generation_status',
    {
      title: "Get a keyframe generation job's current stored status",
      description:
        'Reads the current stored state of a keyframe image generation job — status, provider, model, progress, ' +
        'reserved/actual cost, error, result, and asset id. Read-only; does not contact the provider.',
      inputSchema: { generationId: z.string() },
    },
    async ({ generationId }) => {
      const job = generationStore.getGenerationJob(generationId);
      if (!job || job.generationType !== 'IMAGE_KEYFRAME') {
        throw new Error(`No keyframe generation job found with id "${generationId}"`);
      }
      return jsonResult(job);
    }
  );

  server.registerTool(
    'approve_generated_keyframe',
    {
      title: 'Approve a generated keyframe image as a reusable reference',
      description:
        'Records an explicit human APPROVED decision on one already-generated keyframe asset — never automatic. ' +
        'Only after this does the asset become eligible for reuse as an approved reference (see ' +
        'services/keyframe-prompt-service.js\'s reference-reuse check).',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), assetId: z.string(), approvedBy: z.string().optional() },
    },
    async ({ projectId, keyframeId, assetId, approvedBy }) => {
      requireKeyframe(projectId, keyframeId);
      const result = keyframeGenerationService.approveGeneratedKeyframe(projectId, keyframeId, assetId, { approvedBy });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'reject_generated_keyframe',
    {
      title: 'Reject a generated keyframe image',
      description:
        'Records an explicit human REJECTED decision on one already-generated keyframe asset. The rejected asset ' +
        'and its generation job are never deleted — they remain visible in list_keyframe_generations as history.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), assetId: z.string(), decidedBy: z.string().optional(), reason: z.string().optional() },
    },
    async ({ projectId, keyframeId, assetId, decidedBy, reason }) => {
      requireKeyframe(projectId, keyframeId);
      const result = keyframeGenerationService.rejectGeneratedKeyframe(projectId, keyframeId, assetId, { decidedBy, reason });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'list_keyframe_generations',
    {
      title: 'List every generation job for one keyframe',
      description: 'Lists every image generation job ever created for one keyframe, newest first — including failed/rejected/timed-out attempts, which are never deleted. Read-only.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(keyframeGenerationService.listKeyframeGenerations(projectId, keyframeId));
    }
  );
}

module.exports = register;
