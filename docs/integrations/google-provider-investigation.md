# Google Gemini / Veo Provider Investigation (Stage 22A)

Read-only investigation. **No production code was written or modified for this
document.** No real Google API call was made — no `GOOGLE_API_KEY`/`GEMINI_API_KEY`
exists in this environment, and none would have been used regardless (this stage
explicitly forbids any live call). No real EvoLink generation call was made either.
The real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) was not touched.

Sourcing discipline (matching `docs/integrations/evolink-api.md`'s convention):
every claim below is marked **DOCUMENTED** (opened directly on an official
`ai.google.dev` page during this investigation, cited), **DOCUMENTED (secondary)**
(from a search-engine summary of an official page, not independently re-opened —
flagged for re-verification before code is written against it), or **UNKNOWN**
(not found, or sources conflicted and could not be resolved). Nothing here is
guessed. Where third-party sources were used for pricing/rate-limit numbers
because the live pricing page could only be fetched via summarization, that is
called out explicitly.

---

## A. Executive Conclusion

Google's current Gemini API is a credible, well-documented second provider for
both image and image-to-video generation, and its request shape (JSON body,
`x-goog-api-key` header, base64/inline image data, long-running-operation polling
for video) is structurally compatible with this project's existing
`ProviderAdapter` interface (`createGeneration`/`getGenerationStatus`) — no new
domain concepts are required, only a new provider adapter pair (one for images,
one for video) parallel to the existing EvoLink adapters.

The one capability gap that matters for **this project's specific canonical-
reference architecture** is real: Veo 3.1's `reference_images` mechanism supports
**up to 3** reference images per video (vs. EvoLink's up to 16 for images), is
explicitly optimized for single-subject "ingredients to video" character
consistency, and its exact interaction with a **pre-approved canonical keyframe
image** (our existing artifact) has not been verified against a real request/
response — only against secondary/blog sources. That single unknown, plus the
fact that Veo 3.1 is **Preview** (not GA) with a 10 RPM cap and no free tier, is
why this document recommends **Decision Gate B**, not A: architecturally ready,
but requiring the small additive changes in Section J before any real Google call
is made, and requiring a first real Google call to close the one open
verification gap in Section L before this becomes a fully trusted parity partner
to EvoLink.

**Decision Gate: B — READY WITH ARCHITECTURAL CHANGES** (see Section M).

---

## B. Official Model Catalogue

| Model (product name) | Model ID | Status | Source |
|---|---|---|---|
| Nano Banana 2 (Gemini 3.1 Flash Image) | `gemini-3.1-flash-image` | Stable | DOCUMENTED (secondary) — `ai.google.dev/gemini-api/docs/image-generation` |
| Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image) | `gemini-3.1-flash-lite-image` | Stable | DOCUMENTED (secondary) — same page |
| Nano Banana Pro (Gemini 3 Pro Image) | `gemini-3-pro-image` (some sources also show `gemini-3-pro-image-preview`) | Stable per `ai.google.dev/gemini-api/docs/models`; **CONFLICTING** — see Known Unknowns L1 | DOCUMENTED (secondary), conflict noted |
| Veo 3.1 | `veo-3.1-generate-preview` | **Preview** (not GA) | DOCUMENTED (secondary) — `ai.google.dev/gemini-api/docs/models/veo-3.1-generate-preview` |
| Veo 3.1 Fast | `veo-3.1-fast-generate-preview` | **Preview** | DOCUMENTED (secondary) — same page; also appears on `ai.google.dev/gemini-api/docs/veo` |
| Veo 3.1 Lite | `veo-3.1-lite-generate-preview` | **Preview** | DOCUMENTED (secondary) — `ai.google.dev/gemini-api/docs/models/veo-3.1-lite-generate-preview`; confirms 4K output NOT supported on Lite |
| (legacy, deprecating) Imagen | — | **Shutting down 2026-08-17** | DOCUMENTED (secondary) — users directed to migrate to Nano Banana |

**Operationally urgent note:** today is 2026-08-13. The Imagen shutdown
(2026-08-17) is four days away — irrelevant to us since we were never on Imagen,
but it signals Google is actively retiring older image models in favor of the
Nano Banana family, which is a small positive signal for choosing Nano Banana
Pro specifically (it's the model being migrated *to*, not away from).

---

## C. Image API

**Endpoint (DOCUMENTED, cross-confirmed by two independent searches):**
```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```
e.g. `.../models/gemini-3-pro-image-preview:generateContent`

This is the **same generic `generateContent` endpoint** Gemini uses for text —
image generation is requested via a `generationConfig.responseModalities`
(or model-specific `imageConfig`) field, not a separate image-only endpoint.
One initial search surfaced a differently-named "Interactions API"
(`/v1beta/interactions`) as a newer Gemini 3 surface; it's unclear whether this
is an alternate/newer path for the same capability or a distinct feature —
**flagged as an open question, not resolved** (see L2).

**Image resolution control:** `generationConfig.imageConfig` accepts
`aspectRatio` (e.g. `"16:9"`) and `imageSize` (e.g. `"1K"`, `"2K"`, `"4K"`) —
DOCUMENTED (secondary).

**Reference/input image handling:**
- Inline base64: `{ "inline_data": { "mime_type": "image/png", "data": "<base64>" } }` inside the `contents` array — DOCUMENTED (secondary), consistent across sources.
- Files API for larger/reusable uploads — mentioned but not independently verified for image references specifically (mentioned in the context of video-to-image, one model only) — UNKNOWN whether this is the recommended path for a reused canonical reference image, or whether inline base64 is expected every time.
- Direct external URL as a reference image (the same "reuse an already-hosted URL across N calls" pattern this project uses with EvoLink): **UNKNOWN** — not found in any source opened. This should be verified directly (does `generateContent` accept a `file_uri` pointing at an arbitrary public URL, or only at a Files-API-uploaded resource?) before assuming our existing `evolink-reference-resolver.js`-style "upload once, reuse the URL" pattern transfers unchanged.

**Maximum reference image count (DOCUMENTED, secondary, per-model table):**

| Model | Object/asset references | Character references | Style references |
|---|---:|---:|---:|
| Nano Banana 2 Lite | 14 | N/A | N/A |
| Nano Banana 2 | 10 | 4 | 3 |
| Nano Banana Pro | 6 | 5 | N/A |

**Semantic typing of reference images:** no explicit machine-readable "this is
the character reference, this is the style reference" field was found in any
source opened — the documentation instead describes images being interpreted
through the surrounding text prompt. This is a **materially different model**
from our own `roleType: CHARACTER/ENVIRONMENT/WARDROBE/PROP/STYLE/OTHER` metadata
(Stage 16) and from EvoLink's own reference role handling — see Section E.

---

## D. Video API

**SDK call (DOCUMENTED, secondary):** `client.models.generate_videos(model=..., prompt=..., config=types.GenerateVideosConfig(...))`.

**REST shape:** long-running operation pattern — the endpoint path uses a
`:predictLongRunning` suffix per one source; not independently re-verified
against a raw `curl` example.

**Async/polling (DOCUMENTED, secondary, consistent across sources):**
1. Submit → returns an `operation` object (not a finished result).
2. Poll via `client.operations.get(operation)` (or the REST equivalent) until `operation.done` is `true`.
3. `operation.name` is the durable handle to resume polling if the process restarts.

This maps directly onto our existing `GenerationJob.providerTaskId` +
`checkGenerationOnce()` polling loop — no new polling *concept* is needed, only
a mapper that stores `operation.name` as the job's provider task id.

**Result retrieval (DOCUMENTED, secondary):** `operation.response.generated_videos[0].video`, then `client.files.download()`. This is a **fetch-after-poll** step, structurally identical to how `asset-archive-service.js` already downloads a completed job's result URL — no new archival concept needed, only a mapper that produces a fetchable URL/reference from this response shape instead of EvoLink's flat `results: [url]`.

**First-frame / image-to-video (DOCUMENTED, secondary):** an `image` parameter takes an `Image` object as the starting frame.

**Last-frame (DOCUMENTED, secondary):** a `lastFrame` config parameter, used alongside `image`, for interpolation between two frames.

**Reference images / "Ingredients to Video" (DOCUMENTED, secondary, consistent across 3+ independent sources including Google's own developer blog):**
- Up to **3** reference images via `reference_images` in `GenerateVideosConfig`, each a `VideoGenerationReferenceImage` with a `reference_type` field (one confirmed value: `"asset"`).
- Explicitly marketed for keeping "a character's face and outfit" consistent, or "a product/prop," or "a location/visual style" — i.e. Google's own docs describe assigning each of the (max 3) images a *semantic role*, closer to our `roleType` concept than the image-generation reference mechanism is (Section C), but still capped at 3 total, not per-role.

**Aspect ratios (DOCUMENTED, secondary):** `"16:9"` (default), `"9:16"`.

**Durations (DOCUMENTED, secondary):** 4, 6, or 8 seconds; 8s only available at 1080p/4K or when reference images are used.

**Resolutions (DOCUMENTED, secondary):** 720p (default), 1080p, 4K; Veo 3.1 Lite explicitly does **not** support 4K; video *extension* is capped at 720p regardless of model.

**Audio (DOCUMENTED, secondary, consistent across sources):** native audio generation is always on for Veo 3.1 — dialogue, ambient sound, and effects are generated together with the video, not as a separate step or toggle. This is a genuine capability EvoLink's `seedance-2.5-*` models do not document having (no audio field found in `evolink-api.md`'s documented Seedance schema).

---

## E. Reference-Image Capabilities — Suitability for Our Canonical-Reference Architecture

Our existing architecture's core invariant (Stages 17–21): **one explicitly
human-approved, human-selected canonical reference asset per character/location,
reused byte-identically across every generation that needs it**, with machine-
checkable lineage (`roleType`, `canonical: true/false`, `characterId`) surviving
into the built prompt package.

| Requirement | EvoLink (verified, in production) | Google Veo 3.1 (documented, not yet verified live) |
|---|---|---|
| Max reference images (video) | Not explicitly capped in `seedance-2.5-image-to-video`'s verified schema (per `evolink-api.md`) beyond general `image_urls` array handling | **Hard cap of 3** — a genuine constraint if a shot ever needs more than 3 references (2 characters + 1 location reference already reaches the cap) |
| Semantic role per reference | Additive `roleType` metadata is **our own** application-level convention layered on top of a plain URL array — EvoLink itself doesn't interpret roles | Google's `reference_type: "asset"` is the only confirmed value; whether distinct values exist for "character" vs "style" vs "environment" is **UNKNOWN** — not confirmed in any source opened |
| Byte-identical reused reference URL | Verified in production (Stage 17, 20, 21 — same EvoLink-hosted URL reused across many real calls, 72h TTL) | **UNKNOWN** — whether Google's `reference_images` accepts a stable external URL for reuse, or requires a fresh inline-base64/Files-API upload per request, was not confirmed (Section C) |
| Human canonical-selection compatible | Directly compatible — canonical asset's URL is what gets uploaded/reused | Structurally compatible **in principle** (nothing prevents passing our canonical asset's bytes as one of the up-to-3 `reference_images`) — but the exact request format for "this exact approved PNG, unchanged" has not been built or tested |

**Conclusion for this section:** Veo 3.1's reference mechanism is *usable* for
our architecture but **more constrained** than EvoLink's (hard cap of 3, unclear
role semantics) and **less proven** (zero real requests made, vs. EvoLink's 9
real successful reference-conditioned generations across Stages 17–21). It should
be treated as viable for single/dual-character shots, not yet assumed viable for
anything requiring more simultaneous references.

---

## F. Authentication

**DOCUMENTED**, directly opened from `ai.google.dev/gemini-api/docs/api-key`:

- SDK auto-detects either `GEMINI_API_KEY` or `GOOGLE_API_KEY` (the latter takes precedence if both are set).
- Raw REST requests authenticate via the `x-goog-api-key: YOUR_API_KEY` header (not a Bearer token, unlike EvoLink's documented Bearer-token scheme).
- **Operationally relevant deadline:** "Standard API keys will be rejected by the API starting September 2026" — all new keys from Google AI Studio are now "auth keys" (service-account-bound, more granular). Since today is 2026-08-13, **any key provisioned for this project should be created as an auth key from the start**, not a legacy standard key, to avoid a forced rotation three weeks after connecting.
- No API key currently exists in this environment for either provider beyond `EVOLINK_API_KEY`. Confirmed via the existing credential-handling pattern (`server/.env`, never logged) — the same mechanism (server-side-only env var, read once by a client module, never exposed to the frontend) is directly reusable for a `GOOGLE_API_KEY`/`GEMINI_API_KEY` variable.

---

## G. Pricing

Fetched from `ai.google.dev/gemini-api/docs/pricing` (DOCUMENTED, secondary summarization
of the live page — recommend a direct re-open before finalizing a budget policy,
since this page changes without notice and no snapshot/version was captured).

**No free tier exists for any of these image or video models** — every row
below is paid-only. This is stated explicitly to satisfy the instruction not to
describe a paid model as free.

| Model | Standard price | Batch price |
|---|---|---|
| Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`) | ~$0.034 per 1K-resolution image | ~$0.017 (half of standard, consistent with the documented 50% batch discount pattern) |
| Nano Banana 2 (`gemini-3.1-flash-image`) | $0.045 / $0.067 / $0.101 / $0.151 per image at 0.5K / 1K / 2K / 4K respectively | ~50% of standard |
| Nano Banana Pro (`gemini-3-pro-image`) | $0.134 per 1K or 2K image; $0.24 per 4K image | $0.067 per 1K/2K; $0.12 per 4K |
| Veo 3.1 Lite | $0.05/sec (720p), $0.08/sec (1080p) | not documented |
| Veo 3.1 Fast | $0.10/sec (720p), $0.12/sec (1080p), $0.30/sec (4K) — one source separately states $0.15/sec flat; **CONFLICTING, unresolved** | not documented |
| Veo 3.1 (Standard) | $0.40/sec (720p/1080p), $0.60/sec (4K) | not documented |

**Worked example for comparison:** an 8-second 1080p Veo 3.1 Fast clip would cost
approximately $0.12 × 8 = **$0.96**, or under the conflicting $0.15/sec figure,
**$1.20**. Either way, meaningfully more expensive per second than a single
Nano Banana Pro image call (~$0.13–0.24 flat, resolution-independent of duration
since it's a still image).

**EvoLink cost comparison, from data this project has actually observed (not
list pricing — EvoLink publishes no rate table, see `evolink-api.md`):**
- `gemini-3-pro-image-preview` via EvoLink: **8.5866 credits** per single-reference image call, **8.6576 credits** per two-reference call (Stage 20/21, real generations). EvoLink's credit-to-USD conversion is not published anywhere this project has found, so a direct $-for-$ comparison against Google's list price is **not possible** without that rate — flagged as a known unknown (L3).
- `seedance-2.5-text-to-video` via EvoLink: **100.45 credits** for a 5-second 720p clip (the real smoke-test project's actual generation) — again, not convertible to USD without EvoLink's undocumented credit rate.

---

## H. Rate Limits / Operational Constraints

**DOCUMENTED (secondary):**
- Veo 3.1 preview models (all three IDs in Section B are Preview): **10 requests per minute**.
- A separate, not-yet-generally-available production model (`veo-3.1-generate-001`, mentioned once in a secondary source but not independently confirmed as real/available) would allow 50 RPM / 10 concurrent — **not something we can rely on today**, since every ID we found in the official docs page is still `-preview`.
- Daily quota resets at midnight Pacific Time (secondary, unconfirmed against an official page directly).
- Generation latency observed/reported by third parties: "11 seconds to 6 minutes per video" — consistent with EvoLink's own async, poll-until-terminal video pattern; no architectural surprise here.

**Stability risk:** every Veo 3.1 model ID this project would use is **Preview**,
not GA. Google's own naming convention (`-preview` suffix) is the same signal
this project already treats cautiously for EvoLink's own `-preview`-suffixed
model IDs (e.g. our already-connected `gemini-3-pro-image-preview`). No
different treatment is warranted — this is a normal, already-understood risk
category for this project, not a new one.

**Auth transition risk:** the September 2026 standard-key deprecation (Section
F) is the most concrete near-term operational deadline found.

---

## I. Google vs. EvoLink Capability Matrix (project-relevant capabilities only)

| Capability | EvoLink (proven, in production) | Google (documented, unverified live) |
|---|---|---|
| Image generation | ✅ `gemini-3-pro-image-preview`, real, 9 successful generations across Stages 16–21 | Documented, zero real calls made |
| Image reference conditioning | ✅ Verified byte-exact URL reuse, up to 2 simultaneous references tested (Stage 21) | Documented up to 6–14 depending on model; URL-reuse pattern unverified (Section E) |
| Image-to-video | ✅ Model verified (`seedance-2.5-image-to-video`, `requestSchemaVerified: true`), never yet used for a real generation in this project | Documented (`image` param on Veo 3.1), zero real calls made |
| Video reference conditioning | Not verified — EvoLink's video reference schema exists in `evolink-models.js` (`seedance-2.5-reference-to-video`) but is explicitly marked `requestSchemaVerified: false`, meaning our own mapper refuses to build a request for it today | Documented up to 3 references, semantic-role-labeled ("ingredients"), zero real calls made |
| Polling model | ✅ Proven (`task-unified-*` IDs, `GET` status endpoint, our `generation-poller.js`) | Documented (long-running `operation`), structurally compatible, unverified live |
| Output retrieval | ✅ Proven (flat `results: [url]`, downloaded by `asset-archive-service.js`) | Documented (`operation.response.generated_videos[0].video` → `files.download()`), structurally different shape, needs a new mapper function, not a new concept |
| Cost visibility | Only known post-request (`usage.credits_reserved`); no published rate card | Full published list pricing (Section G), known **before** submission — a genuine advantage for budget planning, since our whole `UNKNOWN_COST_REQUIRES_EXPLICIT_APPROVAL` policy exists specifically because EvoLink can't tell us cost in advance |
| Model stability | `gemini-3-pro-image-preview`/`seedance-2.5-*` — Preview-suffixed, already treated cautiously | All relevant Veo 3.1 IDs are Preview; image models (Nano Banana family) show as Stable |

**Net assessment:** EvoLink remains the more *proven* provider for this project
today (real generations, real lineage, real identity-consistency evidence from
Stages 18–21). Google is the more *cost-transparent* provider (published
pricing vs. EvoLink's opaque post-hoc credit reservation) and offers native
audio on video, which EvoLink's documented Seedance schema does not. Neither
should replace the other — this matches the user's explicit instruction not to
remove or replace EvoLink.

---

## J. Required Architecture Changes (minimum additive set)

None of these require touching the existing EvoLink adapters, the domain model
(`KeyframePromptPackage`, `KeyframeGenerationApproval`, `Asset`, `GenerationJob`),
or the approval/budget/lineage/Operator-Queue machinery already proven in
Stages 13B–21. All changes are additive:

1. **`providers/google/google-client.js`** (new) — the HTTP/SDK boundary, mirroring `providers/evolink/evolink-client.js`'s role exactly: owns the API key header, the base URL, and raw request/response I/O. Nothing else in the codebase would ever import this directly.
2. **`providers/google/google-image-mapper.js`** and **`providers/google/google-video-mapper.js`** (new) — mirror `evolink-image-mapper.js`/`evolink-mapper.js`: translate our generic request/response shape ↔ Google's `generateContent`/`generate_videos` field names. Two files (not one) because the image and video request shapes are different enough (Section C vs D) to warrant the same split EvoLink already has.
3. **`providers/google/google-image-provider.js`** and **`providers/google/google-video-provider.js`** (new) — mirror `evolink-image-provider.js`/`evolink-provider.js`: implement the same generic `createGeneration`/`getGenerationStatus` interface every provider adapter already implements. This is the ONLY new "shape" being introduced, and it's not new — it's the existing interface, implemented again.
4. **One line each** in `keyframe-generation-service.js`'s `IMAGE_PROVIDERS` registry and (once Stage 22's video-generation-service exists) its video equivalent's provider registry — e.g. `'google-image': googleImageProvider`. `DEFAULT_PROVIDER_NAME` stays unchanged (still `'fake-image'` for images; whatever Stage 22 chooses for video), exactly like adding `'evolink-image'` in Stage 16 never changed what a caller gets by default.
5. **`providers/google/google-models.js`** (new) — mirrors `evolink-models.js`'s allowlist-with-`requestSchemaVerified` pattern exactly. Every model ID from Section B goes in, initially with `requestSchemaVerified: false` until a real request/response has been built and verified against a live call — matching the exact discipline already applied to EvoLink's own not-yet-verified models (`seedance-2.5-reference-to-video`, etc.).
6. **`GOOGLE_API_KEY`** (or `GEMINI_API_KEY`) added to `.env.example`/deployment config **only** — never read anywhere but the new `google-client.js`, matching `EVOLINK_API_KEY`'s existing handling exactly. No frontend exposure, ever.

**Explicitly NOT required:** a new state machine, a new approval schema, a new
budget mechanism, a new asset schema, a new Operator Queue, a new provider-
selection abstraction, automatic fallback logic, or any change to
`VideoPromptPackage`/`VideoGenerationApproval` (still to be built per the
original Stage 22 plan) beyond accepting `provider: "google"` as a valid,
explicitly-chosen string alongside `provider: "evolink"` — exactly matching the
example in this instruction's own architecture diagram.

---

## K. Recommended Provider Abstraction

No change from the existing pattern — this section confirms the existing shape
already generalizes correctly, rather than proposing something new:

```
provider: "evolink" | "google"     (explicit, human/caller-chosen — never inferred)
model: <string, validated against that provider's own *-models.js allowlist>
```

Both `keyframeGenerationService.IMAGE_PROVIDERS` (today: `{'fake-image', 'evolink-image'}`)
and the future video provider registry become `{'fake-*', 'evolink-*', 'google-*'}`
— a flat, explicit map exactly like today's, with no "pick the best provider"
logic anywhere, matching the instruction's explicit prohibition on automatic
fallback/implicit selection.

---

## L. Known Unknowns (must be resolved before real Google spend, not before writing adapter code)

1. **Model ID conflict**: `gemini-3-pro-image` vs. `gemini-3-pro-image-preview` — sources disagree on which is current/canonical for Nano Banana Pro. Our own EvoLink integration already uses `gemini-3-pro-image-preview` successfully (a different provider reselling the same underlying model), which is at least proof that string is a real, valid identifier somewhere in Google's ecosystem — but does not confirm it's the correct ID for Google's *own* direct API today. **Must be confirmed against a live `models.list()` call or the model's own dedicated docs page before first real use.**
2. **"Interactions API" vs. `generateContent`**: one source described a `/v1beta/interactions` endpoint as the current Gemini 3 image-generation surface; multiple others describe `models/{model}:generateContent`. Not resolved — could be two valid surfaces, or the `interactions` mention could be for an unrelated capability. **Must be checked directly against the model's own docs page before building the mapper.**
3. **EvoLink credit-to-USD rate**: undocumented (confirmed already in `evolink-api.md`), so no side-by-side dollar cost comparison in Section G/I is actually possible — only credit counts on EvoLink's side and dollar amounts on Google's side, which are not directly comparable numbers.
4. **Reference-image URL reuse on Google's side**: whether a stable external URL (like our EvoLink-hosted 72h reference URLs) can be passed directly, or whether Google requires inline base64 or a Files-API upload per call. This materially affects whether our `evolinkReferenceResolver`-style "upload once, reuse across N generations" pattern needs a Google-specific equivalent or can be reused conceptually with different mechanics.
5. **Veo 3.1 Fast pricing conflict**: $0.10/$0.12/$0.30 per second (720p/1080p/4K) vs. a separately-cited flat $0.15/sec — not resolved.
6. **Rate limit for image models**: not found in any source opened (only Veo's 10 RPM was confirmed). Image-generation-specific RPM/RPD limits remain unknown.

None of these block writing the adapter *code* (Section J) — they block trusting
a *live* Google call's cost/behavior, which this stage explicitly forbids
regardless.

---

## M. Decision Gate

**B — READY WITH ARCHITECTURAL CHANGES**

Rationale: the existing provider-adapter interface generalizes to Google without
any change to the domain model, approval flow, budget ledger, lineage, or
Operator Queue — this is a strong "ready" signal. But six real unknowns remain
(Section L), all resolvable only by either opening a few more official pages or
making a first real (small, human-approved) call — not by guessing. Per this
project's established discipline (never guess a model ID or request shape,
matching `evolink-models.js`'s own `requestSchemaVerified` gate), Google models
should enter `google-models.js` with `requestSchemaVerified: false` and stay
there until Section L's items are individually closed out, exactly the same
bar `seedance-2.5-reference-to-video` is already held to today.

**Recommendation:** proceed with Section J's additive provider-adapter files
(safe, no live calls, mirrors proven EvoLink pattern), but do not flip any
Google model to `requestSchemaVerified: true` — and therefore do not make any
real Google API call — until this document's open questions are individually
resolved against primary sources, per the same rule already governing every
other provider in this codebase.

---

## Safety Statement

- Real Google API calls made during this investigation: **0**
- Real EvoLink generation calls made during this investigation: **0**
- Credits spent (either provider): **0**
- Production source files modified: **0** (this document only)
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) modified: **NO**
