// video-prompt-tools.js — Stage 22B-Part-2 MCP tools for the Video Prompt
// Packaging layer (see schemas/video-prompt-schema.js,
// services/video-prompt-service.js). All real work happens there.
//
// IMPORTANT: nothing registered here can generate a video, call EvoLink or
// Google, execute a Claude skill, spend a credit, create a generation job,
// or create/change a generation approval or canonical-asset selection.
// These tools only build/read structured video-specification data — see
// docs/architecture/video-prompt-package.md. There is deliberately NO
// generate_video, approve_video_generation, or submit_video_generation
// tool here.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const videoPromptService = require('../../services/video-prompt-service');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  return project;
}

const creativeSpecificationShape = {
  camera: z.string().optional(),
  subjectMotion: z.string().optional(),
  environmentMotion: z.string().optional(),
  composition: z.string().optional(),
  lighting: z.string().optional(),
  pacing: z.string().optional(),
};

const executionParametersShape = {
  duration: z.number().optional(),
  resolution: z.string().optional(),
  aspectRatio: z.string().optional(),
  fps: z.number().optional(),
};

const versionMetaFields = {
  updatedBy: z.string().optional(),
  changeNote: z.string().optional(),
};

function register(server) {
  server.registerTool(
    'get_video_prompt_package',
    {
      title: 'Get a video prompt package',
      description:
        'Reads the built VideoPromptPackage for one keyframe (canonical keyframe asset lineage, provider/model ' +
        'selection with its recorded verification snapshot, model-agnostic creative specification, execution ' +
        'parameters, reference lineage, the derived prompt, and a live-computed staleness status). Read-only. ' +
        'Returns null if no package has been built for this keyframe yet — use build_video_prompt_package first.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireProject(projectId);
      return jsonResult(videoPromptService.getVideoPromptPackage(projectId, keyframeId));
    }
  );

  server.registerTool(
    'build_video_prompt_package',
    {
      title: 'Build (or rebuild) a video prompt package',
      description:
        'Resolves a keyframe\'s explicitly-selected, APPROVED canonical keyframe asset, its own already-built ' +
        'image KeyframePromptPackage (for subject/continuity/negativeConstraints/reference lineage), the ' +
        'storyboard shot, and an explicit provider/model selection (validated against the read-only ' +
        'generation-model-registry — never defaulted, never auto-selected, never silently substituted) into a ' +
        'VideoPromptPackage, and persists it (creating it on first call, version-bumping it on every call after ' +
        'that). Fails with a structured { ok: false, code, reason } if there is no valid APPROVED canonical ' +
        'keyframe asset, or if the provider/model is unknown or cannot support the requested workflow ' +
        '(image-to-video, or reference-to-video when requiresReferenceImages is true). The `prompt` field is a ' +
        'deterministic, no-LLM composition of `videoPromptSections` — never hand-authored, never sent anywhere. ' +
        'This tool NEVER generates a video, calls a provider, executes a skill, spends a credit, creates a ' +
        'generation job, creates a generation approval, or changes any canonical-asset/approval selection — it ' +
        'only produces a structured specification a FUTURE video-generation stage could consume.',
      inputSchema: {
        projectId: z.string(),
        keyframeId: z.string(),
        provider: z.string(),
        model: z.string(),
        requiresReferenceImages: z.boolean().optional(),
        creativeSpecification: z.object(creativeSpecificationShape).optional(),
        executionParameters: z.object(executionParametersShape).optional(),
        ...versionMetaFields,
      },
    },
    async ({ projectId, keyframeId, provider, model, requiresReferenceImages, creativeSpecification, executionParameters, updatedBy, changeNote }) => {
      requireProject(projectId);
      const result = videoPromptService.buildVideoPromptPackage(projectId, keyframeId, {
        provider,
        model,
        requiresReferenceImages,
        creativeSpecification,
        executionParameters,
        updatedBy,
        changeNote,
      });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'list_video_prompt_packages',
    {
      title: "List a project's video prompt packages",
      description:
        'Lists every built VideoPromptPackage for a project, optionally filtered by shotId, sceneId, and/or ' +
        'status (CURRENT/STALE, live-computed). Read-only.',
      inputSchema: {
        projectId: z.string(),
        shotId: z.string().optional(),
        sceneId: z.string().optional(),
        status: z.enum(['CURRENT', 'STALE']).optional(),
      },
    },
    async ({ projectId, shotId, sceneId, status }) => {
      requireProject(projectId);
      return jsonResult(videoPromptService.listVideoPromptPackages(projectId, { shotId, sceneId, status }));
    }
  );
}

module.exports = register;
