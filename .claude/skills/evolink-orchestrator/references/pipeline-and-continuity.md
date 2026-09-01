# Pipeline, Continuity & Project State

Detail reference for the EvoLink orchestrator. Load this when actually building or auditing a project — not needed just to route a request to a specialist.

## 1. Narrative segmentation

A large script is a narrative system, not a wall of text to chop by word count or by a fixed clip length. Segment top-down:

```
SCRIPT → ACTS → SEQUENCES → SCENES → NARRATIVE BEATS → SHOTS → GENERATION UNITS
```

The story determines scene boundaries. The director determines shots. Generation constraints determine generation units — never the other way around (don't chunk the script to fit a model's duration limit).

Start a new scene when one or more *meaningful* production dimensions changes: location, time, dramatic purpose, major action, emotional state, character configuration, narrative objective, or visual environment. A paragraph break alone is not a scene boundary.

## 2. Scene definition

Every scene needs: ID, title, narrative purpose, source script range, start/end time, location, time of day, characters present, wardrobe states, props, environment state, emotional beat, narrative beat, visual objective, audio/narration, transition in/out, its shot list, and continuity requirements it must satisfy.

## 3. Shot architecture

Every shot must have a purpose — never pad shot count. For each shot, determine: ID, narrative purpose, visual purpose, target duration, subject(s) and their states, location, props, composition, camera position, FOV/lens, camera height, camera movement, subject movement, blocking, lighting, atmosphere, emotional intent, audio relationship, start frame, end frame/end state, transition, generation method, and continuity requirements.

Shot duration is editorial, not a technical default:

- **1–3s** — inserts, reaction shots, details, visual punctuation
- **3–5s** — simple actions, medium shots, dialogue reactions
- **5–8s** — walking, environmental interaction, cinematic portraits, narrative action
- **8–10s** — establishing shots, landscapes, sustained movement, important visual holds

Guidelines, not rules — editorial purpose always wins. Don't cut immediately after an action completes when the beat deserves a payoff (emotional recognition, comprehension, comedic timing, musical punctuation); don't mistake "maximum generation duration" for "required screen duration."

Respect the project's established transition language. Default to hard cuts unless dissolves/fades/wipes are explicitly directed. Prefer cutting on movement, gesture, eye-line, action completion, a sound cue, a musical beat, or a compositional match.

## 4. Generation unit policy

The generation unit is the atomic motion-generation request.

- **Hard maximum: 10 seconds.** No individual unit may exceed this.
- **Preferred range: 3–8 seconds.** Use shorter when editorially appropriate — don't force every unit to 8–10s.

```
STORY → EDIT → SHOT → DURATION → GENERATION UNIT   (correct)
MODEL LIMIT → CHUNK SCRIPT → GENERATE                (wrong)
```

A cinematic shot may legitimately run longer than 10 seconds. Don't truncate it — decompose it into sequential generation units at natural visual/physical transitions, where each unit's start frame is the previous unit's end frame, so the units together read as one seamless director-designed shot (unless a hard cut is deliberately intended mid-shot).

## 5. Start/end frame protocol

Frames are first-class production objects, not incidental byproducts of a clip:

```
VISUAL STATE → MOTION → VISUAL STATE → MOTION → VISUAL STATE
```

Every generation unit defines a start frame, the motion, and an end frame/end state. Whenever technically possible, the actual final frame of unit N becomes the starting reference for unit N+1, preserving: character identity, body position, hair, wardrobe, accessories, props, environment, spatial geography, lighting, time of day, camera relationship, and relevant object state.

**Frame contract** — each frame carries two layers: the visual reference (the actual image) and a structured state contract (what must be true — character, position, body/hand states, face, wardrobe, location, light, camera). Example:

```
CHARACTER: Marcus
POSITION: standing beside archive table
BODY: torso angled camera-left
RIGHT HAND: holding photograph
LEFT HAND: resting on table
FACE: cautious
WARDROBE: outfit_02
LOCATION: archive_001
LIGHT: warm window light
CAMERA: 50mm medium close-up
```

**End frame methods** — pick per shot based on continuity risk:

- **A — Generated end frame**: deliberately generate the end-frame image. Use for high-risk continuity.
- **B — Extracted final frame**: use the actual final frame of the generated clip when it already represents the intended continuation state.
- **C — End-state contract only**: acceptable when exact visual matching isn't necessary.

Prefer explicit end-frame generation (method A) for: character entrances/exits, wardrobe changes, object handoffs, hand interactions, complex blocking, major camera repositioning, major location transitions, close character interactions, significant physical transformations, and important narrative reveals.

**Image-to-video as first-class method**: `START IMAGE → image-to-video → FINAL FRAME → continuation frame → image-to-video → …`. Prefer this chained approach over one long generation whenever character or environment consistency matters.

## 6. Continuity tracking

**Characters.** Every recurring character gets a canonical identity record. Face, hair, and body are LOCKED (they don't change because emotion, wardrobe, location, lighting, or camera changed). Wardrobe and accessories are STATEFUL. Emotional and physical state are VARIABLE and tracked over time, e.g.:

```
Marcus  00:00–04:30  uninjured
        04:30–06:00  bruised cheek
        06:00–08:00  bruised cheek + torn sleeve
```

Every subsequent shot inherits the character's current state — a later generation must never silently reset it.

**Locations.** Every recurring location gets a canonical identity tracking architecture, geography, entrances/exits, windows, furniture, lighting, weather, time of day, environmental state, recurring props, and camera geography. Never regenerate a location as a generic equivalent.

**Props.** Every recurring prop gets a canonical identity tracking physical design, colour, markings, ownership, state, location, and position. If a character sets a prop down, the next shot needs to know where it is.

## 7. Visual system

A project-wide visual DNA: visual genre, photographic language, colour palette, contrast, lighting philosophy, lens language, camera movement, depth of field, atmosphere, texture/grain, environment treatment, wardrobe philosophy, typography/graphics, motion language. Individual scenes may vary within it but must not randomly abandon it.

**Reference roles must stay explicit** — identity reference, wardrobe reference, location reference, prop reference, composition reference, style reference, lighting reference. A style reference never redefines identity; a composition reference never redefines wardrobe; a wardrobe reference never redefines facial identity.

## 8. Audio-visual timeline

For every narration/dialogue segment, decide what the audience sees while hearing it, prioritizing: narration → visual evidence → emotional reinforcement → visual progression. No arbitrary B-roll — every visual should contribute comprehension, emotion, pacing, curiosity, context, or emphasis.

Build a master timeline coordinating narration, dialogue, music, SFX, scenes, shots, generation units, transitions, title cards, and graphics, e.g.:

```
00:00.000–00:05.200  SCENE 01 / SHOT 01 / GEN_01
00:05.200–00:08.600  SHOT 02 / GEN_02
00:08.600–00:15.000  SHOT 03 / GEN_03
```

The visual timeline must align with the intended audio timeline.

## 9. Creative QA checklist

Before compiling a handoff package, check:

- **Story** — coherent narrative, correct chronology, dramatic beats represented.
- **Characters** — identity, wardrobe, emotional and physical state all consistent with their tracked timeline.
- **Locations** — geography and environment coherent, time of day correct.
- **Props** — state, ownership, position correct.
- **Visuals** — visual system consistent, shots purposeful, no generic filler.
- **Cinematography** — camera language coherent, movement physically plausible, framing intentional.
- **Timing** — durations correct, every generation unit ≤10s, audio/visual alignment correct.
- **Continuity** — every unit has a valid start/end relationship; sequential states are compatible.
- **Production** — assets and references identified, generation methods specified, handoff requirements clear.

## 10. Targeted repair

Diagnose before regenerating. Apply the smallest repair (see the failure-routing table in `SKILL.md`), preserve everything already working, and trace the dependency graph before touching a locked asset:

```
CHARACTER_MARCUS_001 → FACE_LOCK_001 → CHARACTER_SHEET_001 → OUTFIT_02
  → SCENE_04 → SHOT_04_03 → GEN_04_03_A
```

If a face lock changes, identify every downstream asset affected and report the affected dependencies — don't silently regenerate all of them.

## 11. Project structure & stable IDs

Maintain a persistent project representation:

```
PROJECT
├── SCRIPT
├── STORY BIBLE (premise, thesis, world, timeline, factions, relationships, themes, production rules)
├── CHARACTERS (identity, face lock, character sheet, wardrobe, state timeline)
├── LOCATIONS (environment, references, state timeline)
├── PROPS
├── VISUAL SYSTEM
├── SEQUENCES
├── SCENES (narrative beats, shots, generation units)
├── AUDIO TIMELINE
├── CONTINUITY GRAPH
└── PRODUCTION PACKAGE
```

Every persistent entity gets a stable ID and is never duplicated for the same underlying entity, e.g.:

```
project_001
character_marcus_001
outfit_marcus_02
location_warehouse_001
prop_phone_001
scene_004
shot_004_003
generation_004_003_A
frame_004_003_A_start / frame_004_003_A_end
```

## 12. Creative economy

Reuse a canonical character/location/prop/wardrobe/environment identity when the same one recurs — don't regenerate it from scratch. But don't force reuse when the story genuinely requires a new state (an injury, a costume change, a destroyed location).
