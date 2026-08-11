// creative-tools.js — Stage 11A MCP tools for the creative-planning layer
// (Creative Brief, Master Creative Specification, Visual Bible,
// Storyboard). All real work happens in services/creative-store.js.
//
// IMPORTANT: nothing registered here can generate an image or video, call
// EvoLink, spend a credit, or touch the approval/budget gate. These tools
// only create/update/read structured creative-planning data — see
// docs/architecture/creative-intelligence.md.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const creativeStore = require('../../services/creative-store');
const { jsonResult } = require('../lib/respond');

// Every tool here is scoped to a project (Part 10). This distinguishes
// "no such project" (a real error) from "project exists but this artifact
// hasn't been created yet" (a normal, expected `null` result) — the two
// are NOT the same thing.
function requireProject(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  return project;
}

// Shared by every update tool: who made the change and why, always
// optional, never required — a beginner should be able to save a change
// without filling in bookkeeping fields.
const versionMetaFields = {
  updatedBy: z.string().optional(),
  changeNote: z.string().optional(),
};

// --- Creative Brief (Part 1) -------------------------------------------------

const creativeBriefFields = {
  title: z.string().optional(),
  concept: z.string().optional(),
  premise: z.string().optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  tone: z.string().optional(),
  genre: z.string().optional(),
  format: z.string().optional(),
  targetDuration: z.union([z.string(), z.number()]).optional(),
  visualDirection: z.string().optional(),
  narrativeApproach: z.string().optional(),
  keyMessage: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  creativeNotes: z.string().optional(),
};

// --- Master Creative Specification (Part 2) ---------------------------------

const masterCreativeSpecFields = {
  coreConcept: z.string().optional(),
  storyLogic: z.string().optional(),
  tone: z.string().optional(),
  pacing: z.string().optional(),
  visualLanguage: z.string().optional(),
  cinematography: z.string().optional(),
  lighting: z.string().optional(),
  colourLanguage: z.string().optional(),
  environmentRules: z.string().optional(),
  characterRules: z.string().optional(),
  wardrobeRules: z.string().optional(),
  cameraRules: z.string().optional(),
  motionRules: z.string().optional(),
  compositionRules: z.string().optional(),
  continuityRules: z.string().optional(),
  negativeConstraints: z.array(z.string()).optional(),
  referenceStrategy: z.string().optional(),
  masterPrompt: z.string().optional(),
};

// --- Visual Bible (Part 3/4/5) -----------------------------------------------
//
// Characters/props/locations are structured (Part 3/4/5), but each can
// have many optional sub-fields — rather than repeating every one of them
// a third time here, this accepts an array of plain objects (the same
// permissive pattern generation-tools.js already uses for provider
// `parameters`). services/creative-schema.js's createCharacter/
// createProp/createLocation fill in the canonical default shape for
// whatever fields are actually given.

const visualBibleFields = {
  world: z.string().optional(),
  characters: z.array(z.record(z.string(), z.any())).optional(),
  wardrobe: z.string().optional(),
  props: z.array(z.record(z.string(), z.any())).optional(),
  locations: z.array(z.record(z.string(), z.any())).optional(),
  architecture: z.string().optional(),
  lighting: z.string().optional(),
  colour: z.string().optional(),
  camera: z.string().optional(),
  composition: z.string().optional(),
  textureMaterials: z.string().optional(),
  atmosphere: z.string().optional(),
  continuityRules: z.string().optional(),
};

// --- Storyboard (Part 6/7) ----------------------------------------------------

const storyboardShotFields = {
  sceneId: z.string().optional(),
  order: z.number().optional(),
  duration: z.union([z.string(), z.number()]).optional(),
  purpose: z.string().optional(),
  narrativeBeat: z.string().optional(),
  visualDescription: z.string().optional(),
  subject: z.string().optional(),
  location: z.string().optional(),
  action: z.string().optional(),
  camera: z.string().optional(),
  framing: z.string().optional(),
  lens: z.string().optional(),
  movement: z.string().optional(),
  lighting: z.string().optional(),
  soundNotes: z.string().optional(),
  transition: z.string().optional(),
  continuityRequirements: z.array(z.string()).optional(),
  characterReferences: z.array(z.string()).optional(),
  locationReferences: z.array(z.string()).optional(),
  propReferences: z.array(z.string()).optional(),
  referenceAssets: z.array(z.string()).optional(),
  promptDraft: z.string().optional(),
  status: z.enum(require('../../schemas/creative-schema').SHOT_PLANNING_STATUSES).optional(),
};

function register(server) {
  // --- Creative Brief ---

  server.registerTool(
    'get_creative_brief',
    {
      title: "Get a project's Creative Brief",
      description:
        'Reads the Creative Brief creative-planning artifact for a project (title, concept, premise, audience, ' +
        'tone, etc.). Read-only. Returns null if none has been created yet.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(creativeStore.getCreativeBrief(projectId));
    }
  );

  server.registerTool(
    'update_creative_brief',
    {
      title: "Create or update a project's Creative Brief",
      description:
        'Creates the Creative Brief on first use, or updates it (bumping its version and recording a history ' +
        'entry) on every call after that. Only fields you pass are changed. Never generates anything, never ' +
        'calls a provider, never touches approval/budget — this only stores a creative planning decision.',
      inputSchema: { projectId: z.string(), ...creativeBriefFields, ...versionMetaFields },
    },
    async ({ projectId, updatedBy, changeNote, ...updates }) => {
      const result = creativeStore.updateCreativeBrief(projectId, updates, { updatedBy, changeNote });
      if (!result) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(result);
    }
  );

  // --- Master Creative Specification ---

  server.registerTool(
    'get_master_creative_spec',
    {
      title: "Get a project's Master Creative Specification",
      description:
        'Reads the structured Master Creative Specification (core concept, story logic, tone, cinematography, ' +
        'lighting, continuity/negative constraints, etc.) — a structured contract, not one giant prompt. ' +
        'Read-only. Returns null if none has been created yet.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(creativeStore.getMasterCreativeSpec(projectId));
    }
  );

  server.registerTool(
    'update_master_creative_spec',
    {
      title: "Create or update a project's Master Creative Specification",
      description:
        'Creates the Master Creative Specification on first use, or updates it (bumping its version) on every ' +
        'call after that. Never generates anything, never calls a provider, never touches approval/budget.',
      inputSchema: { projectId: z.string(), ...masterCreativeSpecFields, ...versionMetaFields },
    },
    async ({ projectId, updatedBy, changeNote, ...updates }) => {
      const result = creativeStore.updateMasterCreativeSpec(projectId, updates, { updatedBy, changeNote });
      if (!result) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(result);
    }
  );

  // --- Visual Bible ---

  server.registerTool(
    'get_visual_bible',
    {
      title: "Get a project's Visual Bible",
      description:
        'Reads the Visual Bible: persistent visual rules for world, characters, wardrobe, props, locations, ' +
        'architecture, lighting, colour, camera, composition, texture/materials, atmosphere, and continuity. ' +
        'Read-only. Returns null if none has been created yet.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(creativeStore.getVisualBible(projectId));
    }
  );

  server.registerTool(
    'update_visual_bible',
    {
      title: "Create or update a project's Visual Bible",
      description:
        'Creates the Visual Bible on first use, or updates it (bumping its version) on every call after that. ' +
        'characters/props/locations are full-array replacements when given — pass the complete updated array, ' +
        'not just one entry. Never generates anything, never calls a provider, never touches approval/budget.',
      inputSchema: { projectId: z.string(), ...visualBibleFields, ...versionMetaFields },
    },
    async ({ projectId, updatedBy, changeNote, ...updates }) => {
      const result = creativeStore.updateVisualBible(projectId, updates, { updatedBy, changeNote });
      if (!result) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(result);
    }
  );

  // --- Storyboard ---

  server.registerTool(
    'get_storyboard',
    {
      title: "Get a project's Storyboard",
      description:
        "Reads the project's Storyboard (creative-planning scenes and shots — separate from the production " +
        'Timeline IR used for actual generation jobs). Read-only. Returns null if none has been created yet.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(creativeStore.getStoryboard(projectId));
    }
  );

  server.registerTool(
    'update_storyboard',
    {
      title: "Bulk-update a project's Storyboard",
      description:
        'Creates the Storyboard on first use, or updates it (bumping its version) on every call after that. ' +
        'scenes/shots are full-array replacements when given. For adding a single scene or shot, prefer ' +
        'create_storyboard_scene/create_storyboard_shot instead. Never generates anything, never calls a ' +
        'provider, never touches approval/budget, and never moves a shot into actual video generation.',
      inputSchema: {
        projectId: z.string(),
        scenes: z.array(z.record(z.string(), z.any())).optional(),
        shots: z.array(z.record(z.string(), z.any())).optional(),
        ...versionMetaFields,
      },
    },
    async ({ projectId, updatedBy, changeNote, ...updates }) => {
      const result = creativeStore.updateStoryboard(projectId, updates, { updatedBy, changeNote });
      if (!result) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'create_storyboard_scene',
    {
      title: 'Add a scene to the Storyboard',
      description:
        'Adds one new scene to the project storyboard (creating the storyboard first if needed). Counts as a ' +
        "storyboard update — its version bumps and a history entry is recorded. Never generates anything.",
      inputSchema: {
        projectId: z.string(),
        title: z.string().optional(),
        order: z.number().optional(),
        description: z.string().optional(),
        purpose: z.string().optional(),
        ...versionMetaFields,
      },
    },
    async ({ projectId, updatedBy, changeNote, ...sceneFields }) => {
      const scene = creativeStore.addStoryboardScene(projectId, sceneFields, { updatedBy, changeNote });
      if (!scene) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(scene);
    }
  );

  server.registerTool(
    'create_storyboard_shot',
    {
      title: 'Add a shot to the Storyboard',
      description:
        'Adds one new creative-planning shot to the project storyboard (creating the storyboard first if ' +
        'needed). Counts as a storyboard update — its version bumps and a history entry is recorded. This is ' +
        'planning data only: it never creates a generation job, never calls EvoLink, and never spends a credit ' +
        '— see request_generation for the (separate, human-approved) step that actually does that.',
      inputSchema: { projectId: z.string(), ...storyboardShotFields, ...versionMetaFields },
    },
    async ({ projectId, updatedBy, changeNote, ...shotFields }) => {
      const shot = creativeStore.addStoryboardShot(projectId, shotFields, { updatedBy, changeNote });
      if (!shot) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(shot);
    }
  );
}

module.exports = register;
