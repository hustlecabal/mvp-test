// pre-production-gate-tools.js — INT-2.5-P0. Thin MCP wrappers over the
// existing, unmodified services/pre-production-gate-service.js and
// services/pre-production-gate-store.js.
//
// Same discipline as creative-blueprint-tools.js: nothing here decides
// PROCEED/REVISE/REJECT, nothing here decides ACCEPT/OVERRIDE, and nothing
// here mutates a CreativeBlueprint or PreProductionGateResult beyond what
// the existing service functions already do. This file only calls them.
//
// evaluate_pre_production_gate derives a BeatGraph from the project's
// CURRENT Storyboard (via the existing, pure beat-graph-derivation-
// service.js) when one exists, so an operator does not have to hand-
// assemble a BeatGraph JSON blob by hand — this is plumbing, not a new
// derivation path: deriveBeatGraph() itself is called completely
// unmodified, with the same storyboard the project already has.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const creativeStore = require('../../services/creative-store');
const preProductionGateService = require('../../services/pre-production-gate-service');
const preProductionGateStore = require('../../services/pre-production-gate-store');
const beatGraphDerivationService = require('../../services/beat-graph-derivation-service');
const { HUMAN_DECISION_VALUES } = require('../../schemas/pre-production-gate-schema');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function register(server) {
  server.registerTool(
    'evaluate_pre_production_gate',
    {
      title: 'Run the pre-production quality gate against an APPROVED CreativeBlueprint',
      description:
        'Calls evaluatePreProductionGate() verbatim — a read-only, deterministic evaluator (no LLM, no numeric score). ' +
        'If the project currently has a Storyboard, this tool derives its BeatGraph via the existing, unmodified ' +
        'deriveBeatGraph() and supplies it, so per-beat production-capability blockers can be detected; with no ' +
        'Storyboard, the gate still runs but BeatGraph-dependent findings are honestly UNKNOWN, never assumed fine. ' +
        'Always produces a NEW PreProductionGateResult record — never overwrites a prior one.',
      inputSchema: { projectId: z.string(), blueprintId: z.string() },
    },
    async ({ projectId, blueprintId }) => {
      requireProject(projectId);
      let beatGraph;
      const storyboard = creativeStore.getStoryboard(projectId);
      if (storyboard && Array.isArray(storyboard.scenes) && storyboard.scenes.length > 0) {
        const derivation = beatGraphDerivationService.deriveBeatGraph(storyboard);
        if ((derivation.status === 'DERIVED' || derivation.status === 'PARTIAL') && derivation.beatGraph) {
          beatGraph = derivation.beatGraph;
        }
      }
      const result = preProductionGateService.evaluatePreProductionGate(projectId, blueprintId, { beatGraph });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'decide_pre_production_gate_result',
    {
      title: 'Record a human ACCEPT/OVERRIDE/REQUEST_REVISION/REJECT decision on a gate result',
      description:
        'Calls decideGateResult() verbatim. ACCEPT/OVERRIDE are blocked once the gate result is stale (the Blueprint ' +
        'changed since this result was computed). OVERRIDE requires a non-empty rationale. REQUEST_REVISION/REJECT ' +
        'delegate to the existing Blueprint review machinery — this tool never implements a second approval system.',
      inputSchema: {
        projectId: z.string(),
        gateResultId: z.string(),
        decision: z.enum(HUMAN_DECISION_VALUES),
        decidedBy: z.string().optional(),
        rationale: z.string().optional(),
      },
    },
    async ({ projectId, gateResultId, decision, decidedBy, rationale }) => {
      requireProject(projectId);
      const result = preProductionGateService.decideGateResult(projectId, gateResultId, { decision, decidedBy, rationale });
      if (!result.ok) throw new Error(result.reason);
      return jsonResult(result);
    }
  );

  server.registerTool(
    'get_pre_production_gate_result',
    {
      title: 'Get one PreProductionGateResult by id',
      description: 'Read-only. Returns the full stored record, including blockers/warnings/information/humanDecisions.',
      inputSchema: { projectId: z.string(), gateResultId: z.string() },
    },
    async ({ projectId, gateResultId }) => {
      requireProject(projectId);
      const gateResult = preProductionGateStore.getGateResult(projectId, gateResultId);
      if (!gateResult) throw new Error(`No PreProductionGateResult found with id "${gateResultId}" in project "${projectId}"`);
      return jsonResult(gateResult);
    }
  );

  server.registerTool(
    'list_pre_production_gate_results',
    {
      title: 'List every PreProductionGateResult for a project',
      description: 'Read-only. Every evaluation ever run is kept — re-running the gate appends a new result, never overwrites a prior one.',
      inputSchema: { projectId: z.string(), blueprintId: z.string().optional() },
    },
    async ({ projectId, blueprintId }) => {
      requireProject(projectId);
      return jsonResult(preProductionGateStore.listGateResults(projectId, { blueprintId }));
    }
  );
}

module.exports = register;
