// keyframe-execution-bridge-service.js
//
// Stage 13C — the investigation's only real deliverable code. Two
// functions:
//
//   prepareKeyframeExecution()   — read-only. Never executes anything.
//                                  Assembles everything Claude Code (or a
//                                  human) needs to actually run a skill's
//                                  prompt today: the keyframe, its current
//                                  prompt package, the recommended skill,
//                                  resolved reference assets,
//                                  plain-language execution instructions,
//                                  and a safety verdict.
//
//   runFixtureKeyframeExecution() — proves the rest of the pipeline
//                                  (package -> execution -> asset ->
//                                  archive -> lineage) using the SAME
//                                  safety-gated path Stage 13B already
//                                  built and tested
//                                  (services/keyframe-generation-service.js's
//                                  generateKeyframe(), pinned to the
//                                  'fake-image' provider) — never a
//                                  second, parallel pipeline. See
//                                  docs/architecture/keyframe-execution-bridge.md
//                                  Part 6 for why.
//
// NEITHER function calls a real provider, a real skill, or the network.
// Both return BLOCKED (never execute) if the keyframe isn't eligible per
// the exact same checks Stage 13B enforces — see Part 8 of the doc.
//
// Stage 13E, Part 3 — CLASSIFICATION: INTERNAL TEST/DEVELOPMENT ONLY.
// services/keyframe-handoff-service.js (Stage 13D) is the real production
// path for getting a keyframe image today. This file has zero consumers
// outside its own MCP tools (mcp/tools/keyframe-execution-tools.js) and
// its own test files — verified by repo-wide grep for this stage. It is
// never called by frontend/app.js, index.js, or any other service, and
// must never be presented to a user as a real generation option. Kept
// because the existing automated tests (test/keyframe-execution-bridge-
// service.test.js, test/keyframe-execution-mcp.test.js) depend on it.

const projectStore = require('./project-store');
const keyframeStore = require('./keyframe-store');
const keyframePromptService = require('./keyframe-prompt-service');
const keyframeGenerationApprovalStore = require('./keyframe-generation-approval-store');
const keyframeGenerationService = require('./keyframe-generation-service');
const skillOrchestrator = require('./skill-orchestrator');
const { createKeyframeExecutionResult } = require('../schemas/keyframe-execution-result-schema');

// Plain-language, deterministic instructions describing what a human
// would need to do TODAY (Part 1/2 of the doc: no installed skill can be
// invoked programmatically) — never a claim that Claude Code or Node can
// run this automatically.
function buildExecutionInstructions(pkg, recommendedSkill) {
  if (!pkg) {
    return 'No prompt package has been built for this keyframe yet. Build one first (build_keyframe_prompt_package) before preparing execution.';
  }
  const skillName = recommendedSkill ? recommendedSkill.name : pkg.recommendedSkill || 'the recommended skill';
  const refCount = (pkg.existingReferenceAssets || []).length;
  return (
    `No installed skill can be executed programmatically today (see docs/architecture/keyframe-execution-bridge.md, Part 1/2). ` +
    `A human must: 1) open Higgsfield, 2) follow ${skillName}'s own prompt-writing workflow using this package's ` +
    `structured fields (identityLock/wardrobeLock/environmentLock/composition/camera/lighting), 3) upload the ` +
    `${refCount} resolved reference asset(s) listed on this package into Higgsfield's UI in order, 4) run the ` +
    `resulting prompt, 5) download the produced image. This backend has no automated way to receive that file yet — ` +
    `see run_fixture_keyframe_execution for a local, deterministic proof of the archive/lineage steps that would follow.`
  );
}

// Part 7 — read-only preparation. Returns null only if the project or
// keyframe itself doesn't exist; otherwise always returns a payload, even
// when unsafe to execute (the `safety` field says why).
function prepareKeyframeExecution(projectId, keyframeId) {
  if (!projectStore.getProject(projectId)) return null;
  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) return null;

  const pkg = keyframePromptService.getKeyframePromptPackage(projectId, keyframeId);
  const approval = keyframeGenerationApprovalStore.getApproval(projectId, keyframeId);
  // Part 8 — reuses Stage 13B's exact eligibility check (approval, package
  // currency, budget, unknown-cost policy). Never reimplemented here.
  const safety = keyframeGenerationService.canGenerateKeyframe(projectId, keyframeId);
  const recommendedSkill = pkg ? skillOrchestrator.getSkill(pkg.recommendedSkill) : null;

  return {
    projectId,
    keyframeId,
    keyframe,
    promptPackage: pkg,
    approval,
    recommendedSkill,
    referenceAssets: pkg ? pkg.existingReferenceAssets : [],
    executionInstructions: buildExecutionInstructions(pkg, recommendedSkill),
    safety,
  };
}

// Part 6 — the fixture proof. Delegates entirely to
// keyframeGenerationService.generateKeyframe() with the fake-image
// provider (Stage 13B) so approval/staleness/budget/duplicate-protection
// are enforced identically, then translates whatever comes back into the
// Part 5 KeyframeExecutionResult shape. Never invents a field the
// underlying result didn't actually provide (no artifactUrl — this is a
// LOCAL fixture, there is no remote URL to report).
async function runFixtureKeyframeExecution(projectId, keyframeId, options = {}) {
  const pkg = keyframePromptService.getKeyframePromptPackage(projectId, keyframeId);
  const skillId = pkg ? pkg.recommendedSkill : null;

  const result = await keyframeGenerationService.generateKeyframe(projectId, keyframeId, {
    ...options,
    providerName: 'fake-image',
  });

  if (!result.ok) {
    if (result.job) {
      // Attempted (passed every safety check, reached the fake provider)
      // but did not complete successfully.
      return createKeyframeExecutionResult({
        keyframeId,
        packageId: result.job.keyframePromptPackageId,
        packageVersion: result.job.keyframePromptPackageVersion,
        status: 'FAILED',
        provider: result.job.provider,
        model: result.job.model,
        skillId,
        metadata: { generationId: result.job.id },
        warnings: [result.reason],
      });
    }
    // Never reached a provider at all — a safety check stopped it.
    return createKeyframeExecutionResult({
      keyframeId,
      packageId: pkg ? pkg.packageId : null,
      packageVersion: pkg ? pkg.version : null,
      status: 'BLOCKED',
      skillId,
      warnings: [result.reason],
    });
  }

  if (result.job.status !== 'COMPLETED') {
    // An identical execution was already in flight (Stage 13B, Part 7) —
    // this is a snapshot of that job, not a fresh completion.
    return createKeyframeExecutionResult({
      keyframeId,
      packageId: result.job.keyframePromptPackageId,
      packageVersion: result.job.keyframePromptPackageVersion,
      status: 'IN_PROGRESS',
      provider: result.job.provider,
      model: result.job.model,
      skillId,
      metadata: { generationId: result.job.id, deduplicated: Boolean(result.deduplicated) },
    });
  }

  return createKeyframeExecutionResult({
    keyframeId,
    packageId: result.job.keyframePromptPackageId,
    packageVersion: result.job.keyframePromptPackageVersion,
    status: 'COMPLETED',
    provider: result.job.provider,
    model: result.job.model,
    skillId,
    artifactType: 'image',
    artifactPath: result.asset && result.asset.storage ? result.asset.storage.path : null,
    artifactUrl: null, // local fixture only — never an invented remote URL
    metadata: {
      generationId: result.job.id,
      assetId: result.asset ? result.asset.assetId : null,
      deduplicated: Boolean(result.deduplicated),
    },
  });
}

module.exports = {
  prepareKeyframeExecution,
  runFixtureKeyframeExecution,
};
