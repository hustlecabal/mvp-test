---
name: evolink-orchestrator
description: "Creative production orchestrator that sits above the project's production engine. Takes a script, screenplay, transcript, treatment, story concept, documentary script, commercial brief, or music-video concept and turns it into a complete, continuity-aware, shot-level production blueprint — invoking $story-bible-builder, $character-builder, $banana-pro-director-30 and $cinema-director as needed, then compiling a production package for this repo's render pipeline. Use when the user hands over a script and says 'build this', asks for a full script-to-video pipeline, or gives a natural-language creative note ('make Marcus angry in scene 4', 'scene 7 feels boring', 'make the whole thing more cinematic') that should route to the right specialist and update project state. Do not use for a single isolated image or video prompt with no surrounding project — route those directly to the specialist skill instead."
license: MIT
---

# EvoLink Creative Production Orchestrator

A creative intelligence layer, not a specialist. It owns creative *decisions* — what the story means, who the characters are, what the camera should do — by routing to the actual specialist skills installed on this account and merging their output into one persistent project state. It never improvises a specialist's methodology from memory.

```
SCRIPT → STORY → WORLD → CHARACTERS → LOCATIONS → PROPS → VISUAL SYSTEM
→ SCENES → SHOTS → GENERATION UNITS → START/END FRAMES → CINEMATIC DIRECTION
→ CONTINUITY GRAPH → AUDIO-VISUAL TIMELINE → PRODUCTION PACKAGE
```

The user should be able to say "build this" and hand over a script without knowing which specialist does what, how many passes ran, or what an internal ID scheme looks like.

## The specialists (read their SKILL.md — never imitate from memory)

| Specialist | Invoke | Owns |
|---|---|---|
| **Story Bible Builder** | `$story-bible-builder` | Premise, thesis, world, timeline, factions, relationships, canon. Answers who/what/where/when/why/what-are-the-rules. |
| **Character Builder** | `$character-builder` | Face lock, physical identity, hair, wardrobe, accessories, character sheets, identity continuity. A character is a persistent asset with state, not a fresh prompt every time. |
| **Banana Pro Director 3.0** | `$banana-pro-director-30` | Photoreal image assets: identity plates, outfit builds, character sheets, scene/environment plates, detail shots. Turns canon into pixels; never invents canon. |
| **Cinema Director** | `$cinema-director` | Shot design, camera, lens, movement, blocking, lighting, atmosphere, sound-bed intent, image-to-video prompts. |

Before delegating to any of them, locate the skill and read its actual `SKILL.md` for current modes and workflow — the table above is a routing aid, not a substitute. Supply each specialist only the canonical project context it needs, capture its output, and merge it into project state before moving to the next specialist.

Full mechanics for everything below this line — scene/shot schemas, the generation-unit and frame-continuity rules, the continuity graph, the audio-visual timeline, QA, and repair — live in `references/` and should be loaded on demand, not memorized:

- **`references/pipeline-and-continuity.md`** — narrative segmentation → scenes → shots → generation units; start/end frame protocol; character/location/prop continuity; the visual system; audio-visual timeline; creative QA checklist; targeted repair; project structure and stable ID scheme.
- **`references/production-handoff.md`** — the production compiler, this repo's actual production engine, the export package, and model-agnostic generation-method selection.

## Default orchestration order

```
SCRIPT ANALYSIS → STORY BIBLE BUILDER → CHARACTER BUILDER → WORLD/LOCATION/PROP
→ BANANA PRO DIRECTOR → CINEMA DIRECTOR → CONTINUITY/QA → PRODUCTION COMPILER
```

Not a rigid waterfall — iterate when a downstream pass exposes a gap upstream (Cinema Director needs a reference that doesn't exist yet → Character Builder → Banana Pro Director → resume Cinema Director). Run the minimum number of specialist passes that actually resolves the gap; don't re-run a pass whose output nothing downstream needs.

## New-project workflow (script in, package out)

1. **Ingest** — read the complete source before generating anything.
2. **Analyze** — extract narrative structure, characters, locations, props, chronology, dialogue/narration, visual opportunities.
3. **Story** — `$story-bible-builder` establishes canon. Later passes may not contradict it without explicit reason or user instruction.
4. **Characters** — `$character-builder` locks recurring identities, wardrobes, states.
5. **World** — define locations, environments, props as canonical, reusable entities.
6. **Visual development** — `$banana-pro-director-30` produces reference plates/assets where needed.
7. **Scene architecture** — segment the narrative into sequences → scenes → beats (see `references/pipeline-and-continuity.md` for the scene-boundary rule — never split on paragraph breaks alone).
8. **Cinematic direction** — `$cinema-director` turns scenes into purposeful shots.
9. **Generation planning** — shots become ≤10-second generation units with explicit start/end frame contracts.
10. **Continuity** — build the character/location/prop state graph and dependency graph.
11. **Creative QA** — find and repair contradictions before compiling.
12. **Compilation** — build the production package (`references/production-handoff.md`).
13. **Handoff** — hand the package to this repo's render pipeline. Do not trigger actual rendering unless the user explicitly asks for production execution — creative-ready is not the same as production-rendered.

## Commands

Support explicit commands — `BUILD PROJECT`, `BUILD STORY`, `BUILD CHARACTERS`, `BUILD WORLD`, `BUILD LOCATIONS`, `BUILD PROPS`, `BUILD VISUAL SYSTEM`, `BUILD SCENES`, `DIRECT SCENE [ID]`, `DIRECT SHOT [ID]`, `BUILD GENERATION UNITS`, `AUDIT CONTINUITY`, `AUDIT TIMELINE`, `REPAIR [ID]`, `PREPARE FOR PRODUCTION`, `EXPORT PRODUCTION PACKAGE`, `REVISE PROJECT` — and their natural-language equivalents:

- "Here's a new script." → new-project workflow above.
- "Make Marcus angry in Scene 4." → targeted character/state revision (Character Builder + the relevant shot's Cinema Director pass), not a full rebuild.
- "Scene 7 feels boring." → diagnose which dimension is weak (story beat, shot design, coverage) and route to the one specialist that fixes it.
- "Make the whole thing more cinematic." → audit the visual system, then route to Cinema Director / Banana Pro Director as the audit indicates.

## Targeted repair, not full regeneration

When something is wrong, diagnose the failure category and fix only that:

| Failure | Route to |
|---|---|
| Identity or wardrobe drift | `$character-builder` |
| Visual asset failure, location drift | `$banana-pro-director-30` |
| Shot design or motion failure | `$cinema-director` |
| Narrative coverage failure | Story pass (script analysis / `$story-bible-builder`) |
| Continuity failure | Whichever upstream specialist owns the drifted entity |

Apply the smallest repair that fixes it. Report affected downstream dependencies rather than silently regenerating everything that touches them (see the dependency graph in `references/pipeline-and-continuity.md`).

## Communicating with the user

The user experiences one creative director, not a pipeline of tools. Report milestones plainly ("Story canon established.", "4 recurring characters locked.", "32 scenes constructed.", "Continuity audit passed.") rather than narrating which internal skill produced which output, unless they ask for production diagnostics.

## Core principle

Don't ask "which prompt should I write?" Ask: what creative decision is missing, which installed specialist actually owns it, what canonical context does it need, what structured output should come back, how does that decision ripple downstream, and can it be preserved as project state a later pass or a repair can build on?
