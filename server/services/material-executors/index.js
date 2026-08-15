// index.js — maps executorType -> executor module, mirroring
// services/skill-adapters/index.js's exact convention (a plain lookup
// object, no logic). services/material-executor-registry.js is the only
// caller.

module.exports = {
  PROJECT_ASSET_REUSE: require('./project-asset-reuse-executor'),
  STILL_IMAGE_MOTION: require('./still-image-motion-executor'),
  KINETIC_TYPOGRAPHY: require('./kinetic-typography-executor'),
  MOTION_GRAPHIC: require('./motion-graphic-executor'),
  WHITEBOARD: require('./whiteboard-executor'),
  BROLL_CLIP: require('./broll-executor'), // Stage 26.5B, Part 5
};
