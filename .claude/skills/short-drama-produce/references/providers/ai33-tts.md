# ai33 (OpenSpeaker) TTS adapter

Adapter command:

```json
{"command": ["python3", "/absolute/path/provider_adapters.py", "ai33-tts"], "timeout_seconds": 300}
```

Required environment: `AI33_API_KEY`. `AI33_BASE_URL` optionally overrides the default
`https://api.ai33.pro` and must remain HTTPS.

ai33's unified v3 text-to-speech endpoint routes one request across several voice providers
(ElevenLabs, MiniMax, Edge, Kokoro, Vbee, Fish Audio, and cloned voices) behind one account and one
credit balance. The job must have modality `tts` and exactly one `.mp3` output.

`parameters.voice_id` is required and must carry a supported provider prefix: `elevenlabs_`, `minimax_`,
`clone_`, `edge_`, `kokoro_`, `vbee_`, or `fishaudio_` (use ai33's `GET /v3/voices?provider=...` to look up
a concrete voice ID). Other supported parameters are `speed` (0.5–1.5, default 1), `with_transcript`
(default `false`), and `pronunciation_dictionary_id`.

The adapter creates a task with `POST /v3/text-to-speech` (multipart form), then polls
`GET /v1/task/{id}` until `status` is `done` and downloads `metadata.audio_url`.

Protocol reference: `https://ai33.pro/app/api-document` (client-rendered; the adapter's request/response
shapes were reverse-engineered from the app's bundled JS, not from a published OpenAPI spec — verify against
the live docs if ai33 changes its contract). Confirmed working end-to-end against a live account: create,
poll, download, and media-type validation all passed for `edge_*` voices.
