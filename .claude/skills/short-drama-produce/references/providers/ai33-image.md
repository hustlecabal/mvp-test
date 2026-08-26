# ai33 (OpenSpeaker) Image adapter

Adapter command:

```json
{"command": ["python3", "/absolute/path/provider_adapters.py", "ai33-image"], "timeout_seconds": 600}
```

Required environment: `AI33_API_KEY`. `AI33_BASE_URL` optionally overrides the default
`https://api.ai33.pro` and must remain HTTPS.

ai33 (branded "OpenSpeaker") is a multi-provider aggregator: one account and one credit balance sit in
front of several underlying image models (Seedream, Flux, GPT Image, and others) behind its own Imagen
v1i task API. Because the account spans many models, `parameters.model_id` is required on every job —
the adapter never assumes a default model.

The job must have modality `image` and exactly one output (`.png`, `.jpg`, `.jpeg`, or `.webp`). Supported
public parameters are `model_id` (required), `aspect_ratio`, `resolution`, `quality`, `creativity`,
`negative_prompt`, and `enhance_prompt` — the latter four are packed into the request's `model_parameters`
JSON field, which ai33 validates against the chosen model server-side.

The adapter creates a task with `POST /v1i/task/generate-image` (multipart form; local reference images are
sent as repeated `assets` fields), then polls `GET /v1/task/{id}` until `status` is `done` and downloads
`metadata.result_images[0].imageUrl`. ai33 requires an inline `@imgN` token per uploaded reference, matched
by count and order; the adapter appends these automatically after the reference contract so the requirement
is met without the creator needing to write them by hand.

Protocol reference: `https://ai33.pro/app/api-document` (client-rendered; the adapter's request/response
shapes were reverse-engineered from the app's bundled JS, not from a published OpenAPI spec — verify against
the live docs if ai33 changes its contract).
