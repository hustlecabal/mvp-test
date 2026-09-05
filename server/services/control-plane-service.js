// control-plane-service.js
//
// INT-2.5-P0 — the enforcement point closing the bypass the INT-2.5
// forensic audit found: a project could reach paid production
// (requestGeneration / generateKeyframe / generateVideo) without ever
// having an APPROVED CreativeBlueprint or an ACCEPTED/OVERRIDDEN
// PreProductionGate result, because those two artifacts (INT-2/INT-2.5)
// were fully built and tested but never actually consulted by anything
// outside their own tests.
//
// THIS FILE IS THIN ENFORCEMENT, NOT A NEW BUSINESS LOGIC LAYER:
//   - It never decides whether a Blueprint is good — creative-blueprint-
//     service.js does that (buildCreativeBlueprintDraft/reviewCreativeBlueprint).
//   - It never decides whether the gate should PROCEED — pre-production-
//     gate-service.js does that (evaluatePreProductionGate).
//   - It never recomputes staleness — it calls pre-production-gate-
//     service.js's own isGateResultStale() verbatim.
//   - It never performs financial arithmetic and never calls a provider —
//     confirmed by this file's own require() list below.
//   - It never mutates a CreativeBlueprint, PreProductionGateResult, or
//     Storyboard record — every store call below is a read.
//   - It never silently repairs a missing artifact — every failure path
//     returns a structured { ok:false, code, reason }, never a fabricated
//     pass.
//
// THE ANCHOR: a project's CURRENT Storyboard already carries a validated
// (P0-4A) `blueprintId` — a plain reference to the specific CreativeBlueprint
// that Storyboard was authored against. This file uses that EXISTING field
// as the one source of truth for "which Blueprint governs this project's
// production," rather than inventing a second linkage concept. A
// Storyboard with no blueprintId, or one that no longer resolves, is
// treated identically for every project — see the explicit policy note
// below.
//
// POLICY DECISION (documented here, per this stage's own "stop and
// document before implementing" instruction for legacy/migration
// behavior): a project whose Storyboard has no blueprintId — whether it
// predates this patch or simply never set one — is BLOCKED from paid
// production, with a clear, actionable reason. This is a deliberate
// choice: silently exempting "legacy" projects from this check would BE
// the exact bypass this file exists to close. There is no grandfathering.

const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const creativeBlueprintStore = require('./creative-blueprint-store');
const preProductionGateStore = require('./pre-production-gate-store');
const preProductionGateService = require('./pre-production-gate-service');
// PHASE 1 EDITORIAL SPINE, Part 9 — read-only lookups only, exactly like
// every other store this file already imports. Only ever consulted when a
// caller opts into `{ requireEditorialSpine: true }` (see
// validateProductionPrerequisites below) — every existing caller that
// omits this option gets EXACTLY the same behavior as before this phase,
// unchanged.
const editorialStrategyStore = require('./editorial-strategy-store');
const ideaStore = require('./idea-store');
const packageStore = require('./package-store');
const storyStructureStore = require('./story-structure-store');

// Every structured rejection/success code this file can produce. Mirrors
// the "closed, documented code list" convention every schema file in this
// codebase already uses (e.g. pre-production-gate-schema.js's own
// GATE_BLOCKER_CODES) — nothing here is free text alone.
const PRODUCTION_PREREQUISITE_CODES = [
  'PROJECT_NOT_FOUND',
  'NO_STORYBOARD',
  'NO_BLUEPRINT_LINKED',
  'BLUEPRINT_NOT_FOUND',
  'BLUEPRINT_NOT_APPROVED',
  'NO_GATE_RESULT',
  'GATE_RESULT_STALE',
  'GATE_NOT_ACCEPTED',
  // PHASE 1 EDITORIAL SPINE, Part 9 — only reachable when a caller passes
  // { requireEditorialSpine: true }. Structural readiness only (per the
  // phase brief's explicit instruction: "Do NOT yet implement a
  // sophisticated AI quality judge") — these codes check that a Strategy/
  // Idea/Package/StoryStructure EXIST and are linked/selected, never that
  // their content is good.
  'NO_STRATEGY',
  'NO_IDEA_SELECTED',
  'NO_PACKAGE_SELECTED',
  'NO_STORY_STRUCTURE',
];

// A gate result authorizes production only when a human has explicitly
// ACCEPTed a clean PROCEED verdict, or explicitly OVERRIDDEN a REVISE/
// REJECT verdict (decideGateResult() already requires a non-empty
// rationale for OVERRIDE — never re-checked here, never duplicated).
// REQUEST_REVISION/REJECT, or no human decision at all, never authorize
// production — matching this whole system's "human authority, never
// machine self-approval" discipline (CreativeBlueprint's own header)
// applied one layer further down.
const AUTHORIZING_HUMAN_DECISIONS = ['ACCEPT', 'OVERRIDE'];

// The one function every expensive-production call site (generation-
// service.js / keyframe-generation-service.js / video-generation-
// service.js) calls before ever reaching a provider. Read-only, pure
// lookups against existing stores plus one existing service function
// (isGateResultStale) — never a provider call, never a mutation.
//
// PHASE 1 EDITORIAL SPINE, Part 9 — options.requireEditorialSpine (default
// false) additionally requires a Strategy/selected Idea/selected Package/
// StoryStructure to exist and be linked, via the SAME function rather than
// a second, parallel gate (the phase brief's explicit instruction: "Do not
// create a second gate"). Defaulting to false means every existing caller
// of this function — production-orchestrator-service.js, generation-
// service.js, keyframe-generation-service.js, video-generation-service.js,
// and every existing test — is completely unaffected; this is additive,
// opt-in strictness for a caller (e.g. the editorial-spine integration
// test) that specifically wants proof the full spine is wired, not a new
// universal requirement.
//
// Returns { ok:true, code:null, reason:null, blueprint, gateResult } or
// { ok:false, code, reason }.
function validateProductionPrerequisites(projectId, { requireEditorialSpine = false } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `No project found with id "${projectId}".` };
  }

  const storyboard = creativeStore.getStoryboard(projectId);
  if (!storyboard) {
    return {
      ok: false,
      code: 'NO_STORYBOARD',
      reason: 'This project has no Storyboard yet — there is nothing to trace back to an approved CreativeBlueprint. Paid production requires a Storyboard linked (via blueprintId) to an APPROVED CreativeBlueprint that has passed its pre-production gate.',
    };
  }

  if (!storyboard.blueprintId) {
    return {
      ok: false,
      code: 'NO_BLUEPRINT_LINKED',
      reason:
        'This project\'s Storyboard is not linked to any CreativeBlueprint (Storyboard.blueprintId is null). Paid production requires the Storyboard to be built against an APPROVED, gated CreativeBlueprint — set a real blueprintId via update_storyboard first.',
    };
  }

  const blueprint = creativeBlueprintStore.getCreativeBlueprint(projectId, storyboard.blueprintId);
  if (!blueprint) {
    return {
      ok: false,
      code: 'BLUEPRINT_NOT_FOUND',
      reason: `This project's Storyboard references CreativeBlueprint "${storyboard.blueprintId}", which does not exist (or no longer exists) in this project.`,
    };
  }

  if (blueprint.status !== 'APPROVED') {
    return {
      ok: false,
      code: 'BLUEPRINT_NOT_APPROVED',
      reason: `CreativeBlueprint "${blueprint.id}" has status "${blueprint.status}", not APPROVED. A human must approve this Blueprint (reviewCreativeBlueprint) before paid production can begin.`,
    };
  }

  const gateResult = preProductionGateStore.getLatestGateResultForBlueprint(projectId, blueprint.id);
  if (!gateResult) {
    return {
      ok: false,
      code: 'NO_GATE_RESULT',
      reason: `CreativeBlueprint "${blueprint.id}" is APPROVED, but no pre-production gate has been run against it yet (evaluatePreProductionGate). Paid production cannot begin without one.`,
    };
  }

  // Reused verbatim, never reimplemented — the same staleness rule
  // pre-production-gate-service.js itself already enforces before letting
  // a human ACCEPT/OVERRIDE a gate result in the first place. A Blueprint
  // edited or revised AFTER this gate result was decided invalidates it
  // here too, even if the human decision was recorded while it was still
  // fresh.
  const staleness = preProductionGateService.isGateResultStale(projectId, gateResult);
  if (staleness.stale) {
    return { ok: false, code: 'GATE_RESULT_STALE', reason: staleness.reason };
  }

  if (!AUTHORIZING_HUMAN_DECISIONS.includes(gateResult.humanDecision)) {
    return {
      ok: false,
      code: 'GATE_NOT_ACCEPTED',
      reason: `The pre-production gate for CreativeBlueprint "${blueprint.id}" has machine assessment "${gateResult.machineAssessment}" and human decision "${gateResult.humanDecision || 'NONE'}". Paid production requires an explicit ACCEPT or OVERRIDE (decideGateResult).`,
    };
  }

  if (requireEditorialSpine) {
    if (!blueprint.strategyId || !editorialStrategyStore.getStrategy(projectId, blueprint.strategyId)) {
      return { ok: false, code: 'NO_STRATEGY', reason: `CreativeBlueprint "${blueprint.id}" has no linked, resolvable EditorialStrategy (strategyId). The editorial spine requires a Strategy generated before the Idea/Package/Blueprint chain.` };
    }
    const ideaLookup = blueprint.ideaId ? ideaStore.findIdeaCandidate(projectId, blueprint.ideaId) : null;
    if (!blueprint.ideaId || !ideaLookup || ideaLookup.ideaSet.selectedIdeaId !== blueprint.ideaId) {
      return { ok: false, code: 'NO_IDEA_SELECTED', reason: `CreativeBlueprint "${blueprint.id}" has no linked idea that is the SELECTED candidate of its own IdeaSet.` };
    }
    const packageLookup = blueprint.packageId ? packageStore.findPackageCandidate(projectId, blueprint.packageId) : null;
    if (!blueprint.packageId || !packageLookup || packageLookup.packageSet.selectedPackageId !== blueprint.packageId) {
      return { ok: false, code: 'NO_PACKAGE_SELECTED', reason: `CreativeBlueprint "${blueprint.id}" has no linked package that is the SELECTED candidate of its own PackageSet.` };
    }
    const storyStructure = storyStructureStore.getLatestStoryStructureForBlueprint(projectId, blueprint.id);
    if (!storyStructure) {
      return { ok: false, code: 'NO_STORY_STRUCTURE', reason: `no StoryStructure has been derived for CreativeBlueprint "${blueprint.id}" yet.` };
    }
  }

  return { ok: true, code: null, reason: null, blueprint, gateResult };
}

// Boolean convenience wrapper — same underlying check, for callers that
// only need a yes/no (e.g. a future read-only "is this project ready"
// dashboard query) rather than the structured diagnostic.
function canEnterProduction(projectId, options) {
  return validateProductionPrerequisites(projectId, options).ok;
}

module.exports = {
  PRODUCTION_PREREQUISITE_CODES,
  AUTHORIZING_HUMAN_DECISIONS,
  validateProductionPrerequisites,
  canEnterProduction,
};
