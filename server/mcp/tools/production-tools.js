// production-tools.js — P0-ORCH-ENTRY. Thin MCP wrappers over the existing,
// unmodified services/production-orchestrator-service.js.
//
// Same discipline as every other *-tools.js file in this directory:
// nothing here decides anything the orchestrator/its specialist services
// don't already decide — this file only calls them and formats the
// result. In particular, start_production never invents an outputDir
// policy: it calls the orchestrator's own defaultOutputDirFor(projectId)
// convenience helper (one subdirectory per project under the standard,
// overridable server/data/production-output/ location), rather than this
// file picking a path itself.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const productionOrchestrator = require('../../services/production-orchestrator-service');
const productionJobStore = require('../../services/production-job-store');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

// A per-beat narration segment, matching beat-graph-derivation-service.js's
// own context.narrationSegments[shotId] shape verbatim (createNarrationSegment).
const narrationSegmentShape = z.object({
  text: z.string(),
  scriptRefId: z.string().optional(),
});

function register(server) {
  server.registerTool(
    'start_production',
    {
      title: 'Start (or resume) autonomous production of one video for a project',
      description:
        'Calls production-orchestrator-service.js\'s startProductionAsync() — the single operator entry point ' +
        'driving Blueprint -> Storyboard -> BeatGraph -> Material Resolution -> Material Execution -> real HyperFrames ' +
        'rendering -> real narration + Whisper alignment -> Timeline Compilation -> real FFmpeg Assembly -> automated ' +
        'QC, through the existing, unmodified specialist services only. Requires the project\'s current Storyboard to ' +
        'already be linked (via blueprintId) to an APPROVED CreativeBlueprint with an ACCEPTED/OVERRIDDEN ' +
        'PreProductionGateResult (control-plane-service.js) — otherwise fails immediately with a structured code, ' +
        'before any production work starts. Never calls a paid provider: a beat needing a not-yet-approved generation ' +
        'is recorded as an escalation (job status ESCALATED) rather than failing the whole run. If a non-terminal ' +
        'ProductionJob already exists for this project, that job is resumed instead of a new one being created.\n\n' +
        'ASYNCHRONOUS: this tool returns AS SOON AS the approval boundary is checked and the job is created — it does ' +
        'NOT wait for the (often multi-minute, real Chrome/FFmpeg/espeak-ng/faster-whisper) production run to finish. ' +
        'Poll get_production_status with the returned productionJobId until status is COMPLETE, FAILED, or ESCALATED.\n\n' +
        'narrationSegments/treatments/narrativeRoles/materialOptions are keyed by shotId (== beatId) and passed ' +
        'straight through, unmodified, to the same explicit-context shape beat-graph-derivation-service.js\'s own ' +
        'deriveBeatGraph() already accepts — this tool never infers narration text, visual treatment, or on-screen ' +
        'content from anything else.',
      inputSchema: {
        projectId: z.string(),
        treatments: z.record(z.string()).optional(),
        narrationSegments: z.record(narrationSegmentShape).optional(),
        narrativeRoles: z.record(z.string()).optional(),
        materialOptions: z.record(z.record(z.any())).optional(),
      },
    },
    async ({ projectId, treatments, narrationSegments, narrativeRoles, materialOptions }) => {
      requireProject(projectId);
      const result = productionOrchestrator.startProductionAsync(projectId, {
        outputDir: productionOrchestrator.defaultOutputDirFor(projectId),
        treatments,
        narrationSegments,
        narrativeRoles,
        materialOptions,
      });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'get_production_status',
    {
      title: 'Get one ProductionJob by id',
      description:
        'Read-only. Returns the full stored ProductionJob record — status, failureStage, per-beat progress, ' +
        'escalations, and (once COMPLETE) the final assembled artifact path. Calls getProductionStatus() verbatim.',
      inputSchema: { productionJobId: z.string() },
    },
    async ({ productionJobId }) => {
      const result = productionOrchestrator.getProductionStatus(productionJobId);
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result.job);
    }
  );

  server.registerTool(
    'list_production_jobs',
    {
      title: 'List every ProductionJob for a project',
      description: 'Read-only. Every production run ever started for this project, newest first.',
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      requireProject(projectId);
      return jsonResult(productionJobStore.listProductionJobs({ projectId }));
    }
  );
}

module.exports = register;
