// Tests for services/keyframe-prompt-service.js — source resolution
// (character/location/prop, identity/wardrobe/environment locks,
// reference reuse, continuity, negative constraints), deterministic
// prompt composition, skill recommendation, stale detection, versioning,
// persistence, and confirmation that building a package never touches
// generation/approval/budget state. No network, no provider, no LLM call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-service-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-service-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-service-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-service-packages-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfp-service-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');

function newProject(title = 'kfp service test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// A full, realistic fixture: 1 character (with an approved reference
// asset), 1 location (no approved reference), 1 shot, 1 keyframe.
function buildFixture(overrides = {}) {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');

  creativeStore.updateMasterCreativeSpec(project.id, { negativeConstraints: ['no blur', 'no extra limbs'] });
  creativeStore.updateVisualBible(project.id, {
    continuityRules: 'maintain a cold blue palette throughout',
    characters: [
      {
        characterId: 'char-1',
        name: 'Mira',
        facialCharacteristics: 'sharp jaw',
        bodyCharacteristics: 'tall and lean',
        hair: 'black, shoulder-length',
        skinDescription: 'pale',
        wardrobe: 'a weathered grey travelling cloak',
        accessories: ['brass compass'],
        behaviour: 'guarded but curious',
        identityConstraints: 'always has a scar above the left eyebrow',
        continuityNotes: 'scar must appear in every shot',
        referenceAssets: [asset.assetId],
      },
    ],
    locations: [
      {
        locationId: 'loc-1',
        name: 'The Lighthouse',
        architecture: 'stone tower',
        materials: 'granite blocks',
        atmosphere: 'foggy',
        continuityConstraints: 'lamp is always lit at night',
        referenceAssets: [],
      },
    ],
  });

  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    order: 1,
    purpose: 'introduce Mira at the lighthouse',
    characterReferences: ['char-1'],
    locationReferences: ['loc-1'],
    action: 'Mira studies the horizon.',
    continuityRequirements: ['keep the fog consistent with the previous shot'],
    ...overrides.shot,
  });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'COMPOSITION_FRAME',
    subject: 'Mira facing the sea',
    sourceShotVersion: storyboard.version,
    ...overrides.keyframe,
  });

  return { project, asset, scene, shot, keyframe };
}

// --- 2. Prompt sections: individually inspectable ---------------------------------

test('2. composePromptSections returns every section individually, not one opaque blob', () => {
  const sections = kfp.composePromptSections({
    subject: 'Mira facing the sea',
    purpose: null,
    identityLock: [],
    wardrobeLock: [],
    environmentLock: [],
    actionText: 'She studies the horizon.',
    composition: 'rule of thirds',
    camera: 'medium shot',
    framing: 'centered',
    lens: '50mm',
    movementIntent: 'static',
    lighting: 'golden hour',
    colour: 'warm',
    atmosphere: 'foggy',
    continuityRequirements: ['scar must appear'],
    negativeConstraints: ['no blur'],
  });
  assert.equal(sections.SUBJECT, 'Mira facing the sea');
  assert.equal(sections.ACTION, 'She studies the horizon.');
  assert.equal(sections.COMPOSITION, 'rule of thirds');
  assert.match(sections.CAMERA, /medium shot/);
  assert.match(sections.CAMERA, /framing: centered/);
  assert.equal(sections.LIGHTING, 'golden hour');
  assert.equal(sections.COLOUR, 'warm');
  assert.equal(sections.ATMOSPHERE, 'foggy');
  assert.match(sections.CONTINUITY, /scar must appear/);
  assert.match(sections.NEGATIVE_CONSTRAINTS, /Avoid: no blur/);
});

test('a section with no resolved input stays null rather than an empty string', () => {
  const sections = kfp.composePromptSections({
    subject: null,
    purpose: null,
    identityLock: [],
    wardrobeLock: [],
    environmentLock: [],
    actionText: null,
    composition: null,
    camera: null,
    framing: null,
    lens: null,
    movementIntent: null,
    lighting: null,
    colour: null,
    atmosphere: null,
    continuityRequirements: [],
    negativeConstraints: [],
  });
  for (const key of Object.keys(sections)) {
    assert.equal(sections[key], null, `${key} must be null, not an empty string`);
  }
});

// --- 3. Deterministic prompt composition -------------------------------------------

test('3. composePrompt is deterministic — the same sections always produce the same string', () => {
  const sections = kfp.composePromptSections({
    subject: 'Mira facing the sea',
    purpose: null,
    identityLock: [],
    wardrobeLock: [],
    environmentLock: [],
    actionText: null,
    composition: null,
    camera: null,
    framing: null,
    lens: null,
    movementIntent: null,
    lighting: null,
    colour: null,
    atmosphere: null,
    continuityRequirements: [],
    negativeConstraints: [],
  });
  const a = kfp.composePrompt(sections);
  const b = kfp.composePrompt(sections);
  assert.equal(a, b);
  assert.match(a, /^SUBJECT:\nMira facing the sea$/);
});

test('composePrompt never renders a section with no resolved content', () => {
  const sections = kfp.composePromptSections({
    subject: 'x',
    purpose: null,
    identityLock: [],
    wardrobeLock: [],
    environmentLock: [],
    actionText: null,
    composition: null,
    camera: null,
    framing: null,
    lens: null,
    movementIntent: null,
    lighting: null,
    colour: null,
    atmosphere: null,
    continuityRequirements: [],
    negativeConstraints: [],
  });
  const prompt = kfp.composePrompt(sections);
  assert.doesNotMatch(prompt, /WARDROBE/);
  assert.doesNotMatch(prompt, /null/);
});

// --- 4/5. Character resolution + identity lock --------------------------------------

test('4/5. resolvePackageFields resolves the character and builds a full identity lock', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.deepEqual(fields.characterReferences, ['char-1']);
  assert.equal(fields.identityLock.length, 1);
  const lock = fields.identityLock[0];
  assert.equal(lock.characterId, 'char-1');
  assert.equal(lock.name, 'Mira');
  assert.equal(lock.facialCharacteristics, 'sharp jaw');
  assert.equal(lock.identityConstraints, 'always has a scar above the left eyebrow');
  assert.match(fields.promptSections.IDENTITY, /Mira/);
  assert.match(fields.promptSections.IDENTITY, /always has a scar above the left eyebrow/);
});

test('a character reference that does not exist in the Visual Bible still produces an identityLock entry, plus a warning, without inventing values', () => {
  const { project, keyframe } = buildFixture({ keyframe: { characterReferences: ['char-ghost'] } });
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.equal(fields.identityLock.length, 1);
  assert.equal(fields.identityLock[0].characterId, 'char-ghost');
  assert.equal(fields.identityLock[0].facialCharacteristics, null);
  assert.ok(fields.warnings.some((w) => w.includes('char-ghost') && w.includes('not found')));
});

// --- 6. Wardrobe resolution -----------------------------------------------------------

test('6. resolvePackageFields resolves wardrobe from the Visual Bible and never invents a wardrobeOverride', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.equal(fields.wardrobeLock.length, 1);
  assert.equal(fields.wardrobeLock[0].wardrobe, 'a weathered grey travelling cloak');
  assert.deepEqual(fields.wardrobeLock[0].accessories, ['brass compass']);
  assert.equal(fields.wardrobeLock[0].wardrobeOverride, null, 'no structured source exists yet for a shot-specific wardrobe change');
  assert.match(fields.promptSections.WARDROBE, /weathered grey travelling cloak/);
});

// --- 7/8. Location resolution + environment lock ---------------------------------------

test('7/8. resolvePackageFields resolves the location and builds a full environment lock', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.deepEqual(fields.locationReferences, ['loc-1']);
  assert.equal(fields.environmentLock.length, 1);
  const lock = fields.environmentLock[0];
  assert.equal(lock.locationId, 'loc-1');
  assert.equal(lock.architecture, 'stone tower');
  assert.equal(lock.atmosphere, 'foggy');
  assert.equal(fields.atmosphere, 'foggy', 'package-level atmosphere falls back to a resolved location\'s atmosphere');
  assert.match(fields.promptSections.ENVIRONMENT, /stone tower/);
});

// --- 9. Prop resolution -----------------------------------------------------------------

test('9. a prop reference produces an existingReferenceAssets check without inventing a Visual Bible entry', () => {
  const { project, keyframe } = buildFixture({ keyframe: { propReferences: ['prop-compass'] } });
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.deepEqual(fields.propReferences, ['prop-compass']);
  assert.ok(fields.warnings.some((w) => w.includes('prop') && w.includes('prop-compass')));
});

// --- 10/11. Approved asset reuse + missing reference warning ----------------------------

test('10. an APPROVED reference asset is reused, not flagged as missing', () => {
  const { project, keyframe, asset } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  const charEntry = fields.existingReferenceAssets.find((e) => e.role.startsWith('character:'));
  assert.ok(charEntry);
  assert.equal(charEntry.assetId, asset.assetId);
  assert.equal(charEntry.reason, 'approved reusable reference');
  assert.ok(!fields.warnings.some((w) => w.includes('character') && w.includes('Mira')));
});

// --- Stage 16, Part 2 — additive reference roleType -----------------------------------

test('Stage 16: a character reference entry carries roleType CHARACTER alongside its existing role label', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  const charEntry = fields.existingReferenceAssets.find((e) => e.role.startsWith('character:'));
  assert.equal(charEntry.roleType, 'CHARACTER');
  // the original free-text role label is unchanged, not replaced
  assert.equal(charEntry.role, 'character:Mira');
});

test('Stage 16: a prop reference entry carries roleType PROP', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, propReferences: ['prop-1'] });
  const storyboard = creativeStore.getStoryboard(project.id);
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { props: [{ propId: 'prop-1', name: 'Compass', referenceAssets: [asset.assetId] }] });
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, sourceShotVersion: storyboard.version });

  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  const propEntry = fields.existingReferenceAssets.find((e) => e.role.startsWith('prop:'));
  assert.ok(propEntry);
  assert.equal(propEntry.roleType, 'PROP');
});

test('Stage 16: a location reference entry (when approved) carries roleType ENVIRONMENT', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, locationReferences: ['loc-1'] });
  const storyboard = creativeStore.getStoryboard(project.id);
  const asset = timelineStore.addAsset(project.id, { type: 'location_reference' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, { locations: [{ locationId: 'loc-1', name: 'Pier', referenceAssets: [asset.assetId] }] });
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, sourceShotVersion: storyboard.version });

  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  const locEntry = fields.existingReferenceAssets.find((e) => e.role.startsWith('location:'));
  assert.equal(locEntry.roleType, 'ENVIRONMENT');
});

test('Stage 16: multiple simultaneous references each carry their own distinct roleType', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, {
    sceneId: scene.sceneId,
    characterReferences: ['char-1'],
    locationReferences: ['loc-1'],
    propReferences: ['prop-1'],
  });
  const storyboard = creativeStore.getStoryboard(project.id);
  const charAsset = timelineStore.addAsset(project.id, { type: 'character_reference' });
  const locAsset = timelineStore.addAsset(project.id, { type: 'location_reference' });
  const propAsset = timelineStore.addAsset(project.id, { type: 'keyframe' });
  for (const a of [charAsset, locAsset, propAsset]) timelineStore.setAssetApprovalStatus(project.id, a.assetId, 'APPROVED');
  creativeStore.updateVisualBible(project.id, {
    characters: [{ characterId: 'char-1', name: 'Mira', referenceAssets: [charAsset.assetId] }],
    locations: [{ locationId: 'loc-1', name: 'Pier', referenceAssets: [locAsset.assetId] }],
    props: [{ propId: 'prop-1', name: 'Compass', referenceAssets: [propAsset.assetId] }],
  });
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, sourceShotVersion: storyboard.version });

  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  assert.equal(fields.existingReferenceAssets.length, 3);
  const roleTypes = fields.existingReferenceAssets.map((e) => e.roleType).sort();
  assert.deepEqual(roleTypes, ['CHARACTER', 'ENVIRONMENT', 'PROP']);
});

test('11. a reference with no APPROVED asset produces a warning, and never a fabricated existingReferenceAssets entry', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.ok(!fields.existingReferenceAssets.some((e) => e.role.startsWith('location:')));
  assert.ok(fields.warnings.some((w) => w.includes('Approved reference asset not available') && w.includes('Lighthouse')));
});

test('a CANDIDATE (non-approved) reference asset does not satisfy the requirement', () => {
  const project = newProject();
  const asset = timelineStore.addAsset(project.id, { type: 'location_reference' });
  creativeStore.updateVisualBible(project.id, { locations: [{ locationId: 'loc-1', name: 'Pier', referenceAssets: [asset.assetId] }] });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, locationReferences: ['loc-1'] });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, frameType: 'WORLD_REFERENCE', sourceShotVersion: storyboard.version });

  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  assert.equal(fields.existingReferenceAssets.length, 0);
  assert.ok(fields.warnings.some((w) => w.includes('Approved reference asset not available')));
});

// --- 12. Continuity resolution ------------------------------------------------------------

test('12. continuity requirements are pulled from the Visual Bible, character, location, and shot', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.ok(fields.continuityRequirements.some((c) => c.includes('cold blue palette')));
  assert.ok(fields.continuityRequirements.some((c) => c.includes('scar must appear in every shot')));
  assert.ok(fields.continuityRequirements.some((c) => c.includes('lamp is always lit at night')));
  assert.ok(fields.continuityRequirements.some((c) => c.includes('keep the fog consistent')));
});

test('FIRST_FRAME/LAST_FRAME keyframes get a structural continuity note derived from frameType alone', () => {
  const { project, keyframe } = buildFixture({ keyframe: { frameType: 'FIRST_FRAME' } });
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  assert.ok(fields.continuityRequirements.some((c) => c.includes('FIRST_FRAME') && c.includes('LAST_FRAME')));
});

test('a second shot in the same scene records a previous-shot continuity relationship', () => {
  const { project, scene } = buildFixture();
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, purpose: 'Mira turns toward the door' });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe2 = keyframeStore.createKeyframe(project.id, { shotId: shot2.shotId, sceneId: scene.sceneId, frameType: 'ACTION_FRAME', sourceShotVersion: storyboard.version });

  const fields = kfp.resolvePackageFields(project.id, keyframe2.keyframeId);
  assert.ok(fields.continuityRequirements.some((c) => c.includes('Previous shot in scene')));
});

// --- 13/14. Negative constraint merging + deduplication -------------------------------

test('13. negative constraints combine the Master Creative Specification and Visual Bible sources', () => {
  const { project, keyframe } = buildFixture();
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);

  assert.ok(fields.negativeConstraints.includes('no blur'));
  assert.ok(fields.negativeConstraints.includes('no extra limbs'));
  assert.ok(fields.negativeConstraints.some((c) => c.includes('cold blue palette')));
});

test('14. negative constraints are deduplicated, but nothing explicit is silently dropped', () => {
  const project = newProject();
  creativeStore.updateMasterCreativeSpec(project.id, { negativeConstraints: ['no blur', 'no blur', 'no watermark'] });
  creativeStore.updateVisualBible(project.id, {});
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });

  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  const blurCount = fields.negativeConstraints.filter((c) => c === 'no blur').length;
  assert.equal(blurCount, 1, 'duplicates must be collapsed to one entry');
  assert.ok(fields.negativeConstraints.includes('no watermark'));
});

// --- 15. Skill recommendation ------------------------------------------------------------

test('15. a CHARACTER_REFERENCE keyframe recommends banana-pro-director-2.0', () => {
  const { project, keyframe } = buildFixture({ keyframe: { frameType: 'CHARACTER_REFERENCE' } });
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  assert.equal(fields.recommendedSkill, 'banana-pro-director-2.0');
  assert.ok(fields.recommendationReason.length > 0);
});

test('a COMPOSITION_FRAME keyframe recommends cinema-worldbuilder-pro-2.0', () => {
  const { project, keyframe } = buildFixture({ keyframe: { frameType: 'COMPOSITION_FRAME' } });
  const fields = kfp.resolvePackageFields(project.id, keyframe.keyframeId);
  assert.equal(fields.recommendedSkill, 'cinema-worldbuilder-pro-2.0');
});

// --- 16/17. Stale detection ---------------------------------------------------------------

test('16. a package becomes STALE when the storyboard changes after it was built', () => {
  const { project, keyframe, shot } = buildFixture();
  const built = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.equal(built.status, 'CURRENT');

  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised purpose' }, { changeNote: 'revise' });

  const reread = kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.equal(reread.status, 'STALE');
  assert.ok(reread.warnings.some((w) => w.includes('Source creative direction changed')));
});

test('17. a package becomes STALE when the keyframe plan changes after it was built', () => {
  const { project, keyframe } = buildFixture();
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  keyframeStore.createKeyframe(project.id, { shotId: keyframe.shotId, frameType: 'DETAIL_FRAME' }); // bumps the plan version

  const reread = kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.equal(reread.status, 'STALE');
});

test('staleness is computed live on read, never trusted from a stored value alone', () => {
  const { project, keyframe, shot } = buildFixture();
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });
  assert.equal(kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId).status, 'STALE');

  // Rebuilding refreshes sourceShotVersion, so it must go back to CURRENT.
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.equal(kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId).status, 'CURRENT');
});

// --- 18/19/20. Versioning + persistence + build ------------------------------------------

test('18/19/20. building a package the first time creates version 1; rebuilding bumps the version and records history', () => {
  const { project, keyframe } = buildFixture();
  const v1 = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId, { changeNote: 'first build' });
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.history, []);

  const v2 = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId, { changeNote: 'rebuild' });
  assert.equal(v2.version, 2);
  assert.equal(v2.history.length, 1);
  assert.equal(v2.history[0].version, 1);
  assert.equal(v2.packageId, v1.packageId, 'rebuilding must update the SAME package, not create a second one');

  const persisted = kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.equal(persisted.version, 2);
});

test('buildKeyframePromptPackage returns null for an unknown keyframeId', () => {
  const project = newProject();
  assert.equal(kfp.buildKeyframePromptPackage(project.id, 'nope'), null);
});

test('getKeyframePromptPackage returns null before any package has been built', () => {
  const { project, keyframe } = buildFixture();
  assert.equal(kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId), null);
});

// --- 21. List packages ---------------------------------------------------------------------

test('21. listKeyframePromptPackages lists every built package for a project, filterable by shotId', () => {
  const { project, keyframe, shot } = buildFixture();
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: keyframe.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe2 = keyframeStore.createKeyframe(project.id, { shotId: shot2.shotId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });
  kfp.buildKeyframePromptPackage(project.id, keyframe2.keyframeId);

  const all = kfp.listKeyframePromptPackages(project.id);
  assert.equal(all.length, 2);

  const onlyFirst = kfp.listKeyframePromptPackages(project.id, { shotId: shot.shotId });
  assert.equal(onlyFirst.length, 1);
  assert.equal(onlyFirst[0].keyframeId, keyframe.keyframeId);
});

test('listKeyframePromptPackages returns an empty array (not null) for a project with no packages yet', () => {
  const project = newProject();
  assert.deepEqual(kfp.listKeyframePromptPackages(project.id), []);
});

// --- project isolation ------------------------------------------------------------------

test('prompt packages never leak between projects', () => {
  const a = buildFixture();
  const b = buildFixture();
  kfp.buildKeyframePromptPackage(a.project.id, a.keyframe.keyframeId);

  assert.equal(kfp.listKeyframePromptPackages(a.project.id).length, 1);
  assert.equal(kfp.listKeyframePromptPackages(b.project.id).length, 0);
});

// --- 29/30/31. Never touches generation/approval/budget ------------------------------------

test('29/30/31. building/reading/listing prompt packages never creates a generation job or changes approval/budget state', () => {
  const { project, keyframe } = buildFixture();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId);
  kfp.listKeyframePromptPackages(project.id);

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.reserved, 0);
});

// --- keyframe-prompt-service.js never imports a provider/generation/approval module --------

test('services/keyframe-prompt-service.js has no require() of any provider, generation-service, or approval-gate module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-prompt-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});
