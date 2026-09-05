// openmontage-adapter-interface.js
//
// Section 20 — OPENMONTAGE BOUNDARY. No OpenMontage integration exists in
// this repository (Phase 0 audit — one incidental doc mention only, no
// code). This file defines ONLY the attachment point a future adapter
// would implement — it contains no OpenMontage-specific logic, no compile
// implementation, and is never called from anywhere yet.
//
//   EVOLINK CANONICAL PROJECT (schemas/creative-schema.js's Storyboard /
//   VisualBible / Character / Location / Prop / GenerationUnit family)
//     |
//     v
//   OPENMONTAGE ADAPTER  <-- this interface
//     |
//     v
//   OPENMONTAGE PRODUCTION PACKAGE (engine-specific — never defined here)
//
// The canonical project stays model/engine-agnostic: nothing in
// creative-schema.js imports this file, and this file never reaches back
// into creative-schema.js's internals beyond the plain objects it's handed.
// A real adapter, when built, converts a Storyboard + VisualBible +
// resolved GenerationUnits into whatever shape OpenMontage's own
// production package requires — that conversion is 100% out of scope for
// this milestone.

function assertImplementsOpenMontageAdapterInterface(adapter) {
  if (!adapter || typeof adapter.compile !== 'function') {
    throw new Error('OpenMontage adapter must implement compile(canonicalProject) -> OpenMontageProductionPackage');
  }
}

module.exports = { assertImplementsOpenMontageAdapterInterface };
