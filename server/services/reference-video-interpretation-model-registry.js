// reference-video-interpretation-model-registry.js
//
// INT-1D, Part 17 — a capabilities-and-pricing catalogue for REASONING
// (text-in/text-out) models, scoped to interpretation calls only.
//
// WHY A SEPARATE REGISTRY, NOT services/generation-model-registry.js
// (Part 17's explicit instruction to justify this): that file's `record()`
// shape is IMAGE/VIDEO-GENERATION-specific — textToImage/imageToVideo
// booleans, referenceImages/firstFrame/lastFrame, durations/resolutions/
// aspectRatios. None of that describes a text-reasoning model; forcing a
// reasoning model's real fields (contextWindowTokens, per-TOKEN pricing
// rather than per-generation credits, structured-output support) into
// that shape would mean either leaving every visual-generation field null
// (confusing — a reader would have to know those nulls mean "not
// applicable" rather than "not verified") or inventing meaningless values.
// This file reuses that registry's genuinely SHARED spirit instead —
// provider/model identification, an explicit verificationStatus,
// human-supplied costTier (never a computed formula, matching that
// file's own Stage 23 rule), a productionReady flag derived purely from
// verificationStatus — with fields that actually describe a reasoning
// model.
//
// PRICING SOURCE: https://platform.claude.com/docs/en/about-claude/pricing
// (fetched 2026-08-16 — see this stage's final report). Real, current,
// directly-sourced per-token USD prices, not estimated or invented.

const VERIFICATION_STATUSES = ['CATALOGUE_AVAILABLE', 'CAPABILITY_VERIFIED', 'SAFE_FOR_PRODUCTION'];
const COST_TIERS = ['BUDGET', 'STANDARD', 'QUALITY', 'OTHER'];

function record(overrides) {
  const base = {
    provider: null,
    model: null,
    displayName: null,
    verificationStatus: null,
    contextWindowTokens: null,
    maxOutputTokens: null,
    supportsStructuredOutput: true, // every model in this registry is used only via services/reference-video/claude-interpretation-provider.js's own strict JSON-object-response prompting — this records that the CATALOGUE entry is usable that way, never a vendor-guaranteed "JSON mode" flag
    pricing: { inputPerMillionTokensUsd: null, outputPerMillionTokensUsd: null, currency: 'USD', priceKnown: false },
    costTier: 'OTHER',
    docsUrl: null,
    notes: null,
  };
  const merged = { ...base, ...overrides, pricing: { ...base.pricing, ...(overrides.pricing || {}) } };
  merged.productionReady = merged.verificationStatus === 'SAFE_FOR_PRODUCTION';
  return merged;
}

function priced(inputPerMillionTokensUsd, outputPerMillionTokensUsd) {
  return { inputPerMillionTokensUsd, outputPerMillionTokensUsd, currency: 'USD', priceKnown: true };
}

const DOCS_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

const MODELS = {
  'claude/claude-sonnet-5': record({
    provider: 'claude',
    model: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    verificationStatus: 'SAFE_FOR_PRODUCTION',
    contextWindowTokens: 1000000,
    maxOutputTokens: 64000,
    pricing: priced(2, 10),
    costTier: 'STANDARD',
    docsUrl: DOCS_URL,
    notes: 'This stage\'s default interpretation model — the cost-effective, production-grade tier, matching this project\'s established "prefer the verified, cost-effective option" discipline (Stage 23\'s own model-selection precedent).',
  }),
  'claude/claude-opus-5': record({
    provider: 'claude',
    model: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    verificationStatus: 'SAFE_FOR_PRODUCTION',
    contextWindowTokens: 1000000,
    maxOutputTokens: 64000,
    pricing: priced(5, 25),
    costTier: 'QUALITY',
    docsUrl: DOCS_URL,
    notes: 'Higher-cost, higher-capability tier — available for interpretation questions that warrant it, never the default.',
  }),
  'claude/claude-haiku-4-5': record({
    provider: 'claude',
    model: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    verificationStatus: 'SAFE_FOR_PRODUCTION',
    contextWindowTokens: 200000,
    maxOutputTokens: 64000,
    pricing: priced(1, 5),
    costTier: 'BUDGET',
    docsUrl: DOCS_URL,
    notes: 'Cheapest verified option. Not the default — this stage has not evaluated interpretation-quality tradeoffs at this tier.',
  }),
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getModel(provider, model) {
  const key = `${provider}/${model}`;
  return MODELS[key] ? clone(MODELS[key]) : null;
}

function listModels({ productionReadyOnly } = {}) {
  let entries = Object.values(MODELS);
  if (productionReadyOnly) entries = entries.filter((e) => e.productionReady);
  return clone(entries);
}

// Part 18 — the cost gate's own arithmetic, kept here (next to the
// pricing data it depends on) rather than in the service. Returns null
// (never a fabricated number) when the model is unknown or its pricing
// isn't known — the caller (services/reference-video-interpretation-
// service.js) treats null as "cost cannot be determined safely" per
// Part 18's explicit instruction, never as zero/free.
function estimateCostUsd({ provider, model, estimatedInputTokens, estimatedOutputTokens }) {
  const entry = getModel(provider, model);
  if (!entry || !entry.pricing.priceKnown) return null;
  if (typeof estimatedInputTokens !== 'number' || typeof estimatedOutputTokens !== 'number') return null;
  const cost = (estimatedInputTokens * entry.pricing.inputPerMillionTokensUsd + estimatedOutputTokens * entry.pricing.outputPerMillionTokensUsd) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // round to the nearest micro-dollar — precise, never silently truncated to $0.00 for a genuinely small real cost
}

module.exports = { VERIFICATION_STATUSES, COST_TIERS, getModel, listModels, estimateCostUsd };
