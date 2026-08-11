# Timeline / Production IR

While the [Creative IR](./production-ir.md) describes *what the video is
about*, the Timeline IR describes *how it actually gets assembled*:
scenes, shots, the assets that fill them, and how those assets trace back
to what created them.

Code: `server/schemas/production-schema.js`, functions `createTimelineIR()`,
`createScene()`, `createShot()`, `createAsset()`, `createGenerationRequest()`.

## The hierarchy

```
Project
 └─ Scenes         (project.scenes)
     └─ Shots       (project.shots, each with a sceneId)
         └─ Assets  (project.assets, each traceable to a shot)
```

Scenes and shots are stored as **flat lists** on the project (`scenes: []`,
`shots: []`) rather than nested inside each other. A shot points back to
its scene with a `sceneId` field. This keeps the JSON file simple and easy
to scan, and makes it trivial to look up "all shots in scene X" without
walking a deep tree.

Alongside scenes/shots, a project also has:

- `assets` — every generated or referenced piece of media (see lineage,
  below).
- `audio` — audio tracks (voiceover, music) at the project level.
- `transitions` — how one shot/scene moves to the next.
- `outputSettings` — final export settings (resolution, aspect ratio, etc.
  — left blank until we actually decide on real defaults).

## Shot fields, explained

Every shot can hold the following. **None of these are required** — a shot
is valid with everything left at its default (`null`, `''`, or `[]`); the
schema deliberately does not force early fields to be filled in before
later ones exist.

| Field | Plain-English meaning |
|---|---|
| `shotId` | This shot's unique id. |
| `sceneId` | Which scene this shot belongs to. |
| `startTime`, `duration` | Where this shot sits on the timeline and how long it lasts. |
| `narrativePurpose` | Why this shot exists — what it's doing for the story. |
| `characters`, `locations` | Which characters/locations (by reference) appear in this shot. |
| `composition` | Framing/layout notes (e.g. rule of thirds, close-up). |
| `camera` | Camera behavior (angle, movement, lens feel). |
| `subjectAction` | What the subject(s) are doing. |
| `environmentAction` | What's happening in the background/environment. |
| `audio` | Audio specific to this shot (sfx, dialogue cue). |
| `screenText` | Any on-screen text/captions for this shot. |
| `references` | Reference assets this shot should be visually consistent with. |
| `keyframePrompt` | The prompt that would be sent to a provider to generate this shot's keyframe (still image). |
| `motionPrompt` | The prompt that would be sent to a provider to animate the keyframe into motion. |
| `mustPreserve` | Things that must NOT change between keyframe and motion (e.g. "character's face", "logo placement"). |
| `mustChange` | Things that ARE expected to change/move. |
| `keyframeAssetId`, `videoAssetId` | Which generated assets fulfil this shot's keyframe/video. |
| `generationId` | Which generation request produced the current asset(s). |
| `status` | This shot's own progress (defaults to `PLANNED`). |
| `approvalStatus` | Has a human approved this shot's current asset? (`NONE`/`PENDING`/`APPROVED`/`REJECTED`, same vocabulary as the [approval gate](../../server/services/approval-gate.js)). |

## Asset lineage

Every asset (a generated image, video, or an uploaded reference) is a
record with:

```
assetId, projectId, type, sceneId, shotId,
parentAssetId, version, prompt, provider, model,
generationId, approvalStatus, createdAt
```

This is what makes an asset **traceable**: given any asset, you can answer
"which project/scene/shot is this for," "what prompt/provider/model made
this," "which generation run produced it," and "what asset was this
derived from" (`parentAssetId`), for example:

```
Character Reference  (parentAssetId: null,        version: 1)
   └─ Keyframe        (parentAssetId: <character>, version: 1)
        └─ Video      (parentAssetId: <keyframe>,  version: 1)
```

### Versions instead of overwrites

**Approved assets are never edited in place.** There is no "update asset"
function anywhere in the schema — only `createAsset()` (make a new one) and
`createNextAssetVersion(previousAsset, changes)` (make a new one that
supersedes an old one). `createNextAssetVersion`:

- always produces a **new** `assetId`,
- always sets `parentAssetId` to the asset it's replacing,
- always increments `version`,
- and never modifies the object you passed in.

So if a keyframe was approved and someone wants to try a different version
of it later, that becomes version 2, linked back to version 1 — version 1
still exists exactly as it was approved.

## Provider abstraction

A generation request is deliberately generic:

```js
{
  generationId,
  provider,     // e.g. "evolink", "longcat", "local" — just a string
  model,        // left null by default — never guessed
  task,         // e.g. "keyframe_generation", "motion_generation"
  references,   // asset ids this generation should be consistent with
  prompt,
  parameters,   // provider-specific settings, whatever they end up being
  status,       // "PENDING" initially
  createdAt,
}
```

Nothing in `production-schema.js` mentions EvoLink, LongCat, or any other
provider by name. The Creative IR and Timeline IR don't know or care which
provider eventually fulfils a generation request — that's the whole point
of keeping this generic now, before any provider is actually wired in.

**Model identifiers are never invented here.** Where a real model id would
eventually go, the field is left `null`. When EvoLink (or any other
provider) is integrated in a later stage, real model ids will come only
from that provider's official documentation.
