// cinema-worldbuilder-adapter.js
//
// Stage 11B — Part 5. Normalizes cinema-worldbuilder-pro-2.0's raw text
// output (see /root/.claude/skills/synced/cinema-worldbuilder-pro-20/SKILL.md)
// into our canonical creative shape. Does NOT call the skill —
// `context.skillOutputText` is supplied by whoever ran the skill (Claude
// Code, or a test fixture).
//
// THE ONE JOB THIS FILE MUST NEVER FAIL AT: the skill's prompt embeds
// Higgsfield-specific `@image1`..`@image9` reference tags (its own
// "Subject Lock — @imageN:" block format). Those tags are Higgsfield UI
// syntax, not part of our Creative IR, and must never appear inside
// structuredData — see the runtime self-check at the bottom of adapt().
//
// The skill's own documented block order (its "THREE-PART DELIVERY
// FORMAT"): Scene & Mood -> Frame Map -> Subject Lock(s) -> Cross-Frame
// Rules -> Movement -> Last Frame -> World Plate -> Sound Bed -> Capture
// Realism -> Camera Capture. There is no dedicated "Lighting" block in the
// skill's format — lighting/atmosphere information lives in "World Plate"
// (location, time, weather, atmospheric quality), so that's what this
// adapter maps `lighting` to. That's a documented adapter design choice,
// not something the skill itself calls "lighting".

const { requireFields, createNormalizedResult, splitIntoSections } = require('./adapter-contract');

const ADAPTER_ID = 'cinema-worldbuilder-pro-2.0';
const REQUIRED_INPUTS = ['shot'];
const SUPPORTED_OUTPUTS = ['cinematic-shot-prompt'];
const UNSUPPORTED_FIELDS = [
  '@imageN tags are never copied into structuredData — they are translated into referenceAssets entries only.',
  'Cross-Frame Rules and Sound Bed are preserved only in `content`, not broken out as their own structuredData fields (not requested by Part 5).',
];

const BLOCK_HEADINGS = [
  'Scene & Mood',
  'Frame Map',
  'Subject Lock',
  'Cross-Frame Rules',
  'Movement',
  'Last Frame',
  'World Plate',
  'Sound Bed',
  'Capture Realism',
  'Camera Capture',
];

const IMAGE_TAG_PATTERN = /@image(\d+)/gi;

function extractImageTagIndexes(text) {
  if (!text) return [];
  const found = new Set();
  let match = IMAGE_TAG_PATTERN.exec(text);
  while (match !== null) {
    found.add(Number(match[1]));
    match = IMAGE_TAG_PATTERN.exec(text);
  }
  return [...found].sort((a, b) => a - b);
}

function stripImageTags(text) {
  if (!text) return null;
  const cleaned = text.replace(IMAGE_TAG_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim();
  return cleaned || null;
}

// input: { shot, visualBible?, scene?, referenceAssets? }
// context: { skillOutputText, referenceImageList? } — referenceImageList is
//   the skill's own numbered "attach these in order" list (part (a) of its
//   three-part delivery), used only to resolve what @imageN refers to.
function adapt(input = {}, context = {}) {
  requireFields(input, REQUIRED_INPUTS, ADAPTER_ID);
  const { shot } = input;
  const rawText = typeof context.skillOutputText === 'string' ? context.skillOutputText : '';
  const referenceImageList = Array.isArray(context.referenceImageList) ? context.referenceImageList : [];
  const warnings = [];

  if (!rawText) {
    warnings.push('No raw skill output text was supplied in context.skillOutputText — every structured block defaults to null.');
  }

  const sections = splitIntoSections(rawText, BLOCK_HEADINGS, { matchMode: 'startsWith' });

  const imageTagIndexes = extractImageTagIndexes(rawText);
  const referenceAssets = imageTagIndexes.map((index) => {
    const descriptor = referenceImageList[index - 1] || null;
    if (!descriptor) {
      warnings.push(`@image${index} was referenced in the prompt but referenceImageList has no entry at position ${index} — recorded with a null descriptor.`);
    }
    return { index, descriptor };
  });
  if (imageTagIndexes.length === 0 && referenceImageList.length > 0) {
    warnings.push('referenceImageList was supplied but no @imageN tags were found in the output text.');
  }

  const structuredData = {
    shotId: shot.shotId,
    frameMap: stripImageTags(sections['Frame Map']),
    subjectLock: stripImageTags(sections['Subject Lock']),
    camera: stripImageTags(sections['Camera Capture']),
    movement: stripImageTags(sections['Movement']),
    lighting: stripImageTags(sections['World Plate']),
    lastFrame: stripImageTags(sections['Last Frame']),
    referenceAssets,
  };

  // The one guarantee Part 5 demands, enforced at runtime rather than only
  // by convention: @image syntax must never leak into our canonical data.
  if (JSON.stringify(structuredData).toLowerCase().includes('@image')) {
    throw new Error(`${ADAPTER_ID} adapter bug: @image syntax leaked into structuredData — this must never happen.`);
  }

  return createNormalizedResult({
    skillId: ADAPTER_ID,
    sourceArtifact: 'storyboardShot',
    outputType: 'cinematic-shot-prompt',
    content: rawText || null,
    structuredData,
    warnings,
  });
}

module.exports = {
  adapterId: ADAPTER_ID,
  requiredInputs: REQUIRED_INPUTS,
  supportedOutputs: SUPPORTED_OUTPUTS,
  unsupportedFields: UNSUPPORTED_FIELDS,
  adapt,
};
