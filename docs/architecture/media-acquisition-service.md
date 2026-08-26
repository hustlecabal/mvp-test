# Media Acquisition Service

Closes EVOLINK's one confirmed architectural gap identified by the
EVOLINK × OpenMontage forensic audits: `broll-library-service.js` never
acquires stock media — until now, B-roll had to be manually pre-uploaded.
This stage adds a provider-agnostic **Media Acquisition Service** that
automatically obtains stock images and stock video from external
providers (Pexels, Pixabay today), independent of the existing,
untouched B-roll library.

## Architecture

```
Material Resolution          Media Acquisition            Material Execution
(services/material-          (services/media-             (services/material-
 resolution-service.js)       acquisition-service.js)      execution-service.js)

"what kind of material   →   "how do I obtain it"     →   "how do I place it"
 should this beat use?"       (search, download,            (delegates to the
 STOCK_MEDIA candidate,       validate, register,            SAME existing
 never a network call         provenance)                    placement executors
                                                              PROJECT_ASSET_REUSE/
                                                              STILL_IMAGE_MOTION
                                                              already use)
```

Three responsibilities stay strictly separate, per this stage's own
boundary rule:

- **Material Resolution** (`services/material-resolution-service.js`)
  decides WHETHER a beat's material should be `STOCK_MEDIA` — a new,
  additive `MATERIAL_SOURCES` value (`schemas/visual-beat-schema.js`).
  It never calls a provider; a candidate is a proposed strategy, gated
  only by an *injectable* `context.stockMediaProviders` list (mirrors the
  existing `context.brollSegments` pattern), exactly like `GENERATED_NEW`
  never checks whether a generation would actually succeed.
- **Media Acquisition** (`services/media-acquisition-service.js`)
  decides HOW to obtain the requested stock material once asked. It never
  makes a creative decision and never falls back from one provider to
  another automatically.
- **Material Execution** (`services/material-executors/stock-media-executor.js`)
  decides HOW to place an *already-acquired* asset — by delegating,
  unchanged, to the existing `still-image-motion-executor.js` (images) or
  `project-asset-reuse-executor.js` (video). No new placement/render-spec
  logic was written; this stage only feeds those existing executors a
  freshly-acquired `assetId`.

No `VISUAL_TREATMENTS` change was needed: a stock photo satisfies the
existing `STILL_IMAGE` treatment, and stock footage satisfies the
existing `BROLL_CLIP` treatment (already documented there as "a trimmed
segment of licensed/stock footage").

### Why acquisition never runs inside `start_production` directly

`production-orchestrator-service.js`'s entire pipeline after
`DERIVING_BEATS` is deliberately synchronous/blocking
(`execFileSync` throughout — real Chrome, real FFmpeg, real
espeak-ng/faster-whisper; verified directly by that stage, not assumed).
A network fetch is inherently asynchronous in Node, so acquisition can't
run inside that chain without breaking a documented invariant — exactly
the situation `GENERATED_NEW` already solved for paid generation:

1. Material Resolution proposes `STOCK_MEDIA` for a beat (pure, no I/O).
2. `stock-media-executor.js` (synchronous) checks whether stock media was
   **already** acquired for this beat, via `media-acquisition-store.js`'s
   read-only `findAcquiredForBeat()`. If so, it delegates placement to the
   existing executors above.
3. If not, it fails structurally with `NO_ACQUIRED_STOCK_MEDIA_EXISTS`.
   `production-orchestrator-service.js` records this as a
   `ProductionEscalation` — exactly like `NO_APPROVED_GENERATION_EXISTS`
   — and keeps assembling every other beat it can.
4. The `acquire_stock_media` MCP tool (async) performs the real
   acquisition, ahead of — or in response to an escalation from — a
   production run. Re-running material execution / `start_production`
   then finds the cached asset and proceeds.

Acquisition is free (Pexels/Pixabay have no cost), so unlike
`GENERATED_NEW` this never touches `approval-gate.js` or any budget/credit
ledger — there is nothing to authorize spend for. The escalation pattern
is reused purely for the synchronous/asynchronous boundary, not for a
financial one.

## Provider interface

`services/media-acquisition/stock-media-provider-interface.js` defines
the one-method contract every provider implements:

```
search(request) -> MediaSearchResult { status, candidates[], diagnostics[] }
```

Adding a new provider means adding one new module under
`services/media-acquisition/` and one new entry in
`media-acquisition-service.js`'s `PROVIDER_MODULES` dispatch table —
nothing else changes.

| Provider | Image | Video | Credential |
|---|---|---|---|
| Pexels | `pexels-image-provider.js` | `pexels-video-provider.js` | `PEXELS_API_KEY` |
| Pixabay | `pixabay-image-provider.js` | `pixabay-video-provider.js` | `PIXABAY_API_KEY` |
| Fake (tests only) | `fake-stock-media-provider.js` | same module | none required |

## Environment variables

```
PEXELS_API_KEY=
PIXABAY_API_KEY=
```

See `server/.env.example`. Either or both may be left blank — a provider
with no credential configured returns a structured `MISSING_CREDENTIAL`
result (never a crash, never a silent fallback to another provider) and
is excluded from `listAvailableProviders()`, which in turn means Material
Resolution never offers a `STOCK_MEDIA` candidate at all when no provider
is configured (`NO_PROVIDER_CONFIGURED` hard gate).

## Local / mock testing

`fake-stock-media-provider.js` implements the same interface entirely in
memory, reusing the two fixture files this codebase already bundles and
trusts for exactly this purpose (`providers/fake-image/fixtures/sample-keyframe.png`,
`providers/fake-video/fixtures/sample-video.mp4`) — never a third copy of
those bytes. `test/media-acquisition-service.test.js` and
`test/stock-media-material-resolution-integration.test.js` (see Tests
below) exercise the full search → download → validate → register →
provenance → Material Execution chain against it, with no network access
and no API key required.

## Live-provider testing

`test/media-acquisition-live.test.js` is a separate file, run only when
`PEXELS_API_KEY` and/or `PIXABAY_API_KEY` are actually set in the
environment — every test in it is skipped otherwise (`node --test`'s own
`test(name, { skip: reason }, fn)`), never a false pass. It performs a
real search + download + validation against whichever provider(s) have a
key configured.

## Asset cache

`services/asset-storage.js`'s existing `downloadAsset()` already never
re-downloads a file for a given `assetId`. Media Acquisition's own cache
sits one layer above that: `media-acquisition-store.js`'s
`findByProviderAsset(projectId, provider, providerAssetId)` maps a
provider's own stable candidate identity back to the `assetId` a prior
successful acquisition already produced. A repeat request that resolves
to the same top candidate reuses that `assetId` — and, through it, the
already-downloaded file — instead of downloading again. No second,
competing asset-management system was created.

## Provenance

Every acquisition attempt (successful or not) is recorded as a
`MediaAcquisitionResult` (`schemas/media-acquisition-schema.js`) in
`media-acquisition-store.js` — one JSON file per project, same convention
as `broll-library-service.js`. A successful record carries: provider,
providerAssetId, mediaType, source/download URL, width/height/duration,
format, attribution, license summary, the search query used, a
`sha256:` checksum, acquisition timestamp, and the beat/scene it was
acquired for — traceable back to the `assetId` it registered via
`getProvenance(projectId, assetId)`.

## Asset validation

`services/media-acquisition/media-asset-validator.js`:

- **Images** — reuses `asset-storage.js`'s existing magic-byte sniffer
  (never a second format detector). PNG width/height are read directly
  from the file's own IHDR chunk (a real, dependency-free check); other
  formats' dimensions come from the provider's own reported metadata,
  since no image-processing library is a dependency of this project —
  documented, not hidden, the same discipline `schemas/broll-schema.js`
  already established for "no media metadata extraction exists" fields.
- **Videos** — reuses the exact ffprobe + ffmpeg decode-integrity pattern
  `services/renderers/hyperframes-renderer.js`'s own `ffprobeValidate()`
  already established. When ffprobe/ffmpeg cannot be located on `PATH`,
  this returns a distinct `FFPROBE_UNAVAILABLE` outcome — never silently
  treated as a pass or a content-rejection.

An invalid candidate is rejected deterministically (`REJECTED_INVALID`);
its downloaded bytes are removed rather than left as an orphaned file,
since nothing else in the system will ever reference an unregistered
asset id.

## Failure behavior

Every non-`ACQUIRED` outcome is a structured, diagnosed
`MediaAcquisitionResult` — never a thrown error, never a silent retry,
never an automatic fallback to a different provider (`schemas/media-
acquisition-schema.js`'s `ACQUISITION_STATUSES`:
`REJECTED_INVALID | PROVIDER_FAILED | NO_CANDIDATES | MISSING_CREDENTIAL
| UNSUPPORTED_PROVIDER`). A caller that wants a second provider tried
must call `acquire_stock_media` again, explicitly, with a different
`provider` — this codebase deliberately never invents automatic provider
substitution (the same rule `generation-model-registry.js` already
enforces for paid generation providers).

## MCP tools

- `acquire_stock_media` — the one tool that performs a real network call.
- `list_stock_media_providers` — read-only; the same check
  `production-orchestrator-service.js` uses to gate Material Resolution.
- `list_media_acquisitions` — read-only; every acquisition record (and
  its provenance) for a project.
