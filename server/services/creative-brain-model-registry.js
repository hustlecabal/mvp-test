// creative-brain-model-registry.js
//
// CREATIVE BRAIN — a capabilities-and-pricing catalogue for creative
// synthesis (text-in/text-out) calls, mirroring services/reference-video-
// interpretation-model-registry.js's exact shape/rationale (that file's
// own header justifies why a reasoning-model registry is separate from
// services/generation-model-registry.js — the same justification applies
// here unchanged).
//
// COST BUCKET DECISION (this stage's sign-off): Creative Brain spend
// settles against the EXISTING `anthropic` usdSpend bucket in services/
// approval-gate.js — no new bucket, no schema change there. This registry
// exists only for cost ESTIMATION or pricing lookup; it never mutates the
// ledger itself.
//
// PRICING SOURCE: identical models/prices as reference-video-
// interpretation-model-registry.js (same vendor, same public pricing
// page, fetched the same date — see that file's own header).

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
    supportsStructuredOutput: true,
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
    notes: "This stage's default creative-synthesis model — matches reference-video-interpretation-model-registry.js's own default for the same reason (cost-effective, production-grade).",
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
    notes: 'Higher-cost, higher-capability tier — available, never the default.',
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
    notes: 'Cheapest verified option. Not the default — creative-quality tradeoffs at this tier not evaluated.',
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

// Returns null (never a fabricated number) when pricing/estimate inputs
// are unknown — same discipline as the interpretation registry's own
// estimateCostUsd.
function estimateCostUsd({ provider, model, estimatedInputTokens, estimatedOutputTokens }) {
  const entry = getModel(provider, model);
  if (!entry || !entry.pricing.priceKnown) return null;
  if (typeof estimatedInputTokens !== 'number' || typeof estimatedOutputTokens !== 'number') return null;
  const cost = (estimatedInputTokens * entry.pricing.inputPerMillionTokensUsd + estimatedOutputTokens * entry.pricing.outputPerMillionTokensUsd) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

module.exports = { VERIFICATION_STATUSES, COST_TIERS, getModel, listModels, estimateCostUsd };
