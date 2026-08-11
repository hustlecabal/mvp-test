// video-prompt-builder-adapter.js
//
// Stage 11B — Part 4. Normalizes video-prompt-builder's raw text output
// (see /root/.claude/skills/synced/video-prompt-builder/SKILL.md) into our
// canonical creative shape. Does NOT call the skill — `context.skillOutputText`
// is supplied by whoever ran the skill (Claude Code, or a test fixture).
//
// video-prompt-builder always outputs 4 fixed sections, in order:
//   1. SHOT-BY-SHOT EFFECTS TIMELINE
//   2. MASTER EFFECTS INVENTORY
//   3. EFFECTS DENSITY MAP
//   4. ENERGY ARC
// (see the skill's own "Output structure" section). This adapter parses
// those exact sections — nothing here is a guess about undocumented
// behavior.

const { requireFields, createNormalizedResult, splitIntoSections } = require('./adapter-contract');

const ADAPTER_ID = 'video-prompt-builder';
const REQUIRED_INPUTS = ['storyboardShot'];
const SUPPORTED_OUTPUTS = ['shot-prompt'];
// This adapter never attempts to parse anything beyond the 4 documented
// sections — any other structure in the raw text is preserved only in
// `content`, never promoted into structuredData.
const UNSUPPORTED_FIELDS = ['Any section beyond the 4 documented ones is left out of structuredData and only available via `content`.'];

const SECTION_HEADINGS = ['SHOT-BY-SHOT EFFECTS TIMELINE', 'MASTER EFFECTS INVENTORY', 'EFFECTS DENSITY MAP', 'ENERGY ARC'];

// Best-effort: within the shot timeline, pick out bullet lines that
// actually describe camera/movement behavior (the skill's own per-shot
// format includes a "Camera behaviour — angle, movement, lens" bullet).
const MOVEMENT_LINE_PATTERN = /camera|movement|speed|pan|zoom|dolly|tilt|handheld|push|pull|ramp/i;

function extractMovementLines(timelineText) {
  if (!timelineText) return null;
  const lines = timelineText.split('\n').filter((line) => line.trim().startsWith('•') && MOVEMENT_LINE_PATTERN.test(line));
  return lines.length > 0 ? lines.join('\n').trim() : null;
}

// input: { storyboardShot, creativeBrief?, masterCreativeSpec?, visualBible? }
//   (creativeBrief/masterCreativeSpec/visualBible are accepted as optional
//   context for a future stage that builds the skill's INPUT prompt — this
//   adapter only normalizes the skill's OUTPUT, so they're unused here.)
// context: { skillOutputText } — the raw text the skill produced.
function adapt(input = {}, context = {}) {
  requireFields(input, REQUIRED_INPUTS, ADAPTER_ID);
  const { storyboardShot } = input;
  const rawText = typeof context.skillOutputText === 'string' ? context.skillOutputText : '';
  const warnings = [];

  if (!rawText) {
    warnings.push('No raw skill output text was supplied in context.skillOutputText — structuredData falls back to the storyboard shot\'s own fields only.');
  }

  const sections = splitIntoSections(rawText, SECTION_HEADINGS, { matchMode: 'includes' });
  const timeline = sections['SHOT-BY-SHOT EFFECTS TIMELINE'] || null;
  const inventory = sections['MASTER EFFECTS INVENTORY'] || null;
  const densityMap = sections['EFFECTS DENSITY MAP'] || null;
  const energyArc = sections['ENERGY ARC'] || null;

  if (rawText && !timeline) {
    warnings.push('Could not find a "SHOT-BY-SHOT EFFECTS TIMELINE" section in the supplied output — shotPrompt falls back to the full raw text.');
  }

  const movementNotes = extractMovementLines(timeline);
  if (timeline && !movementNotes) {
    warnings.push('No camera-movement-related bullet lines were found in the effects timeline.');
  }

  const structuredData = {
    shotId: storyboardShot.shotId,
    shotPrompt: timeline || rawText || storyboardShot.promptDraft || null,
    cinematographyNotes: inventory,
    movementNotes,
    effectsNotes: [densityMap, energyArc].filter(Boolean).join('\n\n') || null,
  };

  return createNormalizedResult({
    skillId: ADAPTER_ID,
    sourceArtifact: 'storyboardShot',
    outputType: 'shot-prompt',
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
