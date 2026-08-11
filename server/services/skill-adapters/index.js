// index.js — maps skill id -> adapter module, for skill-orchestrator.js to
// look up by id. Only skills with a real adapter appear here; a skill in
// services/skill-registry.js with `adapter: null` (e.g.
// banana-pro-director-2.0) deliberately has no entry.

module.exports = {
  'video-prompt-builder': require('./video-prompt-builder-adapter'),
  'cinema-worldbuilder-pro-2.0': require('./cinema-worldbuilder-adapter'),
};
