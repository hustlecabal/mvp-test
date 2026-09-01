# Production Compiler & Handoff

## What EvoLink owns vs. what the production engine owns

EvoLink decides: what, why, who, where, when, what it should look like, how it should be shot, what the start state is, what the end state is.

The production engine decides: how to generate media, how to fetch/store assets, how to produce video and audio, how to assemble, how to run technical QA, how to render. Don't duplicate engine functionality inside the creative project — describe intent and requirements, not implementation.

**Inspect before integrating, every time.** This document reflects `github.com/calesthio/OpenMontage` as read on 2026-09-01 (schemas, `pipeline_defs/`, `skills/pipelines/`, `AGENT_GUIDE.md`). Re-read the actual repo's current `AGENT_GUIDE.md`, `PROJECT_CONTEXT.md`, `schemas/artifacts/*.schema.json`, and the relevant `pipeline_defs/*.yaml` before compiling a handoff — schemas and pipeline manifests are the kind of thing that changes across versions, and this file is a map, not a substitute for the territory.

## Which engine is actually present

Two possible targets. Check which one is actually checked out before compiling anything:

1. **OpenMontage** (`github.com/calesthio/OpenMontage`) — a real, purpose-built, schema-validated, agent-driven video production system. This is the intended target. Detect it by the presence of `pipeline_defs/`, `AGENT_GUIDE.md`, and `schemas/artifacts/` at the repo root. If the current session's working repo isn't an OpenMontage checkout, ask the user for one, or attach it read-only (`add_repo` → clone) to compile against its schemas even if execution has to happen elsewhere.
2. **This repo's Remotion scaffold** (`src/index.tsx`, `src/HelloWorld.tsx`, `api/`) — a minimal fallback with none of OpenMontage's pipeline machinery. Use only when no OpenMontage checkout is available and the user wants something rendered directly in this repo. See the bottom of this file for that fallback path.

Everything below this point assumes an OpenMontage checkout is available.

## OpenMontage's actual architecture (don't reinvent it)

OpenMontage is **agent-first**: there is no Python orchestrator. Python only provides tools (`tools/`, subclasses of `BaseTool`) and persistence (checkpoints, cost tracking). All orchestration, creative decisions, and review criteria live in instructions the agent reads and follows:

```
pipeline_defs/<pipeline>.yaml (stages, tools, gates)
  -> skills/pipelines/<pipeline>/<stage>-director.md (HOW to run that stage)
  -> tools/ (Python BaseTool registry, scored provider selection)
  -> skills/meta/reviewer.md (self-review, max 2 rounds)
  -> lib/checkpoint.py (resumable JSON checkpoint under projects/<project_id>/)
  -> human approval gate (per the manifest's human_approval_default)
```

Its own pipeline state machine already runs `research -> proposal -> script -> scene_plan -> assets -> edit -> compose -> publish`, each stage producing a schema-validated artifact from `schemas/artifacts/`: `research_brief`, `proposal_packet` + `decision_log`, `script`, `scene_plan`, `asset_manifest`, `edit_decisions`, `render_report` + `final_review`, `publish_log`.

**Rule Zero (from `AGENT_GUIDE.md`), binding on EvoLink too:** every production request goes through a `pipeline_defs/` manifest, stage by stage, reading each stage director skill before acting on that stage. No ad-hoc scripts calling tools directly, no skipping a stage director skill, no bypassing preflight/checkpoints/review. EvoLink arriving with strong creative opinions does not license skipping OpenMontage's own stage sequence — it means each stage director skill inherits decisions that are already made instead of inventing them.

## The integration boundary: EvoLink writes OpenMontage's own artifacts

Don't invent a parallel schema. EvoLink's compiled project state is expressed **directly as OpenMontage's canonical artifacts**, so `projects/<project_id>/` contains real, schema-valid JSON that OpenMontage's own stage director skills, tools, and reviewer can pick up and continue from — typically starting at `scene_plan` or `assets`, since EvoLink has already done the creative work `research`/`proposal`/`script`/`scene_plan` stages would otherwise have to invent.

| EvoLink concept | OpenMontage artifact / field |
|---|---|
| Story bible premise, tone, thesis, target platform/duration | `brief.schema.json` — `title`, `hook`, `key_points`, `core_message`, `tone`, `style`, `target_platform`, `target_duration_seconds` |
| Chosen creative direction, delivery promise, renderer choice | `proposal_packet` (+ `decision_log`) — includes the `renderer_family` / `render_runtime` lock that `edit_decisions` must carry forward unchanged |
| Narration/dialogue timeline, voice performance intent | `script.schema.json` — `sections[]` with `start_seconds`/`end_seconds`, `delivery_cues`, `voice_performance` |
| Scene definition (location, time, purpose, transitions) | `scene_plan.schema.json` — one `scenes[]` entry per EvoLink scene: `type`, `description`, `start_seconds`/`end_seconds`, `transition_in`/`transition_out`, `narrative_role`, `shot_intent`, `hero_moment` |
| Cinema Director's shot design (camera, lens, movement, lighting) | `scene_plan.scenes[].shot_language` — `shot_size`, `camera_movement`, `lens_mm`, `lighting_key`, `depth_of_field`, `color_temperature` maps almost one-to-one onto Cinema Director's camera/lens/movement/lighting decisions |
| Character Builder's locked identity acting in a beat | `scene_plan.scenes[].character_actions[]` — `character_id`, `emotion`, `action_sequence[]`, `dialogue`, `target` (this field exists at the general `scene_plan` level, not gated to the `character-animation` pipeline, so it's valid for any pipeline with acting beats) |
| Locations/props/reference plates Banana Pro Director must produce | `scene_plan.scenes[].required_assets[]` — `type`, `description`, `source: generate|source|provided|record` |
| Generated stills/video/audio once produced | `asset_manifest.schema.json` — `assets[]` with `prompt`, `model`, `provider`, `cost_usd`, `scene_id` |
| Cuts, transitions, overlays, audio mix, subtitles | `edit_decisions.schema.json` |

`character_design.schema.json` is specific to the **local rigged SVG/`character-animation` pipeline** (body_type, required_emotions, required_views for a rig) — it is not the target for Character Builder's photoreal Higgsfield identity locks. For photoreal characters on any other pipeline, the identity lock lives in EvoLink's own character continuity record (see `references/pipeline-and-continuity.md` §6) and surfaces downstream only as generated `asset_manifest` entries plus the `scene_plan.metadata` continuity ledger below — OpenMontage doesn't need a duplicate schema for it.

## Where EvoLink's extra richness lives

OpenMontage's `scene_plan` objects are `additionalProperties: false` per scene, so per-shot generation-unit breakdowns, start/end frame contracts, and the character/location/prop state timeline don't have a dedicated field. OpenMontage's own `scene-director.md` sanctions exactly this situation and resolves it the same way EvoLink should: use the scene_plan's **top-level `metadata` object** for structured extras, keyed by scene/shot id, the same way it already recommends `hero_frames`, `transition_rules`, `overlays` there. Follow that convention:

```json
{
  "version": "1.0",
  "scenes": [ /* ... */ ],
  "metadata": {
    "evolink_continuity_graph": { "...": "character/location/prop stable-ID dependency graph" },
    "evolink_character_states": { "character_marcus_001": [ { "range": "00:00-04:30", "state": "uninjured" } ] },
    "evolink_generation_units": {
      "shot_004_003": [
        { "id": "generation_004_003_A", "duration_seconds": 7, "start_frame": "frame_004_003_A_start", "end_frame": "frame_004_003_A_end" },
        { "id": "generation_004_003_B", "duration_seconds": 6, "start_frame": "frame_004_003_A_end", "end_frame": "frame_004_003_B_end" }
      ]
    }
  }
}
```

EvoLink's own project state (per `references/pipeline-and-continuity.md`) remains the full source of truth for continuity, repair, and dependency tracking; the `scene_plan.metadata` projection above is only the subset OpenMontage's asset/edit/compose stages need to act correctly (which asset requests are actually one decomposed shot, and what each generation unit's frame contract requires).

## Pipeline selection

Match the source material to one of OpenMontage's real `pipeline_defs/*.yaml` — `talking-head`, `animated-explainer`, `screen-demo`, `clip-factory`, `podcast-repurpose`, `cinematic`, `animation`, `character-animation`, `hybrid`, `avatar-spokesperson`, `localization-dub`. A dramatic script/screenplay with locked characters and continuity most often fits `cinematic` (mood-led trailers, brand films, dramatic edits) or `animation`/`character-animation` when the visual system is illustrated/rigged rather than photoreal-live-action. Per Rule Zero, if the fit is genuinely ambiguous, ask the user rather than guessing — don't let EvoLink's confidence about the creative direction override OpenMontage's own pipeline-selection step.

## Governance EvoLink must respect, not route around

- **`renderer_family` / `render_runtime` lock** — set once at the `proposal` stage and carried forward unchanged through `edit_decisions`. EvoLink's Cinema Director / Banana Pro Director outputs inform the creative direction that produces this lock; they don't get to silently override it later.
- **Checkpoint + human approval gates** — each stage's `human_approval_default` in the pipeline manifest still governs whether a human signs off before the next stage runs, checkpoint-writer semantics (`completed`/`failed`/`awaiting_human`/`in_progress`) still apply, and every checkpoint is written under `projects/<project_id>/`.
- **Scored provider selection** — OpenMontage's tool registry picks the generation provider via its own 7-dimension scorer. EvoLink's specialists (Cinema Director, Banana Pro Director) are prompt-grammar authorities for whichever provider ends up selected (Higgsfield is one of OpenMontage's 20+ supported video/image providers) — they are not a bypass of that selection step unless the user explicitly pins a provider.
- **Budget governance, delivery-promise checks, slideshow-risk scoring, post-render self-review** — all still run. EvoLink's creative-QA pass (`references/pipeline-and-continuity.md` §9) is complementary to these, not a replacement.
- **Reviewer meta-skill** — advisory, capped at 2 rounds per stage; don't loop EvoLink's own repair cycle against a stage indefinitely waiting for a "perfect" OpenMontage review.

## Fallback: no OpenMontage checkout available

If only this repo's Remotion scaffold is available, treat it as a much thinner target: no schema validation, no pipeline stages, no checkpointing, no provider scoring, no quality gates — those all have to be reasoned about manually. Export a single JSON manifest a Remotion composition can consume as `defaultProps`, referencing generated media under a project-scoped assets directory:

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

A new Remotion composition (replacing the `HelloWorld` placeholder) would read this manifest and sequence the referenced media on Remotion's timeline, with narration/music as separate audio tracks. Building that composition is a production-engine task, not a creative one — flag it to the user as a prerequisite the first time an export actually needs it, rather than building it speculatively. Prefer getting an OpenMontage checkout attached over investing further in this fallback.

## No premature production

Creative-ready is not production-rendered:

```
BUILD → REVIEW → APPROVE → EXPORT → PRODUCE
```

Don't trigger actual media generation, an OpenMontage pipeline run, or `remotion render` as a side effect of building the creative package — only when the user explicitly asks for production execution.
