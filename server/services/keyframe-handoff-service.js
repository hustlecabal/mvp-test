// keyframe-handoff-service.js
//
// Stage 13D — the HUMAN EXECUTION HANDOFF. Stage 13C established that no
// installed image skill can be executed programmatically; the real
// execution step is a human operating Higgsfield's own UI. This service
// creates the frozen instruction record that hands a human everything
// they need, and later ingests whatever image they bring back.
//
// THIS FILE NEVER GENERATES ANYTHING, NEVER CALLS A PROVIDER, NEVER CALLS
// HIGGSFIELD, AND NEVER TOUCHES THE NETWORK. It has no import of, or path
// to, providers/evolink/*, providers/fake-image/*,
// services/generation-service.js, or services/keyframe-generation-
// service.js. The only "execution" it ever performs is writing
// already-in-memory bytes a human supplied to local disk
// (services/asset-storage.js's storeUploadedImage — no network fetch).
//
// A handoff is a FROZEN instruction: once created, its promptPackageId/
// Version, skillId/Name, and instruction content never change, even if
// the underlying prompt package is later rebuilt (Part 2/9). Because
// services/keyframe-prompt-service.js's versioning is metadata-only (no
// full historical content snapshot per version — the same lightweight
// pattern every store in this project uses), `frozenPackage` below is
// this service's own snapshot of the structured content a handoff needs,
// captured once at creation time. Without it, "must not silently update"
// would be impossible to honor once the live package changes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const timelineStore = require('./timeline-store');
const keyframeStore = require('./keyframe-store');
const keyframePromptService = require('./keyframe-prompt-service');
const keyframeGenerationApprovalStore = require('./keyframe-generation-approval-store');
const skillOrchestrator = require('./skill-orchestrator');
const assetStorage = require('./asset-storage');
const { createKeyframeHandoff } = require('../schemas/keyframe-handoff-schema');

const KEYFRAME_HANDOFF_DATA_DIR = process.env.KEYFRAME_HANDOFF_DATA_DIR
  ? path.resolve(process.env.KEYFRAME_HANDOFF_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'keyframe-handoffs');

fs.mkdirSync(KEYFRAME_HANDOFF_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(KEYFRAME_HANDOFF_DATA_DIR, `${projectId}.json`);
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
    record = { projectId, handoffs: [] };
    saveRecord(record);
  }
  return record;
}

// Lightweight versioning, same pattern as every other store here.
const PROTECTED_FIELDS = new Set(['handoffId', 'projectId', 'keyframeId', 'promptPackageId', 'promptPackageVersion', 'skillId', 'version', 'history', 'createdAt', 'createdBy']);

function applyVersionedUpdate(handoff, updates = {}, { updatedBy, changeNote } = {}) {
  handoff.history = handoff.history || [];
  handoff.history.push({ version: handoff.version, updatedAt: handoff.updatedAt, updatedBy: handoff.updatedBy, changeNote: handoff.changeNote });

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && !PROTECTED_FIELDS.has(key)) handoff[key] = value;
  }

  handoff.version += 1;
  handoff.updatedAt = new Date().toISOString();
  handoff.updatedBy = updatedBy || null;
  handoff.changeNote = changeNote || null;
  return handoff;
}

function findShotAndScene(storyboard, shotId) {
  const shot = storyboard ? storyboard.shots.find((s) => s.shotId === shotId) : null;
  const scene = storyboard && shot ? storyboard.scenes.find((sc) => sc.sceneId === shot.sceneId) : null;
  return { shot, scene };
}

// Part 3's numbered execution steps — generic across any recommended
// skill (never claims the application can perform them itself).
function buildInstructionsText(handoffId, skillName) {
  return [
    `1. Open the recommended skill workflow (${skillName || 'the recommended skill'}).`,
    '2. Open the appropriate image-generation UI (Higgsfield).',
    '3. Attach the listed reference images, in order.',
    '4. Paste the derived prompt.',
    '5. Confirm the requested framing/camera/lighting match the Source of Truth below.',
    '6. Generate the image manually.',
    '7. Download the resulting image.',
    '8. Return to EvoLink Video Factory.',
    `9. Upload the image using this handoff (handoff ID: ${handoffId}).`,
    '10. Complete the handoff (approve or reject the result).',
  ].join('\n');
}

// Part 2 — every check runs before a handoff is ever created. Returns
// { ok: false, reason } on any failure; never creates a record.
function createHandoff(projectId, keyframeId, { createdBy, notes } = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, reason: `No project found with id "${projectId}"` };

  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) return { ok: false, reason: `No keyframe found with id "${keyframeId}" in project "${projectId}"` };

  const pkg = keyframePromptService.getKeyframePromptPackage(projectId, keyframeId);
  if (!pkg) return { ok: false, reason: 'No prompt package has been built for this keyframe yet. Build one first.' };

  // Part 9 — block handoff CREATION on a stale package. An existing
  // handoff created before staleness set in stays valid (see Part 9 test
  // coverage) — this check only ever runs here, at creation time.
  if (pkg.status !== 'CURRENT') {
    return { ok: false, reason: 'The prompt package is STALE — rebuild it (build_keyframe_prompt_package) before creating a handoff.' };
  }

  const approval = keyframeGenerationApprovalStore.getApproval(projectId, keyframeId);
  if (approval.status !== 'APPROVED') {
    return {
      ok: false,
      reason: 'No explicit keyframe generation approval. request_keyframe_generation_approval and approve_keyframe_generation are required before a handoff can be created.',
    };
  }
  if (approval.promptPackageId !== pkg.packageId || approval.promptPackageVersion !== pkg.version) {
    return {
      ok: false,
      reason: `The generation approval was granted for prompt package version ${approval.promptPackageVersion}, but the current package is version ${pkg.version}. Request and approve generation again for the current package.`,
    };
  }

  const storyboard = creativeStore.getStoryboard(projectId);
  const { shot } = findShotAndScene(storyboard, keyframe.shotId);

  const recommendedSkill = skillOrchestrator.getSkill(pkg.recommendedSkill);
  const skillId = pkg.recommendedSkill;
  const skillName = recommendedSkill ? recommendedSkill.name : skillId;

  // Part 8 — own snapshot of the structured content this handoff needs,
  // frozen at creation time (see file header for why). Never mutated
  // after this point, and never re-derived from a later package rebuild.
  const frozenPackage = {
    prompt: pkg.prompt,
    promptSections: pkg.promptSections,
    identityLock: pkg.identityLock,
    wardrobeLock: pkg.wardrobeLock,
    environmentLock: pkg.environmentLock,
    composition: pkg.composition,
    camera: pkg.camera,
    framing: pkg.framing,
    lens: pkg.lens,
    movementIntent: pkg.movementIntent,
    lighting: pkg.lighting,
    colour: pkg.colour,
    atmosphere: pkg.atmosphere,
    continuityRequirements: pkg.continuityRequirements,
    negativeConstraints: pkg.negativeConstraints,
    warnings: pkg.warnings,
    purpose: pkg.purpose,
    frameType: pkg.frameType,
    subject: pkg.subject,
  };

  const handoffId = crypto.randomUUID();
  const handoff = createKeyframeHandoff({
    handoffId,
    projectId,
    keyframeId,
    shotId: keyframe.shotId,
    sceneId: keyframe.sceneId,
    promptPackageId: pkg.packageId,
    promptPackageVersion: pkg.version,
    skillId,
    skillName,
    createdBy: createdBy || null,
    instructions: buildInstructionsText(handoffId, skillName),
    // Part 2, "preserve reference assets" — the package's already-
    // resolved APPROVED references are what must be attached; our data
    // model has no separate concept of an "optional" reference beyond
    // that, so this stays an empty array rather than inventing one.
    requiredReferences: pkg.existingReferenceAssets,
    optionalReferences: [],
    outputRequirements: 'One image file (PNG, JPEG, GIF, or WEBP) matching the derived prompt\'s framing, composition, and lighting requirements below.',
    returnInstructions: `Upload the generated image via POST /handoffs/${handoffId}/asset, then approve or reject it.`,
    notes: notes || null,
    frozenPackage,
  });

  const record = ensureRecord(projectId);
  record.handoffs.push(handoff);
  saveRecord(record);

  return { ok: true, handoff };
}

// Compute-on-read enrichment, never persisted — same pattern as
// keyframeStore's attachStale and keyframe-generation-service.js's asset
// enrichment in listKeyframeGenerations. A handoff-ingested asset has no
// generation job to be enriched through at all, so callers (the REST
// routes, the UI) need this to show approvalStatus/storage without a
// second round-trip.
function withAsset(projectId, handoff) {
  if (!handoff) return handoff;
  const asset = handoff.assetId ? timelineStore.getAsset(projectId, handoff.assetId) : null;
  return { ...handoff, asset };
}

function getHandoff(projectId, handoffId) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  const handoff = record.handoffs.find((h) => h.handoffId === handoffId) || null;
  return withAsset(projectId, handoff);
}

// REST routes only know the handoffId (Part 5) — same pattern as
// keyframeStore.findKeyframeById / timelineStore.findAssetById.
function findHandoffById(handoffId) {
  for (const project of projectStore.listProjects()) {
    const record = loadRecord(project.id);
    if (!record) continue;
    const handoff = record.handoffs.find((h) => h.handoffId === handoffId);
    if (handoff) return { project, handoff: withAsset(project.id, handoff) };
  }
  return null;
}

function listHandoffs(projectId, { keyframeId, status } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  let handoffs = record.handoffs;
  if (keyframeId) handoffs = handoffs.filter((h) => h.keyframeId === keyframeId);
  if (status) handoffs = handoffs.filter((h) => h.status === status);
  return handoffs.map((h) => withAsset(projectId, h));
}

// Part 2's updateHandoff() — deliberately narrow. The only status
// transition this function is allowed to make is READY -> IN_PROGRESS
// ("MARK IN PROGRESS", Part 10); INGESTED is only ever reached through
// ingestHandoffAsset() below, and CANCELLED only through cancelHandoff().
// `notes` can always be updated. Every frozen field (promptPackageId/
// Version, skillId, instructions, ...) is protected — see
// PROTECTED_FIELDS — so this can never be used to silently rewrite what
// the handoff originally instructed.
function updateHandoff(projectId, handoffId, updates = {}, { updatedBy, changeNote } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  const handoff = record.handoffs.find((h) => h.handoffId === handoffId);
  if (!handoff) return null;

  if (handoff.status === 'INGESTED' || handoff.status === 'CANCELLED') {
    return { ok: false, reason: `This handoff is already ${handoff.status} and can no longer be updated.` };
  }

  if (updates.status !== undefined) {
    if (updates.status !== 'IN_PROGRESS') {
      return { ok: false, reason: 'updateHandoff can only transition status to IN_PROGRESS. Use cancelHandoff to cancel, or upload an image to ingest.' };
    }
  }

  applyVersionedUpdate(handoff, { status: updates.status, notes: updates.notes }, { updatedBy, changeNote });
  saveRecord(record);
  return { ok: true, handoff };
}

function cancelHandoff(projectId, handoffId, { decidedBy, reason } = {}) {
  const record = ensureRecord(projectId);
  if (!record) return null;
  const handoff = record.handoffs.find((h) => h.handoffId === handoffId);
  if (!handoff) return null;

  if (handoff.status === 'INGESTED') {
    return { ok: false, reason: 'Cannot cancel a handoff that already has an ingested asset.' };
  }
  if (handoff.status === 'CANCELLED') {
    return { ok: false, reason: 'This handoff is already cancelled.' };
  }

  applyVersionedUpdate(handoff, { status: 'CANCELLED' }, { updatedBy: decidedBy, changeNote: reason || 'Handoff cancelled' });
  saveRecord(record);
  return { ok: true, handoff };
}

// Part 6 — the image-ingestion core (called by the REST upload route;
// there is deliberately no MCP tool for this — binary upload is a REST-
// only concern). `imageBuffer` must already be in memory; this function
// never fetches a URL and never trusts a client-supplied filename or
// asset id. Part 8 — a handoff can only ever produce ONE ingested asset;
// this is checked BEFORE anything is written to disk.
function ingestHandoffAsset(handoffId, imageBuffer, { completedBy } = {}) {
  const found = findHandoffById(handoffId);
  if (!found) return { ok: false, code: 'not_found', reason: `No handoff found with id "${handoffId}"` };
  const { project, handoff } = found;

  if (handoff.status === 'CANCELLED') {
    return { ok: false, code: 'cancelled', reason: 'This handoff was cancelled and can no longer receive an image.' };
  }
  if (handoff.status === 'INGESTED') {
    return { ok: false, code: 'already_ingested', reason: 'This handoff already has an ingested asset. Create a new handoff for another attempt.' };
  }
  if (handoff.status !== 'READY' && handoff.status !== 'IN_PROGRESS') {
    return { ok: false, code: 'invalid_status', reason: `Handoff status "${handoff.status}" cannot receive an image.` };
  }

  const assetId = crypto.randomUUID(); // Part 6 — always generated server-side
  let stored;
  try {
    stored = assetStorage.storeUploadedImage(imageBuffer, assetId);
  } catch (err) {
    return { ok: false, code: err.code || 'upload_failed', reason: err.message };
  }

  const asset = timelineStore.addAsset(project.id, {
    assetId,
    type: 'keyframe',
    sceneId: handoff.sceneId,
    shotId: handoff.shotId,
    keyframeId: handoff.keyframeId,
    handoffId: handoff.handoffId,
    generationType: 'KEYFRAME',
    promptPackageId: handoff.promptPackageId,
    promptPackageVersion: handoff.promptPackageVersion,
    skillId: handoff.skillId,
    generationId: null,
    provider: 'human-handoff',
    model: null,
    prompt: handoff.frozenPackage ? handoff.frozenPackage.prompt : null,
    references: (handoff.requiredReferences || []).map((ref) => ref.assetId),
    url: null,
  });

  timelineStore.updateAssetStorage(project.id, assetId, {
    provider: 'local',
    path: stored.relativePath,
    status: 'STORED',
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    archivedAt: new Date().toISOString(),
    error: null,
  });

  const record = ensureRecord(project.id);
  const storedHandoff = record.handoffs.find((h) => h.handoffId === handoffId);
  applyVersionedUpdate(
    storedHandoff,
    { status: 'INGESTED', assetId, completedAt: new Date().toISOString(), completedBy: completedBy || null },
    { updatedBy: completedBy, changeNote: 'Image ingested' }
  );
  saveRecord(record);

  return { ok: true, handoff: storedHandoff, asset: timelineStore.getAsset(project.id, assetId) };
}

// Part 3/11 — the deterministic human execution package. Reads ONLY the
// handoff's own frozen data for everything that must never silently
// change; the only LIVE lookup is the current prompt package's version
// number, used solely to compute Part 9's "frozen vs. current" banner —
// never to pull fresh content into the package.
function buildExecutionPackage(projectId, handoffId) {
  const found = findHandoffById(handoffId);
  if (!found || found.project.id !== projectId) return null;
  const { project, handoff } = found;

  const storyboard = creativeStore.getStoryboard(projectId);
  const { shot, scene } = findShotAndScene(storyboard, handoff.shotId);
  const keyframe = keyframeStore.getKeyframe(projectId, handoff.keyframeId);
  const recommendedSkill = skillOrchestrator.getSkill(handoff.skillId);

  const currentPkg = keyframePromptService.getKeyframePromptPackage(projectId, handoff.keyframeId);
  const currentPromptPackageVersion = currentPkg ? currentPkg.version : null;
  const frozen = currentPromptPackageVersion != null && currentPromptPackageVersion !== handoff.promptPackageVersion;

  const fp = handoff.frozenPackage || {};
  const missingReferences = (fp.warnings || []).filter((w) => w.startsWith('Approved reference asset not available'));

  const text = renderPlainTextPackage({ project, scene, shot, keyframe, handoff, recommendedSkill, fp, missingReferences, currentPromptPackageVersion, frozen });

  return {
    handoffId: handoff.handoffId,
    project: { id: project.id, title: project.title },
    scene: scene ? { id: scene.sceneId, title: scene.title } : null,
    shot: shot ? { id: shot.shotId, purpose: shot.purpose } : null,
    keyframe: keyframe ? { id: keyframe.keyframeId, frameType: keyframe.frameType, subject: keyframe.subject } : null,
    skill: { id: handoff.skillId, name: handoff.skillName, purpose: recommendedSkill ? recommendedSkill.purpose : null },
    promptPackage: { id: handoff.promptPackageId, version: handoff.promptPackageVersion },
    currentPromptPackageVersion,
    frozen,
    identityLock: fp.identityLock || [],
    wardrobeLock: fp.wardrobeLock || [],
    environmentLock: fp.environmentLock || [],
    references: { required: handoff.requiredReferences || [], optional: handoff.optionalReferences || [], missing: missingReferences },
    prompt: fp.prompt != null ? fp.prompt : null,
    instructions: handoff.instructions,
    outputRequirements: handoff.outputRequirements,
    returnInstructions: handoff.returnInstructions,
    text,
  };
}

function formatLockList(entries, labelFn) {
  if (!entries || entries.length === 0) return '(none)';
  return entries.map((e, i) => `${i + 1}. ${labelFn(e)}`).join('\n');
}

function renderPlainTextPackage({ project, scene, shot, keyframe, handoff, recommendedSkill, fp, missingReferences, currentPromptPackageVersion, frozen }) {
  const lines = [];
  lines.push('--------------------------------');
  lines.push('KEYFRAME EXECUTION');
  lines.push('--------------------------------');
  lines.push('');
  lines.push(`Project: ${project.title || project.id}`);
  lines.push(`Scene: ${scene ? scene.title || scene.sceneId : 'Unknown'}`);
  lines.push(`Shot: ${shot ? shot.purpose || shot.shotId : 'Unknown'}`);
  lines.push(`Keyframe: ${keyframe ? `${keyframe.frameType || 'Unknown'} — ${keyframe.subject || 'Unknown'}` : 'Unknown'}`);
  lines.push('');
  lines.push(`Skill: ${handoff.skillName || handoff.skillId || 'Unknown'}`);
  lines.push(`Skill purpose: ${recommendedSkill ? recommendedSkill.purpose : 'Unknown'}`);
  lines.push('');
  lines.push(`Prompt Package: ${handoff.promptPackageId}`);
  lines.push(`Prompt Package Version: ${handoff.promptPackageVersion}`);
  if (frozen) {
    lines.push(`CURRENT PACKAGE VERSION: ${currentPromptPackageVersion}`);
    lines.push('STATUS: EXECUTION PACKAGE FROZEN — the current package has changed since this handoff was created; this handoff still reflects the version it was approved against.');
  }
  lines.push('');
  lines.push('--------------------------------');
  lines.push('SOURCE OF TRUTH');
  lines.push('--------------------------------');
  lines.push('');
  lines.push('Identity Lock:');
  lines.push(formatLockList(fp.identityLock, (l) => `${l.name || l.characterId}${l.identityConstraints ? ` — ${l.identityConstraints}` : ''}`));
  lines.push('');
  lines.push('Wardrobe Lock:');
  lines.push(formatLockList(fp.wardrobeLock, (l) => `${l.name || l.characterId}${l.wardrobe ? ` — ${l.wardrobe}` : ''}`));
  lines.push('');
  lines.push('Environment Lock:');
  lines.push(formatLockList(fp.environmentLock, (l) => `${l.name || l.locationId}${l.architecture ? ` — ${l.architecture}` : ''}`));
  lines.push('');
  lines.push('--------------------------------');
  lines.push('REFERENCES');
  lines.push('--------------------------------');
  lines.push('');
  lines.push('Existing approved references:');
  lines.push('');
  lines.push(formatLockList(handoff.requiredReferences, (r) => `${r.role || r.assetId} (asset ${r.assetId})`));
  lines.push('');
  lines.push('Missing references:');
  lines.push('');
  lines.push(formatLockList(missingReferences, (w) => w));
  lines.push('');
  lines.push('--------------------------------');
  lines.push('PROMPT');
  lines.push('--------------------------------');
  lines.push('');
  lines.push(fp.prompt || '(no prompt resolved)');
  lines.push('');
  lines.push('--------------------------------');
  lines.push('EXECUTION INSTRUCTIONS');
  lines.push('--------------------------------');
  lines.push('');
  lines.push(handoff.instructions);
  return lines.join('\n');
}

module.exports = {
  KEYFRAME_HANDOFF_DATA_DIR,
  createHandoff,
  getHandoff,
  findHandoffById,
  listHandoffs,
  updateHandoff,
  cancelHandoff,
  ingestHandoffAsset,
  buildExecutionPackage,
};
