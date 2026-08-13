# Generation Model Capability Registry — Investigation & Design (Stage 22B-Part-0)

Read-only investigation and design. **No production code was written or
modified for this document.** No real EvoLink or Google API call was made, no
credits were spent, no generation job was created, and the real smoke-test
project (`9b6a78b3-7238-4469-8280-5c4281216343`) was not touched.

## Verification discipline (four tiers, applied consistently below)

Mirrors and extends `evolink-models.js`'s existing `requestSchemaVerified` gate
— this document does **not** loosen that discipline, it makes its levels
explicit so a model that merely "appears in a pricing table" is never confused
with one whose real request/response shape has been independently opened.

1. **CATALOGUE AVAILABLE** — the model name and a price appear on EvoLink's
   public models/pricing listing (`evolink.ai/models`). Nothing about its
   request shape or exact capabilities has been confirmed.
2. **CAPABILITY VERIFIED** — modes, reference-image limits, durations,
   resolutions etc. were confirmed against *some* official EvoLink page
   (a dedicated model page or blog post), but that page was not necessarily
   a full OpenAPI spec, or was only read via a summarized fetch rather than
   independently re-derived field-by-field.
3. **REQUEST SCHEMA VERIFIED** — a full OpenAPI 3.1.0 spec page for that exact
   model was opened and its request/response fields confirmed. This is the
   **same bar** `evolink-models.js`'s `requestSchemaVerified: true` already
   requires, and the only tier at which this project's mapper code is allowed
   to build a real request.
4. **SAFE FOR PRODUCTION** — Tier 3, AND no capability gap was found that
   would silently break our architecture (e.g. no reference-image support at
   all when our use case requires one). A model can be schema-verified and
   still **not** be production-safe for *this project specifically*.

---

## A. Current EvoLink Model Catalogue

Source: `evolink.ai/models` (catalogue/pricing page, fetched directly) unless
otherwise noted. All prices are EvoLink's own USD-equivalent list prices,
alongside the credit figure the same page shows.

### Video

| Model | Price | Catalogue tier |
|---|---|---|
| Seedance 1.0 Pro Fast | $0.0060/s (0.405 credits) | 1 — CATALOGUE AVAILABLE |
| Seedance 1.5 Pro | $0.013/s (0.8181 credits) | 1 — CATALOGUE AVAILABLE |
| Seedance 2.0 Mini | $0.011/s (0.767 credits) | 3 — REQUEST SCHEMA VERIFIED |
| Seedance 2.0 Fast | not separately priced on the catalogue page (only Mini and standard 2.0 appear as distinct price rows) | 3 — REQUEST SCHEMA VERIFIED (schema confirmed, price UNKNOWN) |
| Seedance 2.0 (standard) | $0.033/s (2.272 credits) | 3 — REQUEST SCHEMA VERIFIED |
| Grok Imagine Video | $0.020/s (1.36 credits) | 1 — CATALOGUE AVAILABLE |
| Wan 2.5 (video) | $0.038/s (2.55 credits) | 1 — CATALOGUE AVAILABLE |
| Wan 2.6 | $0.075/s (5.1 credits) | 2 — CAPABILITY VERIFIED (secondary/blog) |
| Kling 3.0 | $0.080/s (5.4 credits) catalogue; a separate "Motion Control" sub-product is quoted at $0.1134/s in a blog post — **these may be different endpoints, not resolved** | 2 — CAPABILITY VERIFIED (secondary, motion-control variant only) |
| Sora 2 | $0.085/s (5.76 credits) | 1 — CATALOGUE AVAILABLE |
| Veo 3.1 (EvoLink resale) | $0.318/video listed as one line covering "Fast and Pro variants" — **EvoLink's own distinct model-ID strings for Fast vs. Pro were not found**, unlike Google's own direct API (Stage 22A confirmed `veo-3.1-generate-preview` / `veo-3.1-fast-generate-preview` there) | 1 — CATALOGUE AVAILABLE |

### Image

| Model | Price | Catalogue tier |
|---|---|---|
| Raphael Krea 2 Turbo | $0.0067/img (0.45 credits) | 3 — REQUEST SCHEMA VERIFIED, but **NOT production-safe for this project** (no reference-image support at all — see below) |
| GPT Image 2 | $0.015/img (1.02 credits) | 3 — REQUEST SCHEMA VERIFIED (already in this codebase's `evolink-models.js` since Stage 15) — **4 — SAFE FOR PRODUCTION** |
| Wan Image (`wan2.5-image-to-image`) | $0.023/img (1.5 credits) | 3 — REQUEST SCHEMA VERIFIED — **4 — SAFE FOR PRODUCTION** (capped at 2 references) |
| Seedream 5.0 Lite | $0.028/img (1.904 credits) | 1 — CATALOGUE AVAILABLE (exact model ID unconfirmed — see Known Unknowns) |
| Nano Banana 2 (`gemini-3.1-flash-image`, via EvoLink) | $0.036/img (2.4 credits) | 1 — CATALOGUE AVAILABLE (not yet in this codebase's `evolink-models.js` — only Nano Banana **Pro** was added in Stage 16) |
| Nano Banana Pro (`gemini-3-pro-image-preview`, via EvoLink) | $0.046/img (3.1 credits) | 3 — REQUEST SCHEMA VERIFIED (already in `evolink-models.js` since Stage 16) — **4 — SAFE FOR PRODUCTION**, proven in Stages 16–21 with real generations |

**Notably: EvoLink resells Nano Banana Pro cheaper ($0.046/img) than Google's
own direct list price ($0.134/img at 1K–2K, per Stage 22A)** — a concrete,
already-actionable reason to keep EvoLink as the primary path for this exact
model rather than switching to Google directly for it, independent of any
other architecture consideration.

---

## B. Current Google Model Catalogue (carried forward from Stage 22A, Section B/G — not re-fetched this session)

| Model | Model ID | Price | Status |
|---|---|---|---|
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` | ~$0.034/1K image | Stable |
| Nano Banana 2 | `gemini-3.1-flash-image` | $0.067/1K image | Stable |
| Nano Banana Pro | `gemini-3-pro-image` (ID conflict with `-preview` suffix unresolved) | $0.134/1K–2K, $0.24/4K | Stable |
| Veo 3.1 | `veo-3.1-generate-preview` | $0.40/s (720p/1080p), $0.60/s (4K) | Preview |
| Veo 3.1 Fast | `veo-3.1-fast-generate-preview` | $0.10–0.30/s (conflicting sources) | Preview |
| Veo 3.1 Lite | `veo-3.1-lite-generate-preview` | $0.05–0.08/s | Preview |

None of these were re-verified this session; see `docs/integrations/google-provider-investigation.md` for the full sourcing.

---

## C. Cheapest Candidates

**Video — cheapest overall:** Seedance 1.0 Pro Fast at $0.0060/s, but Tier 1
only (catalogue-listed price, capabilities unconfirmed against any dedicated
page). **Cheapest candidate that is also schema-verified and reference-capable:
Seedance 2.0 Mini reference-to-video at $0.011/s** — nearly 2x Seedance 1.0 Pro
Fast's raw price, but the only sub-$0.02/s option this investigation can
actually vouch for (full OpenAPI spec opened, 0–9 reference images, first/last
frame support confirmed). This is the standout recommendation for
cost-sensitive video generation once Stage 22B is built.

**Image — cheapest overall:** Raphael Krea 2 Turbo at $0.0067/img, but
**disqualified for this project** — confirmed via its own full spec page to be
text-to-image only, no reference-image input of any kind, which is
incompatible with the canonical-reference architecture this whole project is
built around (Stages 17–21). **Cheapest candidate that is both schema-verified
and reference-capable: GPT Image 2 at $0.015/img**, already proven safe in this
codebase since Stage 15/16 (also documented there as supporting up to 16
reference images per the original investigation) — this is materially cheaper
than either Nano Banana model while offering equal or greater reference
capacity, and should be considered the default cost-optimized choice for image
generation once a recommendation engine exists.

---

## D. Capability Matrix

| Model | Modality | T2I | I2I | T2V | I2V | Ref-to-video/image | Max refs | First/last frame | Audio | Durations | Max res |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---|
| Seedance 2.0 Mini | video | — | — | ✅ | ✅ | ✅ | 0–9 | ✅ (1–2 images) | ✅ default-on | 4–15s | 720p |
| Seedance 2.0 Fast | video | — | — | ✅ | ✅ | ✅ | 0–9 | ✅ | ✅ | 4–15s | 720p |
| Seedance 2.0 (standard) | video | — | — | ✅ | ✅ | ✅ | 0–9 | ✅ | ✅ | 4–15s | 1080p |
| Seedance 2.5 (already integrated, Stage 16) | video | — | — | ✅ | ✅ | UNKNOWN — `seedance-2.5-reference-to-video` exists in our own `evolink-models.js` but is explicitly `requestSchemaVerified: false` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| Wan 2.6 | video | — | — | ✅ (secondary) | ✅ (secondary) | ✅ (secondary) | 3 videos | UNKNOWN | ✅ ("audio output on current routes") | 2–15s (T2V/I2V), 2–10s (ref) | 1080p |
| Krea 2 Turbo | image | ✅ | ❌ | — | — | ❌ (confirmed: text-to-image only) | 0 | n/a | n/a | n/a | 2K |
| GPT Image 2 | image | ✅ | ✅ | — | — | ✅ (Stage 15) | up to 16 (per Stage 15 investigation) | n/a | n/a | n/a | high-res (per Stage 15) |
| Wan Image (`wan2.5-image-to-image`) | image | UNKNOWN (page covers image-to-image only) | ✅ | — | — | ✅ | 2 | n/a | n/a | n/a | up to 5000px |
| Nano Banana Pro (via EvoLink) | image | ✅ | ✅ | — | — | ✅ (Stage 16, proven live) | up to 5 character / 6 object (Stage 22A, Google's own docs — EvoLink's resold limits not separately re-confirmed) | n/a | n/a | n/a | 4K |

Every other catalogue row (Seedance 1.0 Pro Fast, Seedance 1.5 Pro, Grok
Imagine Video, Wan 2.5 video, Kling 3.0, Sora 2, Veo 3.1 via EvoLink, Seedream
5.0 Lite, Nano Banana 2 non-Pro) has **no capability row here** — deliberately.
This investigation did not open a dedicated spec/capability page for them, and
per the instruction "do not mark a model verified merely because EvoLink lists
it," listing an unconfirmed capability would be worse than omitting it.

---

## E. Verified vs. Unverified Models — Full Tier Assignment

| Model | Provider | Tier | Notes |
|---|---|---|---|
| `seedance-2.0-mini-{text,image,reference}-to-video` | evolink | 3 (Schema Verified) | Full OpenAPI spec opened this session |
| `seedance-2.0-fast-{text,image,reference}-to-video` | evolink | 3 (Schema Verified) | Same spec page as Mini/standard |
| `seedance-2.0-{text,image,reference}-to-video` | evolink | 3 (Schema Verified) | Same page |
| `seedance-2.5-text-to-video` | evolink | 3 (Schema Verified) | Already verified, Stage 15 |
| `seedance-2.5-image-to-video` | evolink | 3 (Schema Verified) | Already verified, Stage 15 |
| `seedance-2.5-reference-to-video` | evolink | 1 (Catalogue only, ID exists) | Already flagged `requestSchemaVerified: false` in our own codebase — this investigation did not change that |
| `seedance-2.5-video-edit` / `-video-extend` | evolink | 1 (Catalogue only, ID exists) | Same pre-existing `false` flag, untouched |
| `seedance-1.0-pro-fast` | evolink | 1 (Catalogue only) | Not independently opened |
| `seedance-1.5-pro` | evolink | 1 (Catalogue only) | Not independently opened |
| `grok-imagine-video` (exact ID UNKNOWN) | evolink | 1 (Catalogue only) | Not independently opened; exact model-ID string not confirmed |
| `wan2.5-*` (video variant, exact ID UNKNOWN) | evolink | 1 (Catalogue only) | Only the *image* Wan 2.5 model ID was confirmed this session, not video |
| `wan2.6-*` (exact ID UNKNOWN) | evolink | 2 (Capability, secondary) | Blog-level detail only, not a spec page |
| Kling 3.0 (exact ID UNKNOWN) | evolink | 2 (Capability, secondary, motion-control sub-product only) | Base Kling 3.0 t2v/i2v capabilities not confirmed |
| Sora 2 (exact ID UNKNOWN) | evolink | 1 (Catalogue only) | Not independently opened |
| Veo 3.1 (EvoLink resale, exact IDs UNKNOWN) | evolink | 1 (Catalogue only) | EvoLink's own Fast/Pro model-ID strings not found; only Google's own direct IDs are known (Stage 22A) |
| `krea-2-turbo` | evolink | 3 (Schema Verified), **not production-safe** | No reference support at all — disqualified for our use case, not a verification failure |
| `gpt-image-2` | evolink | 4 (Safe for production) | Already proven, Stage 15/16 |
| `wan2.5-image-to-image` | evolink | 4 (Safe for production) | Full spec opened this session; capped at 2 references |
| Seedream 5.0 Lite (exact ID UNKNOWN) | evolink | 1 (Catalogue only) | Model ID pattern likely `doubao-seedream-5.0-lite` by analogy with the confirmed `doubao-seedream-5.0-pro`, but **not confirmed** — never guess this into code |
| `gemini-3.1-flash-image` (Nano Banana 2, via EvoLink) | evolink | 1 (Catalogue only) | Priced and named on the catalogue page; no dedicated EvoLink spec page opened. Note: this is a **different** model from our already-verified Nano Banana **Pro** |
| `gemini-3-pro-image-preview` (Nano Banana Pro, via EvoLink) | evolink | 4 (Safe for production) | Already proven, Stage 16–21, 9 real generations |
| `gemini-3.1-flash-lite-image` / `gemini-3.1-flash-image` / `gemini-3-pro-image` (Google direct) | google | 1–2 (per Stage 22A) | Carried forward, not re-verified this session |
| `veo-3.1-generate-preview` / `veo-3.1-fast-generate-preview` / `veo-3.1-lite-generate-preview` (Google direct) | google | 1–2 (per Stage 22A) | Carried forward, not re-verified this session |

---

## F. Proposed Registry Schema

New file: `server/services/generation-model-registry.js`. Pure data +
read-only query functions — no HTTP, no provider imports, no side effects.
Deliberately mirrors `evolink-models.js`'s allowlist shape rather than
inventing a new one, extended to cover both providers and both modalities in
one place:

```js
// generation-model-registry.js
//
// CAPABILITIES ONLY. This file never contains a provider-specific field name
// (no image_urls, no reference_images, no inline_data) — those belong
// exclusively to each provider's own mapper (providers/evolink/evolink-*-mapper.js,
// providers/google/google-*-mapper.js). This file answers "what can this
// model do and what tier of confidence do we have in that claim," never
// "how do I format a request for it."

const GENERATION_MODEL_REGISTRY = [
  {
    provider: 'evolink',
    model: 'seedance-2.0-mini-reference-to-video',
    modality: 'video',
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      referenceToVideo: true,
      maxReferenceImages: 9,
      firstFrame: true,
      lastFrame: true,
      audio: true,
      durationsSeconds: [4, 15],       // documented range, not an enum
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
    },
    pricing: {
      unit: 'per_second',
      startingPrice: 0.011,
      currency: 'USD',
      sourceDate: '2026-08-13',        // pricing pages change without notice — stamp when read
    },
    verificationTier: 'REQUEST_SCHEMA_VERIFIED',
    requestSchemaVerified: true,        // kept as its own boolean too, so
                                         // existing evolink-models.js-style
                                         // callers (`if (!verified) throw`)
                                         // need no new branching
    productionReady: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/video-series/seedance2.0/seedance-2.0-overview',
  },
  {
    provider: 'evolink',
    model: 'gpt-image-2',
    modality: 'image',
    capabilities: {
      textToImage: true,
      imageToImage: true,
      referenceConditioning: true,
      maxReferenceImages: 16,
    },
    pricing: { unit: 'per_image', startingPrice: 0.015, currency: 'USD', sourceDate: '2026-08-13' },
    verificationTier: 'SAFE_FOR_PRODUCTION',
    requestSchemaVerified: true,
    productionReady: true,
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/gpt-image-2/gpt-image-2-image-generation',
  },
  {
    provider: 'evolink',
    model: 'krea-2-turbo',
    modality: 'image',
    capabilities: {
      textToImage: true,
      imageToImage: false,
      referenceConditioning: false,   // explicit false, never omitted —
                                       // omission would look like "unknown",
                                       // this is a CONFIRMED absence
      maxReferenceImages: 0,
    },
    pricing: { unit: 'per_image', startingPrice: 0.0067, currency: 'USD', sourceDate: '2026-08-13' },
    verificationTier: 'REQUEST_SCHEMA_VERIFIED',
    requestSchemaVerified: true,
    productionReady: false,           // schema-verified, but disqualified —
                                       // these two flags are allowed to
                                       // disagree, and this is why the
                                       // registry has both
    productionReadyReason: 'No reference-image support of any kind — incompatible with this project\'s canonical-reference architecture.',
    docsUrl: 'https://evolink.ai/docs/en/api-manual/image-series/krea/krea-2-turbo-image-generate',
  },
  // ...remaining catalogue rows, most at verificationTier: 'CATALOGUE_AVAILABLE',
  // requestSchemaVerified: false, productionReady: false, exactly matching
  // Section E's table row for row.
];

// ---- read-only query functions, EXECUTE NOTHING ----

function listModels({ provider, modality, requireProductionReady = true } = {}) { /* filter */ }

function findModelsSatisfying(requirements) {
  // requirements: { modality, needsReferenceConditioning, minReferenceImages,
  //                 needsAudio, minDurationSeconds, minResolution, ... }
  // Returns every registry entry whose capabilities are a superset of
  // `requirements`, AND whose verificationTier is at least
  // REQUEST_SCHEMA_VERIFIED (never recommends an unverified model).
  // NEVER submits anything — pure filter over the array above.
}

function cheapestSatisfying(requirements) {
  // Calls findModelsSatisfying(requirements), sorts by pricing.startingPrice,
  // returns the cheapest. Still executes nothing — the CALLER decides
  // whether to act on the recommendation, exactly like this project's
  // existing pattern of "read-only estimate function, separate explicit
  // action function" (estimate_generation vs. request_generation).
}

module.exports = {
  GENERATION_MODEL_REGISTRY,
  listModels,
  findModelsSatisfying,
  cheapestSatisfying,
};
```

This is additive and standalone — it imports nothing from
`evolink-models.js`/`evolink-image-provider.js`/`evolink-provider.js` and they
import nothing from it. Wiring it into `keyframe-generation-service.js` or the
future `video-generation-service.js` is a **separate, later, explicit choice**
(Section J), not something this file does automatically.

---

## G. Provider/Model Selection Rules

1. Every generation request (image or video, either provider) must specify
   `provider` and `model` **explicitly**. No caller — human, MCP tool, REST
   endpoint, or internal service function — may omit either and get a default
   silently substituted. (This directly reverses the "EvoLink = Seedance"
   assumption this stage was opened to correct — Stage 22 Part 1's audit
   already showed `generation-service.js`'s hardcoded `'seedance-2.5-text-to-
   video'` example was never actually enforced as a default in code, only
   in the one real smoke-test project's own request — but this rule makes
   that non-defaulting explicit and permanent going forward.)
2. The registry never picks a model on a caller's behalf. `cheapestSatisfying()`
   is advisory-only — it returns a recommendation object, never triggers
   `requestGeneration`/`generateKeyframe`/the future `generateVideo`.
3. A generation service (image or video) must validate the caller's chosen
   `provider`+`model` pair against the registry **before** submission:
   - the pair must exist in `GENERATION_MODEL_REGISTRY`
   - its `requestSchemaVerified` must be `true`
   - its capabilities must satisfy what the calling package actually needs
     (e.g. a package requiring 2 simultaneous character references must be
     rejected against `krea-2-turbo`, which the registry marks as supporting
     zero references) — this is the "generation service validates the
     selected model satisfies the package's requirements" rule from Section J
     of the instructions, and the registry is what makes that check possible
     without hardcoding capability assumptions inside the generation service
     itself.
4. No automatic fallback if the chosen model fails or is rejected — the
   generation service returns `{ ok: false, reason }`, exactly like every
   existing safety check in `keyframe-generation-service.js`'s
   `runSafetyChecks()` already does. A human/caller must explicitly choose a
   different model and resubmit.
5. No automatic cheapest-model substitution ever happens inside a generation
   call path — `cheapestSatisfying()` may only be called by a read-only
   "what would I choose" query, never by `generateKeyframe`/`generateVideo`
   themselves.

---

## H. Future Recommendation Engine Design (not implemented yet)

A later, separate MCP tool/REST endpoint — e.g. `recommend_generation_model`
— would:
1. Accept the same "requirements" shape `findModelsSatisfying()` uses (modality, reference count needed, audio needed, resolution/duration floor, etc.) — derived from an already-built `VideoPromptPackage`/`KeyframePromptPackage`'s own resolved fields, never invented separately.
2. Call `cheapestSatisfying()` (read-only).
3. Return the recommendation **as data** — provider, model, price, why it satisfies the requirements, and which other verified models also would have (for a human to compare).
4. Do **nothing else.** No approval is requested, no job is created, no budget is touched. A human (or a future explicit "accept recommendation" action, itself requiring the same approval/budget gates every other generation already requires) is the only thing that can turn this into a real request.

This satisfies the instruction's "must NOT execute anything" requirement by
construction — the function signature returns data, and no code path exists
from this function to any provider adapter.

---

## I. Cost Optimisation Strategy

With Section A/C's data, the concrete near-term savings this registry design
enables (once built and wired, not automatically applied):

- **Images:** default recommendation should be `gpt-image-2` ($0.015/img,
  already proven, up to 16 references) instead of automatically reaching for
  Nano Banana Pro ($0.046/img) for every keyframe — reserving Nano Banana Pro
  for shots where its specific quality/character-fidelity has already been
  validated (Stages 16–21) and is worth the ~3x cost premium. This is a
  **human decision per shot**, not an automatic substitution.
- **Video:** `seedance-2.0-mini-reference-to-video` ($0.011/s) is a strong
  default candidate once its request schema is wired into a mapper, at roughly
  a third of `seedance-2.5-image-to-video`'s implied per-second cost (inferred
  from the real 8-second smoke-test job's 100.45-credit reservation — EvoLink's
  credit-to-USD rate is still undocumented, so this is a relative, not
  absolute, comparison; see Known Unknowns).
- **Do not chase Seedance 1.0 Pro Fast or Krea 2 Turbo's headline lowest
  prices** — neither is currently verified to support the reference
  conditioning this project's entire identity-consistency architecture depends
  on. Cheapest-that-cannot-do-the-job is not a saving.
- The registry's `findModelsSatisfying()`/`cheapestSatisfying()` pair is what
  turns "minimise cost without sacrificing required capabilities" from a
  one-time investigation finding (this document) into a standing, re-runnable
  query as new models are added or prices change.

---

## J. Architecture Impact on Stage 22B

Confirms and refines Stage 22A's Section J plan, now routed through the
registry instead of a hardcoded model list:

```
VideoPromptPackage  (provider-neutral: subject, action, camera, continuity,
                      input keyframe asset reference — NO image_urls, NO
                      inline_data, NO provider-specific field of any kind)
        ↓
generation requirements  (derived from the package: modality=video,
                           referenceCount needed, duration/resolution floor
                           from the shot's own creative spec)
        ↓
GENERATION_MODEL_REGISTRY.findModelsSatisfying(requirements)   [advisory only]
        ↓
explicit provider + model  (human/caller decision — VideoGenerationApproval
                             RECORDS this exact pair, per the original Stage
                             22 instruction; the registry never writes it)
        ↓
video-generation-service.js validates the chosen pair against the registry
(requestSchemaVerified === true, capabilities superset of requirements) BEFORE
calling any provider adapter
        ↓
Provider Adapter (evolink-video-provider.js or google-video-provider.js)
        ↓
API
```

`VideoPromptPackage` and `VideoGenerationApproval` (not yet built — still
gated on your approval) both need one small, additive change from the Stage
22A plan: `VideoGenerationApproval` must store `provider` and `model` as
explicit required fields (already planned in the original Stage 22
instructions' Part 5), and `video-generation-service.js`'s `runSafetyChecks`
must add one new check — "does the registry confirm this provider+model pair
is schema-verified and capability-sufficient for this package" — alongside
the existing package-CURRENT/approval-APPROVED/budget checks it already
mirrors from `keyframe-generation-service.js`. No other change to the Stage
22A plan is required.

---

## K. Known Unknowns

1. **Exact model IDs not confirmed:** Grok Imagine Video, Wan 2.5 (video
   variant — only the *image* model ID was confirmed), Wan 2.6, Kling 3.0
   (base, non-motion-control), Sora 2, EvoLink's own Veo 3.1 Fast/Pro IDs,
   Seedream 5.0 Lite. None of these should be typed into `evolink-models.js`
   or the registry as a real, callable string until independently opened.
2. **Seedance 2.0 Fast's exact price** — schema confirmed, catalogue price
   row not found separately from Mini/standard.
3. **Kling 3.0 pricing conflict** — $0.080/s (catalogue) vs. $0.1134/s
   (motion-control blog post) — may be two different products, not resolved.
4. **EvoLink credit-to-USD conversion rate** — still undocumented (confirmed
   already in `evolink-api.md` and Stage 22A) — this is why Section I's video
   cost comparison is relative, not absolute.
5. **Seedance 2.5's `reference-to-video` capability** — already flagged
   unverified in this codebase before this investigation; still unverified.
   Notably, Seedance **2.0**'s reference-to-video is now schema-verified,
   which is an interesting inversion (the older model line has the more
   thoroughly documented reference capability) worth being aware of rather
   than assuming "2.5 supersedes 2.0 in every capability."
6. **Whether EvoLink's resold Nano Banana 2 (non-Pro) and Veo 3.1 share
   Google's own exact request schema**, or have EvoLink-specific field
   differences — not checked; would need its own dedicated EvoLink docs page
   opened, which was not found this session.

---

## L. Decision Gate

**A — READY TO IMPLEMENT REGISTRY**

Rationale: enough models across both providers are now at Tier 3/4
(`seedance-2.0-mini/fast/standard-*`, `gpt-image-2`, `wan2.5-image-to-image`,
`gemini-3-pro-image-preview`) to populate a genuinely useful registry today,
without needing to guess a single unverified model ID into it. The registry's
design (Section F) is additive, has no dependency on unresolved questions in
Section K, and every unresolved model can be added later at
`verificationTier: 'CATALOGUE_AVAILABLE'` / `requestSchemaVerified: false`
without changing the registry's shape — exactly the same incremental
discipline `evolink-models.js` has already used successfully since Stage 15.

This gate is about the **registry file itself** — it does not reopen or
override Stage 22A's separate Gate B for connecting Google as a live provider,
nor does it authorize starting `VideoPromptPackage`/`VideoGenerationApproval`/
`video-generation-service.js` implementation, which remains explicitly gated
on your approval per the original Stage 22 plan.

---

## Safety Statement (Stage 22B-Part-0 investigation)

- Real EvoLink generation calls made: **0**
- Real Google API calls made: **0**
- Credits spent: **0**
- Generation jobs created: **0**
- Production source files modified: **0** (this document only)
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) modified: **NO**

---

---

# Part 2 — Implementation (Stage 22B-Part-1)

Everything below documents what was actually built, once Part 0's investigation
was approved. The investigation above (Sections A–M) is the historical record
of *why* — this section is the record of *what got built and how it behaves*.

## N. Catalogue (as implemented)

`server/services/generation-model-registry.js` — 34 entries: 22 EvoLink video,
6 EvoLink image, 6 Google (3 image, 3 video). Every entry's
`verificationStatus`/`requestSchemaVerified`/`productionReady` combination was
copied verbatim from this document's own Section E table — the implementation
was written to match the investigation, never the other way around. A
module-load-time assertion (`for (const entry of GENERATION_MODEL_REGISTRY) { if
(!VERIFICATION_STATUSES.includes(...)) throw ... }`) makes an invalid
verification-status string a load-time crash, not a silent data error.

For the 7 model IDs that already existed in `providers/evolink/evolink-models.js`
(`seedance-2.5-text-to-video`, `seedance-2.5-image-to-video`,
`seedance-2.5-reference-to-video`, `seedance-2.5-video-edit`,
`seedance-2.5-video-extend`, `gpt-image-2`, `gemini-3-pro-image-preview`), the
registry derives `requestSchemaVerified` and `docsUrl` directly from that file
(`fromEvolinkModels(key)`) instead of re-typing them — the one deliberate
point of non-duplication Section J/Part 9 asked for. Every other EvoLink
model's literal ID string lives only in this registry, since
`evolink-models.js`'s own stated scope is narrower ("the ONLY place EvoLink
model identifiers are allowed to appear" — for models it already knows about)
and forcing the other ~25 catalogue/capability-tier entries into that file
would have been exactly the "unnecessary coupling" this document's own Section
J warned against.

`evolink-models.js` and `evolink-image-provider.js`/`evolink-provider.js` were
**not modified** by this stage.

## O. Capability Semantics (as implemented)

Three-state logic, enforced consistently across every one of the 34 entries:

- **`true`** — confirmed present, sourced from an opened page (see each
  entry's own `docsUrl`/`notes`).
- **`false`** — confirmed **absent** for that specific model — an active,
  sourced finding, never a default. Example: `krea-2-turbo.capabilities.referenceImages
  === false`, `seedance-2.0-mini-text-to-video.capabilities.referenceImages
  === false` (that specific endpoint doesn't take references, even though its
  sibling `seedance-2.0-mini-reference-to-video` does).
- **`null`** — not verified, OR not applicable to the model's modality (e.g.
  `audio` on a pure image model, `textToImage` on a pure video model). `null`
  and `false` are never conflated — a test (`generation-model-registry.test.js`,
  "unknown capability does not satisfy a true requirement" /  "a confirmed
  false capability does not satisfy a true requirement") asserts both are
  rejected by a `true` requirement, and a separate test asserts `false` is
  satisfied by *either* a confirmed-`false` or an unconfirmed-`null` capability
  (see Requirement Matching below) — the two states fail identically against a
  positive requirement but are never merged into one value.

## P. Verification Semantics (as implemented)

`productionReady` is not an independently-set field — it is computed at
record-construction time as exactly `verificationStatus === 'SAFE_FOR_PRODUCTION'`,
enforced by a repo-wide test (`productionReady is always exactly
(verificationStatus === SAFE_FOR_PRODUCTION) for every registry entry`) that
iterates the whole registry. This makes "is this model allowed to be used" a
single, un-fakeable boolean derived from one enum, rather than two facts that
could ever drift apart. Only 3 of the 34 entries carry `SAFE_FOR_PRODUCTION`:
`evolink/gpt-image-2`, `evolink/wan2.5-image-to-image`,
`evolink/gemini-3-pro-image-preview` — exactly Section E's own list, verified
by a dedicated test.

`krea-2-turbo` is the deliberate counter-example kept in both the data and the
tests: `verificationStatus: 'REQUEST_SCHEMA_VERIFIED'`, `requestSchemaVerified:
true`, but `productionReady: false` — proving the two facts ("we understand its
API" vs. "we should use it here") are independent, exactly as Part 3 of the
implementation instructions required.

## Q. Requirement Matching (as implemented)

`findModelsSatisfying(requirements)` / `isModelCapable(provider, model,
requirements)` / `validateModelSelection(...)` all route through one shared
`modelSatisfies(entry, requirements)` function. Per-field behavior:

- **Boolean capability fields** (`textToImage`, `imageToImage`, `textToVideo`,
  `imageToVideo`, `referenceImages`, `firstFrame`, `lastFrame`, `audio`):
  - requirement omitted → no constraint
  - requirement `true` → capability must be exactly `true` (`false` and `null`
    both fail)
  - requirement `false` → capability must **not** be `true` (both `false` and
    `null` pass) — this reads as "not required to be true," the weaker and
    safer claim, never "confirmed absent," which this function never invents
- **`minReferenceImages`** — requires a known numeric `maxReferenceImages` at
  or above the threshold; `null`/missing never satisfies a minimum.
- **`resolution`** / **`aspectRatio`** — requires the exact string to appear in
  the model's own known array; a `null` array never satisfies either.
- **`minDurationSeconds`** / **`maxDurationSeconds`** — requires a known
  `{ minSeconds, maxSeconds }` range that covers the requested value; a model
  with no known duration range never satisfies a duration requirement.
- **`provider`** / **`modality`** — exact match if given.

## R. `cheapestSatisfying` Behaviour (as implemented)

Calls `findModelsSatisfying`, then partitions matches into `priced` (
`pricing.priceKnown === true`) and `unpriced`, sorts `priced` ascending by
`pricing.startingPrice`, and returns `[...priced, ...unpriced]`. An
unknown-priced model is **never** sorted as if its price were `0` — it always
sorts after every known-priced match, and its own `pricing.priceKnown: false`
travels with it in the result so a caller can never mistake "we don't know" for
"this is free" or "this is cheapest." Verified directly by a dedicated test
(`unknown pricing is never treated as zero/cheapest...`) using
`seedance-2.0-fast-image-to-video` (the one entry with confirmed schema but
unconfirmed catalogue price) as the concrete unpriced case.

`cheapestSatisfying` returns data only — it is never called from inside any
generation-submission code path in this stage (there is no such path yet;
`VideoGenerationService` doesn't exist). A test asserts calling it (with any
requirements, including ones matching zero models) never mutates
`GENERATION_MODEL_REGISTRY`.

## S. Explicit Selection / `validateModelSelection` (as implemented)

Returns `{ allowed, provider, model, reasons: [], warnings: [] }` and **never
throws** for a normal capability mismatch (verified across every registered
model with a dedicated test) — it only throws-equivalent (returns
`allowed: false`) for a genuinely unknown provider/model pair, still without
throwing a JS exception. Diagnostics distinguish:

- unknown provider/model → one `reasons` entry, nothing else evaluated
- known but not `requestSchemaVerified` → explicit reason naming that fact
- known but not `productionReady` → explicit reason naming that fact
- a required boolean capability that's `null` (unverified) → **its own,
  distinct reason** ("Required capability unknown (never assumed true) for:
  ...") — never silently folded into the generic "does not satisfy
  requirements" reason, so a caller can tell "definitely doesn't support this"
  apart from "we don't know if it supports this"
- capability mismatch (confirmed `false`, or requirement otherwise unmet) →
  generic reason
- an unconfirmed model-ID string (`modelIdConfirmed: false`) → a `warnings`
  entry (not a `reasons` entry — it doesn't by itself block `allowed`,
  matching Section E's distinction between "ID string not confirmed" and
  "capability not confirmed")

## T. Why the Registry Never Executes Generation

Structural, not just a convention: `generation-model-registry.js` imports
`../providers/evolink/evolink-models.js` (a pure data file, no HTTP) and
nothing else outside Node's stdlib — no `evolink-client.js`, no
`evolink-provider.js`, no `evolink-image-provider.js`, no `fetch`. A test
statically confirms this (`the registry module never imports a provider HTTP
client or fetch-capable module`) by scanning the file's own source text for
those exact `require(...)` calls and for a bare `fetch(`. A second test
confirms none of the four safety-relevant vocabulary terms
(`creditLedger`, `reservedCost`, `approvalStatus`, `generationId`) appear
anywhere in the file, and a third confirms the module's exports contain none
of `requestGeneration`/`generateKeyframe`/`generateVideo`/
`createGenerationJob`/`reconcileGenerationCost`/`submit`/`approve`/`reject`.
There is, today, no code path from this file to any provider — the only way
that changes is a future, separate, explicitly-authorized stage wiring a
generation service to *call* `validateModelSelection` before submission (never
the reverse).

## U. How the Future `VideoPromptPackage` Will Consume This Registry

Per Section J's dependency direction (unchanged by implementation):
`VideoPromptPackage` resolves its own provider-neutral requirements (modality,
reference count needed from its resolved input keyframe asset(s), duration/
resolution from the shot's own creative spec) and hands them to
`findModelsSatisfying`/`cheapestSatisfying` for advisory information only. The
actual `provider`+`model` choice is recorded on `VideoGenerationApproval` (not
yet built) by a human/caller, and the future `video-generation-service.js`
calls `validateModelSelection({ provider, model, requirements })` as one of
its `runSafetyChecks()` gates — mirroring exactly how
`keyframe-generation-service.js`'s existing safety checks already work,
substituting "is this model registry-valid for what the package needs" for
what would otherwise be a hardcoded capability assumption. None of this exists
yet; this section is a forward-looking contract, not a description of code
that runs today.

## V. How Future Google/EvoLink Adapters Will Consume This Registry

A future `providers/google/google-image-provider.js` /
`google-video-provider.js` (Stage 22A's Section J) would be registered into
whatever provider map a generation service uses (mirroring
`keyframe-generation-service.js`'s `IMAGE_PROVIDERS` map), completely
independently of this registry — the registry never imports a provider
adapter, and a provider adapter never imports the registry (no circular
dependency is possible by construction). The connection between them is
one level up, in a generation service: look up the chosen model in the
registry to validate the request is well-formed and capability-appropriate,
then hand the *request itself* to the provider adapter keyed by `provider`
string — the registry's `capabilities`/`pricing` data is never passed into an
adapter's request-building code, and an adapter's request-building code never
reads from the registry. This is the same separation
`evolink-image-mapper.js` (API field mapping) already keeps from
`keyframe-prompt-service.js` (content/package resolution) today.

## W. Tests

53 new tests across 4 files, all passing alongside the existing 855 (908
total):

- `test/generation-model-registry.test.js` — 36 tests: catalogue completeness,
  exact/unknown lookup, provider mismatch, capability matching (true/false/
  unknown), reference-image count requirements, first/last-frame, audio,
  resolution, duration, aspect-ratio, production-ready/verification-status
  filtering, `cheapestSatisfying` (known-price ordering + unknown-price
  handling), cross-provider search, explicit provider filtering, deterministic
  ordering, no-mutation (including a caught real bug — see Section X),
  no-network-import, `validateModelSelection` diagnostics, and a safety check
  that the module exports no job/approval/credit-mutating function.
- `test/generation-model-registry-api.test.js` — 10 tests: all 4 REST routes,
  404 on unknown model, 400 on missing provider/model to `/validate`, and two
  static checks that `index.js`'s registry routes contain no capability/
  pricing logic or job/approval-creating calls of their own.
- `test/generation-model-registry-frontend.test.js` — 7 tests: tab/section
  existence, required render functions, `switchView` routing, no forbidden
  generate/approve control label, every fetch in the section targets only
  `/generation-models*`, no `setInterval`/`setTimeout`, no `POST` call from
  this UI section at all (it only ever `GET`s the list endpoint).
- `test/mcp.test.js` / `test/generation-mcp.test.js` — updated tool-count
  assertions (76 → 78) to include the two new discovery tools.

## X. A Real Bug Found and Fixed During Testing

The first implementation of `listModels`/`getModel`/`findModelsSatisfying`
returned live references into `GENERATION_MODEL_REGISTRY` (plain `.filter()`/
`.find()`, no cloning). A test ("mutating a returned array/object never
affects the registry's own state") caught this immediately: mutating a
returned record's nested `capabilities` field silently corrupted the shared
module-level array for every subsequent caller. Fixed by adding a
`clone(value)` helper (`structuredClone`) applied at every query function's
return boundary, so every caller always receives an independent deep copy.
This is exactly the kind of defensive-copying gap the instructions' "no
mutation" test requirement (#23) was designed to catch, and it did.

## Y. Known Limitations (implementation-level, additive to Section K)

- Exactly the same unresolved model-ID/pricing questions from Section K
  remain unresolved — nothing in the implementation resolved any of them
  (that was never in scope; only the registry's *shape* was built).
  `modelIdConfirmed: false` is now a queryable, testable field for every
  entry Section K flagged as ID-unconfirmed, rather than only a prose note.
- `durations`/`resolutions`/`aspectRatios` are modeled as a flat
  `{minSeconds,maxSeconds}` / `string[]` / `string[]` — sufficient for every
  registry entry so far, but a model with a genuinely discontinuous duration
  set (e.g. "4s or 8s only, nothing between") would be over-approximated by a
  min/max range. None of the 34 current entries need that precision; a future
  entry that does would need a small, additive schema extension.
- No REST/MCP pagination — `GET /generation-models` returns the full list
  every time. Fine at 34 entries; would need revisiting well before this grows
  much further.

## Z. Safety Statement (Stage 22B-Part-1 implementation)

- Real EvoLink generation calls made: **0**
- Real Google API calls made: **0**
- Credits spent: **0**
- Generation jobs created: **0**
- Approvals created: **0**
- Provider adapters modified: **0** (`evolink-models.js`, `evolink-image-provider.js`,
  `evolink-provider.js`, `evolink-client.js` all untouched)
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) modified: **NO**
- Full test suite: **908/908 passing** (855 pre-existing + 53 new)
