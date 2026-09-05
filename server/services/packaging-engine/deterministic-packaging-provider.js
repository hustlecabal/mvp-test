// deterministic-packaging-provider.js
//
// PHASE 1 EDITORIAL SPINE, Part 3 — the default, always-available
// PackagingProvider. Free and offline, same discipline as idea-engine/
// deterministic-idea-provider.js: recombines the selected Idea's OWN
// already-supplied topic/premise through a small, fixed set of "package
// shapes" (title framing + thumbnail concept + curiosity mechanism),
// never inventing a new factual claim about the idea itself. A starting
// point for candidate generation, not a claim of creative quality — see
// idea-engine/deterministic-idea-provider.js's identical honesty note.

function capitalize(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const PACKAGE_SHAPES = [
  {
    key: 'QUESTION_TITLE',
    buildTitle: (idea) => `Why ${idea.topic}?`,
    buildThumbnailConcept: (idea) => `A single bold visual for "${idea.topic}" with a visible question/contradiction cue`,
    buildCuriosityMechanism: () => 'Opens on the unanswered question in the title itself, withheld until the reveal beat.',
    buildSpecificity: (idea) => `Names the exact topic ("${idea.topic}") rather than a vague category.`,
    buildNovelty: () => 'Framed as a direct question rather than a flat statement.',
    buildStakes: () => 'The viewer keeps an unresolved assumption if they skip this.',
  },
  {
    key: 'CONTRADICTION_TITLE',
    buildTitle: (idea) => `The Truth About ${idea.topic}`,
    buildThumbnailConcept: (idea) => `Split-frame visual contrasting the common assumption against "${idea.topic}"'s real mechanism`,
    buildCuriosityMechanism: () => 'Sets up the expected answer, then contradicts it.',
    buildSpecificity: (idea) => `Grounded in the idea's own stated premise: "${idea.premise}".`,
    buildNovelty: () => 'Leads with contradiction rather than agreement, which most coverage of a topic defaults to.',
    buildStakes: () => 'Names a real cost of believing the common (wrong) version.',
  },
  {
    key: 'DIRECT_PROMISE_TITLE',
    buildTitle: (idea) => capitalize(idea.topic),
    buildThumbnailConcept: () => 'A single concrete image representing the promise itself, no text overlay needed',
    buildCuriosityMechanism: () => 'States the promise directly and lets specificity itself be the hook.',
    buildSpecificity: (idea) => `Title is the topic itself ("${idea.topic}"), stated plainly.`,
    buildNovelty: () => 'Deliberately avoids a question/contradiction hook in favor of directness.',
    buildStakes: () => 'Lowest-risk framing — relies on the promise being concrete enough to carry interest alone.',
  },
];

function createDeterministicPackagingProvider() {
  async function generatePackageCandidates(input = {}) {
    const { idea, candidateCount = 3 } = input;
    if (!idea) {
      return { status: 'FAILED', candidates: [], diagnostics: [{ code: 'MISSING_IDEA', message: 'a selected Idea is required to generate package candidates' }] };
    }
    const count = Math.max(1, Math.min(candidateCount, PACKAGE_SHAPES.length));
    const candidates = PACKAGE_SHAPES.slice(0, count).map((shape) => ({
      title: shape.buildTitle(idea),
      thumbnailConcept: shape.buildThumbnailConcept(idea),
      promise: idea.premise,
      curiosityMechanism: shape.buildCuriosityMechanism(idea),
      specificity: shape.buildSpecificity(idea),
      novelty: shape.buildNovelty(idea),
      stakes: shape.buildStakes(idea),
      packageRationale: `Generated via the ${shape.key} package shape from Idea "${idea.ideaId}".`,
    }));
    return { status: 'COMPLETED', candidates, diagnostics: [] };
  }
  return { generatePackageCandidates };
}

module.exports = { PACKAGE_SHAPES, createDeterministicPackagingProvider };
