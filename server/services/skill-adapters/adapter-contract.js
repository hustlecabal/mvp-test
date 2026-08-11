// adapter-contract.js
//
// Stage 11B — the shared shape every skill adapter follows, plus small
// pure-text helper functions adapters use to parse a specialist skill's
// raw text output. Nothing here calls a skill, a provider, or the
// network — it only shapes/validates plain objects and strings.
//
// Every adapter module (see ./video-prompt-builder-adapter.js,
// ./cinema-worldbuilder-adapter.js) exports:
//   adapterId        — string, matches its entry in services/skill-registry.js
//   requiredInputs    — string[] of keys the adapter's `input` object must have
//   supportedOutputs  — string[] outputType values this adapter can produce
//   unsupportedFields — string[] describing what this adapter deliberately
//                       does NOT translate (Part 2) — e.g. platform-specific
//                       syntax that must never leak into structuredData
//   adapt(input, context) → normalized result (see createNormalizedResult)

class AdapterValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterValidationError';
  }
}

// Throws a clear, specific error listing exactly which required input keys
// are missing, rather than letting the adapter fail on a confusing
// downstream `undefined` access.
function requireFields(input, fields, adapterId) {
  const missing = fields.filter((key) => input[key] === undefined || input[key] === null);
  if (missing.length > 0) {
    throw new AdapterValidationError(`${adapterId} adapter is missing required input(s): ${missing.join(', ')}`);
  }
}

// Part 3 — the normalized result every adapter returns. `content` is the
// raw specialist output, preserved as-is for audit/debugging purposes —
// it is NEVER the source of truth. `structuredData` is our own normalized
// representation, built to match fields our Creative IR (Stage 11A)
// already understands. The two are kept deliberately separate so a raw
// skill output can never silently become canonical data.
function createNormalizedResult({ skillId, sourceArtifact, outputType, content, structuredData = {}, warnings = [] }) {
  return {
    skillId,
    sourceArtifact,
    outputType,
    content: content || null,
    structuredData,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

// Splits raw skill output text into sections keyed by a list of known
// heading strings. Best-effort and purely textual — if a heading isn't
// found, that section is simply absent from the result. Nothing is ever
// invented to fill a missing section.
//
// matchMode 'startsWith' (default, stricter) only matches a heading at the
// start of a trimmed line — needed for short/common words like "Movement"
// that could otherwise false-positive inside prose. 'includes' is looser,
// for long, distinctive multi-word headings unlikely to appear by accident.
function splitIntoSections(text, headings, { matchMode = 'startsWith' } = {}) {
  const sections = {};
  if (!text) return sections;

  const matchHeading = (line) => {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    return headings.find((h) => (matchMode === 'includes' ? upper.includes(h.toUpperCase()) : upper.startsWith(h.toUpperCase())));
  };

  let currentKey = null;
  let buffer = [];
  for (const line of text.split('\n')) {
    const matched = matchHeading(line);
    if (matched) {
      if (currentKey) sections[currentKey] = buffer.join('\n').trim();
      currentKey = matched;
      buffer = [];
      // Many skills put the section's content on the SAME line as its
      // label (e.g. "World Plate: Dawn, overcast, ..."), not on the next
      // line — capture that remainder as the first piece of this section.
      const remainder = line.trim().slice(matched.length).replace(/^[\s:—-]+/, '');
      if (remainder) buffer.push(remainder);
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  if (currentKey) sections[currentKey] = buffer.join('\n').trim();
  return sections;
}

module.exports = {
  AdapterValidationError,
  requireFields,
  createNormalizedResult,
  splitIntoSections,
};
