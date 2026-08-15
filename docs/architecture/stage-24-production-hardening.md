# Stage 24 — Production Hardening & End-to-End UI Acceptance

Stage 24's question was narrower than "does the architecture work" (Stages
1-23 already answered that): **can the whole pipeline — project creation
through an approved video — be driven entirely through the intended UI,
with no backend data manipulated by hand?** This doc records what the
audit found and fixed, and points at the docs that already describe the
rest of the system correctly.

## Method

A disposable project ("STAGE 24 ACCEPTANCE TEST") was created and driven
end-to-end through a real Chromium browser (Playwright), against a server
instance pointed at an isolated data directory (`PROJECT_DATA_DIR` and its
sibling `*_DATA_DIR` env vars, all under a scratch path) with
`EVOLINK_API_KEY` explicitly emptied — so any accidental click on a real
GENERATE control would fail safely instead of spending a credit. The real
smoke-test projects under `server/data/` were never touched.

## Gaps found and fixed

Four genuine UI-completeness gaps surfaced from actually clicking through
the app, not from reading source:

1. **No storyboard scene/shot creation control.** The Storyboard workspace
   could display scenes/shots but had no way to create one — the MCP tools
   (`create_storyboard_scene`, `create_storyboard_shot`) existed, but
   nothing in the REST layer or frontend did. Added
   `POST /projects/:id/creative/storyboard/scenes` and
   `.../storyboard/shots` (thin wrappers over the existing
   `creative-store.js` functions, same change-note discipline as every
   other creative write), plus `renderAddSceneControl` /
   `renderAddShotControl` in the Storyboard view.

2. **No way to act on a keyframe recommendation.** `ANALYZE KEYFRAMES`
   (Stage 12) is deliberately read-only — that rule is unchanged. But
   there was no separate, explicit action to actually record one of its
   recommendations as a keyframe; a shot could be analyzed forever without
   ever getting a keyframe out of it. Added one **ADD THIS KEYFRAME**
   button per recommendation in the "Recommended (new)" group only — never
   a batch/auto-accept — calling the pre-existing
   `POST /projects/:id/keyframes` endpoint with that recommendation's own
   fields.

3. **No way to upload a reference image.** `POST .../reference-assets`
   (Stage 19) only ever accepted an `assetId` that already existed — there
   was no endpoint that turned a human's raw image bytes into one, so
   `character_reference`/`location_reference` assets (declared in
   `production-schema.js` since Stage 19, never actually created) had no
   path into the system. Added
   `POST /projects/:id/reference-library/:entityType/:entityId/upload`
   (raw-body, same convention as the existing
   `POST /handoffs/:handoffId/asset`: the request body *is* the image
   bytes, sniffed from magic bytes via `asset-storage.js`, never trusted
   from Content-Type or filename) and a matching **ADD AS CANDIDATE**
   file-upload control in the Reference Library.

4. **A freshly uploaded reference could never be selected as canonical.**
   Once gap 3 was fixed, uploaded candidates sat in the library
   permanently unselectable: `renderReferenceAssetCard` only showed
   **SELECT AS CANONICAL** when `asset.approvalStatus === 'APPROVED'`, but
   `creative-store.js`'s `selectCanonicalReferenceAsset` only ever blocks
   `REJECTED` assets — `NONE` (unreviewed) has always been backend-eligible.
   Nothing in the system ever promotes a human-uploaded reference asset
   from `NONE` to `APPROVED` (that transition only exists for
   machine-generated keyframes/videos via
   `approveGeneratedKeyframe`/`approveGeneratedVideo`), so the stricter
   frontend condition meant every uploaded candidate was permanently
   stuck. Fixed the condition to match the backend's actual gate
   (`approvalStatus !== 'REJECTED'`).

All four are additive — no existing route, schema, or approval rule
changed shape. See `server/test/creative-director-api.test.js`,
`server/test/reference-library-api.test.js`, and
`server/test/reference-library-frontend.test.js` for the regression tests
each gap got.

## Everything else audited, not changed

Parts 2-6 of the Stage 24 mandate (failure/recovery invariants, security,
cost display, model registry, legacy-pipeline distinction) were audited
against the existing implementation and test suite and found already
correct — see the Stage 24 final report for the invariant-by-invariant
mapping. Nothing there needed a code change. In particular:

- **Model registry, cost tiers, observed-cost semantics**:
  `docs/architecture/generation-model-registry.md`.
- **Budget/approval lifecycle**: `docs/architecture/budget-safety.md`,
  `docs/architecture/control-surfaces.md`.
- **Operator Queue states**: `docs/architecture/operator-queue.md`.
- **VideoPromptPackage**: `docs/architecture/video-prompt-package.md`.
- **Legacy vs. current generation pipeline**:
  `docs/architecture/generation-lifecycle.md` (header) and
  `docs/architecture/video-generation-lifecycle.md` — `generation-service.js`
  is the original, project-level pipeline (MCP-only, no REST route, no
  frontend usage anywhere); `video-generation-service.js` is the current,
  per-shot pipeline bound to a versioned `VideoPromptPackage` + explicit
  approval + exact canonical keyframe asset. The old file is kept
  untouched as reference material; nothing in the UI points at it.
