// visual-world-tools.js — thin MCP wrappers over the existing, unmodified
// services/visual-world-service.js, services/visual-technical-qc-service.js,
// and services/visual-creative-qc-service.js. Nothing here decides
// anything those services don't already decide.

const { z } = require('zod');
const projectStore = require('../../services/project-store');
const creativeStore = require('../../services/creative-store');
const creativeBlueprintStore = require('../../services/creative-blueprint-store');
const keyframeStore = require('../../services/keyframe-store');
const visualWorldService = require('../../services/visual-world-service');
const technicalQc = require('../../services/visual-technical-qc-service');
const creativeQc = require('../../services/visual-creative-qc-service');
const { jsonResult } = require('../lib/respond');

function requireProject(projectId) {
  if (!projectStore.getProject(projectId)) {
    throw new Error(`No project found with id "${projectId}"`);
  }
}

function findShot(projectId, shotId) {
  const storyboard = creativeStore.getStoryboard(projectId);
  if (!storyboard) return null;
  return storyboard.shots.find((s) => s.shotId === shotId) || null;
}

function register(server) {
  server.registerTool(
    'resolve_shot_material_specification',
    {
      title: 'Build the provider-neutral MaterialSpecification for one Storyboard shot',
      description:
        'Calls visual-world-service.js\'s buildMaterialSpecification() — merges CreativeBlueprint.visualSpecification ' +
        'with VisualBible entity descriptions and this shot\'s own (higher-priority) fields into ONE provider-neutral ' +
        'MaterialSpecification. Read-only; does not mutate anything.',
      inputSchema: { projectId: z.string(), shotId: z.string() },
    },
    async ({ projectId, shotId }) => {
      requireProject(projectId);
      const shot = findShot(projectId, shotId);
      if (!shot) return jsonResult({ ok: false, reason: `no shot found with id "${shotId}"` });
      const storyboard = creativeStore.getStoryboard(projectId);
      const blueprint = storyboard.blueprintId ? creativeBlueprintStore.getCreativeBlueprint(projectId, storyboard.blueprintId) : null;
      const visualBible = creativeStore.getVisualBible(projectId);
      const spec = visualWorldService.buildMaterialSpecification(projectId, shot, { blueprint, visualBible });
      return jsonResult({ ok: true, materialSpecification: spec });
    }
  );

  server.registerTool(
    'apply_visual_world_to_keyframe',
    {
      title: 'Populate a Keyframe\'s blank fields from CreativeBlueprint.visualSpecification',
      description:
        'Calls visual-world-service.js\'s populateKeyframeFromMaterialSpecification() for an existing Keyframe, using ' +
        'the MaterialSpecification built for its shot. Fills ONLY currently-blank fields (subject/composition/camera/' +
        'lighting/colour, plus continuity-required character/location/prop reference ids) — never overwrites a field ' +
        'a human already set. The keyframe still needs build_keyframe_prompt_package (unchanged) to become a prompt.',
      inputSchema: { projectId: z.string(), keyframeId: z.string(), updatedBy: z.string().optional() },
    },
    async ({ projectId, keyframeId, updatedBy }) => {
      requireProject(projectId);
      const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
      if (!keyframe) return jsonResult({ ok: false, reason: `no keyframe found with id "${keyframeId}"` });
      const shot = findShot(projectId, keyframe.shotId);
      if (!shot) return jsonResult({ ok: false, reason: `no shot found with id "${keyframe.shotId}" for this keyframe` });
      const storyboard = creativeStore.getStoryboard(projectId);
      const blueprint = storyboard.blueprintId ? creativeBlueprintStore.getCreativeBlueprint(projectId, storyboard.blueprintId) : null;
      const visualBible = creativeStore.getVisualBible(projectId);
      const spec = visualWorldService.buildMaterialSpecification(projectId, shot, { blueprint, visualBible });
      const updated = visualWorldService.populateKeyframeFromMaterialSpecification(projectId, keyframeId, spec, { updatedBy });
      return jsonResult({ ok: true, keyframe: updated });
    }
  );

  server.registerTool(
    'run_visual_technical_qc',
    {
      title: 'Run technical QC (valid, decodable media) on one generated asset',
      description:
        'Calls visual-technical-qc-service.js\'s runTechnicalQc() — ffprobe-based structural validation (dimensions/' +
        'codec/duration where applicable). Never a creative judgment. Opt-in, additive — never wired into the ' +
        'generation services\' own hot path.',
      inputSchema: { projectId: z.string(), assetId: z.string() },
    },
    async ({ projectId, assetId }) => {
      requireProject(projectId);
      return jsonResult(technicalQc.runTechnicalQc(projectId, assetId));
    }
  );

  server.registerTool(
    'run_visual_creative_qc',
    {
      title: 'Run creative QC (treatment adherence, continuity, specificity, originality) on one shot\'s material',
      description:
        'Calls visual-creative-qc-service.js\'s evaluateVisualMaterial() — independent PASS/FAIL/WARN findings per ' +
        'dimension, never a single combined score. executorType and evidenceTexts are optional context that sharpen ' +
        'the treatment-adherence and reference-overfitting checks.',
      inputSchema: { projectId: z.string(), shotId: z.string(), executorType: z.string().optional(), evidenceTexts: z.array(z.string()).optional() },
    },
    async ({ projectId, shotId, executorType, evidenceTexts }) => {
      requireProject(projectId);
      const shot = findShot(projectId, shotId);
      if (!shot) return jsonResult({ ok: false, reason: `no shot found with id "${shotId}"` });
      const storyboard = creativeStore.getStoryboard(projectId);
      const blueprint = storyboard.blueprintId ? creativeBlueprintStore.getCreativeBlueprint(projectId, storyboard.blueprintId) : null;
      const visualBible = creativeStore.getVisualBible(projectId);
      const spec = visualWorldService.buildMaterialSpecification(projectId, shot, { blueprint, visualBible });
      const findings = creativeQc.evaluateVisualMaterial(spec, { executorType, evidenceTexts });
      return jsonResult({ ok: true, findings, hasFailure: creativeQc.hasFailure(findings) });
    }
  );
}

module.exports = register;
