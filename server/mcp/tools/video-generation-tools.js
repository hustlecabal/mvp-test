// video-generation-tools.js — Stage 22B-Part-3 MCP tools for controlled,
// per-shot VIDEO generation. All real work happens in
// services/video-generation-approval-store.js and
// services/video-generation-service.js — this file only validates input
// and shapes output.
//
// generate_video is the ONLY tool here allowed to cause a real provider
// call, and even it can only do so if video-generation-service.js's
// safety checks (video prompt package CURRENT, explicit VIDEO_GENERATION_
// APPROVAL APPROVED and bound to the exact package version/canonical
// asset/provider/model, budget gate, no in-flight duplicate) ALL pass
// first — those checks run server-side and cannot be skipped or
// overridden by the caller. There is deliberately no single "generate
// video" tool that bypasses approval, no raw_http_request, no
// bypass_budget, and no automatic provider/model selection anywhere in
// this file.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const keyframeStore = require('../../services/keyframe-store');
const videoPromptService = require('../../services/video-prompt-service');
const videoGenerationApprovalStore = require('../../services/video-generation-approval-store');
const videoGenerationService = require('../../services/video-generation-service');
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
    'request_video_generation_approval',
    {
      title: 'Request explicit approval to generate one video',
      description:
        'Starts (or restarts) the VIDEO_GENERATION_APPROVAL process for one keyframe — separate from, and not ' +
        'satisfied by, approving the storyboard, the keyframe plan, the image prompt package, or a keyframe ' +
        'generation approval. Resolves the current built video prompt package automatically (provider, model, ' +
        'canonicalKeyframeAssetId, executionParameters) unless explicitly overridden. The approval binds to the ' +
        'exact package id + version + canonical asset + provider + model at request time — it stops authorizing ' +
        'generation the moment any of those change. Never generates anything.',
      inputSchema: {
        projectId: z.string(),
        keyframeId: z.string(),
        estimatedCost: z.number().nonnegative().optional(),
        reason: z.string().optional(),
        requestedBy: z.string().optional(),
      },
    },
    async ({ projectId, keyframeId, estimatedCost, reason, requestedBy }) => {
      const keyframe = requireKeyframe(projectId, keyframeId);

      const pkg = videoPromptService.getVideoPromptPackage(projectId, keyframeId);
      if (!pkg) {
        throw new Error('No video prompt package has been built for this keyframe yet. Call build_video_prompt_package first.');
      }

      const approval = videoGenerationApprovalStore.requestApproval(projectId, keyframeId, {
        sceneId: keyframe.sceneId,
        shotId: keyframe.shotId,
        videoPromptPackageId: pkg.packageId,
        videoPromptPackageVersion: pkg.version,
        canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
        provider: pkg.provider,
        model: pkg.model,
        executionParameters: pkg.executionParameters,
        estimatedCost,
        reason,
        requestedBy,
      });
      return jsonResult(approval);
    }
  );

  server.registerTool(
    'get_video_generation_approval',
    {
      title: "Get a keyframe's video generation approval status",
      description: 'Reads the current VIDEO_GENERATION_APPROVAL for one keyframe. Read-only.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(videoGenerationApprovalStore.getApproval(projectId, keyframeId));
    }
  );

  server.registerTool(
    'approve_video_generation',
    {
      title: 'Approve a pending video generation request',
      description:
        'Records an explicit human APPROVED decision on the pending VIDEO_GENERATION_APPROVAL for one keyframe. ' +
        'This is the ONLY thing that satisfies "explicit approval" for video generation — never generates ' +
        'anything itself, never changes the canonical keyframe asset, and never selects a provider or model.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), approvedBy: z.string().optional() },
    },
    async ({ projectId, keyframeId, approvedBy }) => {
      requireKeyframe(projectId, keyframeId);
      const approval = videoGenerationApprovalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: approvedBy });
      if (!approval) {
        return jsonResult({ ok: false, reason: 'No pending video generation approval request to approve.' });
      }
      return jsonResult({ ok: true, approval });
    }
  );

  server.registerTool(
    'reject_video_generation',
    {
      title: 'Reject a pending video generation request',
      description: 'Records an explicit human REJECTED decision on the pending VIDEO_GENERATION_APPROVAL for one keyframe.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), decidedBy: z.string().optional(), reason: z.string().optional() },
    },
    async ({ projectId, keyframeId, decidedBy, reason }) => {
      requireKeyframe(projectId, keyframeId);
      const approval = videoGenerationApprovalStore.decideApproval(projectId, keyframeId, { approve: false, decidedBy, reason });
      if (!approval) {
        return jsonResult({ ok: false, reason: 'No pending video generation approval request to reject.' });
      }
      return jsonResult({ ok: true, approval });
    }
  );

  server.registerTool(
    'can_generate_video',
    {
      title: 'Check whether generate_video would currently be allowed',
      description:
        'Read-only eligibility check — runs every safety gate generate_video would (package CURRENT, approval ' +
        'APPROVED and bound to the exact package/canonical asset/provider/model, canonical asset still APPROVED, ' +
        'model registry validation, budget, duplicate protection) WITHOUT submitting anything or calling a ' +
        'provider. Use this to decide whether to show/enable a GENERATE VIDEO control.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(videoGenerationService.canGenerateVideo(projectId, keyframeId));
    }
  );

  server.registerTool(
    'generate_video',
    {
      title: 'Generate one video (controlled, approval-gated)',
      description:
        'Submits ONE controlled video generation for a keyframe via the provider adapter selected by the ' +
        'approved provider/model — but ONLY if every safety check passes server-side (see can_generate_video). ' +
        'Polls to completion, archives the result, creates a fully-traceable video asset, and reconciles cost ' +
        'into the project\'s shared credit ledger. The resulting asset\'s approvalStatus starts at NONE and is ' +
        'never automatically canonical — a human reviews it separately. No automatic retry, fallback provider, ' +
        'fallback model, or alternate canonical asset ever occurs.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(await videoGenerationService.generateVideo(projectId, keyframeId));
    }
  );

  server.registerTool(
    'acknowledge_video_unknown_cost',
    {
      title: 'Acknowledge an unknown video generation cost',
      description:
        'Records an explicit human acknowledgement that the current VIDEO_GENERATION_APPROVAL has no estimatedCost ' +
        '(EvoLink gives no pre-submission price quote for video). Required by video-generation-service.js\'s budget ' +
        'check before generation can proceed whenever estimatedCost is unset — never invents a cost, never changes ' +
        'the approval decision itself.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), acknowledgedBy: z.string().optional() },
    },
    async ({ projectId, keyframeId, acknowledgedBy }) => {
      requireKeyframe(projectId, keyframeId);
      const approval = videoGenerationApprovalStore.acknowledgeUnknownCost(projectId, keyframeId, { acknowledgedBy });
      if (!approval) {
        return jsonResult({ ok: false, reason: 'No video generation approval exists for this keyframe yet.' });
      }
      return jsonResult({ ok: true, approval });
    }
  );

  server.registerTool(
    'approve_generated_video',
    {
      title: 'Approve a completed video asset',
      description:
        'Records an explicit human APPROVED decision on one generated video asset\'s own approvalStatus — separate ' +
        'from, and not satisfied by, approving the VIDEO_GENERATION_APPROVAL that authorized generating it. A video ' +
        'asset always starts at approvalStatus NONE and is never automatically approved; this is the only thing ' +
        'that changes it. Never re-selects a canonical asset and never generates anything.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), assetId: z.string(), approvedBy: z.string().optional() },
    },
    async ({ projectId, keyframeId, assetId, approvedBy }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(videoGenerationService.approveGeneratedVideo(projectId, keyframeId, assetId, { approvedBy }));
    }
  );

  server.registerTool(
    'reject_generated_video',
    {
      title: 'Reject a completed video asset',
      description:
        'Records an explicit human REJECTED decision on one generated video asset\'s own approvalStatus. The ' +
        'rejected asset and its generation job are never deleted — both remain permanently visible for history/audit.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), assetId: z.string(), decidedBy: z.string().optional(), reason: z.string().optional() },
    },
    async ({ projectId, keyframeId, assetId, decidedBy, reason }) => {
      requireKeyframe(projectId, keyframeId);
      return jsonResult(videoGenerationService.rejectGeneratedVideo(projectId, keyframeId, assetId, { decidedBy, reason }));
    }
  );

  server.registerTool(
    'get_video_generation_status',
    {
      title: "Get a video generation job's current stored status",
      description:
        'Reads the current stored, normalized state of a video generation job — status (BLOCKED/IN_PROGRESS/' +
        'COMPLETED/FAILED), provider, model, provider task id, reserved/actual cost, error, and asset id once ' +
        'complete. Read-only; does not contact the provider.',
      inputSchema: { generationId: z.string() },
    },
    async ({ generationId }) => {
      const result = videoGenerationService.getVideoGenerationStatus(generationId);
      if (!result) throw new Error(`No video generation job found with id "${generationId}"`);
      return jsonResult(result);
    }
  );
}

module.exports = register;
