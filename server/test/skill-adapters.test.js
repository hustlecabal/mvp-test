// Tests for the skill adapters (services/skill-adapters/*.js) using
// fixture text — no real skill is ever invoked, no network call is made.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNormalizedResult, requireFields, AdapterValidationError, splitIntoSections } = require('../services/skill-adapters/adapter-contract');
const videoPromptBuilderAdapter = require('../services/skill-adapters/video-prompt-builder-adapter');
const cinemaWorldbuilderAdapter = require('../services/skill-adapters/cinema-worldbuilder-adapter');

// --- 9. normalized result shape -----------------------------------------------

test('9. createNormalizedResult produces the Part 3 contract shape', () => {
  const result = createNormalizedResult({
    skillId: 'x',
    sourceArtifact: 'storyboardShot',
    outputType: 'shot-prompt',
    content: 'raw text',
    structuredData: { a: 1 },
    warnings: ['w1'],
  });

  assert.equal(result.skillId, 'x');
  assert.equal(result.sourceArtifact, 'storyboardShot');
  assert.equal(result.outputType, 'shot-prompt');
  assert.equal(result.content, 'raw text');
  assert.deepEqual(result.structuredData, { a: 1 });
  assert.deepEqual(result.warnings, ['w1']);
  assert.ok(result.generatedAt);
});

test('createNormalizedResult defaults structuredData/warnings and never fabricates content', () => {
  const result = createNormalizedResult({ skillId: 'x', sourceArtifact: 'y', outputType: 'z' });
  assert.equal(result.content, null);
  assert.deepEqual(result.structuredData, {});
  assert.deepEqual(result.warnings, []);
});

// --- 10. adapter input validation ----------------------------------------------

test('10. requireFields throws AdapterValidationError listing exactly what is missing', () => {
  assert.throws(
    () => requireFields({ a: 1 }, ['a', 'b', 'c'], 'test-adapter'),
    (err) => {
      assert.ok(err instanceof AdapterValidationError);
      assert.match(err.message, /test-adapter/);
      assert.match(err.message, /b, c/);
      return true;
    }
  );
});

test('video-prompt-builder adapter rejects input missing storyboardShot', () => {
  assert.throws(() => videoPromptBuilderAdapter.adapt({}, {}), AdapterValidationError);
});

test('cinema-worldbuilder adapter rejects input missing shot', () => {
  assert.throws(() => cinemaWorldbuilderAdapter.adapt({}, {}), AdapterValidationError);
});

// --- splitIntoSections helper ---------------------------------------------------

test('splitIntoSections is best-effort: a missing heading produces no entry, never an invented one', () => {
  const sections = splitIntoSections('just some prose with no headings', ['SECTION A', 'SECTION B']);
  assert.deepEqual(sections, {});
});

test('splitIntoSections startsWith mode avoids false positives on common words mid-prose', () => {
  const text = 'Scene & Mood: a quiet dawn.\nSome unrelated line mentioning movement in passing.\nMovement: the character walks slowly.';
  const sections = splitIntoSections(text, ['Scene & Mood', 'Movement'], { matchMode: 'startsWith' });
  assert.equal(sections['Scene & Mood'].includes('unrelated line'), true, 'the unrelated line must be attributed to Scene & Mood, not treated as a new Movement heading');
  assert.match(sections['Movement'], /walks slowly/);
});

// --- 5. video-prompt-builder compatibility / 11. adapter output normalization -

const VIDEO_PROMPT_FIXTURE = `
SHOT-BY-SHOT EFFECTS TIMELINE
SHOT 1 (0:00-0:02) — Runner enters frame
• EFFECT: speed ramp (deceleration)
• Runner sprints into frame from camera-left, dust kicking up behind
• Camera behaviour — handheld tracking shot, 35mm, slight shake
• Speed: approximately 20-25% at the peak of the ramp
• Exits into Shot 2 via a whip pan

MASTER EFFECTS INVENTORY
1. Speed ramp (deceleration) — used 1x — Shot 1 — slows the runner's entrance for impact

EFFECTS DENSITY MAP
0:00-0:02 = HIGH DENSITY (speed ramp, whip pan — 2 effects in 2s)

ENERGY ARC
Act 1: explosive entrance. Act 2: sustained tension. Act 3: triumphant landing.
`;

test('5 & 11. video-prompt-builder adapter normalizes the 4 documented sections', () => {
  const result = videoPromptBuilderAdapter.adapt(
    { storyboardShot: { shotId: 'shot-1', promptDraft: null } },
    { skillOutputText: VIDEO_PROMPT_FIXTURE }
  );

  assert.equal(result.skillId, 'video-prompt-builder');
  assert.equal(result.outputType, 'shot-prompt');
  assert.equal(result.content, VIDEO_PROMPT_FIXTURE);
  assert.match(result.structuredData.shotPrompt, /Runner sprints into frame/);
  assert.match(result.structuredData.cinematographyNotes, /Speed ramp \(deceleration\)/);
  assert.match(result.structuredData.movementNotes, /handheld tracking shot/);
  assert.match(result.structuredData.effectsNotes, /HIGH DENSITY/);
  assert.match(result.structuredData.effectsNotes, /Act 1/);
  assert.deepEqual(result.warnings, []);
});

test('video-prompt-builder adapter degrades gracefully with no raw text — never crashes, warns instead', () => {
  const result = videoPromptBuilderAdapter.adapt(
    { storyboardShot: { shotId: 'shot-1', promptDraft: 'fallback draft text' } },
    {}
  );

  assert.equal(result.content, null);
  assert.equal(result.structuredData.shotPrompt, 'fallback draft text', 'falls back to the storyboard shot\'s own promptDraft, never invents one');
  assert.ok(result.warnings.length > 0);
});

// --- 6/12. cinema-worldbuilder compatibility + @image syntax isolation --------

const CINEMA_FIXTURE = `
Scene & Mood: A quiet lighthouse at dawn, mist rolling off the water.

Frame Map: Subject centered, midground, facing the horizon. Negative space above the head for the sky.

Subject Lock — @image1: Identity anchor from reference. Standing, hands on the railing, gaze fixed on the horizon, damp hair from the mist.

Cross-Frame Rules: Subject never crosses center. Screen side held throughout.

Movement: Slow push-in over the full runtime, subject remains still, mist drifts right to left.

Last Frame: Subject fully still, gaze unbroken, mist thick around the shoulders. No on-screen text.

World Plate: Dawn, overcast, cold blue light from the left, damp stone underfoot, anchored to @image2.

Sound Bed: distant foghorn, water lapping, wind.

Capture Realism: depth via suspended atmosphere between planes, moisture-without-shine on skin.

Camera Capture: 50mm spherical, static tripod, Kodak 5219 emulation, 24fps, 8s runtime.
`;

test('6 & 12. cinema-worldbuilder adapter normalizes blocks and isolates @image syntax into referenceAssets', () => {
  const result = cinemaWorldbuilderAdapter.adapt(
    { shot: { shotId: 'shot-2' } },
    { skillOutputText: CINEMA_FIXTURE, referenceImageList: ['locked character reference', 'lighthouse environment plate'] }
  );

  assert.equal(result.skillId, 'cinema-worldbuilder-pro-2.0');
  assert.equal(result.outputType, 'cinematic-shot-prompt');
  assert.match(result.structuredData.frameMap, /Negative space above the head/);
  assert.match(result.structuredData.subjectLock, /hands on the railing/);
  assert.match(result.structuredData.movement, /push-in/);
  assert.match(result.structuredData.lastFrame, /gaze unbroken/);
  assert.match(result.structuredData.lighting, /cold blue light/);
  assert.match(result.structuredData.camera, /50mm spherical/);

  // The critical guarantee (Part 5/12): no @image token anywhere in structuredData.
  assert.equal(JSON.stringify(result.structuredData).toLowerCase().includes('@image'), false);

  assert.deepEqual(result.structuredData.referenceAssets, [
    { index: 1, descriptor: 'locked character reference' },
    { index: 2, descriptor: 'lighthouse environment plate' },
  ]);
  assert.deepEqual(result.warnings, []);

  // The raw text (with @image tags) is still preserved, just never in structuredData.
  assert.match(result.content, /@image1/);
});

test('cinema-worldbuilder adapter warns when an @imageN tag has no matching reference descriptor', () => {
  const result = cinemaWorldbuilderAdapter.adapt(
    { shot: { shotId: 'shot-2' } },
    { skillOutputText: 'Subject Lock — @image1: locked.', referenceImageList: [] }
  );

  assert.deepEqual(result.structuredData.referenceAssets, [{ index: 1, descriptor: null }]);
  assert.ok(result.warnings.some((w) => w.includes('@image1')));
});

test('cinema-worldbuilder adapter never throws its own internal leak-guard on normal input', () => {
  assert.doesNotThrow(() => cinemaWorldbuilderAdapter.adapt({ shot: { shotId: 'x' } }, { skillOutputText: CINEMA_FIXTURE }));
});

// --- 7. banana-pro-director compatibility (no adapter exists) -----------------

test('7. banana-pro-director-2.0 has no adapter — it is recommendable but not executable', () => {
  const registry = require('../services/skill-registry');
  const skill = registry.getSkill('banana-pro-director-2.0');
  assert.equal(skill.adapter, null);
  assert.equal(skill.enabled, true, 'still a real, installed skill — just not wired up yet');
});
