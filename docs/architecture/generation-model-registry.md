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

## Safety Statement

- Real EvoLink generation calls made: **0**
- Real Google API calls made: **0**
- Credits spent: **0**
- Generation jobs created: **0**
- Production source files modified: **0** (this document only)
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) modified: **NO**
