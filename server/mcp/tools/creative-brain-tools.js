// creative-brain-tools.js — CREATIVE BRAIN. Thin MCP wrappers over the
// existing, unmodified services/creative-brain-service.js (Part 20's own
// "ONE operator entry point" discipline, mirrored from the Intelligence
// Orchestrator stage: MCP and REST must call the SAME orchestrator
// function, never a separate path). Nothing here decides an angle,
// evaluates a candidate, or approves spend — every one of those decisions
// is made by the existing service functions this file only calls.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const creativeBrainService = require('../../services/creative-brain-service');
const creativeBrainApprovalStore = require('../../services/creative-brain-approval-store');
const humanVoiceAcquisitionService = require('../../services/human-voice-acquisition-service');
const humanVoiceProfileService = require('../../services/human-voice-profile-service');
const humanVoiceProfileStore = require('../../services/human-voice-profile-store');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function register(server) {
  server.registerTool(
    'generate_creative_blueprint',
    {
      title: 'Generate a CreativeBlueprint via the Creative Brain (ONE entry point)',
      description:
        'Calls services/creative-brain-service.js\'s generateCreativeBlueprint() verbatim — the ONE Creative Brain entry ' +
        'point. Takes a real, already-persisted RecommendationSet (+ optional HumanVoiceProfile) and a topic, generates 3 ' +
        'evidence-grounded creative angle candidates, evaluates each independently, and persists ONE real CreativeBlueprint ' +
        'via the existing, unmodified buildCreativeBlueprintDraft(). Requires human approval (see request_creative_brain_approval) ' +
        'before any LLM spend occurs. If every candidate fails evaluation, the strongest is still persisted, carrying blocking ' +
        'diagnostics that the EXISTING review gate already enforces — never silently discarded, never auto-approved.',
      inputSchema: {
        projectId: z.string(),
        referenceSetId: z.string().optional(),
        recommendationSetId: z.string().optional(),
        humanVoiceProfileId: z.string().optional(),
        topic: z.string(),
        format: z.string().optional(),
        targetDuration: z.number().optional(),
        candidateCount: z.number().optional(),
        requestedBy: z.string().optional(),
      },
    },
    async ({ projectId, ...options }) => {
      requireProject(projectId);
      return jsonResult(await creativeBrainService.generateCreativeBlueprint(projectId, options));
    }
  );

  server.registerTool(
    'get_creative_brain_approval_status',
    {
      title: 'Get the current CreativeBrainApproval status for a RecommendationSet',
      description: 'Read-only lookup of services/creative-brain-approval-store.js\'s current approval record — never decides anything.',
      inputSchema: { projectId: z.string(), recommendationSetId: z.string() },
    },
    async ({ projectId, recommendationSetId }) => {
      requireProject(projectId);
      return jsonResult(creativeBrainApprovalStore.getApproval(projectId, recommendationSetId));
    }
  );

  server.registerTool(
    'decide_creative_brain_approval',
    {
      title: 'Human decision on a pending CreativeBrainApproval',
      description: 'Calls services/creative-brain-approval-store.js\'s decideApproval() verbatim — the ONLY way a Creative Brain generation attempt becomes authorized to spend. Never auto-approved by any other path.',
      inputSchema: { projectId: z.string(), recommendationSetId: z.string(), approve: z.boolean(), decidedBy: z.string().optional(), reason: z.string().optional() },
    },
    async ({ projectId, recommendationSetId, approve, decidedBy, reason }) => {
      requireProject(projectId);
      return jsonResult(creativeBrainApprovalStore.decideApproval(projectId, recommendationSetId, { approve, decidedBy, reason }));
    }
  );

  server.registerTool(
    'acknowledge_creative_brain_unknown_cost',
    {
      title: 'Acknowledge the unknown-cost policy for a CreativeBrainApproval',
      description: 'Calls services/creative-brain-approval-store.js\'s acknowledgeUnknownCost() verbatim — required before generation can proceed, per the same UNKNOWN_COST_POLICY services/approval-gate.js already enforces everywhere else.',
      inputSchema: { projectId: z.string(), recommendationSetId: z.string(), acknowledgedBy: z.string().optional() },
    },
    async ({ projectId, recommendationSetId, acknowledgedBy }) => {
      requireProject(projectId);
      return jsonResult(creativeBrainApprovalStore.acknowledgeUnknownCost(projectId, recommendationSetId, { acknowledgedBy }));
    }
  );

  server.registerTool(
    'generate_human_voice_profile',
    {
      title: 'Acquire a real public-discussion corpus and build a HumanVoiceProfile',
      description:
        'Calls services/human-voice-acquisition-service.js (real Apify-backed Reddit acquisition, cost-gated against the project\'s ' +
        'existing apify USD bucket) then services/human-voice-profile-service.js\'s buildHumanVoiceProfile() to derive aggregate, ' +
        'evidence-linked patterns — never a raw dump of posts. Persists via services/human-voice-profile-store.js.',
      inputSchema: { projectId: z.string(), topic: z.string(), platform: z.string().optional() },
    },
    async ({ projectId, topic, platform }) => {
      requireProject(projectId);
      const acquisition = await humanVoiceAcquisitionService.acquireHumanVoiceCorpus(projectId, { topic, platform });
      if (acquisition.status !== 'COMPLETED') return jsonResult({ ok: false, code: 'ACQUISITION_FAILED', acquisition });
      const profile = humanVoiceProfileService.buildHumanVoiceProfile(projectId, { topic, platform: platform || 'REDDIT', items: acquisition.items });
      const saved = humanVoiceProfileStore.addHumanVoiceProfile(projectId, profile);
      return jsonResult(saved.ok ? { ok: true, profile: saved.profile } : { ok: false, reason: saved.reason });
    }
  );

  server.registerTool(
    'list_human_voice_profiles',
    {
      title: 'List HumanVoiceProfiles for a project',
      description: 'Read-only lookup of services/human-voice-profile-store.js\'s listHumanVoiceProfiles().',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(humanVoiceProfileStore.listHumanVoiceProfiles(projectId));
    }
  );

  server.registerTool(
    'get_human_voice_profile',
    {
      title: 'Get one HumanVoiceProfile',
      description: 'Read-only lookup of services/human-voice-profile-store.js\'s getHumanVoiceProfile().',
      inputSchema: { projectId: z.string(), profileId: z.string() },
    },
    async ({ projectId, profileId }) => {
      requireProject(projectId);
      return jsonResult(humanVoiceProfileStore.getHumanVoiceProfile(projectId, profileId));
    }
  );
}

module.exports = register;
