// index.js — maps renderSpec.type -> renderer module, mirroring services/
// material-executors/index.js's exact convention (a plain lookup object,
// no logic). services/renderer-registry.js is the only caller.

module.exports = {
  ASSET_PLACEMENT: require('./asset-placement-renderer'),
  STILL_IMAGE_MOTION: require('./still-image-motion-renderer'),
  KINETIC_TYPOGRAPHY: require('./kinetic-typography-renderer'),
  MOTION_GRAPHIC: require('./motion-graphic-renderer'),
  WHITEBOARD: require('./whiteboard-renderer'),
  BROLL_CLIP: require('./broll-clip-renderer'),
};
