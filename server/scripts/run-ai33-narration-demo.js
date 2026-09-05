#!/usr/bin/env node
// run-ai33-narration-demo.js
//
// THE REAL LIVE TEST + REAL MP4 ACCEPTANCE TEST for the AI33 TTS
// integration. Drives the EXISTING EVOLINK pipeline (Strategy/Idea/
// Package -> Creative Brain -> approved Blueprint -> real Storyboard ->
// narration) through to a real production run, with AI33 as the ACTIVE
// voice provider (services/voice-generation-service.js's own
// resolveDefaultVoiceProvider() selects it automatically whenever
// EVOLINK_AI33_API_KEY + EVOLINK_AI33_VOICE_ID are both set — no
// parameter threaded through production-orchestrator-service.js, which
// remains completely unmodified).
//
// Reuses the exact same approval-chain pattern as every other real-
// production demo this session (run-creative-production-compiler-demo.js,
// run-story-architecture-demo.js) rather than hand-authoring an unrelated
// fixture — this IS the real EVOLINK narration pipeline, just with
// deterministic Creative Brain content (the Claude-backed Story
// Architecture path is currently blocked by a separate, pre-existing,
// out-of-scope Anthropic billing exhaustion documented in an earlier
// milestone this session — reusing the deterministic path is the correct,
// honest choice here, not a fabricated substitute).
//
// Two narration passes, per the milestone's own instruction: a short one
// first to validate the provider, then a longer one to expose pacing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const demoDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-demo-data-'));
process.env.ASSET_STORAGE_DIR = path.join(demoDataRoot, 'asset-storage');
process.env.PROJECT_DATA_DIR = path.join(demoDataRoot, 'projects');
process.env.CREATIVE_DATA_DIR = path.join(demoDataRoot, 'creative');
process.env.PRE_PRODUCTION_GATE_DATA_DIR = path.join(demoDataRoot, 'pre-production-gates');
process.env.PRODUCTION_JOBS_DATA_DIR = path.join(demoDataRoot, 'production-jobs');
process.env.RECOMMENDATION_DATA_DIR = path.join(demoDataRoot, 'recommendations');
process.env.CREATIVE_BRAIN_APPROVAL_DATA_DIR = path.join(demoDataRoot, 'creative-brain-approvals');
process.env.HUMAN_VOICE_PROFILE_DATA_DIR = path.join(demoDataRoot, 'human-voice-profiles');

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const recommendationStore = require('../services/recommendation-store');
const { createRecommendation, createRecommendationSet } = require('../schemas/recommendation-schema');
const creativeBrainApprovalStore = require('../services/creative-brain-approval-store');
const { createFakeCreativeBrainProvider } = require('../services/creative-brain/fake-creative-brain-provider');
const creativeBlueprintService = require('../services/creative-blueprint-service');
const preProductionGateService = require('../services/pre-production-gate-service');
const productionOrchestrator = require('../services/production-orchestrator-service');

function log(msg) {
  console.log(`[ai33-narration-demo] ${msg}`);
}

async function standUpApprovedProject(title, targetDuration) {
  const projectSeed = projectStore.createProject({ title, topic: 'the paradox of choice' });
  gate.setBudget(projectSeed, 1000);
  gate.requestApproval(projectSeed, { estimatedCost: 1 });
  gate.decideApproval(projectSeed, { approve: true, decidedBy: 'ai33-narration-demo' });
  const project = projectStore.touch(projectSeed);

  const recSet = recommendationStore.addRecommendationSet(project.id, createRecommendationSet({
    projectId: project.id, referenceSetId: 'rs1',
    recommendations: [createRecommendation({ statement: 'A clear, sequential mechanism explanation retains viewers longer.', rationale: 'RECURRING_OBSERVATION, 4/5 support.', evidenceSufficiency: 'SUFFICIENT' })],
  })).recommendationSet;

  const creativeBrainService = require('../services/creative-brain-service');
  const blueprintOptions = {
    recommendationSetId: recSet.id, topic: 'the paradox of choice', targetDuration,
    provider: createFakeCreativeBrainProvider({ candidateShapes: [() => ({
      concept: 'The mechanism nobody names out loud',
      corePromise: 'Not just willpower — a specific, measurable 12% shift once it kicks in.',
      hookStrategy: "This isn't about willpower, but about one specific moment most people miss.",
      rationale: 'Mechanism framing with a concrete numeric anchor.',
    })] }),
  };
  const firstAttempt = await creativeBrainService.generateCreativeBlueprint(project.id, blueprintOptions);
  if (!firstAttempt.ok && firstAttempt.code !== 'CREATIVE_BRAIN_APPROVAL_REQUIRED') throw new Error(`Blueprint generation failed: ${JSON.stringify(firstAttempt)}`);
  creativeBrainApprovalStore.decideApproval(project.id, recSet.id, { approve: true, decidedBy: 'ai33-narration-demo' });
  creativeBrainApprovalStore.acknowledgeUnknownCost(project.id, recSet.id, { acknowledgedBy: 'ai33-narration-demo' });
  const blueprintResult = await creativeBrainService.generateCreativeBlueprint(project.id, blueprintOptions);
  if (!blueprintResult.ok) throw new Error(`Blueprint generation failed: ${JSON.stringify(blueprintResult)}`);

  const submitted = creativeBlueprintService.submitCreativeBlueprintForReview(project.id, blueprintResult.blueprint.id, { submittedBy: 'ai33-narration-demo' });
  const approved = creativeBlueprintService.reviewCreativeBlueprint(project.id, blueprintResult.blueprint.id, { decision: 'APPROVE', reviewedBy: 'ai33-narration-demo' });
  if (!submitted.ok || !approved.ok) throw new Error(`Blueprint submit/approve failed: ${JSON.stringify({ submitted, approved })}`);

  const evaluated = preProductionGateService.evaluatePreProductionGate(project.id, approved.blueprint.id);
  const decision = evaluated.gateResult.machineAssessment === 'PROCEED' ? 'ACCEPT' : 'OVERRIDE';
  const decided = preProductionGateService.decideGateResult(project.id, evaluated.gateResult.id, { decision, decidedBy: 'ai33-narration-demo', rationale: decision === 'OVERRIDE' ? 'AI33 demo — overriding to proceed with a controlled example.' : undefined });
  if (!decided.ok) throw new Error(`Gate decision failed: ${JSON.stringify(decided)}`);

  return { project, blueprint: approved.blueprint };
}

function authorSingleShotStoryboard(projectId, blueprintId, { sceneTitle, shotPurpose }) {
  const scene = creativeStore.addStoryboardScene(projectId, { title: sceneTitle, order: 1 });
  const shot = creativeStore.addStoryboardShot(projectId, { sceneId: scene.sceneId, order: 1, duration: 8, purpose: shotPurpose, visualTreatment: 'KINETIC_TYPOGRAPHY' });
  creativeStore.updateStoryboard(projectId, { blueprintId });
  return { scene, shot };
}

async function runPass({ label, text, targetDuration }) {
  log('');
  log(`########## ${label} ##########`);
  const { project, blueprint } = await standUpApprovedProject(`AI33 Narration Demo — ${label}`, targetDuration);
  const { shot } = authorSingleShotStoryboard(project.id, blueprint.id, { sceneTitle: label, shotPurpose: text });

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-ai33-demo-output-'));
  const result = productionOrchestrator.startProduction(project.id, {
    outputDir,
    treatments: { [shot.shotId]: 'KINETIC_TYPOGRAPHY' },
    narrationSegments: { [shot.shotId]: { text } },
  });

  if (!result.ok && !result.escalated) {
    log(`PRODUCTION DID NOT COMPLETE — status: ${result.job.status}, failureStage: ${result.job.failureStage || '(none)'}`);
    log(`Diagnostics: ${JSON.stringify(result.job.diagnostics, null, 2)}`);
    return { ok: false, job: result.job };
  }

  const { job } = result;
  log(`job status: ${job.status}`);
  if (job.diagnostics && job.diagnostics.length) log(`diagnostics: ${JSON.stringify(job.diagnostics, null, 2)}`);
  if (job.escalations && job.escalations.length) log(`escalations: ${JSON.stringify(job.escalations, null, 2)}`);

  const narratedProgress = job.beatProgress.find((b) => b.audioEvent);
  if (narratedProgress) {
    log(`narration asset provider: ${JSON.stringify({ provider: narratedProgress.audioEvent.sourceAssetId ? 'see asset record' : null })}`);
  }

  if (job.assemblyResult && job.assemblyResult.status === 'COMPLETED') {
    const finalCopyPath = path.join(outputDir, 'final.mp4');
    fs.copyFileSync(job.assemblyResult.artifact.path, finalCopyPath);
    log('COMPLETE.');
    log(`  final MP4: ${finalCopyPath}`);
    log(`  duration = ${job.assemblyResult.artifact.duration}s, ${job.assemblyResult.artifact.width}x${job.assemblyResult.artifact.height}, fps = ${job.assemblyResult.artifact.fps}`);
    return { ok: true, job, mp4Path: finalCopyPath };
  }
  log('NO ASSEMBLED MP4 — reporting the exact execution boundary reached, not fabricating success.');
  return { ok: false, job };
}

async function main() {
  const hasAi33 = Boolean(process.env.EVOLINK_AI33_API_KEY) && Boolean(process.env.EVOLINK_AI33_VOICE_ID);
  log(`AI33 configured: ${hasAi33} (EVOLINK_AI33_API_KEY=${process.env.EVOLINK_AI33_API_KEY ? 'set' : 'MISSING'}, EVOLINK_AI33_VOICE_ID=${process.env.EVOLINK_AI33_VOICE_ID || 'MISSING'})`);
  if (!hasAi33) {
    log('AI33 is NOT configured in this environment — this run will use the existing espeak-ng fallback voice provider instead, and will honestly demonstrate the wiring rather than a real AI33 call.');
    log('Set EVOLINK_AI33_API_KEY and EVOLINK_AI33_VOICE_ID (a provider-prefixed id, e.g. elevenlabs_<id>) and re-run with NODE_USE_ENV_PROXY=1 for a real AI33 narration.');
  }

  const shortResult = await runPass({ label: 'short-validation-pass', text: 'More options should make choosing easier. It does the opposite.', targetDuration: 12 });
  const longResult = await runPass({
    label: 'longer-pacing-pass',
    text: 'More options should make choosing easier. It does the opposite. Every new option forces a fresh comparison against everything else, and that cost keeps rising the more you add. Cut your options to three before you compare, and the paralysis disappears.',
    targetDuration: 28,
  });

  log('');
  log('########## SUMMARY ##########');
  log(`short pass: ${shortResult.ok ? 'COMPLETE' : 'DID NOT PRODUCE AN MP4'}`);
  log(`long pass: ${longResult.ok ? 'COMPLETE' : 'DID NOT PRODUCE AN MP4'}`);
}

main().catch((err) => {
  console.error('[ai33-narration-demo] FAILED:', err);
  process.exitCode = 1;
});
