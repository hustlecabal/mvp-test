# Video Cost Optimisation Investigation (Stage 22B Post-Smoke-Test)

Read-only research. **No production code was written or modified.** No real
EvoLink generation call was made this stage, no credits were spent, no
approval was created, no budget reserved, no canonical asset touched, and the
real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) was not
modified. `GET /v1/credits` (documented safe, read-only, non-generation
endpoint) was called once to confirm current account balance.

Trigger: the Stage 22B real-generation smoke test (see
`docs/integrations/multi-shot-identity-consistency.md` and prior stage
reports) proved the end-to-end video pipeline works, at an OBSERVED real cost
of 100.45 credits for a 5-second, 720p `seedance-2.5-image-to-video`
generation. This document investigates whether cheaper, still-capable
alternatives exist before any further real spend.

## Part 1 — Baseline

- Branch: `claude/evolink-video-factory-mvp-b4oo5i` @ `bb70e55`
- `git status`: clean
- Full test suite: **1061/1061 passing**
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`): file
  mtime `2026-08-11T17:35:03Z`, predating this and the prior stage — untouched
- Current EvoLink balance (`GET /v1/credits`, called once, real):
  `user.remaining_credits: 344.2484`, `user.used_credits: 315.7516`,
  `token.unlimited_credits: true` (a separate, token-level figure — the
  `user`-level balance is the one that matters for real spend)

## Part 2 — Full EvoLink Video Model Registry Audit

Source: `server/services/generation-model-registry.js` (as currently
implemented, 22 EvoLink video entries) cross-checked against
`server/providers/evolink/evolink-models.js` (the narrower allowlist
`evolink-mapper.js` actually reads — **only 5 EvoLink video model IDs exist
there at all**: `seedance-2.5-{text-to-video,image-to-video,
reference-to-video,video-edit,video-extend}`, and only the first two have
`requestSchemaVerified: true`).

**Critical architectural fact, not previously stated this explicitly:**
`generation-model-registry.js`'s own `verificationStatus`/`requestSchemaVerified`
fields are **independent** of `evolink-models.js`. For the 9
`seedance-2.0-*` entries, the registry marks `requestSchemaVerified: true`
(set directly in the registry record itself, from the Stage 22B-Part-0
investigation), but `evolink-models.js` has **zero** entries for any
`seedance-2.0-*` or `seedance-1.x` model ID. `evolink-mapper.js`'s
`toEvolinkRequest()` throws `"<model>" is not a verified EvoLink model` for
any model absent from `evolink-models.js`, regardless of what the broader
registry says. So **no video model other than the two already-proven
Seedance 2.5 variants can currently be used for a real generation** — every
other row below would fail fast (before any HTTP call, so no credits spent)
if `generateVideo()` were invoked today.

| Model | Registry verificationStatus | productionReady | requestSchemaVerified (registry) | In `evolink-models.js`? | referenceImages | imageToVideo | first/last frame | max refs | duration | resolution | published price | price unit | Mapper can build request today? | Usable w/o code change? | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `seedance-2.5-text-to-video` | REQUEST_SCHEMA_VERIFIED | false | true | ✅ true | false | false | false | 0 | UNKNOWN (registry) | UNKNOWN (registry) | UNKNOWN (no catalogue row) | per_second | **YES** | **YES** (proven, this is the real smoke-test baseline) | HIGH |
| `seedance-2.5-image-to-video` | REQUEST_SCHEMA_VERIFIED | false | true | ✅ true | false | true | UNKNOWN | 0 | UNKNOWN (registry) | UNKNOWN (registry) | UNKNOWN (no catalogue row) | per_second | **YES** | **YES** (proven, this is our currently-used model) | HIGH |
| `seedance-2.5-reference-to-video` | CATALOGUE_AVAILABLE | false | false | ✅ present, `requestSchemaVerified:false` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | NO (throws) | NO — schema never independently opened + mapper has no reference-to-video branch | LOW |
| `seedance-2.5-video-edit` | CATALOGUE_AVAILABLE | false | false | ✅ present, `false` | n/a | n/a | n/a | n/a | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | NO | NO | LOW |
| `seedance-2.5-video-extend` | CATALOGUE_AVAILABLE | false | false | ✅ present, `false` | n/a | n/a | n/a | n/a | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | NO | NO | LOW |
| `doubao-seedance-1.0-pro-fast` ("Seedance 1.0 Pro Fast") | CATALOGUE_AVAILABLE (registry stale — see below) | false | false | ❌ absent | false (single-image, first-frame only — not multi-image) | **true** (confirmed this session) | first-frame only, no last-frame | 1 | 2–12s, default 5 | 480p/720p/1080p, default 1080p | **$0.006/s (0.405 credits/s)** — cheapest of every candidate found | per_second | NO (absent from allowlist) | NO — needs 1 new allowlist entry; **no new mapper branch needed** (`image_urls`/first-frame semantics identical to already-handled `image-to-video` task) | HIGH capability (full OpenAPI spec independently opened this session) / LOW real cost (never billed) |
| `seedance-1.5-pro` | CATALOGUE_AVAILABLE (registry stale — see below) | false | false | ❌ absent | false (0/1/2-image, not identity-conditioning) | **true** (confirmed this session) | true (2-image = first-last-frame) | 2 | 4–12s, default 5 | 480p/720p(default)/1080p | $0.013/s (0.8181 credits/s) | per_second | NO | NO — needs 1 new allowlist entry; no new mapper branch needed | HIGH capability / LOW real cost |
| `seedance-2.0-mini-text-to-video` | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | false | false | false | 0 | 4–15s | 480p/720p | UNKNOWN (no separate row) | per_second | NO | NO — allowlist entry only | HIGH capability |
| `seedance-2.0-mini-image-to-video` | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | false | true | true (1–2 img) | 0 | 4–15s | 480p/720p | UNKNOWN | per_second | NO | NO — allowlist entry only (reuses existing `image-to-video` mapper branch) | HIGH |
| `seedance-2.0-mini-reference-to-video` | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | **true** | false | true | **9** | 4–15s | 480p/720p | **$0.011/s (0.767 credits/s)** | per_second | NO | NO — needs allowlist entry **and** a new mapper branch (`reference-to-video` task has no `image_urls`-building logic today) | HIGH capability / LOW real cost |
| `seedance-2.0-fast-text-to-video` | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | false | false | false | 0 | 4–15s | 480p/720p | UNKNOWN | per_second | NO | NO — allowlist only | HIGH capability |
| `seedance-2.0-fast-image-to-video` | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | false | true | true | 0 | 4–15s | 480p/720p | UNKNOWN (not separately priced on catalogue) | per_second | NO | NO — allowlist only | HIGH capability / price UNKNOWN |
| `seedance-2.0-fast-reference-to-video` | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | true | false | true | 9 | 4–15s | 480p/720p | UNKNOWN | per_second | NO | NO — allowlist + new mapper branch | HIGH capability / price UNKNOWN |
| `seedance-2.0-text-to-video` (standard) | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | false | false | false | 0 | 4–15s | 480p/720p/1080p | $0.033/s (2.272 credits/s) | per_second | NO | NO — allowlist only | HIGH |
| `seedance-2.0-image-to-video` (standard) | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | false | true | true | 0 | 4–15s | 480p/720p/1080p | $0.033/s (2.272 credits/s) | per_second | NO | NO — allowlist only | HIGH |
| `seedance-2.0-reference-to-video` (standard) | REQUEST_SCHEMA_VERIFIED | false | true (registry) | ❌ absent | **true** | false | true | **9** | 4–15s | 480p/720p/1080p | **$0.033/s (2.272 credits/s)** | per_second | NO | NO — allowlist + new mapper branch | HIGH capability / LOW real cost |
| `grok-imagine-video` | CATALOGUE_AVAILABLE | false | false | ❌ absent | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | $0.02/s (1.36 credits/s) | per_second | NO | NO | LOW — exact model-ID string itself unconfirmed |
| `wan-2.5-video` | CATALOGUE_AVAILABLE | false | false | ❌ absent | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | $0.038/s (2.55 credits/s) | per_second | NO | NO | LOW — exact model-ID string unconfirmed |
| `wan-2.6-video` | CAPABILITY_VERIFIED | false | false | ❌ absent | true (secondary source) | true (secondary) | UNKNOWN | 3 (videos, not images) | 2–15s | 1080p | $0.075/s (5.1 credits/s) | per_second | NO | NO | MEDIUM capability (blog-level, not OpenAPI spec) / LOW ID |
| `kling-3.0` | CAPABILITY_VERIFIED | false | false | ❌ absent | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | $0.08/s catalogue vs. $0.1134/s motion-control (unresolved conflict) | per_second | NO | NO | LOW — base t2v/i2v unconfirmed, ID unconfirmed |
| `sora-2` | CATALOGUE_AVAILABLE | false | false | ❌ absent | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | $0.085/s (5.76 credits/s) | per_second | NO | NO | LOW — ID unconfirmed |
| `veo-3.1-resale` | CATALOGUE_AVAILABLE | false | false | ❌ absent | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | $0.318/video | per_video | NO | NO | LOW — ID unconfirmed, single combined catalogue line for Fast+Pro |

**Note on "registry stale":** `seedance-1.0-pro-fast` and `seedance-1.5-pro`
are still marked `CATALOGUE_AVAILABLE`/`requestSchemaVerified: false` in
`generation-model-registry.js` as currently committed — that file was **not
edited this stage** (no production/registry changes made, per the safety
rules). The HIGH-confidence capability data above comes from this session's
own fresh primary-source fetches (Part 3), which upgrade what *could* be
recorded in the registry in a future, separate, explicitly-authorized change
— not something this document performs.

## Part 3 — Primary-Source Verification (this session's fresh fetches)

All fetched directly from `evolink.ai/docs/en/...` this session (fetch tool,
proxied), not third-party summaries. Full detail already folded into the
table above; source pages:

1. `seedance2.0/seedance-2.0-overview` — confirmed `image_urls` (0–9 items),
   `duration` (4–15s), `quality` (480p/720p/1080p, 1080p standard-tier only),
   `aspect_ratio` (same 7-value enum as 2.5), model IDs
   `seedance-2.0-{,fast-,mini-}reference-to-video`. Full OpenAPI 3.1.0 spec.
2. `seedance1.0/seedance-1.0-pro-fast-video-generate` — model ID
   `doubao-seedance-1.0-pro-fast`; `image_urls` max **1** image, first-frame
   only; `duration` 2–12s default 5; `quality` 480p/720p/1080p default 1080p;
   `aspect_ratio` adds `keep_ratio` for image-to-video mode. Full OpenAPI
   3.1.0 spec.
3. `seedance1.5/seedance-1.5-pro-video-generate` — model ID
   `seedance-1.5-pro`; `image_urls` 0–2 items (0=t2v, 1=i2v, 2=first-last-frame);
   `duration` 4–12s default 5; `quality` 480p/720p(default)/1080p. Full
   OpenAPI 3.1.0 spec.

None of these three pages published a per-second price — pricing for all
three comes only from the separate `evolink.ai/models` catalogue page (Stage
22B-Part-0), not from their own OpenAPI spec pages.

**Priority findings (per the requested priority order):**

1. **Cheapest reference-capable (multi-image) video model:**
   `seedance-2.0-mini-reference-to-video` — $0.011/s catalogue, 0–9 images,
   REQUEST_SCHEMA_VERIFIED.
2. **Next-cheapest reference-capable:** `seedance-2.0-reference-to-video`
   (standard) — $0.033/s catalogue, 0–9 images, adds 1080p.
   (`seedance-2.0-fast-reference-to-video` sits between these in capability
   but has no published price.)
3. **Cheapest image-to-video model that can accept our canonical keyframe:**
   `doubao-seedance-1.0-pro-fast` — $0.006/s catalogue, single-image
   first-frame conditioning, the *exact same* input pattern our current
   `seedance-2.5-image-to-video` calls already use (one canonical asset →
   `image_urls[0]`).
4. **Best cost/capability opportunity:** `doubao-seedance-1.0-pro-fast` —
   cheapest catalogue price of anything found (this stage or Stage
   22B-Part-0), fully schema-verified via direct primary source this
   session, and — critically — needs **zero new mapper logic**, only a new
   `evolink-models.js` allowlist entry, because its `image_urls`
   single-image-first-frame semantics are identical to the
   already-implemented `image-to-video` task branch in `evolink-mapper.js`.
   `seedance-2.0-mini-reference-to-video` is the strongest *pure
   cost/reference-capability* opportunity but costs strictly more per second
   ($0.011 vs $0.006) and requires the larger change (new mapper branch for
   the `reference-to-video` task, which does not exist today).

## Part 4 — Cost Normalisation

**OBSERVED** (real EvoLink calls, this and the prior stage):
- `seedance-2.5-text-to-video`, `duration:5`, `quality:720p` (2026-08-11 real
  smoke test): `reservedCost = 100.45` credits.
- `seedance-2.5-image-to-video`, `duration:5`, `aspectRatio:adaptive`,
  `quality` unset → EvoLink default `720p` (2026-08-15, this stage's smoke
  test): `reservedCost = 100.45` credits.
- Two independent real requests, same duration/resolution, **identical**
  reserved cost → consistent with a flat per-request rate for Seedance 2.5 at
  5s/720p, though only two data points exist and only at one
  duration/resolution combination.
- **OBSERVED credits/second for Seedance 2.5 @ 5s/720p: 100.45 / 5 ≈ 20.09
  credits/second.**
- Current account balance (`GET /v1/credits`, real, read-only):
  `remaining_credits: 344.2484`, `used_credits: 315.7516`.

**DOCUMENTED:**
- `evolink-api.md`'s own "Unknowns" section states no centralized
  credits-to-USD rate table is published anywhere in EvoLink's docs — still
  true, re-confirmed this session.
- The `evolink.ai/models` catalogue page pairs a USD/s price with a credits
  figure for several *other* models (not Seedance 2.5): Seedance 1.0 Pro Fast
  $0.006/s = 0.405 credits/s; Seedance 2.0 Mini $0.011/s = 0.767 credits/s;
  Seedance 2.0 standard $0.033/s = 2.272 credits/s; Wan 2.6 $0.075/s = 5.1
  credits/s; Kling 3.0 $0.08/s = 5.4 credits/s; Sora 2 $0.085/s = 5.76
  credits/s. Dividing each of these 6 independently-published pairs gives a
  $-per-credit ratio clustering tightly between **$0.0143 and $0.0148 per
  credit** (≈67.5–69.7 credits per $1) — a **derived-but-documented**
  constant (each pair is itself a directly published catalogue figure; only
  the division is arithmetic, not a separately stated EvoLink policy).
  Seedance 2.5 itself has **no** catalogue price row at all — its real cost
  has never been published anywhere; only the two live `reservedCost` points
  above exist for it.

**INFERRED (explicitly uncertain — not fact):**
- Applying the derived ≈$0.0146/credit rate to the OBSERVED Seedance 2.5
  cost: 100.45 credits ≈ **$1.47 for 5 seconds ≈ $0.29/second** — roughly
  **9×–27× higher** than Seedance 2.0/1.x's catalogue-quoted $0.006–$0.033/s.
  This is the single largest potential saving this investigation has found,
  but it rests on two unverified assumptions: (a) that the derived credit/USD
  rate, built from 6 *other* models, also applies to Seedance 2.5, and (b)
  that Seedance 2.0/1.x's catalogue price is actually what gets billed as
  `reservedCost` on a real call — exactly as untested today as Seedance 2.5's
  own catalogue price was before this stage's real smoke test (which had no
  catalogue row to check against at all).
- No real `reservedCost` data exists for any model other than Seedance 2.5.
  The magnitude of the gap is plausible (Seedance 2.5 is a newer, likely
  higher-quality/more-compute model line than 1.0/1.5/2.0-mini) but the exact
  ratio is not established fact.

## Part 5 — Rankings

**Ranking A — cheapest verified reference-capable (multi-image, schema-verified):**
1. `seedance-2.0-mini-reference-to-video` — $0.011/s (0.767 credits/s)
2. `seedance-2.0-fast-reference-to-video` — price unpublished
3. `seedance-2.0-reference-to-video` (standard) — $0.033/s (2.272 credits/s)

**Ranking B — cheapest potentially viable (capability plausible, not sufficiently verified):**
1. `seedance-2.5-reference-to-video` — model ID confirmed to exist in
   EvoLink's own docs enum, but its schema was **not** opened even this
   session (still `requestSchemaVerified: false` everywhere)
2. `wan-2.6-video` — capability from a secondary/blog source only, exact
   model-ID string unconfirmed
3. `kling-3.0` (base, non-motion-control) — base t2v/i2v capability
   unconfirmed, model-ID unconfirmed, pricing conflict unresolved

**Ranking C — best cost/capability opportunity (cost + reference/identity support + duration/resolution + request compatibility combined):**
1. `doubao-seedance-1.0-pro-fast` — cheapest of everything found ($0.006/s),
   accepts our exact current single-canonical-image input pattern,
   schema-verified via primary source this session, needs only an additive
   allowlist entry (no new mapper branch)
2. `seedance-2.0-mini-reference-to-video` — cheapest true multi-image
   reference-capable option, needs an allowlist entry **and** a new mapper
   branch
3. `seedance-1.5-pro` — cheap, flexible (0/1/2 images incl. first-last-frame),
   also allowlist-entry-only, a reasonable middle option

## Part 6 — Decision Gate

**Recommendation: A — TEST CHEAPEST VERIFIED MODEL**

- **Model:** `doubao-seedance-1.0-pro-fast` (EvoLink catalogue name "Seedance
  1.0 Pro Fast")
- **Why:** cheapest catalogue price of any candidate found across this and
  the prior investigation stage; its single-image, first-frame
  `image_urls` semantics are functionally identical to our
  already-proven `seedance-2.5-image-to-video` usage (one canonical keyframe
  asset in, one video out) — so it is a like-for-like substitute, not a new
  capability; its request schema was independently opened and confirmed via
  primary source this session (full OpenAPI 3.1.0 spec); and wiring it in is
  the smallest possible change — one new, data-only entry in
  `evolink-models.js` (no new logic branch in `evolink-mapper.js`, since the
  existing `task === 'image-to-video'` branch already builds `image_urls`
  correctly for a single image).
- **Prerequisite the recommendation depends on, and which this stage
  explicitly does NOT perform:** adding that one allowlist entry to
  `evolink-models.js` is itself a provider-implementation change. Per this
  stage's safety rules ("no provider implementation changes," "do not modify
  the core generation architecture unless a concrete defect is found"), that
  change is **not** made here — it would need its own separate, explicit
  authorization before any real test of this model is possible. This
  recommendation is therefore: *(1) authorize the one additive allowlist
  entry, then (2) run the one real generation* — not a single combined step.
- **Expected experimental cost range:** **not supported by evidence** — no
  real `reservedCost` data point exists for this model or any non-Seedance-2.5
  model, and Seedance 2.5's own real cost (100.45 credits/5s) turned out to
  have no catalogue row to have been predicted from at all, so catalogue
  price is not yet known to predict real billing for *any* model on this
  platform. Do not treat the catalogue-implied ~2 credits (5s × 0.405
  credits/s) as a reliable estimate.
- **Proposed ONE controlled real generation (not performed yet):** same
  canonical Kade keyframe image, same 5-second duration, explicit
  `quality: 720p` (to keep the comparison apples-to-apples against the two
  existing Seedance 2.5 data points), single-image `image_urls`, in a new
  disposable experiment project (never the real smoke-test project).
- **Budget ceiling:** propose the same conservative **150-credit** ceiling
  used for the previous real call — not derived from a cost prediction (none
  is supported), but as a pure safety cap with the same headroom margin,
  specifically so this next test itself produces the first real
  `reservedCost` data point for a non-Seedance-2.5 model.

No generation was performed. No approval was created. No budget was
reserved. No registry or provider file was modified.

## Safety Statement

- Real EvoLink generation calls made: **0**
- Credits spent: **0**
- `GET /v1/credits` (read-only, non-generation) calls made: **1**
- Generation jobs created: **0**
- Approvals created: **0**
- Registry/provider/mapper files modified: **0**
- Real smoke-test project (`9b6a78b3-7238-4469-8280-5c4281216343`) modified: **NO**
- Disposable smoke-test project (`1425375f-ef95-4b86-98b4-0b03ba0f0d42`) modified: **NO**
- Full test suite: **1061/1061 passing** (unchanged — no code touched)
