# Asset Storage

Stage 9A. Written after the first real EvoLink generation
(`bd08023f-ea3a-46a7-af8a-6257e188fd5f`, asset `49b475f0-aaf9-4f3c-ad9d-5713455c60d7`)
was successfully archived into permanent local storage.

## Why EvoLink URLs are temporary

Every completed EvoLink generation returns a `results` array of URLs
pointing at files EvoLink itself is hosting
(`docs/integrations/evolink-api.md`, "Results" section). EvoLink's own
documentation says this explicitly, repeated on nearly every model's docs
page: **generated file URLs are only valid for 24 hours.** After that, the
link is gone — not slow, not redirected, just gone. If our application
only ever stored that URL, the video itself would become permanently
unreachable a day after it was made.

## Why we archive assets

Because "the video exists" and "the video is reachable" are two different
facts, and only the first one is permanent unless we do something about
the second. Archiving means: the moment we know a generation succeeded, we
download EvoLink's copy into storage we control, so the asset keeps
existing long after EvoLink's temporary link has expired.

## Where MVP assets are stored

Plain files on local disk, under `server/data/assets/` (one file per
asset, named `<assetId>.<extension>` — see `server/services/asset-storage.js`).
No database, no cloud storage, no S3/R2/etc. — deliberately, for this
stage. The directory is gitignored (only `.gitkeep` is tracked), the same
way `server/data/projects/` and `server/data/generation-jobs/` already
work.

The filename is **never** derived from anything a caller supplies. It's
always `assetId` (already a `crypto.randomUUID()`, validated against a
strict UUID pattern before it ever touches a path) plus a file extension
chosen from a small whitelist (`.mp4`, `.mov`, `.png`, etc. — anything
else becomes a generic `.bin`). That's the whole path-traversal defense:
there's simply no code path where user input becomes part of a filesystem
path.

## How archiving works

`services/asset-archive-service.js`'s `archiveGenerationAsset(assetId)`:

1. Finds the asset (and the project it belongs to) by id.
2. If it's already `STORED` and the file is genuinely still on disk,
   returns immediately — no re-download, no duplicate work.
3. If it's `STORED` but the file has gone missing (disk cleared, moved,
   etc.), it doesn't trust the stale metadata — it re-downloads from the
   asset's original provider URL, if one is still recorded.
4. Otherwise, downloads `asset.url` (EvoLink's result URL, already
   recorded on the asset when the generation completed) via
   `services/asset-storage.js`, and records the outcome on
   `asset.storage`.

This makes archiving **idempotent** — call it once, ten times, or after a
crash mid-download, and the end state is the same: exactly one correctly
stored file, never a duplicate download, never data loss from an
in-between failure (downloads land in a `.download` temp file first and
are only renamed into place after finishing completely).

**Never generates anything.** This whole file only reads an
already-completed generation job/asset and downloads a URL that already
exists. There is no code path here that calls a generation endpoint.

## How preview works

`GET /assets/:assetId/preview` streams the stored file with a
`Content-Type` matching what was recorded at archive time (e.g.
`video/mp4`), and no `Content-Disposition` header — so a browser
`<video>` tag renders it inline instead of downloading it.

It supports the common single-range case (`Range: bytes=start-end`, what a
`<video>` element sends when scrubbing/seeking), responding `206 Partial
Content` with the matching `Content-Range`. It does **not** support
multi-range requests (`bytes=0-10,20-30`) — that's a real, documented
limitation, not an oversight: multi-range responses require a
multipart/byteranges body, which is meaningfully more code for a case
browsers essentially never send in practice for `<video>` playback.

## How download works

`GET /assets/:assetId/download` streams the same file, but with
`Content-Disposition: attachment; filename="<assetId>.<ext>"` — telling
the browser to save it rather than play it. The filename in that header is
built only from the asset id and its own already-known extension, never
from anything else.

Neither endpoint ever puts a real filesystem path in a response. The
client only ever sees `/assets/:assetId/download` and
`/assets/:assetId/preview` — logical URLs, not `server/data/assets/...`.
`get_asset_download` (the MCP tool) follows the same rule: it returns
those two URL paths and a storage status, never `asset.storage.path`
itself in a form a client could reason about as "the real file lives
here."

## How lineage is preserved

Archiving only ever touches one field: `asset.storage`. Every lineage
field an asset already had — `projectId`, `sceneId`, `shotId`,
`generationId`, `provider`, `model`, `prompt`, `references` — is read but
never written by `archiveGenerationAsset()` or `updateAssetStorage()`
(`services/timeline-store.js`). An archived asset still traces back to the
exact project, scene, shot, generation job, and prompt that produced it,
exactly as before Stage 9A.

## The asset shape

```json
{
  "assetId": "...",
  "type": "video",
  "url": "https://files.evolink.ai/.../video.mp4",
  "storage": {
    "provider": "local",
    "path": "49b475f0-....mp4",
    "status": "STORED",
    "contentType": "video/mp4",
    "sizeBytes": 4282205,
    "archivedAt": "2026-08-11T17:35:03.821Z",
    "error": null
  }
}
```

`url` is untouched — it's still EvoLink's original (now-expired-eventually)
result URL, kept for provenance. `storage` is new, additive information
about whether/where we've made our own permanent copy. `storage.status` is
one of `NOT_ARCHIVED` (default, nothing downloaded yet), `STORED`
(archived and the file is on disk), or `FAILED` (the last archive attempt
failed — `storage.error` has why, and it's safe to call `archive_asset`
again).

## Why local storage for the MVP

Because the goal right now is "don't lose the video when EvoLink's link
expires," not "build a production media pipeline." Local disk is the
simplest thing that solves exactly that problem, with no new
infrastructure, no new credentials, no new failure modes beyond "disk
write failed" (which local disk already has to handle anyway, the same as
every JSON file this project already writes). Reaching for S3/R2/a
database before there's a real reason to (multiple servers, needing
signed URLs, needing durability guarantees beyond one disk) would be
solving a problem this MVP doesn't have yet.

## How cloud storage could replace it later

`asset.storage.provider` already exists specifically so this transition
doesn't require a schema rewrite: it's `"local"` today, and could become
`"s3"`/`"r2"`/etc. later, with `storage.path` becoming an object key or
signed-URL reference instead of a local filename. `services/asset-storage.js`
is the only file that knows about the local filesystem — a cloud adapter
would live beside it (e.g. `asset-storage-s3.js`) behind the same
`downloadAsset()`/`resolveStoredPath()`-shaped interface, the same way
`services/generation-service.js` already swaps provider adapters via a
small registry (`PROVIDERS = { evolink: evolinkProvider }`) rather than
hardcoding EvoLink everywhere. Nothing in `asset-archive-service.js`,
the MCP tools, or the HTTP endpoints would need to change beyond which
adapter they point at.
