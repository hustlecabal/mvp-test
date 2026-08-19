// creative-blueprint-tools.js — INT-2.5-P0. Thin MCP wrappers over the
// existing, unmodified services/creative-blueprint-service.js and
// services/creative-blueprint-store.js.
//
// This file exists to close the exact gap the INT-2.5 forensic audit
// found: CreativeBlueprint (INT-2) is a fully built, tested, deterministic
// service with ZERO operator-facing surface — reachable only from test
// files. Nothing here decides whether a Blueprint is good, whether it may
// be approved, or what its content should be — every one of those
// decisions is made by the existing service functions this file only
// calls. No business logic is duplicated here.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const creativeBlueprintService = require('../../services/creative-blueprint-service');
const creativeBlueprintStore = require('../../services/creative-blueprint-store');
const { RECOMMENDATION_DECISION_TYPES, CREATIVE_BLUEPRINT_REVIEW_DECISIONS } = require('../../schemas/creative-blueprint-schema');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

const recommendationDecisionInput = z.object({
  recommendationId: z.string(),
  decision: z.enum(RECOMMENDATION_DECISION_TYPES),
  decidedBy: z.string().optional(),
  note: z.string().optional(),
  finalCreativeDecision: z.string().optional(),
});

const structuralDirectionInput = z.object({
  plannedSectionCount: z.number().optional(),
  minimumSectionDurationSeconds: z.number().optional(),
  rhythmNotes: z.string().optional(),
});

const continuityRequirementInput = z.object({
  entityType: z.string(),
  entityId: z.string(),
  requirement: z.string().optional(),
});

function register(server) {
  server.registerTool(
    'build_creative_blueprint_draft',
    {
      title: 'Build a DRAFT CreativeBlueprint from a real RecommendationSet',
      description:
        'Calls services/creative-blueprint-service.js\'s buildCreativeBlueprintDraft() verbatim — every recommendationId, ' +
        'continuityRequirement, and structural field is validated against real, already-persisted records; nothing is ' +
        'invented. Always starts at status DRAFT, never auto-approved. This is the first step of the Recommendation -> ' +
        'Blueprint -> Human Approval -> Gate chain a project must pass through before paid production can begin.',
      inputSchema: {
        projectId: z.string(),
        referenceSetId: z.string().optional(),
        recommendationSetId: z.string().optional(),
        creativeBriefId: z.string().optional(),
        title: z.string().optional(),
        concept: z.string().optional(),
        corePromise: z.string().optional(),
        format: z.string().optional(),
        targetAudience: z.string().optional(),
        targetDuration: z.number().optional(),
        hookStrategy: z.string().optional(),
        narrativeStrategy: z.string().optional(),
        pacingStrategy: z.string().optional(),
        visualStrategy: z.string().optional(),
        narrationStrategy: z.string().optional(),
        tone: z.string().optional(),
        emotionalArc: z.string().optional(),
        recommendationDecisions: z.array(recommendationDecisionInput).optional(),
        constraints: z.array(z.string()).optional(),
        exclusions: z.array(z.string()).optional(),
        openQuestions: z.array(z.string()).optional(),
        visualDirection: z.string().optional(),
        structuralDirection: structuralDirectionInput.optional(),
        continuityRequirements: z.array(continuityRequirementInput).optional(),
      },
    },
    async ({ projectId, ...input }) => {
      requireProject(projectId);
      return jsonResult(creativeBlueprintService.buildCreativeBlueprintDraft(projectId, input));
    }
  );

  server.registerTool(
    'edit_creative_blueprint_draft',
    {
      title: 'Edit a DRAFT or PENDING_REVIEW CreativeBlueprint\'s content',
      description:
        'Calls editCreativeBlueprintDraft() verbatim — only ever operates on a DRAFT/PENDING_REVIEW record (an ' +
        'APPROVED Blueprint\'s content is immutable). Recomputes diagnostics fresh against the edited content; this ' +
        'is the real repair path for a Blueprint a pre-production gate marked REVISE.',
      inputSchema: {
        projectId: z.string(),
        blueprintId: z.string(),
        title: z.string().optional(),
        concept: z.string().optional(),
        corePromise: z.string().optional(),
        format: z.string().optional(),
        targetAudience: z.string().optional(),
        targetDuration: z.number().optional(),
        hookStrategy: z.string().optional(),
        narrativeStrategy: z.string().optional(),
        pacingStrategy: z.string().optional(),
        visualStrategy: z.string().optional(),
        narrationStrategy: z.string().optional(),
        tone: z.string().optional(),
        emotionalArc: z.string().optional(),
        recommendationDecisions: z.array(recommendationDecisionInput).optional(),
        constraints: z.array(z.string()).optional(),
        exclusions: z.array(z.string()).optional(),
        openQuestions: z.array(z.string()).optional(),
        visualDirection: z.string().optional(),
        structuralDirection: structuralDirectionInput.optional(),
        continuityRequirements: z.array(continuityRequirementInput).optional(),
      },
    },
    async ({ projectId, blueprintId, ...edits }) => {
      requireProject(projectId);
      const result = creativeBlueprintService.editCreativeBlueprintDraft(projectId, blueprintId, edits);
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'submit_creative_blueprint_for_review',
    {
      title: 'Submit a DRAFT CreativeBlueprint for human review',
      description: 'Soft transition DRAFT -> PENDING_REVIEW. Never blocked by missing/incomplete fields — only APPROVE is a hard gate.',
      inputSchema: { projectId: z.string(), blueprintId: z.string(), submittedBy: z.string().optional() },
    },
    async ({ projectId, blueprintId, submittedBy }) => {
      requireProject(projectId);
      const result = creativeBlueprintService.submitCreativeBlueprintForReview(projectId, blueprintId, { submittedBy });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'review_creative_blueprint',
    {
      title: 'Record a human APPROVE/REJECT/REQUEST_REVISION decision on a CreativeBlueprint',
      description:
        'Calls reviewCreativeBlueprint() verbatim — the ONLY function that can ever move a Blueprint to APPROVED, ' +
        'and it always requires this explicit human decision. APPROVE is blocked if any structural blocker remains ' +
        'unresolved, even for a human. REQUEST_REVISION creates a brand-new DRAFT revision and marks the current ' +
        'version SUPERSEDED — its content is never overwritten in place. REJECTED is terminal.',
      inputSchema: {
        projectId: z.string(),
        blueprintId: z.string(),
        decision: z.enum(CREATIVE_BLUEPRINT_REVIEW_DECISIONS),
        reviewedBy: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async ({ projectId, blueprintId, decision, reviewedBy, note }) => {
      requireProject(projectId);
      const result = creativeBlueprintService.reviewCreativeBlueprint(projectId, blueprintId, { decision, reviewedBy, note });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'get_creative_blueprint',
    {
      title: 'Get one CreativeBlueprint by id',
      description: 'Read-only. Returns the full stored record, including diagnostics/reviews/provenance.',
      inputSchema: { projectId: z.string(), blueprintId: z.string() },
    },
    async ({ projectId, blueprintId }) => {
      requireProject(projectId);
      const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId);
      if (!blueprint) throw new Error(`No CreativeBlueprint found with id "${blueprintId}" in project "${projectId}"`);
      return jsonResult(blueprint);
    }
  );

  server.registerTool(
    'list_creative_blueprints',
    {
      title: 'List every CreativeBlueprint for a project',
      description: 'Read-only. Every draft/revision/review-decision ever made is kept — nothing here is ever deleted.',
      inputSchema: { projectId: z.string(), referenceSetId: z.string().optional() },
    },
    async ({ projectId, referenceSetId }) => {
      requireProject(projectId);
      return jsonResult(creativeBlueprintStore.listCreativeBlueprints(projectId, { referenceSetId }));
    }
  );
}

module.exports = register;
