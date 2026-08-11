// keyframe-prompt-service.js
//
// Stage 13A — the KEYFRAME PROMPT PACKAGING layer. Converts Creative Brief
// + Master Creative Specification + Visual Bible + Storyboard + Keyframe
// Plan + existing approved reference assets into a KeyframePromptPackage
// (schemas/keyframe-prompt-schema.js): the final structured specification
// a FUTURE image-generation stage could consume.
//
// THIS FILE NEVER CALLS A PROVIDER, NEVER EXECUTES A SKILL, NEVER CREATES
// A GENERATION JOB, AND NEVER SPENDS A CREDIT. It has no import of, or
// path to, providers/evolink/*, services/generation-service.js, or
// services/approval-gate.js. It only reads existing creative-planning data
// (services/creative-store.js), keyframe-planning data
// (services/keyframe-store.js), and production Timeline IR assets
// (services/timeline-store.js, read-only — asset.approvalStatus is only
// ever READ here, never written), then writes ONE new kind of planning
// data: prompt packages. The `prompt` field on every package is a
// deterministic, no-LLM, no-network composition of `promptSections` — see
// composePromptSections()/composePrompt() below. See
// docs/architecture/keyframe-prompt-packaging.md.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const timelineStore = require('./timeline-store');
const keyframeStore = require('./keyframe-store');
const skillOrchestrator = require('./skill-orchestrator');
const {
  PROMPT_SECTION_KEYS,
  createKeyframePromptPackage,
  createPromptSections,
  createIdentityLockEntry,
  createWardrobeLockEntry,
  createEnvironmentLockEntry,
} = require('../schemas/keyframe-prompt-schema');

// Stage 16, Part 2 — maps resolveExistingReferenceAssets()'s existing
// `kind` argument ('character'/'location'/'prop') to the new, additive
// REFERENCE_ROLE_TYPES vocabulary. Anything not in this map (there is
// nothing today, but a future `kind` would fall through safely) becomes
// 'OTHER' rather than throwing — this field is informational, never a hard
// requirement.
const REFERENCE_KIND_TO_ROLE_TYPE = {
  character: 'CHARACTER',
  location: 'ENVIRONMENT',
  prop: 'PROP',
};

// Overridable for tests, same pattern as CREATIVE_DATA_DIR/KEYFRAME_DATA_DIR.
const KEYFRAME_PROMPT_DATA_DIR = process.env.KEYFRAME_PROMPT_DATA_DIR
  ? path.resolve(process.env.KEYFRAME_PROMPT_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'keyframe-prompt-packages');

fs.mkdirSync(KEYFRAME_PROMPT_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(KEYFRAME_PROMPT_DATA_DIR, `${projectId}.json`);
}

function loadRecord(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveRecord(record) {
  fs.writeFileSync(fileFor(record.projectId), JSON.stringify(record, null, 2));
}

function ensureRecord(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let record = loadRecord(projectId);
  if (!record) {
    record = { projectId, packages: [] };
    saveRecord(record);
  }
  return record;
}

// ===========================================================================
// Part 3 — source resolution helpers. Every one of these only READS
// existing creative-planning/keyframe-planning/timeline data; none of them
// invent a value that isn't already present in a source record.
// ===========================================================================

// A shot can reference more than one character/location/prop. A keyframe
// MAY scope itself down to a subset (e.g. a CHARACTER_REFERENCE keyframe
// for one specific character even though the shot has two) by carrying its
// own non-empty references array; when a keyframe doesn't specify its own
// (the common case for shot-scoped frame types like ESTABLISHING_FRAME),
// this falls back to the full shot scope instead of resolving nothing.
function scopeIds(keyframeIds, shotIds) {
  if (Array.isArray(keyframeIds) && keyframeIds.length > 0) return keyframeIds;
  return Array.isArray(shotIds) ? shotIds : [];
}

function findCharacter(visualBible, characterId) {
  return (visualBible && visualBible.characters || []).find((c) => c.characterId === characterId) || null;
}

function findLocation(visualBible, locationId) {
  return (visualBible && visualBible.locations || []).find((l) => l.locationId === locationId) || null;
}

function findProp(visualBible, propId) {
  return (visualBible && visualBible.props || []).find((p) => p.propId === propId) || null;
}

// Part 7 — does this entity's requirement already have an APPROVED asset?
// Same reasoning as keyframe-planner.js's approvedReferenceAsset: a
// candidate (non-approved) asset never satisfies the requirement.
function approvedAssetFor(entity) {
  if (!entity || !Array.isArray(entity.referenceAssets)) return null;
  for (const assetId of entity.referenceAssets) {
    const found = timelineStore.findAssetById(assetId);
    if (found && found.asset.approvalStatus === 'APPROVED') return found.asset;
  }
  return null;
}

// Part 4 — character identity locks, one entry per in-scope character.
// Never invents a missing field: whatever the Visual Bible doesn't have
// stays null, exactly as createIdentityLockEntry defaults it.
function buildIdentityLock(visualBible, characterIds, warnings) {
  return characterIds.map((characterId) => {
    const character = findCharacter(visualBible, characterId);
    if (!character) {
      warnings.push(`Character "${characterId}" was not found in the Visual Bible — identity lock could not be resolved.`);
      return createIdentityLockEntry({ characterId });
    }
    return createIdentityLockEntry({
      characterId: character.characterId,
      name: character.name,
      facialCharacteristics: character.facialCharacteristics,
      bodyCharacteristics: character.bodyCharacteristics,
      hair: character.hair,
      skinDescription: character.skinDescription,
      behaviour: character.behaviour,
      identityConstraints: character.identityConstraints,
      continuityNotes: character.continuityNotes,
    });
  });
}

// Part 5 — wardrobe locks, one entry per in-scope character. `wardrobe`
// always stays the Visual Bible's own value (Part 5: never silently
// replaced). `wardrobeOverride` is left null in this stage: neither the
// storyboard shot schema (schemas/creative-schema.js) nor the keyframe
// schema (schemas/keyframe-schema.js) currently has a structured field for
// a shot-specific wardrobe change, so there is nothing to resolve it from
// without guessing — see the Known Limitations section of the Stage 13A
// report rather than inventing a heuristic here.
function buildWardrobeLock(visualBible, characterIds) {
  return characterIds.map((characterId) => {
    const character = findCharacter(visualBible, characterId);
    if (!character) return createWardrobeLockEntry({ characterId });
    return createWardrobeLockEntry({
      characterId: character.characterId,
      name: character.name,
      wardrobe: character.wardrobe,
      accessories: character.accessories || [],
      continuityNotes: character.continuityNotes,
      wardrobeOverride: null,
    });
  });
}

// Part 6 — environment locks, one entry per in-scope location.
function buildEnvironmentLock(visualBible, locationIds, warnings) {
  return locationIds.map((locationId) => {
    const location = findLocation(visualBible, locationId);
    if (!location) {
      warnings.push(`Location "${locationId}" was not found in the Visual Bible — environment lock could not be resolved.`);
      return createEnvironmentLockEntry({ locationId });
    }
    return createEnvironmentLockEntry({
      locationId: location.locationId,
      name: location.name,
      architecture: location.architecture,
      geography: location.geography,
      materials: location.materials,
      colourPalette: location.colourPalette,
      lighting: location.lighting,
      atmosphere: location.atmosphere,
      recurringElements: location.recurringElements || [],
      continuityConstraints: location.continuityConstraints,
    });
  });
}

// Part 7 — existing reference assets for every in-scope character/
// location/prop, plus a warning (never an auto-generated placeholder) for
// anything still missing an approved reference.
function resolveExistingReferenceAssets(visualBible, { characterIds, locationIds, propIds }, warnings) {
  const entries = [];

  function consider(kind, id, entity, assetType) {
    const label = entity && entity.name ? entity.name : id;
    const asset = approvedAssetFor(entity);
    if (asset) {
      entries.push({
        assetId: asset.assetId,
        type: asset.type || assetType,
        role: `${kind}:${label}`,
        // Stage 16, Part 2 — additive machine-checkable role, alongside the
        // existing free-text `role` label above. Never replaces it.
        roleType: REFERENCE_KIND_TO_ROLE_TYPE[kind] || 'OTHER',
        reason: 'approved reusable reference',
      });
    } else {
      warnings.push(`Approved reference asset not available for ${kind} "${label}".`);
    }
  }

  for (const characterId of characterIds) consider('character', characterId, findCharacter(visualBible, characterId), 'character_reference');
  for (const locationId of locationIds) consider('location', locationId, findLocation(visualBible, locationId), 'location_reference');
  for (const propId of propIds) consider('prop', propId, findProp(visualBible, propId), 'keyframe');

  return entries;
}

function dedupeStrings(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item) continue;
    const key = String(item).trim();
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    result.push(key);
  }
  return result;
}

// Part 8 — continuity, pulled from every source Part 8 names: Visual
// Bible, Storyboard, Keyframe Plan. Structural first/last-frame and
// previous-shot relationships are derived only from fields that already
// exist (frameType, storyboard ordering) — nothing here is invented prose.
function resolveContinuity(visualBible, storyboard, shot, keyframe, identityLock, environmentLock) {
  const items = [];

  if (visualBible && visualBible.continuityRules) items.push(`Visual Bible: ${visualBible.continuityRules}`);
  for (const lock of identityLock) {
    if (lock.continuityNotes) items.push(`Character ${lock.name || lock.characterId}: ${lock.continuityNotes}`);
  }
  for (const lock of environmentLock) {
    if (lock.continuityConstraints) items.push(`Location ${lock.name || lock.locationId}: ${lock.continuityConstraints}`);
  }
  if (shot && Array.isArray(shot.continuityRequirements)) {
    for (const item of shot.continuityRequirements) items.push(`Shot: ${item}`);
  }
  if (keyframe && Array.isArray(keyframe.continuityRequirements)) {
    for (const item of keyframe.continuityRequirements) items.push(`Keyframe: ${item}`);
  }

  if (keyframe && keyframe.frameType === 'FIRST_FRAME') {
    items.push('This is the FIRST_FRAME of the shot\'s movement — must match the composition, lighting, and character/location appearance of the corresponding LAST_FRAME.');
  }
  if (keyframe && keyframe.frameType === 'LAST_FRAME') {
    items.push('This is the LAST_FRAME of the shot\'s movement — must match the composition, lighting, and character/location appearance of the corresponding FIRST_FRAME.');
  }

  if (storyboard && shot) {
    const sceneShots = storyboard.shots
      .map((s, index) => ({ s, index }))
      .filter((entry) => entry.s.sceneId === shot.sceneId)
      .sort((a, b) => {
        const ao = a.s.order == null ? Infinity : a.s.order;
        const bo = b.s.order == null ? Infinity : b.s.order;
        if (ao !== bo) return ao - bo;
        return a.index - b.index;
      });
    const myIndex = sceneShots.findIndex((entry) => entry.s.shotId === shot.shotId);
    if (myIndex > 0) {
      const previous = sceneShots[myIndex - 1].s;
      items.push(`Previous shot in scene: "${previous.purpose || previous.shotId}" — maintain visual continuity with it.`);
    }
  }

  return dedupeStrings(items);
}

// Part 9 — negative constraints, combined from the Master Creative
// Specification's own negativeConstraints array (verbatim — Part 9: never
// silently remove an explicit one) and the Visual Bible's global
// continuityRules. Shot-specific negative constraints have no dedicated
// structured field yet in schemas/creative-schema.js or
// schemas/keyframe-schema.js (see the Known Limitations section) — nothing
// is guessed in their place.
function resolveNegativeConstraints(masterSpec, visualBible) {
  const items = [];
  if (masterSpec && Array.isArray(masterSpec.negativeConstraints)) items.push(...masterSpec.negativeConstraints);
  if (visualBible && visualBible.continuityRules) items.push(visualBible.continuityRules);
  return dedupeStrings(items);
}

// Part 11 — reuses the existing skill-orchestrator rather than a
// duplicate lookup table. Character/world/detail frame types need a
// reference image (banana-pro-director-2.0); everything else is
// cinematic shot composition (cinema-worldbuilder-pro-2.0). The skill is
// never executed here — only identified.
const REFERENCE_IMAGE_FRAME_TYPES = new Set(['CHARACTER_REFERENCE', 'WORLD_REFERENCE', 'DETAIL_FRAME']);

function recommendSkillForFrameType(frameType) {
  if (REFERENCE_IMAGE_FRAME_TYPES.has(frameType)) {
    return skillOrchestrator.recommendSkill({ needsReferenceImage: true });
  }
  return skillOrchestrator.recommendSkill({ needsCinematicPlanning: true });
}

// ===========================================================================
// Part 2/10 — prompt sections + deterministic composition. No LLM call, no
// external API — plain string templating over already-resolved fields.
// ===========================================================================

function composePromptSections({ subject, purpose, identityLock, wardrobeLock, environmentLock, actionText, composition, camera, framing, lens, movementIntent, lighting, colour, atmosphere, continuityRequirements, negativeConstraints }) {
  const sections = createPromptSections();

  sections.SUBJECT = subject || purpose || null;

  sections.IDENTITY =
    identityLock.length === 0
      ? null
      : identityLock
          .map((lock) => {
            const who = lock.name ? `${lock.name} (Character ${lock.characterId})` : `Character ${lock.characterId}`;
            let text = `Preserve the established facial structure, hairstyle, skin characteristics, and body proportions defined for ${who}.`;
            if (lock.identityConstraints) text += ` Identity lock: ${lock.identityConstraints}`;
            return text;
          })
          .join(' ');

  sections.WARDROBE =
    wardrobeLock.length === 0
      ? null
      : wardrobeLock
          .map((lock) => {
            const who = lock.name || lock.characterId;
            if (!lock.wardrobe && !lock.wardrobeOverride) return `No established wardrobe recorded yet for ${who}.`;
            let text = lock.wardrobe ? `Use the established wardrobe for ${who}: ${lock.wardrobe}.` : `No established wardrobe recorded yet for ${who}.`;
            if (lock.wardrobeOverride) text += ` Shot-specific change: ${lock.wardrobeOverride}.`;
            return text;
          })
          .join(' ');

  sections.ENVIRONMENT =
    environmentLock.length === 0
      ? null
      : environmentLock
          .map((lock) => {
            const who = lock.name || lock.locationId;
            const details = [lock.architecture, lock.materials, lock.geography].filter(Boolean).join(', ');
            return details
              ? `${who}, using Location ${lock.locationId}'s established ${details}.`
              : `${who} (Location ${lock.locationId}) — no established environment details recorded yet.`;
          })
          .join(' ');

  sections.ACTION = actionText || null;
  sections.COMPOSITION = composition || null;

  const cameraParts = [];
  if (camera) cameraParts.push(camera);
  if (framing) cameraParts.push(`framing: ${framing}`);
  if (lens) cameraParts.push(`lens: ${lens}`);
  if (movementIntent) cameraParts.push(`movement: ${movementIntent}`);
  sections.CAMERA = cameraParts.length > 0 ? cameraParts.join('; ') : null;

  sections.LIGHTING = lighting || null;
  sections.COLOUR = colour || null;
  sections.ATMOSPHERE = atmosphere || null;
  sections.CONTINUITY = continuityRequirements.length > 0 ? continuityRequirements.join('; ') : null;
  sections.NEGATIVE_CONSTRAINTS = negativeConstraints.length > 0 ? `Avoid: ${negativeConstraints.join('; ')}` : null;

  return sections;
}

// Human-readable composition of promptSections into one `prompt` string.
// Sections with no resolved content are omitted, never rendered as
// "SUBJECT:\nnull".
function composePrompt(promptSections) {
  const blocks = [];
  for (const key of PROMPT_SECTION_KEYS) {
    const value = promptSections[key];
    if (value) blocks.push(`${key.replace(/_/g, ' ')}:\n${value}`);
  }
  return blocks.join('\n\n');
}

// ===========================================================================
// Part 12/13 — stale detection + versioning helpers
// ===========================================================================

// Recomputes status/warnings live against the CURRENT storyboard/keyframe
// plan versions, the same "compute on read" approach keyframe-store.js
// uses for its own `stale` flag (Stage 12, Part 17) — a persisted status
// could itself go stale, so callers always get the true current answer.
// `liveVersions` lets a caller that's about to attach live status to MANY
// packages at once (listKeyframePromptPackages below) fetch the current
// storyboard/plan versions ONCE and pass them through, instead of this
// function re-fetching them per package. Without this, listing N packages
// costs O(N) calls to getKeyframePlan() — itself O(keyframe count), since
// it runs keyframe-store.js's attachStale() per keyframe — turning an
// O(N) listing into O(N^2) (Stage 14, Part 13/20 measured this at ~4.6s
// for 100 packages before this fix). getKeyframePlanVersion() (used
// below) is the O(1)-per-call alternative: it reads the plan's own
// version field without ever running attachStale.
function attachLiveStatus(projectId, pkg, liveVersions) {
  const currentStoryboardVersion = liveVersions ? liveVersions.storyboardVersion : (creativeStore.getStoryboard(projectId) || {}).version ?? null;
  const currentKeyframePlanVersion = liveVersions ? liveVersions.keyframePlanVersion : keyframeStore.getKeyframePlanVersion(projectId);

  const shotChanged = pkg.sourceShotVersion != null && currentStoryboardVersion != null && pkg.sourceShotVersion !== currentStoryboardVersion;
  const planChanged =
    pkg.sourceKeyframePlanVersion != null && currentKeyframePlanVersion != null && pkg.sourceKeyframePlanVersion !== currentKeyframePlanVersion;

  if (!shotChanged && !planChanged) {
    return { ...pkg, status: 'CURRENT', warnings: pkg.warnings.filter((w) => !w.includes('Source creative direction changed')) };
  }

  const staleWarning = 'Source creative direction changed after this package was created.';
  const warnings = pkg.warnings.includes(staleWarning) ? pkg.warnings : [...pkg.warnings, staleWarning];
  return { ...pkg, status: 'STALE', warnings };
}

const PROTECTED_FIELDS = new Set(['packageId', 'projectId', 'keyframeId', 'version', 'history']);

function applyVersionedUpdate(pkg, updates, { updatedBy, changeNote } = {}) {
  pkg.history = pkg.history || [];
  pkg.history.push({ version: pkg.version, updatedAt: pkg.updatedAt, updatedBy: pkg.updatedBy, changeNote: pkg.changeNote });

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && !PROTECTED_FIELDS.has(key)) pkg[key] = value;
  }

  pkg.version += 1;
  pkg.updatedAt = new Date().toISOString();
  pkg.updatedBy = updatedBy || null;
  pkg.changeNote = changeNote || null;
  return pkg;
}

// ===========================================================================
// Part 3/14/15 — the public build/get/list functions
// ===========================================================================

// Resolves every source and produces the full set of fields a
// KeyframePromptPackage needs, WITHOUT persisting anything. Shared by
// buildKeyframePromptPackage; kept separate so it stays easy to test in
// isolation. Returns null if the project, keyframe, or storyboard shot
// doesn't exist.
function resolvePackageFields(projectId, keyframeId) {
  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) return null;

  const storyboard = creativeStore.getStoryboard(projectId);
  const shot = storyboard ? storyboard.shots.find((s) => s.shotId === keyframe.shotId) : null;
  const visualBible = creativeStore.getVisualBible(projectId) || { characters: [], locations: [], props: [] };
  const masterSpec = creativeStore.getMasterCreativeSpec(projectId);
  const keyframePlan = keyframeStore.getKeyframePlan(projectId);

  const warnings = [];

  const characterIds = scopeIds(keyframe.characterReferences, shot ? shot.characterReferences : []);
  const locationIds = scopeIds(keyframe.locationReferences, shot ? shot.locationReferences : []);
  const propIds = scopeIds(keyframe.propReferences, shot ? shot.propReferences : []);

  const identityLock = buildIdentityLock(visualBible, characterIds, warnings);
  const wardrobeLock = buildWardrobeLock(visualBible, characterIds);
  const environmentLock = buildEnvironmentLock(visualBible, locationIds, warnings);
  const existingReferenceAssets = resolveExistingReferenceAssets(visualBible, { characterIds, locationIds, propIds }, warnings);
  const continuityRequirements = resolveContinuity(visualBible, storyboard, shot, keyframe, identityLock, environmentLock);
  const negativeConstraints = resolveNegativeConstraints(masterSpec, visualBible);

  const atmosphere = environmentLock.map((l) => l.atmosphere).find(Boolean) || (visualBible && visualBible.atmosphere) || null;
  const actionText = keyframe.visualDescription || (shot && (shot.action || shot.movement || shot.visualDescription)) || null;

  const skillRec = recommendSkillForFrameType(keyframe.frameType);

  const promptSections = composePromptSections({
    subject: keyframe.subject,
    purpose: keyframe.purpose,
    identityLock,
    wardrobeLock,
    environmentLock,
    actionText,
    composition: keyframe.composition,
    camera: keyframe.camera,
    framing: keyframe.framing,
    lens: keyframe.lens,
    movementIntent: keyframe.movementIntent,
    lighting: keyframe.lighting,
    colour: keyframe.colour,
    atmosphere,
    continuityRequirements,
    negativeConstraints,
  });

  return {
    projectId,
    keyframeId: keyframe.keyframeId,
    shotId: keyframe.shotId,
    sceneId: keyframe.sceneId,
    sourceShotVersion: storyboard ? storyboard.version : null,
    sourceKeyframePlanVersion: keyframePlan ? keyframePlan.version : null,
    purpose: keyframe.purpose,
    frameType: keyframe.frameType,
    subject: keyframe.subject,
    characterReferences: characterIds,
    locationReferences: locationIds,
    propReferences: propIds,
    existingReferenceAssets,
    identityLock,
    wardrobeLock,
    environmentLock,
    composition: keyframe.composition,
    camera: keyframe.camera,
    framing: keyframe.framing,
    lens: keyframe.lens,
    movementIntent: keyframe.movementIntent,
    lighting: keyframe.lighting,
    colour: keyframe.colour,
    atmosphere,
    continuityRequirements,
    negativeConstraints,
    prompt: composePrompt(promptSections),
    promptSections,
    recommendedSkill: skillRec.skillId,
    recommendationReason: skillRec.reason,
    status: 'CURRENT',
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

// Part 13 — build (create on first call) or rebuild (version-bump on every
// call after that) the prompt package for one keyframe. Returns null if
// the project or keyframe doesn't exist.
function buildKeyframePromptPackage(projectId, keyframeId, { updatedBy, changeNote } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  const fields = resolvePackageFields(projectId, keyframeId);
  if (!fields) return null;

  const existingIndex = record.packages.findIndex((p) => p.keyframeId === keyframeId);
  if (existingIndex === -1) {
    const pkg = createKeyframePromptPackage({ ...fields, updatedBy: updatedBy || null, changeNote: changeNote || null });
    record.packages.push(pkg);
    saveRecord(record);
    return attachLiveStatus(projectId, pkg);
  }

  const pkg = record.packages[existingIndex];
  applyVersionedUpdate(pkg, fields, { updatedBy, changeNote: changeNote || 'Rebuilt from current source material' });
  saveRecord(record);
  return attachLiveStatus(projectId, pkg);
}

function getKeyframePromptPackage(projectId, keyframeId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  const pkg = record.packages.find((p) => p.keyframeId === keyframeId);
  if (!pkg) return null;
  return attachLiveStatus(projectId, pkg);
}

function listKeyframePromptPackages(projectId, { shotId, sceneId, status } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;

  // Fetch the live storyboard/plan versions ONCE for the whole list — see
  // attachLiveStatus's own comment for why this matters at scale.
  const storyboard = creativeStore.getStoryboard(projectId);
  const liveVersions = { storyboardVersion: storyboard ? storyboard.version : null, keyframePlanVersion: keyframeStore.getKeyframePlanVersion(projectId) };

  let packages = record.packages.map((p) => attachLiveStatus(projectId, p, liveVersions));
  if (shotId) packages = packages.filter((p) => p.shotId === shotId);
  if (sceneId) packages = packages.filter((p) => p.sceneId === sceneId);
  if (status) packages = packages.filter((p) => p.status === status);
  return packages;
}

module.exports = {
  KEYFRAME_PROMPT_DATA_DIR,
  buildKeyframePromptPackage,
  getKeyframePromptPackage,
  listKeyframePromptPackages,
  // exported for focused unit testing (Part 19 items 2-15)
  composePromptSections,
  composePrompt,
  resolvePackageFields,
};
