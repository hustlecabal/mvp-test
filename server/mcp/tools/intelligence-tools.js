// intelligence-tools.js — P0-INTEL. Thin MCP wrappers over the existing,
// unmodified services/intelligence-orchestrator-service.js.
//
// Same discipline as production-tools.js's own header: nothing here
// decides anything the orchestrator/its specialist services don't
// already decide — this file only calls startIntelligenceRunAsync()/
// getIntelligenceStatus() and formats the result.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const intelligenceOrchestrator = require('../../services/intelligence-orchestrator-service');
const intelligenceRunStore = require('../../services/intelligence-run-store');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function register(server) {
  server.registerTool(
    'start_intelligence',
    {
      title: 'Start (or resume) an autonomous intelligence run analysing a set of reference videos',
      description:
        'Calls intelligence-orchestrator-service.js\'s startIntelligenceRunAsync() — the single operator entry point ' +
        'driving Reference Video ingestion -> Measurement -> Observation -> (optional) Interpretation -> cross-video ' +
        'Pattern extraction -> evidence-backed Recommendation generation, through the existing, unmodified INT-1A-F ' +
        'specialist services only. Requires at least one referenceVideoUrl or an existing referenceSetId — this ' +
        'pipeline analyses real reference videos, never a bare topic string; no automatic video-discovery capability ' +
        'exists in this codebase. interpretationQuestions is optional and opt-in: when given, INT-1D interpretation ' +
        'is attempted per video, but always through its own existing human cost-approval gate — a question awaiting ' +
        'approval never fails the run and is never auto-approved. Cross-video pattern extraction and recommendation ' +
        'generation never depend on interpretation completing (real, current codebase behaviour: patterning/' +
        'recommendation read Measurements/Observations directly, not Interpretations).\n\n' +
        'ASYNCHRONOUS: this tool returns AS SOON AS the run is created (or an existing non-terminal run for this ' +
        'project is found and resumed) — it does NOT wait for the (real network acquisition + ffmpeg, potentially a ' +
        'real LLM call) run to finish. Poll get_intelligence_status with the returned intelligenceRunId until status ' +
        'is COMPLETE or FAILED.',
      inputSchema: {
        projectId: z.string(),
        referenceVideoUrls: z.array(z.string()).optional(),
        referenceSetId: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        interpretationQuestions: z.array(z.string()).optional(),
      },
    },
    async ({ projectId, referenceVideoUrls, referenceSetId, name, description, interpretationQuestions }) => {
      requireProject(projectId);
      const result = intelligenceOrchestrator.startIntelligenceRunAsync(projectId, {
        referenceVideoUrls,
        referenceSetId,
        name,
        description,
        interpretationQuestions,
      });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'get_intelligence_status',
    {
      title: 'Get one IntelligenceRun by id',
      description:
        'Read-only. Returns the full stored IntelligenceRun record — status, failureStage, per-video progress ' +
        '(ingestion/measurement/observation/interpretation ids), the resulting patternSetId and recommendationSetId ' +
        'once COMPLETE, and diagnostics. Calls getIntelligenceStatus() verbatim.',
      inputSchema: { intelligenceRunId: z.string() },
    },
    async ({ intelligenceRunId }) => {
      const result = intelligenceOrchestrator.getIntelligenceStatus(intelligenceRunId);
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result.run);
    }
  );

  server.registerTool(
    'list_intelligence_runs',
    {
      title: 'List every IntelligenceRun for a project',
      description: 'Read-only. Every intelligence run ever started for this project, newest first.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(intelligenceRunStore.listIntelligenceRuns({ projectId }));
    }
  );
}

module.exports = register;
