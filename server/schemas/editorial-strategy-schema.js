// editorial-strategy-schema.js
//
// PHASE 1 EDITORIAL SPINE, Part 1 — the minimum structured strategy
// contract the Idea Engine scores candidate ideas against. This is
// deliberately thin: a channel/content-positioning statement plus enough
// structure to ask "does this idea actually serve the strategy," never a
// full audience-research platform.
//
// CANONICAL LOCATION / WHY THIS IS A NEW RECORD, NOT A REUSE OF AN
// EXISTING ONE (documented per the phase brief's explicit instruction to
// justify this before creating a new structure):
//   - project.audience/project.tone (schemas/production-schema.js, via
//     project-store.js's UPDATABLE_FIELDS) are bare, optional, free-text
//     labels on the Project itself — no positioning/need/promise/avoid
//     structure, and nothing reads them to score anything. EditorialStrategy
//     REUSES these as an optional SEED (see editorial-strategy-store.js's
//     createStrategyFromProject()) rather than duplicating their authority —
//     Project remains the one place a human names "who is this for" in
//     passing; EditorialStrategy is the one place that statement becomes an
//     evaluable contract.
//   - CreativeBrief (schemas/creative-schema.js) is a continuously-editable,
//     unversioned-approval, per-project "what/who/why" free-text document —
//     exactly the same reasoning creative-blueprint-schema.js's own header
//     already gives for why CreativeBlueprint is NOT built on CreativeBrief.
//     EditorialStrategy sits ABOVE Idea generation and needs the same
//     "reusable, scoreable contract" property CreativeBlueprint needed
//     relative to CreativeBrief — so it is a new, dedicated, structured
//     record for the identical reason, not a stylistic preference.
//   - CreativeBlueprint (schemas/creative-blueprint-schema.js) is a
//     PRODUCTION contract for ONE proposed video, downstream of a topic
//     already chosen. EditorialStrategy is UPSTREAM of topic choice
//     entirely (it exists before any Idea is generated) — it is referenced
//     BY a Blueprint (via the new strategyId field), never the other way
//     around.
//
// One project may accumulate multiple EditorialStrategy records over time
// (append-only, mirrors RecommendationSet/PatternSet's own "one record per
// attempt" convention) — editorial-strategy-store.js tracks which one is
// ACTIVE, never overwrites a prior one in place.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const EDITORIAL_STRATEGY_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'];

function createEditorialStrategy(overrides = {}) {
  const { preferredCharacteristics, avoid, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,

    targetAudience: '', // who this channel/video is for
    positioning: '', // how this channel/video positions itself relative to alternatives
    audienceNeed: '', // the concrete problem/desire/curiosity this serves
    contentPromise: '', // what a viewer can expect this channel/content to deliver, in general
    preferredCharacteristics: Array.isArray(preferredCharacteristics) ? [...preferredCharacteristics] : [],
    avoid: Array.isArray(avoid) ? [...avoid] : [], // things the channel should not do/be

    status: 'ACTIVE', // one of EDITORIAL_STRATEGY_STATUSES
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  EDITORIAL_STRATEGY_STATUSES,
  createEditorialStrategy,
};
