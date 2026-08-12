// reference-library-tools.js — Stage 19 MCP tools for the Reference
// Library, Identity Lock, and Identity Consistency Review. All real work
// happens in services/creative-store.js, services/reference-library-
// service.js, and services/identity-consistency-review-store.js.
//
// IMPORTANT: nothing registered here can generate an image or video, call
// a provider, spend a credit, or auto-approve/auto-canonicalize an asset.
// select_canonical_reference_asset is the ONLY write here that changes
// canonical state, and it is always an explicit, single, human/agent-
// requested action — never automatic. record_identity_consistency_review
// never touches an asset's approvalStatus.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const creativeStore = require('../../services/creative-store');
const referenceLibraryService = require('../../services/reference-library-service');
const identityConsistencyReviewStore = require('../../services/identity-consistency-review-store');
const { REFERENCE_ENTITY_TYPES } = require('../../schemas/creative-schema');
const { REVIEW_DIMENSIONS } = require('../../schemas/identity-consistency-review-schema');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    throw new Error(`No project found with id "${projectId}"`);
  }
  return project;
}

const entityTypeSchema = z.enum(REFERENCE_ENTITY_TYPES);
const scoreSchema = z.number().int().min(0).max(5).nullable().optional();
const scoresSchema = z.object(Object.fromEntries(REVIEW_DIMENSIONS.map((dim) => [dim, scoreSchema]))).partial();

function registerReferenceLibraryTools(server) {
  server.registerTool(
    'list_reference_library',
    {
      title: 'List the project Reference Library',
      description:
        'Read-only. Lists every character/location/prop in the Visual Bible, each with its full associated ' +
        'reference-asset list (approval status, storage status, generation lineage — never filtered, never ' +
        'deleted), which one (if any) is the CANONICAL reference, and approved/rejected/pending counts. An ' +
        'entity with zero references is still listed (missing is a visible state, never omitted).',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      const library = referenceLibraryService.listReferenceLibrary(projectId);
      return jsonResult(library);
    }
  );

  server.registerTool(
    'get_identity_lock',
    {
      title: 'Get one entity\'s Identity Lock record',
      description:
        'Read-only derived view: entityId, entityType, canonical asset id, approved reference asset ids, ' +
        'identity/wardrobe constraints (characters), environment constraints (locations), and continuity notes ' +
        '— resolved directly from the existing Visual Bible entity, never a second stored copy of it.',
      inputSchema: { projectId: z.string(), entityType: entityTypeSchema, entityId: z.string() },
    },
    async ({ projectId, entityType, entityId }) => {
      requireProject(projectId);
      const lock = referenceLibraryService.getIdentityLock(projectId, entityType, entityId);
      if (!lock) throw new Error(`No ${entityType.toLowerCase()} found with id "${entityId}" in project "${projectId}"`);
      return jsonResult(lock);
    }
  );

  server.registerTool(
    'add_entity_reference_asset',
    {
      title: 'Associate a candidate reference asset with an entity',
      description:
        'Appends an existing asset id to a character/location/prop\'s referenceAssets list, making it eligible ' +
        'to later be selected as that entity\'s canonical reference. Idempotent (adding the same asset twice is ' +
        'a no-op). Never changes approval status, never selects anything as canonical by itself.',
      inputSchema: {
        projectId: z.string(),
        entityType: entityTypeSchema,
        entityId: z.string(),
        assetId: z.string(),
        updatedBy: z.string().optional(),
        changeNote: z.string().optional(),
      },
    },
    async ({ projectId, entityType, entityId, assetId, updatedBy, changeNote }) => {
      requireProject(projectId);
      const entity = creativeStore.addEntityReferenceAsset(projectId, entityType, entityId, assetId, { updatedBy, changeNote });
      if (!entity) throw new Error(`No ${entityType.toLowerCase()} found with id "${entityId}" in project "${projectId}"`);
      return jsonResult(entity);
    }
  );

  server.registerTool(
    'select_canonical_reference_asset',
    {
      title: 'Select the canonical reference asset for an entity',
      description:
        'Explicitly marks ONE existing, already-associated, non-REJECTED asset as THE reference for a ' +
        'character/location/prop (Stage 19, Part 1). Always an explicit human/agent decision — nothing in this ' +
        'codebase ever selects a canonical reference automatically. The asset must already be one of the ' +
        'entity\'s associated reference assets (see add_entity_reference_asset) — this never fabricates that ' +
        'association. Every previous selection is preserved in canonicalReferenceHistory, never discarded.',
      inputSchema: {
        projectId: z.string(),
        entityType: entityTypeSchema,
        entityId: z.string(),
        assetId: z.string(),
        selectedBy: z.string().optional(),
        changeNote: z.string().optional(),
      },
    },
    async ({ projectId, entityType, entityId, assetId, selectedBy, changeNote }) => {
      requireProject(projectId);
      const result = creativeStore.selectCanonicalReferenceAsset(projectId, entityType, entityId, assetId, { selectedBy, changeNote });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result.entity);
    }
  );

  server.registerTool(
    'get_canonical_reference_asset',
    {
      title: 'Get the canonical reference asset for an entity',
      description:
        'Reads which asset (if any) is currently canonical for a character/location/prop, including the full ' +
        'asset record and the complete selection history. Read-only. Returns canonicalAssetId: null (not an ' +
        'error) when nothing has been selected yet.',
      inputSchema: { projectId: z.string(), entityType: entityTypeSchema, entityId: z.string() },
    },
    async ({ projectId, entityType, entityId }) => {
      requireProject(projectId);
      const result = creativeStore.getCanonicalReferenceAsset(projectId, entityType, entityId);
      if (!result) throw new Error(`No ${entityType.toLowerCase()} found with id "${entityId}" in project "${projectId}"`);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'record_identity_consistency_review',
    {
      title: 'Record a structured human identity-consistency review',
      description:
        'Records a human\'s 0-5 score across up to 8 identity dimensions (head/face geometry, hair/head ' +
        'ornament, clothing, colour palette, eyes/facial characteristics, distinctive accessory, silhouette, ' +
        'overall identity resemblance — the same dimensions Stage 18\'s manual A/B experiment used) plus free-' +
        'text notes, against one generated asset. This is NOT computer vision — every score is human-entered. ' +
        'Recording a review NEVER changes the asset\'s approvalStatus or any canonical selection; scoring and ' +
        'approving remain two separate, deliberate actions. A partial score (not every dimension filled in) is ' +
        'allowed. Multiple reviews per asset are kept, never overwritten.',
      inputSchema: {
        projectId: z.string(),
        assetId: z.string(),
        keyframeId: z.string().optional(),
        referenceAssetId: z.string().optional(),
        scores: scoresSchema.optional(),
        notes: z.string().optional(),
        reviewedBy: z.string().optional(),
      },
    },
    async ({ projectId, assetId, keyframeId, referenceAssetId, scores, notes, reviewedBy }) => {
      requireProject(projectId);
      const review = identityConsistencyReviewStore.recordReview(projectId, assetId, { keyframeId, referenceAssetId, scores, notes, reviewedBy });
      if (!review) throw new Error(`No project found with id "${projectId}"`);
      return jsonResult(review);
    }
  );

  server.registerTool(
    'list_identity_consistency_reviews',
    {
      title: 'List every identity-consistency review recorded for an asset',
      description: 'Read-only. Returns every review ever recorded for this asset, oldest first — never deleted, never overwritten.',
      inputSchema: { projectId: z.string(), assetId: z.string() },
    },
    async ({ projectId, assetId }) => {
      requireProject(projectId);
      const reviews = identityConsistencyReviewStore.listReviews(projectId, assetId);
      return jsonResult(reviews);
    }
  );
}

module.exports = registerReferenceLibraryTools;
