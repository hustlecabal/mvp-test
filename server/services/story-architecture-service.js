// story-architecture-service.js
//
// STORY ARCHITECTURE ENGINE — the operator entry point. Same GENERATE N ->
// EVALUATE EACH INDEPENDENTLY -> SELECT STRONGEST pattern preserved from
// idea-engine-service.js/packaging-engine-service.js, one layer further
// down the hierarchy: Strategy -> Idea -> Package -> **Story Argument** ->
// Blueprint's Storyboard. Coordination only — no creative reasoning here.
//
// Candidates are generated across shape keys (services/story-architecture/
// story-shapes.js): the caller's requested shape (if any) plus the
// registry default, deduplicated — so an explicit caller choice wins ties
// (fewest-FAIL, first-listed-wins, same rule as every other engine in this
// codebase) while a genuinely broken candidate still loses to a valid one.

const editorialStrategyStore = require('./editorial-strategy-store');
const ideaStore = require('./idea-store');
const packageStore = require('./package-store');
const creativeBlueprintStore = require('./creative-blueprint-store');
const storyArgumentStore = require('./story-argument-store');
const { assertImplementsStoryArchitectureProviderInterface } = require('./story-architecture/story-architecture-provider-interface');
const { createDeterministicStoryArchitectureProvider } = require('./story-architecture/deterministic-story-architecture-provider');
const { evaluateStoryArgument } = require('./story-architecture/story-architecture-evaluator');
const { DEFAULT_SHAPE_KEY } = require('./story-architecture/story-shapes');
const { createStoryArgument } = require('../schemas/story-argument-schema');

const DEFAULT_PROVIDER = createDeterministicStoryArchitectureProvider();

function selectStrongestStoryArgument(candidatesWithResults) {
  let best = candidatesWithResults[0];
  let bestFailCount = best.results.filter((r) => r.result === 'FAIL').length;
  for (const c of candidatesWithResults.slice(1)) {
    const failCount = c.results.filter((r) => r.result === 'FAIL').length;
    if (failCount < bestFailCount) {
      best = c;
      bestFailCount = failCount;
    }
  }
  return { best, allPassed: bestFailCount === 0 };
}

async function generateStoryArgument(projectId, { ideaId, packageId, blueprintId }, options = {}) {
  const ideaLookup = ideaStore.findIdeaCandidate(projectId, ideaId);
  if (!ideaLookup) return { ok: false, code: 'IDEA_NOT_FOUND', reason: `no Idea candidate found with id "${ideaId}"` };
  const packageLookup = packageStore.findPackageCandidate(projectId, packageId);
  if (!packageLookup) return { ok: false, code: 'PACKAGE_NOT_FOUND', reason: `no Package candidate found with id "${packageId}"` };
  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, blueprintId);
  if (!blueprint) return { ok: false, code: 'BLUEPRINT_NOT_FOUND', reason: `no CreativeBlueprint found with id "${blueprintId}"` };
  const strategy = blueprint.strategyId ? editorialStrategyStore.getStrategy(projectId, blueprint.strategyId) : null;

  const provider = options.provider || DEFAULT_PROVIDER;
  assertImplementsStoryArchitectureProviderInterface(provider);

  // Candidate shapes: when the caller explicitly requests one, it runs
  // head-to-head against the registry default (deduplicated) — a
  // genuinely invalid/broken requested shape still cannot win merely by
  // being requested. When the caller does NOT request one (Claude Story
  // Architecture Engine: "make Claude select the appropriate shape...
  // rather than having the demo caller dictate it"), this passes
  // `shape: undefined` through to the provider UNCHANGED — the provider
  // itself decides (the deterministic provider falls back to its own
  // DEFAULT_SHAPE_KEY internally either way; a real reasoning provider is
  // actually free to choose). This never forces a second, wasted
  // generation call in that case — one real candidate, exactly what was
  // asked for.
  const candidateShapeKeys = options.shape ? [...new Set([options.shape, DEFAULT_SHAPE_KEY])] : [undefined];

  const rawCandidates = [];
  for (const shapeKey of candidateShapeKeys) {
    const generated = await provider.generateStoryArgument({ idea: ideaLookup.idea, package: packageLookup.packageCandidate, blueprint, strategy, shape: shapeKey });
    if (generated.status !== 'COMPLETED' || !generated.storyArgument) {
      return { ok: false, code: 'CANDIDATE_GENERATION_FAILED', reason: `Story Argument generation did not complete for shape "${shapeKey}" (status: ${generated.status})`, diagnostics: generated.diagnostics };
    }
    rawCandidates.push(generated.storyArgument);
  }

  const candidatesWithResults = rawCandidates.map((c) => ({ candidate: c, results: evaluateStoryArgument(c) }));
  const { best, allPassed } = selectStrongestStoryArgument(candidatesWithResults);

  const candidates = candidatesWithResults.map(({ candidate, results }) =>
    createStoryArgument({
      ...candidate,
      projectId,
      blueprintId,
      ideaId,
      packageId,
      selected: candidate === best.candidate,
      evaluationResults: results,
      status: 'EVALUATED',
    })
  );
  const selectedArgument = candidates.find((c) => c.selected);
  selectedArgument.status = 'SELECTED';

  const saved = storyArgumentStore.addStoryArgumentSet(projectId, {
    projectId,
    blueprintId,
    candidates,
    selectedStoryArgumentId: selectedArgument.id,
    status: 'SELECTED',
  });
  if (!saved.ok) return { ok: false, code: 'PERSIST_FAILED', reason: saved.reason };

  return {
    ok: true,
    storyArgumentSet: saved.storyArgumentSet,
    selectedStoryArgument: saved.storyArgumentSet.candidates.find((c) => c.selected),
    allCandidatesPassed: allPassed,
  };
}

module.exports = { generateStoryArgument, selectStrongestStoryArgument };
