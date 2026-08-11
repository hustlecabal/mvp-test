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
  'gpt-image-2': {
    task: 'text-to-image',
    endpointPath: '/v1/images/generations',
    requestSchemaVerified: false, // only seen in quickstart's abbreviated example, not a full opened spec
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/gpt-image-2/gpt-image-2-image-generation',
  },
};

module.exports = EVOLINK_MODELS;
