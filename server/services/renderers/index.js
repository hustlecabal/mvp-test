// index.js — maps renderSpec.type -> renderer module, mirroring services/
// material-executors/index.js's exact convention (a plain lookup object,
// no logic). services/renderer-registry.js is the only caller.
//
// Stage 26.8C: BROLL_CLIP now routes to hyperframes-renderer.js — the only
// renderer in this directory with real video decode/trim capability (see
// that file's own header for why the other 5 types stay on their existing,
// already-tested SVG renderers rather than also moving to HyperFrames).
// broll-clip-renderer.js (the honest FFmpeg-less blocker) remains in the
// codebase and is still directly tested — it's simply no longer the
// registered default now that the real blocker is resolved.

module.exports = {
  ASSET_PLACEMENT: require('./asset-placement-renderer'),
  STILL_IMAGE_MOTION: require('./still-image-motion-renderer'),
  KINETIC_TYPOGRAPHY: require('./kinetic-typography-renderer'),
  MOTION_GRAPHIC: require('./motion-graphic-renderer'),
  WHITEBOARD: require('./whiteboard-renderer'),
  BROLL_CLIP: require('./hyperframes-renderer'),
};
