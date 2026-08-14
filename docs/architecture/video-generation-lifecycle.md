# Video Generation Lifecycle (Stage 22B-Part-3)

`server/schemas/video-generation-approval-schema.js` +
`server/services/video-generation-approval-store.js` +
`server/services/video-generation-service.js` +
`server/schemas/video-generation-result-schema.js`. This stage builds the
production-controlled VIDEO generation layer on top of Stage 22B-Part-2's
`VideoPromptPackage`: an explicit, package-bound approval, a central
execution boundary that re-validates everything server-side before ever
calling a provider, and a normalized result. It is deliberately **not** a
resurrection of the older project-level pipeline documented in
[generation-lifecycle.md](./generation-lifecycle.md) — see "Relationship
to the older pipeline" below.

## The full chain

```
Storyboard Shot → Creative Brief/Master Spec/Visual Bible
                → Keyframe Plan → canonical APPROVED keyframe image
                → VideoPromptPackage (Stage 22B-Part-2)
                → VideoGenerationApproval (this stage)
                → services/video-generation-service.js
                → provider adapter (EvoLink today, Google later)
                → Generation Job → archived video Asset
```

## VideoGenerationApproval — exact binding, not a general "yes"

Mirrors `KeyframeGenerationApproval`'s shape and lifecycle (`NONE` →
`PENDING` → `APPROVED`/`REJECTED`), one per keyframe
(`services/video-generation-approval-store.js`, one JSON file per project
keyed by `keyframeId`), but binds to five fields at once, captured from
the package at request time:

- `videoPromptPackageId` + `videoPromptPackageVersion`
- `canonicalKeyframeAssetId`
- `provider` + `model`

If **any** of these no longer match the live package when generation is
attempted, the approval no longer authorizes anything — an approval for
package version 1 can never generate version 2, an approval bound to
canonical asset A can never generate against canonical asset B, and an
EvoLink approval can never silently execute against Google. This
re-validation happens fresh on every `canGenerateVideo`/`generateVideo`
call — the approval's own stored fields are a snapshot, never a live
value the service trusts blindly.

**Known-quirk note:** `keyframe-generation-approval-store.js`'s
`decideApproval()` never sets `approvedAt` (only `decidedAt`/
`approvedBy`) — a long-standing, unchanged quirk of that store. This
NEW store deliberately does not repeat it: `video-generation-approval-
store.js`'s `decideApproval()` sets `approvedAt` on approval, so a caller
of this store can rely on it (see the schema file's header comment).

## Eligibility — `canGenerateVideo()`

`services/video-generation-service.js`'s `runSafetyChecks()` (shared,
read-only, by `canGenerateVideo()` and continued by `generateVideo()`)
verifies, in order, and returns a structured `{ ok: false, code, reason }`
on the first failure — **never throws for an ordinary ineligibility**:

| # | Check | Code |
|---|---|---|
| 1-2 | project & shot exist | `PROJECT_NOT_FOUND` / `SHOT_NOT_FOUND` |
| 3-4 | video prompt package exists and is `CURRENT` | `NO_VIDEO_PROMPT_PACKAGE` / `VIDEO_PACKAGE_STALE` |
| 5-6 | an approval exists and is `APPROVED` | `NO_VIDEO_GENERATION_APPROVAL` |
| 7-8 | approval's package id + version match | `APPROVAL_PACKAGE_MISMATCH` |
| 9 | approval's canonical asset matches | `APPROVAL_CANONICAL_ASSET_MISMATCH` |
| 10-11 | canonical asset is still APPROVED and still belongs to this keyframe | `CANONICAL_ASSET_NOT_APPROVED` / `CANONICAL_ASSET_NOT_ASSOCIATED` |
| 12-13 | approval's provider/model still match the package | `APPROVAL_PROVIDER_MISMATCH` / `APPROVAL_MODEL_MISMATCH` |
| 14-16 | model registry: exists, capable, verification recorded | `UNKNOWN_MODEL` / `MODEL_CAPABILITY_UNSUPPORTED` / `MODEL_VERIFICATION_MISSING` |
| 18-19 | project budget allows it, unknown-cost policy satisfied | `BUDGET_BLOCKED` / `UNKNOWN_COST_NOT_ACKNOWLEDGED` |
| 20 | no active duplicate generation | (returns the existing job instead of an error) |
| 21 | no active keyframe execution handoff conflicting with the canonical asset | `HANDOFF_CONFLICT` |
| 22 | a provider adapter is registered | `PROVIDER_ADAPTER_NOT_FOUND` |
| 23 | execution parameters are structurally valid | `INVALID_EXECUTION_PARAMETERS` |

Checks 14-16 are true defense-in-depth: `VideoPromptPackage`'s own build-time
validation (Stage 22B-Part-2) already refuses to create a package with an
unknown or incapable model, so these can only ever fire if the registry or
persisted state changed out from under an already-built package — proven
in tests by directly corrupting a persisted package/approval pair (see
`test/video-generation-service.test.js`).

## Model registry — validation, never selection

Exactly like `VideoPromptPackage`'s own use of
`services/generation-model-registry.js` (Stage 22B-Part-1): the service
only ever *validates* the provider/model the approval carries, branching
on the same mutually-exclusive `imageToVideo`/`referenceImages`
capability distinction. It never chooses cheapest, fastest, Seedance, or
any provider on the caller's behalf.

## Provider interface — generic, injectable, no hard-coded provider

`video-generation-service.js` calls only `../providers/provider-
interface.js`'s generic contract (`createGeneration`/`getGenerationStatus`/
`getGenerationResult`) against a `PROVIDERS` registry (`{ evolink:
evolinkProvider }` by default, overridable per call). It never imports an
EvoLink HTTP client directly and knows nothing about EvoLink's own field
names — that translation stays entirely inside `providers/evolink/
evolink-mapper.js`, reused as-is. Adding Google later means adding one
entry to `PROVIDERS`; nothing else in this file changes. Tests prove this
generically by confirming `PROVIDERS.evolink` is exactly the real,
unmodified `evolinkProvider` module (identity check, never invoked) while
every actual generation in this stage's tests runs against a dedicated,
fully in-memory `providers/fake-video/fake-video-provider.js` — a
separate provider from `providers/fake-image/`'s own fixture/state,
registered only for tests.

## Input image — never a raw filesystem path

The canonical keyframe asset is resolved into a provider-ready reference
through an injectable `resolveReferenceImpl` (default:
`services/evolink-reference-resolver.js`'s already-proven
`resolveReferenceImageUrl` — the same file-upload mechanism Stage 17
built and verified). The provider adapter is only ever handed `{ type:
'image', url }` — never an internal `asset-storage.js` path. Every test in
this stage injects a fake resolver, so no test path can ever reach
`evolink-reference-resolver.js`'s real upload call. The REST layer (which
cannot inject a fake resolver) is proven safe by construction instead: the
real resolver refuses to resolve any asset that isn't locally `STORED`
*before* it would ever build a request or touch the network, and no REST
test in this stage ever archives its canonical asset — see
`test/video-generation-api.test.js`'s explicit assertion on the
`REFERENCE_RESOLUTION_FAILED` reason string.

## Submission — `generateVideo()`

1. run `runSafetyChecks()` — return `BLOCKED` immediately on any failure, no job created
2. if an active duplicate exists, return it unchanged (no resubmission)
3. resolve the canonical asset into a provider reference
4. create the Generation Job (`generationType: 'VIDEO'`, `videoPromptPackageId`/`videoPromptPackageVersion`/`canonicalKeyframeAssetId` — additive fields on `schemas/production-schema.js`'s existing job/asset shapes)
5. submit exactly once via the resolved provider adapter
6. record `providerTaskId` and `reservedCost`, reconcile into the project's shared credit ledger (`services/approval-gate.js` — no second ledger)
7. poll to completion (same local-loop shape as `keyframe-generation-service.js`)
8. on completion: create the video Asset (full lineage — `keyframeId`, `generationId`, `videoPromptPackageId`/`Version`, provider/model/prompt/references), archive it (`services/asset-archive-service.js`, unchanged), reconcile final cost
9. return a normalized `VideoGenerationResult`

No automatic retry, no fallback provider, no fallback model, no alternate
canonical asset, no automatic approval, no automatic canonical selection
— anywhere in this sequence.

## Duplicate protection

Never two ACTIVE (`REQUESTED`/`SUBMITTED`/`PROCESSING`) video generations
for the same project + shot + `videoPromptPackageId` + `videoPromptPackageVersion`
+ `canonicalKeyframeAssetId`. A completed/failed/timed-out job never
permanently blocks a later authorized attempt, and no job is ever deleted.

## Normalized result

`schemas/video-generation-result-schema.js`'s `VideoGenerationResult` uses
`BLOCKED`/`IN_PROGRESS`/`COMPLETED`/`FAILED` — our own vocabulary, mapped
from (never a passthrough of) the raw job status. `assetId` is set only
once the result has actually been archived through the existing
storage pipeline; no artifact URL is ever invented.

## Archival / lineage

Reuses `services/asset-archive-service.js`, `schemas/production-schema.js`,
and `services/timeline-store.js` unchanged. The resulting video asset
carries complete lineage back to its keyframe, generation job, video
prompt package (id + version), provider, model, prompt, and references.
`approvalStatus` starts at `NONE` — a generated video is never
automatically approved or canonical, exactly like a generated keyframe
image.

## Operator Queue

`services/operator-queue-service.js` gained an **additive** `videoStatus`
field per queue item (`NOT_APPLICABLE` / `NEEDS_VIDEO_PACKAGE` /
`VIDEO_READY_FOR_APPROVAL` / `VIDEO_READY_FOR_GENERATION` /
`VIDEO_IN_PROGRESS` / `VIDEO_RETURNED` / `VIDEO_APPROVED`), computed the
same way `referenceStatus` already is (Stage 19) — never a new top-level
`category`/`priority`, never touching the existing image-lifecycle
decision. `videoStatus` is only ever meaningful once the keyframe's own
image pipeline is `COMPLETE` (a canonical `APPROVED` image asset exists) —
before that, it's `NOT_APPLICABLE`. Because a video Asset shares the same
`Asset.keyframeId` field an image keyframe asset already used, the bulk
asset read in `buildProjectQueue()` is explicitly split by `type` (`'keyframe'`
vs `'video'`) so a video asset can never be mistaken for an image asset by
the existing `decideCategory()` logic — verified directly in
`test/operator-queue-video-status.test.js`. The queue remains entirely
read-only and compute-on-read; no execution control was added to it.

## Control surfaces

**MCP** (`mcp/tools/video-generation-tools.js`): `request_video_generation_approval`,
`get_video_generation_approval`, `approve_video_generation`,
`reject_video_generation`, `can_generate_video`, `generate_video`,
`get_video_generation_status`. The request/approve/can-generate/generate
separation is structural, not a convention — only `generate_video` can
ever submit, and only after every gate in `runSafetyChecks()` passes.

**REST** (`server/index.js`): `POST`/`GET /shots/:shotId/video-generation/approval`,
`POST /shots/:shotId/video-generation/approval/{approve,reject}`,
`GET /shots/:shotId/video-generation/eligibility`, `POST /shots/:shotId/video-generation`,
`GET /shots/:shotId/video-generation/:generationId`. Since a shot can have
more than one keyframe, every route requires an explicit `keyframeId`
(query for GET, body for POST) — never inferred. `creativeStore.findProjectByShotId()`
(Stage 22B-Part-2) resolves the owning project; a new `resolveShotKeyframe()`
helper in `index.js` confirms the given keyframe genuinely belongs to that
shot before delegating to the service — all business logic stays in
`services/video-generation-service.js`/`services/video-generation-approval-store.js`.

**Frontend** (`frontend/app.js`): a read/control panel
(`renderVideoGenerationControls`/`renderVideoGenerationPanel`) in the
Creative Director keyframe workspace, showing the video prompt package,
canonical keyframe, provider/model, verification status, production
readiness, approval status, budget status, and eligibility status.
Controls: REQUEST APPROVAL / APPROVE / REJECT / GENERATE VIDEO. GENERATE
VIDEO's disabled state is driven *only* by the server-fetched eligibility
result — this file never re-derives its own eligibility rule, exactly
like `computeKeyframeGenerationEligibility`'s own documented "convenience,
not a security boundary" caveat for the image pipeline. No automatic
generation, approval, or model/provider selection.

## Relationship to the older pipeline

`generation-service.js` (project-level `project.approvals`, a single
provider registry hard-coded to `{ evolink: evolinkProvider }`,
`requestGeneration()`/`checkGenerationOnce()`) is kept exactly as-is,
untouched, and remains the only thing that produced the real smoke-test
project's one video asset. This stage's new pipeline never calls into it
and never merges its project-level approval model into the new one — the
new pipeline is deliberately per-shot, per-video-package-version,
per-input-keyframe-asset, human-approved, and budget-gated, matching the
architecture the Stage 22B-Part-3 instructions required.

## Scope boundary

This stage stops at implementation + fully mocked verification (see
`providers/fake-video/fake-video-provider.js`). No real EvoLink
generation, no real Google generation, no production reference-image
upload, and no credit spend occurred while building it — see the Stage
22B-Part-3 final report's smoke-test isolation section. Real-provider
validation is reserved for a future, explicitly-authorized stage.
