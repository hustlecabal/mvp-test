// creative-blueprint-store.js
//
// INT-2 — persistence for CreativeBlueprint records (schemas/creative-
// blueprint-schema.js). Same one-JSON-file-per-project convention every
// store in this codebase uses — `{ projectId, blueprints: [] }`. Never
// mutates a ReferenceVideo, Measurements, Observation, Pattern, or
// Recommendation record (Part 26) — this file only ever writes its own
// small JSON index of DERIVED blueprint data.
//
// UNLIKE PatternSet/RecommendationSet (a "one record per generation
// attempt" wrapper around many child records), a CreativeBlueprint is
// ITSELF the reviewable unit — there is no wrapping "BlueprintSet". This
// matches Part 19's own v1/v2 revision chain, which operates on
// individual Blueprint records directly (via supersedesBlueprintId), not
// on a batch container.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const CREATIVE_BLUEPRINT_DATA_DIR = process.env.CREATIVE_BLUEPRINT_DATA_DIR ? path.resolve(process.env.CREATIVE_BLUEPRINT_DATA_DIR) : path.join(__dirname, '..', 'data', 'creative-blueprints');

fs.mkdirSync(CREATIVE_BLUEPRINT_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(CREATIVE_BLUEPRINT_DATA_DIR, `${projectId}.json`);
}

function loadLibrary(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveLibrary(library) {
  fs.writeFileSync(fileFor(library.projectId), JSON.stringify(library, null, 2));
}

function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, blueprints: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, blueprints: [] };
}

function getCreativeBlueprint(projectId, blueprintId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.blueprints.find((b) => b.id === blueprintId) || null;
}

function listCreativeBlueprints(projectId, { referenceSetId } = {}) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return referenceSetId ? library.blueprints.filter((b) => b.referenceSetId === referenceSetId) : library.blueprints.slice();
}

function getLatestCreativeBlueprintForReferenceSet(projectId, referenceSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.blueprints.filter((b) => b.referenceSetId === referenceSetId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, b) => (new Date(b.createdAt) > new Date(latest.createdAt) ? b : latest));
}

// Part 19 — walks supersedesBlueprintId back to the very first draft in
// this Blueprint's own revision chain, returning every version oldest
// first. Read-only — never mutates any record it finds along the way.
function getRevisionChain(projectId, blueprintId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const byId = new Map(library.blueprints.map((b) => [b.id, b]));
  let current = byId.get(blueprintId);
  if (!current) return null;
  const chain = [current];
  while (current.supersedesBlueprintId && byId.has(current.supersedesBlueprintId)) {
    current = byId.get(current.supersedesBlueprintId);
    chain.unshift(current);
  }
  return chain;
}

function addCreativeBlueprint(projectId, blueprint) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(blueprint));
  library.blueprints.push(stored);
  saveLibrary(library);
  return { ok: true, blueprint: stored };
}

// Part 7/19 — updates ONLY status/reviews[]/updatedAt of an EXISTING
// Blueprint, in place. Never touches title/concept/corePromise/strategy
// fields/recommendationDecisions/provenance — the machine-and-human-
// authored content is permanent once persisted, matching cross-video-
// pattern-store.js's updatePatternReviewState()/recommendation-store.js's
// updateRecommendationReviewState() exactly. A REQUEST_REVISION decision
// does NOT call this with new content — it creates a brand-new Blueprint
// via addCreativeBlueprint and only uses this function to mark the
// PRIOR version SUPERSEDED.
function updateCreativeBlueprintReviewState(projectId, blueprintId, { status, review }) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const blueprint = library.blueprints.find((b) => b.id === blueprintId);
  if (!blueprint) return null;
  if (status) blueprint.status = status;
  if (review) blueprint.reviews.push(JSON.parse(JSON.stringify(review)));
  blueprint.updatedAt = new Date().toISOString();
  saveLibrary(library);
  return blueprint;
}

// P0 Hardening — the ONE content mutator this store previously lacked
// (see updateCreativeBlueprintReviewState's own comment above, which was
// accurate about every function that existed at the time it was written).
// Only ever called by creative-blueprint-service.js's editCreativeBlueprintDraft(),
// which itself only ever operates on a DRAFT/PENDING_REVIEW record — this
// function re-checks that same precondition defensively (never trusts a
// caller not to skip the service layer) so an APPROVED Blueprint's content
// can never be mutated in place through this path either. contentFields is
// a plain object of already-validated field values (recommendationDecisions/
// diagnostics/etc. already recomputed by the caller) — this function does
// no validation of its own, exactly like updateCreativeBlueprintReviewState
// does no validation of its own; it only writes.
const EDITABLE_STATUSES = ['DRAFT', 'PENDING_REVIEW'];
function updateCreativeBlueprintContent(projectId, blueprintId, contentFields) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const blueprint = library.blueprints.find((b) => b.id === blueprintId);
  if (!blueprint) return null;
  if (!EDITABLE_STATUSES.includes(blueprint.status)) return null;
  for (const [key, value] of Object.entries(contentFields)) {
    if (value !== undefined) blueprint[key] = JSON.parse(JSON.stringify(value));
  }
  blueprint.updatedAt = new Date().toISOString();
  saveLibrary(library);
  return blueprint;
}

module.exports = {
  CREATIVE_BLUEPRINT_DATA_DIR,
  getCreativeBlueprint,
  listCreativeBlueprints,
  getLatestCreativeBlueprintForReferenceSet,
  getRevisionChain,
  addCreativeBlueprint,
  updateCreativeBlueprintReviewState,
  updateCreativeBlueprintContent,
};
