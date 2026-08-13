# Video Prompt Package (Stage 22B-Part-2)

`server/schemas/video-prompt-schema.js` + `server/services/video-prompt-service.js`.
This stage introduces `VideoPromptPackage`: a deterministic, versioned
specification for animating one approved canonical keyframe asset into a
video. It builds only the specification — no real video generation, no
Google/EvoLink video adapter changes, no `VideoGenerationApproval`, and no
`VideoGenerationService` exist yet. Those are explicitly out of scope for
this stage (see "Scope boundary" below).

## Purpose

Conceptually:

```
Storyboard Shot → Visual Bible / Creative Brief / Master Spec
                → Keyframe Plan → canonical APPROVED keyframe image
                → VideoPromptPackage
                → (future) VideoGenerationApproval
                → (future) VideoGenerationService
```

A `VideoPromptPackage` must contain enough information that a future
generation service does NOT need to reconstruct creative intent from the
project again — it resolves everything relevant once, records it in a
structured, versioned form, and lets a future stage consume it directly.

## Relationship to KeyframePromptPackage

`VideoPromptPackage` deliberately mirrors the proven architecture of
`KeyframePromptPackage` (`schemas/keyframe-prompt-schema.js` /
`services/keyframe-prompt-service.js`, Stage 13A) — same CURRENT/STALE
vocabulary, same versioned-rebuild pattern (protected fields, `history`
array, version increment), same deterministic no-LLM composition
discipline — but it is **not** a duplicate. A `KeyframePromptPackage`
describes how to GENERATE an image (identity/wardrobe/environment locks).
A `VideoPromptPackage` describes how to ANIMATE an already-approved one —
those image-specific locks are already baked into the canonical keyframe
asset itself and are never re-derived here. Instead, a video package
carries forward only what's still relevant from the keyframe's own
already-built `KeyframePromptPackage` (`subject`, `continuity`,
`negativeConstraints`, reference lineage) and adds new, video-specific
fields that have no prior source of truth in the project
(`creativeSpecification`, `executionParameters`) — these are explicitly
caller-supplied, with fallback to the keyframe's own `camera`/
`composition`/`lighting` fields only where the field names and meanings
genuinely overlap.

## Source of truth

A `VideoPromptPackage` derives from, and only from:

- the keyframe's storyboard shot (`services/creative-store.js`)
- the project's Keyframe Plan (`services/keyframe-store.js`)
- the keyframe's own already-built `KeyframePromptPackage`
  (`services/keyframe-prompt-service.js`, read-only)
- the keyframe's explicitly-selected, APPROVED canonical asset
  (`services/keyframe-store.js`'s `getCanonicalKeyframeAsset`, Stage 13E)
- the read-only model capability registry
  (`services/generation-model-registry.js`, Stage 22B-Part-1)
- explicit caller-supplied provider/model/creative-spec/execution-params

No new creative source of truth is introduced. Large source documents
(Creative Brief, Master Spec, Visual Bible, full Storyboard) are never
duplicated into the package — only references/IDs plus the resolved
fields the package actually needs.

## Canonical keyframe requirement

A video package's primary input is the exact, explicitly-selected,
APPROVED keyframe asset that will be animated — never "the newest" or
"the first" asset, never a silent fallback. `resolveCanonicalKeyframeInput()`
enforces this and returns a structured `{ ok: false, code, reason }`
diagnostic (never throws) if:

| Code | Meaning |
|---|---|
| `PROJECT_OR_KEYFRAME_NOT_FOUND` | the project or keyframe doesn't exist |
| `NO_CANONICAL_ASSET_SELECTED` | the keyframe has no `canonicalAssetId` set (Stage 13E's `select_canonical_keyframe_asset` was never called) |
| `CANONICAL_ASSET_NOT_FOUND` | the selected asset id no longer resolves to a real asset |
| `CANONICAL_ASSET_NOT_APPROVED` | the selected asset's `approvalStatus` is not `APPROVED` |

## Model validation

`validateVideoModelSelection(provider, model, { requiresReferenceImages })`
wraps the Stage 22B-Part-1 registry (`getModel` / `isModelCapable`).
provider/model are never defaulted, never auto-selected, never silently
promoted — the caller must supply both explicitly.

- `PROVIDER_MODEL_REQUIRED` — provider or model missing.
- `UNKNOWN_MODEL` — no registry entry for that provider/model pair.
- `MODEL_CAPABILITY_UNSUPPORTED` — the model exists but doesn't support
  the required workflow.

**Capability branching.** The registry models "image-to-video" (one
starting frame) and "reference-to-video" (multiple simultaneous reference
images) as **distinct, non-overlapping** capabilities per model variant —
e.g. `seedance-2.0-mini-image-to-video` has `imageToVideo: true,
referenceImages: false`, while `seedance-2.0-mini-reference-to-video` has
the reverse. So the actual requirement depends on what the package needs:
`requiresReferenceImages: false` requires `imageToVideo: true` only;
`requiresReferenceImages: true` requires `referenceImages: true` only.
Unknown (`null`) is never treated as supported in either branch.

On success, the package records a `modelVerification` snapshot —
`verificationStatus`, `productionReady`, `requestSchemaVerified` — exactly
as the registry reported them at build time. A catalogue-only/unverified
model may still back a package (its true status is simply recorded, never
hidden or silently promoted to look more production-ready than it is).

## Video specification: intent vs. execution

Two deliberately separate objects:

- **`creativeSpecification`** — provider-agnostic creative INTENT:
  `camera`, `subjectMotion`, `environmentMotion`, `composition`,
  `lighting`, `pacing`, `continuity[]`, `negativeConstraints[]`. Never
  encodes a provider's own field names or prompt conventions (no "Seedance
  prompt", no "image_urls"). Provider-specific translation belongs in a
  future `video-generation-service.js` + provider mapper, never here — the
  same creative package should eventually be able to target EvoLink,
  Google, or another provider without being rebuilt.
- **`executionParameters`** — the narrow, explicit set of technical
  knobs a provider mapper will translate later: `duration`, `resolution`,
  `aspectRatio`, `fps`.

Where the project has no existing field for something, the schema uses
`null`/`[]` rather than inventing a value to look complete — every field
in both objects defaults to unset unless the caller (or, for `camera`/
`composition`/`lighting` only, the keyframe's own already-resolved fields)
explicitly supplies it.

## Reference lineage

`referenceLineage` carries forward the reference assets represented by
the canonical keyframe's own `KeyframePromptPackage`
(`existingReferenceAssets`), informational only. No binary file is ever
duplicated, no URL is ever resolved, no network call is ever made — a
future generation service resolves/prepares provider-specific inputs.

## Versioning and staleness

Same rebuild pattern as `KeyframePromptPackage`: rebuilding while the
underlying source is unchanged reuses the package id, increments
`version`, and preserves prior state in `history`. `attachLiveVideoPackageStatus`
compares three live values against what the package was built against:

1. the storyboard's version (`sourceShotVersion`)
2. the Keyframe Plan's version (`sourceKeyframePlanVersion`)
3. the keyframe's *current* `canonicalAssetId` (`sourceCanonicalKeyframeAssetId`)

— a third trigger beyond the image package's two, since the canonical
keyframe asset can change independently of either version counter. Any
mismatch marks the package `STALE` with an explanatory warning; nothing
transitions automatically — a caller must rebuild.

Provider, model, execution parameters, and creative specification are
always caller-supplied fresh on every `buildVideoPromptPackage` call, so
there is no "live" external value for them to drift against between
calls. Changing any of them is just an ordinary rebuild: the package's
stored value updates and its version bumps, exactly like any other
rebuild-driven change.

## Deterministic composition

`composeVideoPromptSections()` / `composeVideoPrompt()` are pure string
templating over already-resolved fields — no LLM call, no network call,
no random IDs or timestamps affecting content. The same source state plus
the same requested provider/model/parameters always produces equivalent
`videoPromptSections`/`prompt` content. Sections with no resolved value
are omitted from `prompt`, never rendered as `"KEY: null"`.

## Human review boundary

Building (or rebuilding) a `VideoPromptPackage` does **not**:

- generate a video, call EvoLink or Google, or execute a skill
- create a generation job or spend a credit
- create a generation approval
- select, change, or otherwise touch any canonical-asset selection
- change any asset's `approvalStatus`

It only produces a versioned specification. `server/services/video-prompt-service.js`
has no import of `providers/evolink/*`, `services/generation-service.js`,
`services/keyframe-generation-service.js`, `services/approval-gate.js`, or
`services/keyframe-generation-approval-store.js` — there is no code path
from this layer to any of them.

## Control surfaces

Following `docs/architecture/control-surfaces.md`'s division of
responsibility — MCP and REST are both thin wrappers over the same
service, the frontend adds no business logic of its own:

**MCP** (`mcp/tools/video-prompt-tools.js`, registered in `mcp/server.js`):
`build_video_prompt_package`, `get_video_prompt_package`,
`list_video_prompt_packages`. There is deliberately no
`generate_video`/`approve_video_generation`/`submit_video_generation` tool.

**REST** (`server/index.js`):
- `POST /keyframes/:keyframeId/video-prompt-package`
- `GET /keyframes/:keyframeId/video-prompt-package`
- `GET /shots/:shotId/video-prompt-packages` (resolves the owning project
  via `creativeStore.findProjectByShotId()`, a new read-only cross-project
  scan mirroring `keyframeStore.findKeyframeById()`'s existing pattern)

**Frontend** (`frontend/app.js`): a minimal, read-only inspection panel in
the existing Creative Director / Keyframe workspace
(`renderVideoPromptPackageControls`/`renderVideoPromptPackagePanel`).
It can only VIEW an already-built package — shot/keyframe/canonical-asset
lineage, provider/model with its recorded verification snapshot, the
creative-specification/execution-parameters split, version, CURRENT/STALE,
source versions, and reference lineage. There is no
GENERATE/APPROVE/credit control, and no provider/model selector — building
a package still requires explicit provider/model, which this minimal
surface does not yet offer a way to choose (that remains an MCP/REST-only
operation for now).

## Scope boundary

This stage stops at the `VideoPromptPackage` specification layer. Not
built here, and reserved for a future stage: `VideoGenerationApproval`,
`VideoGenerationService`, any EvoLink video-provider changes, a Google
adapter, real video generation, batch generation, or provider fallback.
