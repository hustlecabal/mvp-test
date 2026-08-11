// keyframe-prompt-tools.js — Stage 13A MCP tools for the Keyframe Prompt
// Packaging layer (see schemas/keyframe-prompt-schema.js,
// services/keyframe-prompt-service.js). All real work happens there.
//
// IMPORTANT: nothing registered here can generate an image or video, call
// EvoLink, execute a Claude skill, spend a credit, or touch the approval/
// budget gate. These tools only build/read structured prompt-packaging
// data — see docs/architecture/keyframe-prompt-packaging.md. There is
// deliberately NO generate_keyframe, execute_skill, or submit_generation
// tool here.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const keyframePromptService = require('../../services/keyframe-prompt-service');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  return project;
}

const versionMetaFields = {
  updatedBy: z.string().optional(),
  changeNote: z.string().optional(),
};

function register(server) {
  server.registerTool(
    'get_keyframe_prompt_package',
    {
      title: 'Get a keyframe prompt package',
      description:
        "Reads the built KeyframePromptPackage for one keyframe (structured identity/wardrobe/environment " +
        "locks, resolved references, continuity, negative constraints, the derived prompt, and a live-computed " +
        'staleness status). Read-only. Returns null if no package has been built for this keyframe yet — use ' +
        'build_keyframe_prompt_package first.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireProject(projectId);
      return jsonResult(keyframePromptService.getKeyframePromptPackage(projectId, keyframeId));
    }
  );

  server.registerTool(
    'build_keyframe_prompt_package',
    {
      title: 'Build (or rebuild) a keyframe prompt package',
      description:
        'Resolves the Creative Brief, Master Creative Specification, Visual Bible, Storyboard, Keyframe Plan, ' +
        'and existing approved reference assets for one keyframe into a KeyframePromptPackage, and persists it ' +
        '(creating it on first call, version-bumping it on every call after that). The `prompt` field is a ' +
        'deterministic, no-LLM composition of `promptSections` — never hand-authored, never sent anywhere. This ' +
        'tool NEVER generates an image/video, calls a provider, executes a skill, or spends a credit — it only ' +
        'produces a structured specification a FUTURE generation stage could consume.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), ...versionMetaFields },
    },
    async ({ projectId, keyframeId, updatedBy, changeNote }) => {
      requireProject(projectId);
      const result = keyframePromptService.buildKeyframePromptPackage(projectId, keyframeId, { updatedBy, changeNote });
      if (!result) throw new Error(`No keyframe found with id "${keyframeId}" in project "${projectId}"`);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'list_keyframe_prompt_packages',
    {
      title: 'List a project\'s keyframe prompt packages',
      description:
        'Lists every built KeyframePromptPackage for a project, optionally filtered by shotId, sceneId, and/or ' +
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
      return jsonResult(keyframePromptService.listKeyframePromptPackages(projectId, { shotId, sceneId, status }));
    }
  );
}

module.exports = register;
