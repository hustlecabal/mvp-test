# Production Compiler & Handoff

## What EvoLink owns vs. what the production engine owns

EvoLink decides: what, why, who, where, when, what it should look like, how it should be shot, what the start state is, what the end state is.

The production engine decides: how to generate media, how to fetch/store assets, how to produce video and audio, how to assemble, how to run technical QA, how to render. Don't duplicate engine functionality inside the creative project — describe intent and requirements, not implementation.

## There is no separate "OpenMontage" repository in this project

This repo (`mvp-test`) is currently a minimal Remotion + Vercel "faceless YouTube" template:

- `src/index.tsx` registers Remotion `<Composition>`s (currently one: `HelloWorld`, a placeholder).
- `src/HelloWorld.tsx` is a props-driven React component that Remotion renders frame-by-frame.
- `api/` holds small Vercel serverless routes (health/status only today).
- `package.json` renders via `remotion render src/index.tsx <compositionId> out/video.mp4`.

**This is the actual production engine for this project right now.** Before compiling a handoff package, re-inspect this repo's current state (compositions, props schemas, any asset-ingestion or timeline code that's been added since) rather than assuming a fixed target — the same inspect-before-integrate discipline the source instructions ask for OpenMontage applies here to whatever engine is actually present. If a dedicated production repo (OpenMontage or otherwise) is later attached to the session, inspect *its* schemas, pipelines, skills, and tooling the same way and prefer it over the scaffolding below.

## Model-agnostic shot spec

Never couple the creative project to one video/image provider:

```
CREATIVE PROJECT → SHOT SPEC → MODEL ADAPTER → VIDEO/IMAGE MODEL
```

The shot spec (from `references/pipeline-and-continuity.md` §3) captures creative intent and technical generation requirements (duration, start/end frame, motion, continuity locks). An adapter — one per provider (Higgsfield/Banana Pro, Seedance, or whatever the account has connected) — turns that into a provider-specific prompt. Swapping providers should never require rebuilding the creative project.

## Generation method selection

Pick per shot, not globally:

- Text → video
- Image → video
- Still image
- B-roll / existing footage
- Motion graphics
- Map/diagram
- Animated still
- Character performance (via Character Builder + Cinema Director)
- Environmental plate (via Banana Pro Director)

Base the choice on narrative requirement, character-consistency need, visual/motion complexity, available references, generation reliability, cost, and continuity risk. Don't force every shot through the same method.

## The production package (conceptual contents)

Where compatible with the engine actually present, compile:

- Project manifest
- Story bible
- Character / location / prop manifests
- Visual style manifest
- Scene manifest / shot manifest / generation-unit manifest
- Frame manifest (start/end state contracts)
- Audio timeline
- Continuity graph
- Asset manifest (generated images/video/audio, with their stable IDs)
- Production brief
- Model/provider instructions (which adapter each generation unit needs)

Exact file names and shapes follow the engine actually receiving the package — don't invent a schema the engine can't consume.

## Default export target for this repo today

Until a richer engine exists here, export as a single JSON manifest a Remotion composition can consume as `defaultProps`, plus the referenced media files under a project-scoped assets directory:

```json
{
  "project_id": "project_001",
  "scenes": [
    {
      "scene_id": "scene_004",
      "shots": [
        {
          "shot_id": "shot_004_003",
          "generation_units": [
            {
              "generation_unit_id": "generation_004_003_A",
              "duration_seconds": 6,
              "start_frame": "frame_004_003_A_start.png",
              "end_frame": "frame_004_003_A_end.png",
              "video_asset": "generation_004_003_A.mp4",
              "audio_ref": "audio_timeline#00:08.600-00:15.000"
            }
          ]
        }
      ]
    }
  ]
}
```

A new Remotion composition (replacing the `HelloWorld` placeholder) would read this manifest and sequence the referenced media on Remotion's timeline, with narration/music as separate audio tracks per the audio-visual timeline. Building that composition is a production-engine task, not a creative one — flag it to the user as a prerequisite the first time an export actually needs it, rather than building it speculatively.

## No premature production

Creative-ready is not production-rendered:

```
BUILD → REVIEW → APPROVE → EXPORT → PRODUCE
```

Don't trigger actual media generation or `remotion render` as a side effect of building the creative package — only when the user explicitly asks for production execution.
