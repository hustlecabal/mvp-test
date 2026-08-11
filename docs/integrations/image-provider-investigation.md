# Real Image-Generation Provider Investigation (Stage 15)

**This is an investigation and decision document, not an implementation.** No
provider was connected, no image-generation endpoint was called, no
credential was created or used, and no production code was modified as part
of this stage other than this document. See Part 12 (Credential Considerations)
and Part 18 (What Must NOT Be Changed Yet).

Every claim below is labeled one of:

- **VERIFIED FACT** — read directly from an official/primary source (vendor
  docs, vendor-authored MCP tool schema), source cited.
- **UNKNOWN** — not found anywhere in the sources checked.
- **INFERENCE** — a reasonable conclusion drawn from verified facts, but not
  itself independently confirmed.
- **RECOMMENDATION** — a judgment call about what to do, not a factual claim.

---

## 1. Executive Conclusion

**VERIFIED FACT + INFERENCE, summarized:** EvoLink — the provider we already
have a verified, documented video integration for — also exposes a large
catalog of image-generation models through the same account, the same base
URL, the same authentication mechanism, and the same asynchronous
task-lifecycle pattern already implemented in `providers/evolink/`. Two of
these models are fully verified from EvoLink's own OpenAPI specs and both
accept multiple reference images per request (`gpt-image-2`: 1–16 images;
`gemini-3-pro-image-preview`, i.e. "Nano Banana Pro": up to 14 images, max 5
of them real-person images). This is a materially stronger fit for our
reference-driven keyframe pipeline than Higgsfield, whose own official docs
and its own vendor-authored MCP tool catalog together verify only
**single-reference-image** models.

This investigation also resolves Stage 13C's open "Banana Pro" question
(Part 3 below): the skills' target, "Banana Pro," is almost certainly **Nano
Banana Pro** — Google's `gemini-3-pro-image` model — which is reachable
through at least three paths: Google's own Gemini API directly, EvoLink's
resold `gemini-3-pro-image-preview`, and Higgsfield's wrapped
`nano_banana_pro` (capped at effectively one reference image in Higgsfield's
own catalog, unlike the other two paths).

**Decision: A — READY TO CONNECT**, narrowly scoped to extending the
existing `providers/evolink/` integration with an image-model adapter. See
Part 11 for the full justification and the residual unknowns that don't
block implementation but should inform the first (still future, still
requires separate authorization) test generation.

---

## 2. Current Architecture

**VERIFIED FACT**, from reading the code directly (unchanged by this stage):

- `providers/image-provider-interface.js` requires exactly two methods:
  `createImageGeneration(request)` and `getGenerationStatus(taskId)`, reusing
  the existing generic `GENERATION_STATUSES`/`createGenerationStatus` shape
  from `providers/provider-interface.js` (the video contract). No
  image-specific status vocabulary exists or is needed.
- `services/image-generation-executor.js`'s `buildNormalizedImageRequest()`
  turns a `KeyframePromptPackage` into the provider-agnostic request shape:
  `{ projectId, keyframeId, promptPackageId, promptPackageVersion, prompt,
  promptSections, referenceAssets, recommendedSkill, parameters }`, where
  `referenceAssets` is currently just an array of `assetId` strings (role/type
  metadata is dropped at this step — see Part 7).
- `providers/fake-image/fake-image-provider.js` is the only implementation
  today: in-memory, deterministic, never touches the network.
- `providers/evolink/evolink-client.js`'s `evolinkRequest({ method, path,
  body, baseUrl, fetchImpl })` is already fully generic — it knows nothing
  EvoLink-image-specific or EvoLink-video-specific, only how to authenticate
  and parse EvoLink's envelope. Adding an image endpoint means adding one
  new path constant (`createImageGenerationTask`), not changing this
  function.
- `providers/evolink/evolink-provider.js` and `evolink-mapper.js` implement
  the **video** provider contract (`createGeneration`/`getGenerationStatus`/
  `getGenerationResult`) — a separate, unmodified module from anything an
  image adapter would need.
- `docs/architecture/keyframe-execution-bridge.md` (Stage 13C) already
  independently investigated the installed Claude skills
  (`banana-pro-director-2.0`, `cinema-worldbuilder-pro-2.0`) and found they
  are prompt-writing aids only — no installed skill can call an image API
  programmatically. That finding is unchanged and still governs: connecting
  a real provider means the **backend** calls it directly (Architecture B in
  that document), not that a skill executes anything.

---

## 3. Requirements Imposed by the Keyframe Prompt Package

**VERIFIED FACT**, from `schemas/keyframe-prompt-schema.js` and
`services/keyframe-prompt-service.js`:

| Package field | What it needs from a provider |
|---|---|
| `identityLock[]` (per character: facial/body/hair/skin/behaviour/constraints) | A way to condition generation on a specific person's appearance — not just "a person," a *specific* one, preserved across separate generations |
| `wardrobeLock[]` (wardrobe + accessories + shot-specific override) | Either a reference image of the wardrobe, or reliable prompt-text wardrobe control |
| `environmentLock[]` (architecture/geography/materials/colour/lighting/atmosphere/recurring elements) | A way to condition on a specific location's visual identity, same durability requirement as identity |
| `existingReferenceAssets[]` — **already carries a `role` field** (e.g. `"character:Aria"`, `"location:Rooftop"`) and a `type` (`character_reference`/`location_reference`/`keyframe`), resolved by `keyframe-prompt-service.js`'s `resolveExistingReferenceAssets()` | A way to pass **multiple** reference images **with distinguishable roles**, not one undifferentiated image |
| `composition`/`camera`/`framing`/`lens`/`movementIntent`/`lighting`/`colour`/`atmosphere`/`continuityRequirements` | Plain prompt-text conditioning — every provider researched supports this |
| `negativeConstraints[]` | A negative-prompt mechanism, or fold into the main prompt |

**The single most important requirement, per the user's own framing:** the
provider must support **multiple** reference images with **distinguishable
roles** (at minimum: identity vs. environment vs. wardrobe), not just "an
image upload field." A model that accepts one image total cannot satisfy a
keyframe that locks both a character's identity *and* a location's
appearance simultaneously — which is common in this pipeline's
`CHARACTER_REFERENCE`/`WORLD_REFERENCE`/`DETAIL_FRAME` frame types (Stage 12).

---

## 4. EvoLink Investigation

**Source discipline:** every claim below was read from `evolink.ai/docs`
directly (via its `llms.txt` index and individual page fetches), the same
primary-source method Stage 6 used to write `docs/integrations/evolink-api.md`.
No API call was made; no key exists.

**VERIFIED FACT — EvoLink has a large, distinct image-generation catalog**,
separate from its video models, found via `https://evolink.ai/docs/llms.txt`.
Series present: Nanobanana (7 variants), Seedream (4 variants), GPT Image (3
variants), Midjourney (2 variants), Krea, Z Image Turbo, Qwen Image (4
variants), Wan2.5 (2 variants). This directly answers Part 4's framing
question — **EvoLink's image capability is not the video model repurposed;
it is a wholly separate, extensively documented catalog.**

### 4a. `gemini-3-pro-image-preview` ("Nanobanana Pro")

**VERIFIED FACT**, from
`evolink.ai/docs/en/api-manual/image-series/nanobanana/nanobanana-pro-image-generate.md`:

| Field | Verified value |
|---|---|
| Endpoint | `POST https://api.evolink.ai/v1/images/generations` |
| Auth | Bearer token — identical mechanism to the verified video endpoint |
| Model identifier | `gemini-3-pro-image-preview` (exact string, `model` field, required) |
| `prompt` | string, required, ≤2000 tokens |
| `image_urls` | array, optional, **max 14 images**, each ≤20MB, formats jpeg/jpg/png/webp, **max 5 real-person images**. Documented purpose: "Reference image URL list for image-to-image and image editing" |
| `size` | aspect-ratio enum (`auto`, `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`), default `auto` |
| `quality` | `1K`/`2K`/`4K`, default `2K`; 4K "incurs additional charges" |
| `model_params` | object, includes optional `web_search` boolean |
| `callback_url` | HTTPS webhook, same shape as the video endpoint |
| Lifecycle | Asynchronous — returns a task (`status`: pending/processing/completed/failed, `progress`, `object: image.generation.task`), same task-management pattern as video; **results valid 24 hours**, matching the video endpoint's documented expiry |
| Cost visibility | `usage.credits_reserved` estimate on the initial response, same as video |

### 4b. `gpt-image-2`

**VERIFIED FACT**, from
`evolink.ai/docs/en/api-manual/image-series/gpt-image-2/gpt-image-2-image-generation.md`:

| Field | Verified value |
|---|---|
| Endpoint | Same: `POST https://api.evolink.ai/v1/images/generations` |
| Model identifier | `gpt-image-2` |
| `image_urls` | array, optional, **1–16 images per request**, each ≤50MB, ≤178,956,970 total pixels, ≤23,170px per side — "Reference images for image-to-image or editing modes" |
| `mask_url` | PNG, alpha channel, must match reference dimensions — inpainting-specific |
| `size`/`resolution` | ratio or explicit pixels; `resolution` enum `1K`/`2K`/`4K` |
| `quality` | `low`/`medium`/`high`, cost multiplier ~0.11×/1.0×/~4.0× |
| `n` | 1–10 images per call |
| Lifecycle | Same async task pattern, same 24-hour result expiry |
| Error codes | 400/401/402/403/429/500 documented |

### 4c. `doubao-seedream-5.0-pro` (third candidate model, same provider)

**VERIFIED FACT**, from
`evolink.ai/docs/en/api-manual/image-series/seedream/seedream-5.0-pro-image-generate.md`:
`image_urls` array, **max 10 images**, same async lifecycle, same 24-hour
result expiry. **No character-consistency claim documented** for this model
specifically (unlike 4a).

### 4d. Does the existing provider abstraction support this?

**VERIFIED FACT + INFERENCE:** Yes, with no structural change.
`evolink-client.js`'s `evolinkRequest()` already accepts an arbitrary
`{method, path, body}` — adding `createImageGenerationTask(body)` calling
`POST /v1/images/generations` is a one-function addition, reusing the exact
same `getApiKey()`/error-handling/auth path already used for video. EvoLink's
own docs (`evolink-api.md`, Stage 6) already record that `GET
/v1/tasks/{task_id}` is a **unified** status endpoint for all multimodal
tasks (image, video, audio) — so `getTask()` needs no change at all for
polling an image task. A new `evolink-image-mapper.js`, mirroring the
existing `evolink-mapper.js`, is the only new translation code required.

**Whether it can accept our required reference assets:** **VERIFIED FACT +
INFERENCE.** EvoLink's `image_urls` field is a flat array of URLs — it
accepts multiple images (up to the documented per-model max), satisfying the
"more than one reference image" requirement. It does **not** document a
structured role/label per image (see Part 7's gap analysis) — ordering or
prompt-text framing would be the only way to convey "this one is the
identity reference, this one is the environment reference," which is
UNKNOWN to be officially supported (not found in any EvoLink page checked).

---

## 5. Higgsfield Investigation

**Source discipline:** official docs (`docs.higgsfield.ai`) fetched directly
where reachable; where a guessed URL 404'd, that is reported rather than
substituted with a third-party page. Additionally, Higgsfield's own
vendor-authored MCP tool catalog (`Higgsfield_MCP`, available read-only in
this environment) was inspected via its **model-catalog lookup tool**
(`models_explore`, `action: get`/`search`) — this calls Higgsfield's model
*catalog*, not a generation endpoint; **no image or video was generated, no
credit was spent, confirmed by the tool's own response containing no
job/generation id, only static model metadata.**

**VERIFIED FACT**, from `docs.higgsfield.ai/docs` and
`docs.higgsfield.ai/docs/guides/images`:

| Question | Finding |
|---|---|
| API base | `https://platform.higgsfield.ai/` |
| Auth | `Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}` |
| Officially documented model | `higgsfield-ai/soul/standard` — "flagship text-to-image model" |
| Documented request fields (this model) | `prompt`, `aspect_ratio`, `resolution` only |
| Reference image field on this page | **Not documented.** No `image`/`image_url`/`reference_image` field appears anywhere on the official text-to-image guide page |
| File upload mechanism (separate page) | 3-step presigned-URL flow (`/files/generate-upload-url` → PUT → reference via `public_url` in a model-specific field like `image_url`); confirms *a* mechanism to feed images into *some* models exists, but does not itself confirm which models accept it or how many |
| Lifecycle | Asynchronous — submit, then poll `status_url` or use a webhook |
| Pricing | Per-request, model/parameter-dependent; example given: 1,500 credits ≈ $0.094; credits expire 1 year after being added; failed/moderated/canceled requests refunded |
| Result retention | ≥7 days before possible removal |
| Rate limits | Concurrency-based, no published fixed number |

**VERIFIED FACT, via Higgsfield's own MCP tool catalog (not the REST docs)**
— the vendor's own model catalog lists these image models, with their
declared reference-media limits:

| Model ID | Provider | Reference images (`medias`) |
|---|---|---|
| `soul_2` (Higgsfield Soul 2.0) | Higgsfield | **max 1** image, role `image` |
| `nano_banana_pro` | Google (wrapped by Higgsfield) | `medias` role `image`, **no `max` declared** in the catalog entry (UNKNOWN whether this means unlimited or the catalog simply omits a cap that still defaults to 1) |
| `marketing_studio_image` | Higgsfield | `medias` role `image`, no `max` declared |
| `autosprite` | Higgsfield | max 1 image, required |

**Searching the catalog directly for "multiple reference images / character
consistency" returned only single-reference-image models** (`soul_2`,
`autosprite`, `soul_v2`) — no Higgsfield-native model in the catalog declares
support for more than one simultaneous reference image with distinct roles
(e.g., one for identity, one for environment).

**UNKNOWN, explicitly:** Whether `nano_banana_pro` as wrapped by Higgsfield
actually supports the same multi-image, character-consistency-specific input
(up to 5 character + 6 object images) that Google's own native API documents
for the same underlying model (Part 6 below) — the Higgsfield catalog entry
simply doesn't specify a `max`, and no REST-level OpenAPI spec for this
specific wrapped model was found on `docs.higgsfield.ai`.

**Conclusion for Higgsfield:** its one fully-documented native model
(`soul/standard`) is text-to-image only with **no reference-image support at
all** per official docs. Its broader catalog (visible only through the
vendor's own MCP tool, not the public REST docs) caps every *other*
Higgsfield-native model at a single reference image. This does not meet the
"multiple references with distinguishable roles" requirement from Part 3.

---

## 6. Other Provider Investigation — Google Gemini API (direct)

Investigated as the third required candidate (Part 1), and because it is
the **primary source** for the model both EvoLink and Higgsfield resell as
"Nano Banana Pro."

**VERIFIED FACT**, from `ai.google.dev/gemini-api/docs/image-generation`
(Google's own official docs):

| Field | Verified value |
|---|---|
| Model identifiers | `gemini-3-pro-image` (Nano Banana Pro), `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite), `gemini-2.5-flash-image` (legacy Nano Banana) |
| Multiple reference images | **Yes, explicitly, per model:** Nano Banana 2 Lite — up to 14 object images; Nano Banana 2 — up to 10 object + **4 dedicated character-consistency images** + 3 style references; **Nano Banana Pro — up to 6 object images + 5 dedicated character-consistency images** |
| Character consistency | **Explicitly documented, distinct input class**: "Dedicated character consistency inputs enable maintaining facial features and identity across multiple images in a scene." This is the strongest, most explicit reference-conditioning claim found across all three providers researched — it names identity preservation as a first-class, structurally distinct input, not just "upload an image and hope." |
| Request shape | `client.interactions.create(model=..., input=[{type:"text",...},{type:"image", data: base64, mime_type:...}], response_format={type:"image", aspect_ratio, image_size})` |
| Processing mode | **Synchronous** — image returned directly in the response (`interaction.output_image.data`, base64) — notably different from EvoLink/Higgsfield's async task model |
| Resolutions | 0.5K/1K/2K/4K, model-dependent |
| Watermarking | Generated images carry a SynthID watermark (documented) |
| Commercial terms | Not found in the fetched excerpt; UNKNOWN beyond the watermark note |
| Pricing/rate limits | UNKNOWN — not in the fetched excerpt, referenced as living in separate doc sections not fetched this stage |

**This is a genuinely separate provider integration path** (own API key, own
base URL, own auth, synchronous instead of async) — not a drop-in extension
of `providers/evolink/`. Connecting it would mean a new `providers/google/`
adapter from scratch, including a new synchronous-result code path our
current `image-provider-interface.js` doesn't need to change to support
(nothing in the interface assumes async), but our generic
`createGenerationStatus`'s `PROCESSING` state would simply never be observed
for this provider — a compatible, not conflicting, difference.

---

## 7. Reference-Image Capability Comparison

| Capability | EvoLink (`gemini-3-pro-image-preview`) | EvoLink (`gpt-image-2`) | Higgsfield (`soul/standard`, official docs) | Higgsfield (catalog, other models) | Google Gemini (`gemini-3-pro-image`, direct) |
|---|---|---|---|---|---|
| One character reference | VERIFIED — supported | VERIFIED — supported | NOT SUPPORTED | VERIFIED (max 1) | VERIFIED — supported |
| Multiple character references | VERIFIED — up to 5 person images within the 14-image cap | VERIFIED — within 16-image cap, no person-specific sub-cap documented | NOT SUPPORTED | NOT SUPPORTED (max 1 total) | VERIFIED — up to 5 dedicated character-consistency images |
| Character + environment references together | INFERENCE — both are just entries in the same flat `image_urls` array, so plausible, but no role-tagging documented | INFERENCE — same reasoning | NOT SUPPORTED | NOT SUPPORTED | VERIFIED — object images (environment/props) and character-consistency images are separate declared input classes |
| Reference-image ordering significance | NOT DOCUMENTED | NOT DOCUMENTED | N/A | N/A | NOT DOCUMENTED (roles are declared by input class, not order, per the summarized guide) |
| Reference-image weighting | NOT DOCUMENTED | NOT DOCUMENTED | N/A | N/A | NOT DOCUMENTED |
| Identity preservation (explicitly named as such) | INFERENCE (same underlying Google model as col. 5, not independently confirmed by EvoLink's own docs) | NOT DOCUMENTED | N/A | UNKNOWN | **VERIFIED FACT** — explicitly documented |
| Real conditioning vs. prompt attachment | INFERENCE — likely real conditioning (see above) | INFERENCE | N/A (no image input at all) | UNKNOWN | VERIFIED — explicit dedicated input class, not merely an uploaded file |
| References reusable across generations | UNKNOWN — no persistent reference-asset concept documented (a fresh URL per request) | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

---

## 8. Provider Comparison Table

Per Part 5's instruction: HIGH/MEDIUM/LOW/UNKNOWN only, no fabricated
numeric scores.

| Provider | API available | Image generation | Reference images | Multiple references | Character consistency | Environment consistency | Async | Output archival | Pricing clarity | Commercial API | Model ID verified | Request schema verified | Overall suitability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **EvoLink** | HIGH | HIGH | HIGH | HIGH (up to 14–16) | MEDIUM (inferred from underlying model, not EvoLink-documented directly) | MEDIUM (same reasoning) | HIGH (async, matches our existing integration) | MEDIUM (24h URL expiry, documented, same as video) | MEDIUM (per-request estimate only, no rate card) | UNKNOWN (no explicit commercial-terms page found this stage) | HIGH | HIGH | **HIGH** |
| **Higgsfield** | HIGH (official REST docs exist) | HIGH (official docs) | LOW (official model supports none; catalog models cap at 1) | LOW | LOW (only claimed for the un-REST-documented `nano_banana_pro` wrap) | LOW | HIGH | MEDIUM (≥7 days documented) | MEDIUM (example rate + expiry documented) | UNKNOWN | MEDIUM (official model verified; "Banana Pro" mapping still unresolved at the REST-doc level) | MEDIUM (only `soul/standard`'s fields are REST-documented) | **LOW-MEDIUM** |
| **Google Gemini (direct)** | HIGH | HIGH | HIGH | HIGH, with **dedicated character-consistency input class** | **HIGH** (only provider with an explicit, named identity-preservation input) | MEDIUM (object images, not identity-specific) | N/A (synchronous) | UNKNOWN (not fetched this stage) | UNKNOWN (not fetched this stage) | UNKNOWN | HIGH | HIGH | **HIGH, but requires a new, separate integration (new provider module, new auth, new sync code path)** |

---

## 9. Recommended Provider

**RECOMMENDATION:** Extend the existing **EvoLink** integration with an
image-model adapter targeting **`gemini-3-pro-image-preview`** first, with
**`gpt-image-2`** as a documented fallback/alternative model within the same
adapter (both share identical request/response shape — only `model` and a
few field names like `size` vs. `resolution` differ).

**Why EvoLink over Google direct**, despite Google's own docs being more
explicit about character consistency: EvoLink reuses an account, an API key
pattern, an HTTP client, an async task/polling model, and an error-mapping
convention **we have already built, tested, and documented** for video. A
new `providers/google/` integration would duplicate that entire boundary for
a synchronous API with a different auth scheme, for unknown/UNKNOWN pricing
and commercial terms. The EvoLink path is the smaller, lower-risk change —
consistent with Stage 13E/14's repeated instruction to prefer narrow
extension over new surface area.

**Why not Higgsfield:** its only REST-documented model has no reference-image
support at all, and every other model in its own vendor-authored catalog
caps out at one reference image — insufficient for keyframes that lock both
identity and environment simultaneously.

---

## 10. Exact Verified Model Identifiers

- `gemini-3-pro-image-preview` — EvoLink, primary recommendation (VERIFIED FACT, `evolink.ai/docs`)
- `gpt-image-2` — EvoLink, fallback/alternative (VERIFIED FACT, `evolink.ai/docs`)
- `doubao-seedream-5.0-pro` — EvoLink, third option, no character-consistency claim (VERIFIED FACT, `evolink.ai/docs`)
- `higgsfield-ai/soul/standard` — Higgsfield, REST-documented but no reference-image support (VERIFIED FACT, `docs.higgsfield.ai`)
- `soul_2` / `nano_banana_pro` / `marketing_studio_image` / `autosprite` — Higgsfield, catalog-only (VERIFIED FACT via vendor MCP tool, **not** REST-doc-verified)
- `gemini-3-pro-image` — Google direct (VERIFIED FACT, `ai.google.dev`) — note the identifier **differs** from EvoLink's resold `-preview` suffix; these are documented separately and not confirmed to be byte-identical models, though almost certainly the same underlying model per a shared name (INFERENCE)

---

## 11. Exact Verified Request Schema (Recommended Path)

`POST https://api.evolink.ai/v1/images/generations`, `Authorization: Bearer <EVOLINK_API_KEY>`:

```json
{
  "model": "gemini-3-pro-image-preview",
  "prompt": "string, required, ≤2000 tokens",
  "image_urls": ["https://...", "... up to 14 total, max 5 real-person images"],
  "size": "auto | 1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 4:5 | 5:4 | 9:16 | 16:9 | 21:9",
  "quality": "1K | 2K | 4K",
  "model_params": { "web_search": false },
  "callback_url": "https://... (optional webhook)"
}
```

Response (submission):
```json
{
  "id": "task-unified-...",
  "object": "image.generation.task",
  "type": "image",
  "model": "gemini-3-pro-image-preview",
  "status": "pending",
  "progress": 0,
  "task_info": { "estimated_time": <seconds> },
  "usage": { "credits_reserved": <number>, "billing_rule": "per_call|per_token|per_second" }
}
```

Polling: `GET https://api.evolink.ai/v1/tasks/{task_id}` — **the same unified
endpoint already implemented in `evolink-client.js`'s `getTask()`**, no new
polling code needed.

---

## 12. Mapping to Our Normalized Request

```
KeyframePromptPackage
  → buildNormalizedImageRequest() [services/image-generation-executor.js]
  → { prompt, promptSections, referenceAssets: [assetId, ...], recommendedSkill, parameters }
  → (NEW) evolink-image-mapper.js
  → { model: "gemini-3-pro-image-preview",
      prompt: <derived package.prompt>,
      image_urls: <referenceAssets resolved to their public/archived URLs>,
      size: <from parameters.aspectRatio, mapped to EvoLink's enum>,
      quality: <from parameters.resolution, mapped to 1K/2K/4K> }
```

| Package concept | Where it goes today | Gap |
|---|---|---|
| `identityLock[]` / `wardrobeLock[]` / `environmentLock[]` (structured fields) | Folded into `promptSections` → `prompt` text today (per `keyframe-prompt-service.js`'s derivation) | None — this already works, text-only conditioning is exactly what EvoLink's `prompt` field takes |
| `existingReferenceAssets[]` (**has** `role`/`type` per entry) | `buildNormalizedImageRequest()` **drops** `role`/`type`, keeping only `assetId` | **Gap.** To exploit EvoLink's multi-image support meaningfully (vs. just piling all images into one undifferentiated array), the normalized request would need to carry `role`/`type` through, and the image-mapper would need to either (a) order images consistently with a documented convention, or (b) fold role labels into the prompt text itself (e.g., "the first reference image is the character's identity, the second is the environment") — since EvoLink documents no structured per-image role field |
| `negativeConstraints[]` | Already folded into `prompt`/`promptSections` | None |
| Aspect ratio / resolution | Not yet in `parameters` at all — `buildNormalizedImageRequest()` passes through `parameters` verbatim from the caller, but nothing today populates aspect ratio/resolution from the package | **Gap** — would need to be added as a caller-supplied `parameters` value, or derived from `keyframe.frameType`/project defaults; not present anywhere in the current schema |
| Cost/budget check before submission | `services/approval-gate.js` / `keyframe-generation-service.js` — unchanged, already gates every generation attempt | None — this layer is provider-agnostic already and needs no change to support a new image provider |

**Everything else** (skill recommendation, warnings, package versioning/
staleness) already flows through unchanged, since none of it is
provider-specific.

---

## 13. Unknowns

Explicit list, consolidated from all sections above:

- Whether EvoLink's `image_urls` ordering or position conveys any semantic
  meaning to the model, or is purely order-independent — not documented.
- Whether EvoLink's resold `gemini-3-pro-image-preview` inherits Google's
  documented dedicated character-consistency input class, or silently folds
  everything into one undifferentiated `image_urls` array — not confirmed;
  EvoLink's own docs don't repeat Google's character-consistency framing.
- EvoLink's numeric rate limits (RPM/concurrency) for image models —
  not published (same gap already noted for video in Stage 6).
- A centralized EvoLink image-model price list — not published; only
  per-request `usage.credits_reserved` estimates exist.
- EvoLink's commercial-usage/licensing terms for generated images —
  not found in the pages fetched this stage.
- Whether reference images can be reused across multiple generation calls
  without re-uploading (a persistent reference-asset concept) — not
  documented by any of the three providers.
- Google Gemini API's pricing, rate limits, and commercial terms — not
  fetched this stage (out of scope once EvoLink was identified as the
  narrower, lower-risk path).
- Whether Higgsfield's `nano_banana_pro` catalog entry's unstated `max` on
  reference images means "1" (like every other Higgsfield-native model) or
  something larger — no REST-level spec found to confirm either way.

---

## 14. Risks

- **Identity-preservation reliability is an empirical question, not a
  documentation question.** No amount of further reading resolves whether
  `gemini-3-pro-image-preview` actually keeps a character's face consistent
  across our specific keyframe set — only a real (future, separately
  authorized) test generation can answer that. This investigation can only
  confirm the API *accepts* the inputs needed to attempt it.
- **Role-blind reference arrays.** Without an explicit per-image role
  (Part 12's identified gap), a naive implementation could pass identity and
  environment references in an order the model doesn't reliably interpret as
  intended, silently degrading output quality rather than failing loudly.
- **24-hour result URL expiry** (documented, matches the existing video
  provider) means any real integration must archive results promptly — the
  existing `services/asset-archive-service.js` (Stage 9A) already does this
  and needs no change, but this is a real operational constraint to keep in
  mind, not a hypothetical one.
- **Cost exposure.** Every model researched bills per generation with no
  free/sandbox tier found for any of the three providers — the existing
  budget/approval gate (Stage 13B/13E) is the only thing standing between a
  connected provider and real spend, and must not be weakened when this is
  eventually implemented.

---

## 15. Cost Considerations

**PARTIALLY DOCUMENTED**, consistent with the existing video integration's
own pricing gap (Stage 6): every provider exposes a **per-request cost
estimate** (`usage.credits_reserved` for EvoLink) but **no provider
publishes a standalone price list** per model/resolution/reference-count
that was found this stage. `gpt-image-2`'s quality tiers carry documented
relative multipliers (`low` ~0.11×, `medium` 1.0×, `high` ~4.0×); Nano Banana
Pro/`gemini-3-pro-image-preview` documents only that 4K "incurs additional
charges" without a number. No live cost was incurred confirming any of this
— all figures above are read directly from vendor documentation.

---

## 16. Credential Considerations

**No credential was requested, printed, logged, or added anywhere in this
investigation.** `server/.env.example` already has a placeholder for
`EVOLINK_API_KEY` (added Stage 6, still empty). If image generation is ever
connected, it would reuse this **same** environment variable — EvoLink's
image and video endpoints share one API key and one account, confirmed by
both endpoints living under the same `https://api.evolink.ai` base URL and
`Authorization: Bearer` scheme. No new environment variable, no new
`.env.example` entry, and no code touching credential handling was added or
modified this stage.

---

## 17. Proposed Implementation Plan (NOT executed this stage)

Recorded for a future, separately-authorized stage — nothing below was built:

1. Add `createImageGenerationTask(body, options)` to `evolink-client.js`
   (`POST /v1/images/generations`) — reuses `evolinkRequest()` unchanged.
2. Add `evolink-image-mapper.js`, mirroring `evolink-mapper.js`, translating
   the normalized image request to/from EvoLink's image-task shape.
3. Add `evolink-image-provider.js` implementing
   `image-provider-interface.js`'s two required methods, wired the same way
   `fake-image-provider.js` is today.
4. Extend `services/image-generation-executor.js`'s
   `buildNormalizedImageRequest()` to carry `role`/`type` through from
   `existingReferenceAssets` (closes Part 12's gap) — additive, no existing
   field removed or renamed.
5. Add aspect-ratio/resolution as explicit, package-derived (or
   project-default) `parameters`, rather than leaving them entirely
   caller-supplied.
6. First real validation: call the safe, non-generation
   `GET /v1/credits` endpoint (already identified in Stage 6) to confirm a
   newly-added key works, **before** any generation call.
7. A single, explicitly human-approved test generation against one
   disposable project, gated by the existing
   `KEYFRAME_GENERATION_APPROVAL`/budget gate — never automatic, never
   batched.

---

## 18. What Must NOT Be Changed Yet

Per this stage's explicit constraints — none of the following were touched:

- `providers/image-provider-interface.js` — unmodified.
- `providers/evolink/` — unmodified (no new file added).
- `services/keyframe-generation-service.js`, `services/approval-gate.js` —
  unmodified.
- `frontend/` — unmodified.
- Any MCP generation tool — unmodified.
- `server/.env` / `server/.env.example` — unmodified, no key added.
- No new provider module was created.

---

## Decision Gate

**A — READY TO CONNECT.**

Scoped narrowly: EvoLink's `gemini-3-pro-image-preview` (primary) and
`gpt-image-2` (fallback) are documented to the same level of primary-source
completeness the existing, already-connected EvoLink **video** integration
was documented to before it was built — exact endpoint, exact auth, full
field-level request/response schema, verified async lifecycle, verified
result-URL expiry, verified error-code taxonomy. The existing provider
abstraction (`image-provider-interface.js`) requires **no change** to
represent this — it already treats a provider's request as opaque past the
normalized shape. The one real gap found (role/type metadata dropped in
`buildNormalizedImageRequest()`) is a small, additive extension, not a
redesign, and is not itself a blocker to writing a first adapter.

This is **not** a claim that the model will reliably preserve identity for
our specific characters — that remains genuinely unverifiable from
documentation alone (Part 14) and must be confirmed by a real, narrowly
scoped, separately-approved test generation before this is trusted for
production keyframes. It is a claim that the **API integration itself** can
be implemented safely, following the same documented-first discipline
already used for video.

**Per this stage's instructions, this document does not proceed to
implementation.** Part 17's plan is a proposal for a future stage to accept,
modify, or reject.

---

## Safety Check (Part 12/8)

- Real image-generation calls made: **0**
- Real video-generation calls made: **0**
- EvoLink generation calls made: **0**
- Higgsfield generation calls made: **0** (only a read-only model-catalog
  lookup via the vendor's own MCP tool — no job/generation id was ever
  returned, confirming no generation was submitted)
- Credits spent: **0**
- API keys accessed, created, or requested: **0**
- Production code modified: **0 files** (this document is the only file
  added or changed this stage)
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`): verified
  byte-identical before and after this stage (status `CALIBRATION`,
  `creditLedger.reserved = 100.45`, unacknowledged 0.45 overage,
  `blocked: true`, 1 asset, 0 keyframes)
- Test suite: 716/716 passing before this stage; re-verified after (Part 21)
