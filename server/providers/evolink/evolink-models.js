// evolink-models.js
//
// The ONLY place EvoLink model identifiers are allowed to appear as
// literal strings. Every entry here was confirmed against an official
// EvoLink documentation page (see docsUrl) — never guessed.
//
// requestSchemaVerified: true  = the full request/response field list was
//   independently opened and read (via that page's embedded OpenAPI spec).
//   evolink-mapper.js will build requests for these.
// requestSchemaVerified: false = the identifier is confirmed to exist
//   (seen directly on evolink.ai/docs), but its exact request fields have
//   NOT been independently checked. evolink-mapper.js refuses to build a
//   request for these until requestSchemaVerified is flipped to true —
//   which should only happen after actually opening that model's own
//   docs page. See docs/integrations/evolink-api.md for what's been
//   checked so far.

const EVOLINK_MODELS = {
  'seedance-2.5-text-to-video': {
    task: 'text-to-video',
    endpointPath: '/v1/videos/generations',
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-text-to-video',
  },
  'seedance-2.5-image-to-video': {
    task: 'image-to-video',
    endpointPath: '/v1/videos/generations',
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-image-to-video',
  },
  'seedance-2.5-reference-to-video': {
    task: 'reference-to-video',
    endpointPath: '/v1/videos/generations',
    requestSchemaVerified: false,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-reference-to-video',
  },
  'seedance-2.5-video-edit': {
    task: 'video-edit',
    endpointPath: '/v1/videos/generations',
    requestSchemaVerified: false,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-video-edit',
  },
  'seedance-2.5-video-extend': {
    task: 'video-extend',
    endpointPath: '/v1/videos/generations',
    requestSchemaVerified: false,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-video-extend',
  },
  // Stage 22B cost-optimisation investigation — full OpenAPI spec opened
  // directly (evolink.ai/docs/en/api-manual/video-series/seedance1.0/
  // seedance-1.0-pro-fast-video-generate). Reuses the exact same
  // image_urls/duration/quality/aspect_ratio field names and single-image
  // first-frame semantics as seedance-2.5-image-to-video, so task:
  // 'image-to-video' is correct here too — no new mapper branch needed.
  'doubao-seedance-1.0-pro-fast': {
    task: 'image-to-video',
    endpointPath: '/v1/videos/generations',
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance1.0/seedance-1.0-pro-fast-video-generate',
  },
  // Stage 15 opened this model's own dedicated OpenAPI spec page (not just
  // the quickstart's abbreviated example that Stage 6 originally saw) —
  // full request/response field list independently verified, including
  // image_urls (1-16 reference images), size, resolution, quality, n,
  // mask_url, callback_url. See docs/integrations/image-provider-investigation.md
  // Part 4b.
  'gpt-image-2': {
    task: 'image-generation',
    endpointPath: '/v1/images/generations',
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/gpt-image-2/gpt-image-2-image-generation',
  },
  // Stage 15 — "Nano Banana Pro" (Google's gemini-3-pro-image), resold by
  // EvoLink. Full request schema independently verified from its own
  // dedicated OpenAPI spec page: image_urls (up to 14 reference images, max
  // 5 real-person images), size, quality, model_params, callback_url. See
  // docs/integrations/image-provider-investigation.md Part 4a — this is the
  // Stage 15/16 recommended model.
  'gemini-3-pro-image-preview': {
    task: 'image-generation',
    endpointPath: '/v1/images/generations',
    requestSchemaVerified: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/nanobanana/nanobanana-pro-image-generate',
  },
};

module.exports = EVOLINK_MODELS;
