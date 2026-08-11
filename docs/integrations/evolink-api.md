# EvoLink API Integration

This document records what the **official EvoLink documentation** actually
says, fetched directly from `evolink.ai/docs` (not third-party summaries,
not guesses). Every claim below is labeled:

- **DOCUMENTED FACT** — read directly from an official docs page, source linked.
- **ASSUMPTION** — inferred with reasonable confidence, but not independently opened/verified.
- **UNKNOWN** — not found anywhere in the docs pages checked.

No API key exists yet. Nothing in this document required calling EvoLink — everything came from reading their published documentation pages directly.

## Source

Official documentation root: https://evolink.ai/docs/
Full page index used to find relevant pages: https://evolink.ai/docs/llms.txt

Pages fetched and read in full (all under `evolink.ai/docs/en/...`):
- `/introduction` — platform overview
- `/quickstart` — auth, base URLs, first request, rate limits
- `/api-manual/task-management/get-task-detail` — status/polling endpoint (full OpenAPI spec)
- `/api-manual/task-management/error-codes` — error code reference
- `/api-manual/account-management/get-credits` — account balance endpoint (full OpenAPI spec)
- `/api-manual/video-series/seedance2.5/seedance-2.5-overview` — unified Seedance 2.5 model list
- `/api-manual/video-series/seedance2.5/seedance-2.5-text-to-video` — full OpenAPI spec
- `/api-manual/video-series/seedance2.5/seedance-2.5-image-to-video` — full OpenAPI spec

Everything else in this document that isn't sourced to one of these pages is explicitly marked ASSUMPTION or UNKNOWN.

## Authentication

**DOCUMENTED FACT.** Every endpoint requires an HTTP Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

Keys are created at https://evolink.ai/dashboard/keys. The quickstart guide explicitly warns: *"API Keys can invoke resources on your account. Store them only on the server side or in secure environment variables. Do not put keys in frontend code, public repositories, or client packages."*

Source: `quickstart`, and the `securitySchemes` block (identical wording) in every OpenAPI spec fetched.

## Base URL

**DOCUMENTED FACT.** Two different base URLs depending on what you're calling:

| Base URL | Used for |
|---|---|
| `https://api.evolink.ai` | Image, video, audio — all multimodal/generation tasks |
| `https://direct.evolink.ai` | Text/chat models (Claude, GPT, etc.) |

Source: `quickstart` ("Choose a Base URL" step); confirmed again as the `servers:` entry in every multimodal OpenAPI spec fetched (`get-task-detail`, `get-credits`, both Seedance 2.5 specs all say `https://api.evolink.ai`).

We do not need `direct.evolink.ai` for this project (no text/chat model use case here).

## Video Generation

**DOCUMENTED FACT.** Endpoint: `POST https://api.evolink.ai/v1/videos/generations`

Confirmed identical for both Seedance 2.5 text-to-video and image-to-video (same `paths:` entry in both OpenAPI specs) — model selection differentiates behavior via the `model` field, not the URL.

**ASSUMPTION (not independently verified):** other video model families (Kling, Veo, Sora, Hailuo, Wan, etc.) likely also use this same endpoint, since `quickstart`'s own Seedance 2.0 example uses this exact path, and every video model's docs entry in the page index describes the same "asynchronous task, query by task ID" pattern. I did not open each family's individual OpenAPI spec to independently confirm this for anything beyond Seedance 2.5.

## Image Generation

**DOCUMENTED FACT.** Endpoint (from `quickstart`'s worked example using GPT Image 2): `POST https://api.evolink.ai/v1/images/generations`

Example request body shown: `{ "model": "gpt-image-2", "prompt": "...", "size": "16:9", "resolution": "4K", "quality": "high", "n": 1 }`

**UNKNOWN:** I did not open a full image-model OpenAPI spec, so I cannot confirm the complete field list, constraints, or whether `size`/`resolution`/`quality`/`n` behave consistently across all image models. Do not rely on these field names beyond what's shown in the quickstart example.

## Image-to-Video

**DOCUMENTED FACT** (Seedance 2.5 image-to-video specifically — full spec opened):

- Same endpoint as text-to-video: `POST /v1/videos/generations`, with `model: "seedance-2.5-image-to-video"`
- `image_urls`: array of 1–2 URIs.
  - 1 image → first-frame video generation
  - 2 images → first-last-frame video generation (image 1 = first frame, image 2 = last frame)
- Image requirements: formats `.jpeg`/`.png`/`.webp`; aspect ratio (width/height) `0.4`–`2.5`; width/height `300`–`6000`px; max `30MB` per image; total request body ≤ `64MB`; URLs must be **directly, publicly accessible** (no auth walls).
- `aspect_ratio` is forced to `"adaptive"` only for this model — fixed ratios like `16:9` are rejected.

Source: `seedance-2.5-image-to-video` OpenAPI spec.

## Models

### Directly verified (full request/response schema opened)

| Model identifier | Task |
|---|---|
| `seedance-2.5-text-to-video` | Text-to-video |
| `seedance-2.5-image-to-video` | Image-to-video (first-frame or first-last-frame) |

### Identifier confirmed to exist, but full field schema NOT independently opened

**DOCUMENTED FACT that these exist** (both appear directly in the Seedance 2.5 overview page's model `enum`, sourced from `evolink.ai/docs` itself):
`seedance-2.5-reference-to-video`, `seedance-2.5-video-edit`, `seedance-2.5-video-extend`

**ASSUMPTION (identifier likely correct, not independently opened as a full spec):** many other model identifiers appear in `evolink.ai/docs/llms.txt`'s page descriptions, e.g. `seedance-1.5-pro`, `doubao-seedance-1.0-pro-fast`, `kling-o3-text-to-video`, `kling-v3-turbo-image-to-video`, `veo3.1-pro-beta`, `sora-2-preview`, `sora-2-pro-preview`, `MiniMax-Hailuo-2.3`, `wan2.6-text-to-video`, `gpt-image-2`. These come from the official docs site itself, but I have not opened their individual OpenAPI specs to confirm exact field-level request shapes. **None of these are used anywhere in the code this stage** — only the two fully-verified Seedance 2.5 identifiers are wired into the adapter (see `server/providers/evolink/evolink-models.js`).

### How model selection works

**DOCUMENTED FACT:** a single string field `model` in the JSON request body. The Seedance 2.5 overview page's own title states this directly: *"Unified API for all Seedance 2.5 models, select a specific model via the `model` parameter."*

**UNKNOWN:** no `GET /v1/models` (or similar model-catalog) endpoint was found anywhere in the pages checked — model identifiers appear to be documentation-only, not queryable through the API.

## Request Fields

Confirmed field-by-field for the two verified Seedance 2.5 endpoints (types/defaults/constraints from the OpenAPI spec, not paraphrased):

| Field | Type | Notes |
|---|---|---|
| `model` | string, required | e.g. `seedance-2.5-text-to-video` |
| `prompt` | string, required | Up to ~1000 English words / 10000 tokens |
| `image_urls` | string[] (URI), 1–2 items | **Image-to-video only**; required there, not accepted by text-to-video |
| `duration` | integer | Default `5`; `4`–`30` seconds, or `-1` for automatic (billed on actual output length) |
| `quality` | string enum | `480p` \| `720p` (default `720p`) — **this is the resolution field; there is no separate `resolution` field for video** |
| `aspect_ratio` | string enum | Text-to-video: `16:9`\|`9:16`\|`1:1`\|`4:3`\|`3:4`\|`21:9`\|`adaptive` (default `adaptive`). Image-to-video: **only** `adaptive` is accepted. |
| `generate_audio` | boolean | Default `true` — synchronized audio at no extra charge |
| `content_filter` | boolean | Default `true`. Setting `false` relaxes filtering but **bills +10% (1.1x)**; illegal/prohibited content is always blocked regardless |
| `output_format` | string enum | `mp4` (default) \| `mov` — no extra charge either way |
| `model_params.web_search` | boolean | Text-to-video only, default `false`; lets the model search the web for timeliness; only billed when a search is actually triggered |
| `callback_url` | string (URI) | Optional webhook — see "Polling" below |

**Note on naming inconsistency:** the *image* generation example in `quickstart` uses a field named `"resolution": "4K"` (in addition to `"quality": "high"`), while the *video* endpoints use only `quality` (`480p`/`720p`) with **no** separate `resolution` field. Field names are **not** uniform across EvoLink's image vs. video APIs — do not assume a field name from one model family applies to another without checking that family's own spec.

## Job / Task Lifecycle

**DOCUMENTED FACT.** Every generation request returns a task object immediately (not the final result):

```json
{
  "id": "task-unified-1774857405-abc123",
  "object": "video.generation.task",
  "model": "seedance-2.5-text-to-video",
  "status": "pending",
  "progress": 0,
  "task_info": { "can_cancel": true, "estimated_time": 165 },
  "usage": { "billing_rule": "per_second", "credits_reserved": 50, "user_group": "default" }
}
```

Task IDs are always prefixed `task-unified-` (confirmed via the documented 400 error: *"Invalid task ID format, must start with 'task-unified-'"*).

**Status values (DOCUMENTED FACT, exact enum):** `pending`, `processing`, `completed`, `failed`. That is the complete list — there is **no separate `cancelled` status value**. A cancelled task shows up as `status: "failed"` with `error.code: "request_cancelled"`.

Source: `get-task-detail` and both Seedance 2.5 specs (identical enum in all three).

### Mapping to our internal generic status

Our system's generic lifecycle (defined in `server/providers/provider-interface.js`) is `REQUESTED → SUBMITTED → PROCESSING → COMPLETED`, plus `FAILED`/`CANCELLED`. `REQUESTED` only exists on our side, before we've called EvoLink at all — EvoLink itself has no equivalent.

| EvoLink `status` | Our generic status |
|---|---|
| *(before any call is made)* | `REQUESTED` |
| `pending` | `SUBMITTED` |
| `processing` | `PROCESSING` |
| `completed` | `COMPLETED` |
| `failed` (`error.code` ≠ `request_cancelled`) | `FAILED` |
| `failed` (`error.code` = `request_cancelled`) | `CANCELLED` |

This mapping is implemented in `server/providers/evolink/evolink-mapper.js`, and is the **only** place these EvoLink-specific strings appear.

## Polling

**DOCUMENTED FACT.** All multimodal (image/video/audio) generation is asynchronous — text/chat models are synchronous, but that's out of scope here. Status endpoint: `GET https://api.evolink.ai/v1/tasks/{task_id}`.

The official Python example in `quickstart` polls every 5 seconds with a timeout. `quickstart`'s "Production Recommendations" explicitly says: *"Set polling intervals based on task type. Image tasks can be polled more frequently; video tasks should usually be polled less often."* No specific recommended interval number is given.

**Webhook alternative (DOCUMENTED FACT):** an optional `callback_url` field (HTTPS only, ≤2048 chars) can be set on a generation request instead of polling. EvoLink POSTs the same task-detail response shape to that URL when the task reaches `completed`, `failed`, or `cancelled` (sent *after* billing is finalized). Timeout `10s`, up to `3` retries at `1s`/`2s`/`4s` intervals; a `2xx` response is required or it retries; callbacks to private IP ranges (`127.0.0.1`, `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`) are rejected.

**Per Stage 6's Part 9 instruction, we are not implementing automatic polling or webhook handling yet** — this stage only defines create → check status → retrieve result as three discrete operations.

## Results

**DOCUMENTED FACT.** When `status: "completed"`, a `results` field appears: an array of URI strings pointing to the generated file(s).

```json
{ "status": "completed", "progress": 100, "results": ["https://example.com/generated-video.mp4"] }
```

**Important, repeated on nearly every model's docs page:** generated file URLs are **only valid for 24 hours** — the docs explicitly instruct downloading and storing results in your own storage promptly. This is a real constraint our eventual asset-storage design needs to account for (not addressed in this stage).

## Errors

**DOCUMENTED FACT.** Two distinct error shapes exist:

**1. HTTP-level error** (bad request, auth failure, rate limit, etc. — returned instead of a task object):
```json
{ "error": { "code": "invalid_task_id", "message": "...", "type": "invalid_request_error", "param": "task_id" } }
```

**2. Task-level failure** (the task itself was accepted, but failed during processing — `status: "failed"`):
```json
{ "id": "...", "status": "failed", "error": { "code": "content_policy_violation", "message": "..." } }
```

**Documented business error codes** (from the dedicated error-codes reference page):

*Client errors (fix and retry):* `content_policy_violation`, `invalid_parameters`, `image_processing_error`, `image_dimension_mismatch`, `request_cancelled`

*Server errors (retry later):* `generation_failed_no_content`, `service_error`, `generation_timeout`, `resource_exhausted`, `quota_exceeded`, `service_unavailable`, `resource_not_found`, `unknown_error`

`content_policy_violation` is documented as the single most common error — triggered by real human faces in uploaded images, celebrity/public-figure likeness, copyrighted/trademarked content, adult/NSFW content, violence/self-harm content, or content involving minors.

**Inconsistency I found (flagging, not resolving):** the `error.code` field is typed as a **string** everywhere I checked (e.g. `"invalid_task_id"`) **except** in the `get-credits` page's own `ErrorResponse` schema, where its example shows `code: 401` as an **integer**. I have not resolved which is authoritative — our error-handling code treats `code` defensively as "string or number" rather than assuming one.

## Pricing / Cost

**PARTIALLY DOCUMENTED.**

- `GET https://api.evolink.ai/v1/credits` — **DOCUMENTED FACT, full spec opened.** Returns current account balance: `data.token.{remaining_credits, used_credits, unlimited_credits}` and `data.user.{remaining_credits, used_credits}`. This is a **safe, non-generation, read-only endpoint** — see the note at the end of this document.
- Every generation response includes a `usage` object: `{ billing_rule: "per_call"|"per_token"|"per_second", credits_reserved: <number>, user_group: <string> }` — so an **estimated** cost is visible per-request. The `50` shown in the docs is only an illustrative example value, not a real rate.
- `content_filter: false` bills at `+10% (1.1x)` for Seedance 2.5 — the one concrete pricing modifier documented at the field level.

**UNKNOWN:** no standalone pricing page or rate table (credits-per-second-per-model, etc.) exists anywhere in `evolink.ai/docs` that I could find. Actual per-model costs are not published in the documentation — only discoverable via the `usage.credits_reserved` estimate returned at request time, or by checking account balance before/after.

## Rate Limits

**PARTIALLY DOCUMENTED.** `quickstart`'s "Rate Limits" section states limits are *"configured per model"* and depend on *"model type, upstream service capacity, account tier, and real-time availability,"* with video/image models generally more limited than lightweight text models. Exceeding a limit returns HTTP `429` with error code `rate_limit_exceeded`.

**UNKNOWN:** no specific numeric RPM/concurrency values are published anywhere I found. The docs say to email support@evolink.ai if you need higher limits.

## Unknowns

Explicit list, for anyone reviewing this later:

- Exact numeric rate limits (RPM/concurrency) per model — not published.
- A centralized price list per model/resolution/duration — not published; only account balance and per-request estimates exist.
- Whether every non-Seedance-2.5 video model shares the exact same endpoint/field shape — assumed likely, not proven.
- Full request schema for `seedance-2.5-reference-to-video`, `-video-edit`, `-video-extend` — identifiers confirmed to exist, fields not opened.
- Full request schema for any image model (`gpt-image-2`, Nanobanana, Seedream, etc.) beyond the one abbreviated example in `quickstart`.
- Whether a model-catalog/list endpoint exists anywhere in the API.
- Whether `error.code` is authoritatively a string or can be an integer (inconsistent between docs pages).
- A sandbox / dry-run / test mode that doesn't consume credits — **not found anywhere**. See the note below on what to use instead.

## Assumptions

Explicit list — treat these as unverified until independently checked:

- All EvoLink video models likely share the single `POST /v1/videos/generations` endpoint pattern seen in Seedance 2.5, switched by `model`. Not proven beyond Seedance 2.5.
- Image models likely share a single `POST /v1/images/generations` endpoint the same way. Not proven beyond the one `quickstart` example.
- The response envelope shape (`id`/`object`/`model`/`status`/`progress`/`results`/`task_info`/`usage`) is likely consistent across image and video tasks, based on the shared schema names (`TaskDetailResponse`, `VideoGenerationResponse`) seen so far.

## Open Questions

Flagging rather than guessing, as instructed:

1. **`error.code` type inconsistency** (string vs. integer) between `get-credits` and every other page — our code treats it defensively as either, but this should ideally be clarified with EvoLink directly before it matters.
2. **No documented sandbox/test mode.** I found no way to validate a real generation call without it being billed. The closest thing to a safe verification endpoint is `GET /v1/credits` (see below) — but this stage doesn't use it live either, since we still have no API key and Stage 6 explicitly prohibits any live call regardless.
3. Whether the rest of the video model catalog (Kling, Veo, Sora, Hailuo, Wan, etc.) truly shares Seedance 2.5's exact request/response shape should be confirmed model-by-model before any of them are added to `evolink-models.js`.

### The safe, non-generation endpoint for verifying authentication

Per Stage 6 Part 6's instruction to identify this if it exists: **`GET https://api.evolink.ai/v1/credits`** is exactly that endpoint. It requires a valid Bearer token (so a real call would prove a key works) and only reads account balance — no generation, no documented cost, no side effects. **This document does not call it** (we have no key, and this stage forbids any live call regardless), but it's the endpoint a future stage should use first, before ever calling a generation endpoint, to confirm a newly-added `EVOLINK_API_KEY` is valid.
