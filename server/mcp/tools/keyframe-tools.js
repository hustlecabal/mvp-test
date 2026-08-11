// keyframe-tools.js — Stage 12 MCP tools for the Keyframe Intelligence
// layer (see schemas/keyframe-schema.js, services/keyframe-store.js,
// services/keyframe-planner.js). All real work happens in those files.
//
// IMPORTANT: nothing registered here can generate an image or video, call
// EvoLink, spend a credit, execute a Claude skill, or touch the approval/
// budget gate. These tools only read/write structured keyframe-planning
// data and run a deterministic, read-only requirement analysis — see
// docs/architecture/keyframe-intelligence.md.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const keyframeStore = require('../../services/keyframe-store');
const keyframePlanner = require('../../services/keyframe-planner');
const { FRAME_TYPES, KEYFRAME_STATUSES } = require('../../schemas/keyframe-schema');
const { jsonResult } = require('../lib/respond');

// Same pattern as creative-tools.js's requireProject: distinguishes "no
// such project" (a real error) from "project exists but has no keyframe
// plan yet" (a normal, expected result).
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

const keyframeFields = {
  sceneId: z.string().optional(),
  shotId: z.string().optional(),
  order: z.number().optional(),
  purpose: z.string().optional(),
  frameType: z.enum(FRAME_TYPES).optional(),
  subject: z.string().optional(),
  visualDescription: z.string().optional(),
  composition: z.string().optional(),
  camera: z.string().optional(),
  framing: z.string().optional(),
  lens: z.string().optional(),
  movementIntent: z.string().optional(),
  lighting: z.string().optional(),
  colour: z.string().optional(),
  characterReferences: z.array(z.string()).optional(),
  locationReferences: z.array(z.string()).optional(),
  propReferences: z.array(z.string()).optional(),
  referenceAssets: z.array(z.string()).optional(),
  continuityRequirements: z.array(z.string()).optional(),
  promptDraft: z.string().optional(),
  sourceShotVersion: z.number().optional(),
  status: z.enum(KEYFRAME_STATUSES).optional(),
  notes: z.string().optional(),
  recommendedSkill: z.string().optional(),
  recommendationReason: z.string().optional(),
};

function register(server) {
  server.registerTool(
    'get_keyframe_plan',
    {
      title: "Get a project's Keyframe Plan",
      description:
        "Reads the project's whole Keyframe Plan (every planned keyframe, plus version/history). Each keyframe " +
        'includes a computed `stale` flag comparing it against the storyboard\'s current version. Read-only. ' +
        'Returns an empty plan (not null) the first time it is called for a project — see create_keyframe to add ' +
        'entries.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(keyframeStore.getKeyframePlan(projectId));
    }
  );

  server.registerTool(
    'update_keyframe_plan',
    {
      title: "Bulk-update a project's Keyframe Plan",
      description:
        'Updates top-level Keyframe Plan fields (bumping its version and recording a history entry). For adding ' +
        'or editing a single keyframe, prefer create_keyframe/update_keyframe instead. Never generates anything, ' +
        'never calls a provider, never touches approval/budget.',
      inputSchema: {
        projectId: z.string(),
        keyframes: z.array(z.record(z.string(), z.any())).optional(),
        ...versionMetaFields,
      },
    },
    async ({ projectId, updatedBy, changeNote, ...updates }) => {
      const result = keyframeStore.updateKeyframePlan(projectId, updates, { updatedBy, changeNote });
      if (!result) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'list_keyframes',
    {
      title: 'List keyframes in a project',
      description:
        'Lists planned keyframes for a project, optionally filtered by shotId, sceneId, frameType, and/or ' +
        'status. Each result includes a computed `stale` flag. Read-only.',
      inputSchema: {
        projectId: z.string(),
        shotId: z.string().optional(),
        sceneId: z.string().optional(),
        frameType: z.enum(FRAME_TYPES).optional(),
        status: z.enum(KEYFRAME_STATUSES).optional(),
      },
    },
    async ({ projectId, shotId, sceneId, frameType, status }) => {
      requireProject(projectId);
      return jsonResult(keyframeStore.listKeyframes(projectId, { shotId, sceneId, frameType, status }));
    }
  );

  server.registerTool(
    'get_keyframe',
    {
      title: 'Get a single keyframe',
      description: 'Reads one keyframe by id, including its computed `stale` flag. Read-only.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireProject(projectId);
      const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
      if (!keyframe) throw new Error(`No keyframe found with id "${keyframeId}" in project "${projectId}"`);
      return jsonResult(keyframe);
    }
  );

  server.registerTool(
    'create_keyframe',
    {
      title: 'Add a planned keyframe',
      description:
        'Adds one new keyframe to the project Keyframe Plan (creating the plan first if needed). Counts as a ' +
        'plan update — its version bumps and a history entry is recorded. This is planning data only: it never ' +
        'creates a generation job, never calls EvoLink, and never spends a credit.',
      inputSchema: { projectId: z.string(), ...keyframeFields, ...versionMetaFields },
    },
    async ({ projectId, updatedBy, changeNote, ...fields }) => {
      const keyframe = keyframeStore.createKeyframe(projectId, fields, { updatedBy, changeNote });
      if (!keyframe) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(keyframe);
    }
  );

  server.registerTool(
    'update_keyframe',
    {
      title: 'Update a planned keyframe',
      description:
        'Updates one existing keyframe\'s fields in place (counts as a plan update — version bumps, history is ' +
        'recorded). Only fields you pass are changed. Never generates anything, never calls a provider, never ' +
        'touches approval/budget.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), ...keyframeFields, ...versionMetaFields },
    },
    async ({ projectId, keyframeId, updatedBy, changeNote, ...fields }) => {
      const keyframe = keyframeStore.updateKeyframe(projectId, keyframeId, fields, { updatedBy, changeNote });
      if (!keyframe) throw new Error(`No keyframe found with id "${keyframeId}" in project "${projectId}"`);
      return jsonResult(keyframe);
    }
  );

  server.registerTool(
    'select_canonical_keyframe_asset',
    {
      title: 'Select the canonical asset for a keyframe',
      description:
        'Explicitly marks ONE existing asset as THE asset for this keyframe (Stage 13E, Part 1). Always an ' +
        'explicit human/agent decision — nothing in this codebase ever selects a canonical asset automatically ' +
        '(not on generation, not on approval, not because it is newest). The asset must already exist, already ' +
        'belong to this exact project + keyframe, and must not currently be REJECTED (a rejected asset can never ' +
        'become canonical); this never approves, generates, or moves the asset. Every previous selection is ' +
        'preserved in canonicalAssetHistory, never discarded. If the currently-canonical asset is later REJECTED, ' +
        'this must be called again explicitly — nothing clears it automatically.',
      inputSchema: {
        projectId: z.string(),
        keyframeId: z.string(),
        assetId: z.string(),
        selectedBy: z.string().optional(),
        changeNote: z.string().optional(),
      },
    },
    async ({ projectId, keyframeId, assetId, selectedBy, changeNote }) => {
      requireProject(projectId);
      const result = keyframeStore.selectCanonicalKeyframeAsset(projectId, keyframeId, assetId, { selectedBy, changeNote });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result.keyframe);
    }
  );

  server.registerTool(
    'get_canonical_keyframe_asset',
    {
      title: 'Get the canonical asset for a keyframe',
      description:
        'Reads which asset (if any) is currently canonical for a keyframe, including the full asset record and ' +
        'the complete selection history. Read-only. Returns canonicalAssetId: null (not an error) when nothing ' +
        'has been selected yet.',
      inputSchema: { projectId: z.string(), keyframeId: z.string() },
    },
    async ({ projectId, keyframeId }) => {
      requireProject(projectId);
      const result = keyframeStore.getCanonicalKeyframeAsset(projectId, keyframeId);
      if (!result) throw new Error(`No keyframe found with id "${keyframeId}" in project "${projectId}"`);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'analyze_shot_keyframes',
    {
      title: 'Analyze which keyframes a shot needs',
      description:
        'Runs a deterministic (no LLM call, no generation) requirement analysis for one storyboard shot: which ' +
        'reference frames it plausibly needs, which are already satisfied by an existing APPROVED asset ' +
        '("reused"), which already have a planned keyframe ("existing"), and which are net-new ' +
        '("recommendations", each with a recommended skill and reason). Read-only — never creates a keyframe, ' +
        'generation job, or spends a credit. Use create_keyframe to actually record a recommendation.',
      inputSchema: { projectId: z.string(), shotId: z.string() },
    },
    async ({ projectId, shotId }) => {
      requireProject(projectId);
      const result = keyframePlanner.analyzeShotKeyframes(projectId, shotId);
      if (!result) throw new Error(`No storyboard shot found with id "${shotId}" in project "${projectId}"`);
      return jsonResult(result);
    }
  );
}

module.exports = register;
