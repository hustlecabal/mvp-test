# Stage 26 — Visual Production Director + External Repository Architecture Study

**Status: INVESTIGATION ONLY. No production code, schema, or `server/data` changes were made. No generation calls were made. No credits were spent. No dependencies were installed.** Verified: `git status --short` was clean before this document was created and only this file is new afterward.

This document studies how to evolve EVOLINK from the proven "creative brief → storyboard → keyframe → video" control plane into a system that can assemble a full short-to-8-minute video from mixed material — AI video, AI stills, existing project assets, B-roll, and deterministic motion graphics — without discarding anything already built.

---

## PART 1 — Internal Architecture Audit

### 1.1 What exists today, exactly

| Layer | File(s) | Owns |
|---|---|---|
| Creative Brief / Master Spec | `schemas/creative-schema.js` (`createCreativeBrief`, `createMasterCreativeSpec`) | project-level creative intent, one per project, lightweight-versioned (`versionFields()`: version/updatedAt/updatedBy/changeNote/history) |
| Visual Bible | `creative-schema.js` (`createVisualBible`, `createCharacter`, `createLocation`, `createProp`) | recurring characters/locations/props, each with `canonicalReferenceFields()` (an entity-level canonical reference asset selection + history) |
| Storyboard | `creative-schema.js` (`createStoryboardScene`, `createStoryboardShot`, `createStoryboard`) | scenes (`sceneId`, `title`, `order`, `description`, `purpose`) and shots (`shotId`, `sceneId`, `order`, `duration`, `purpose`, `narrativeBeat`, `visualDescription`, `subject`, `location`, `action`, `camera`, `framing`, `lens`, `movement`, `lighting`, `soundNotes`, `transition`, `continuityRequirements`, `characterReferences`/`locationReferences`/`propReferences`, `referenceAssets`, `promptDraft`, `status` from `SHOT_PLANNING_STATUSES`) |
| Keyframes | `schemas/keyframe-schema.js` (`createKeyframe`, `createKeyframePlan`) | 1..N planned still-image references per shot, typed by `FRAME_TYPES` (`ESTABLISHING_FRAME`, `ACTION_FRAME`, `FIRST_FRAME`, `LAST_FRAME`, `TRANSITION_FRAME`, `DETAIL_FRAME`, etc.), each with its own canonical-asset selection (`canonicalAssetId` + history), staleness tracked via `sourceShotVersion` vs. the storyboard's live version |
| KeyframePromptPackage | `schemas/keyframe-prompt-schema.js` + `services/keyframe-prompt-service.js` | resolves a keyframe's references into `identityLock`/`wardrobeLock`/`environmentLock` sections, builds a structured `promptSections` object and a derived `prompt` string, versioned, `status: CURRENT \| STALE` |
| VideoPromptPackage | `schemas/video-prompt-schema.js` + `services/video-prompt-service.js` | binds a keyframe's **canonical, APPROVED** image asset + an explicit provider/model + execution parameters (`duration`, `resolution`, `aspectRatio`, `fps`, `quality`) into a video generation request; blocks if the canonical asset isn't `APPROVED` (`CANONICAL_ASSET_NOT_APPROVED`) or the model doesn't satisfy required capabilities (`MODEL_CAPABILITY_UNSUPPORTED`) |
| Generation Model Registry | `services/generation-model-registry.js` | **the single source of truth for every image/video model this system knows about** — `provider`, `model`, `modality` (`'image' \| 'video'`), `capabilities` (textToImage/imageToImage/textToVideo/imageToVideo/referenceImages/maxReferenceImages/resolutions/aspectRatios/durations), `verificationStatus`, `productionReady`, `pricing` (`{unit, startingPrice, currency, priceKnown}`), `costTier` (`BUDGET/STANDARD/QUALITY/OTHER`), `observedCost` + `observedCostBasis` (real historical spend, human-recorded, never auto-updated) |
| Reference Library | `services/reference-library-service.js` + `creative-store.js` | per-entity (CHARACTER/LOCATION/PROP) reference-asset candidates, human upload (`ingestReferenceAsset`), human approve/reject (`decideReferenceAsset`, added Stage 25), human canonical selection (`selectCanonicalReferenceAsset`, blocks only `REJECTED`) |
| Identity Consistency Review | `services/identity-consistency-review-store.js` | scored human review of a generated asset against a reference (`clothing`/etc. dimension scores) — **read-only observation, never touches `approvalStatus`** |
| Generation services | `keyframe-generation-service.js`, `video-generation-service.js`, `generation-service.js` (legacy) | each does the same shape of thing: safety checks → resolve reference image URL → submit to provider adapter → poll → archive result asset → reconcile cost. `generation-service.js` is the **original, project-level, MCP-only, never-touched-by-UI legacy path** (own `project.approvals`/`project.creditLedger`); `keyframe-generation-service.js`/`video-generation-service.js` are the **current, per-shot/per-keyframe pipeline** with their own approval-store records but the **same shared budget ledger** (see below) |
| Approval / Budget | `services/approval-gate.js` (ledger: `setBudget`, `getRemainingBudget`, `reconcileGenerationCost`, `canProceed`, overage detection/`acknowledgeOverage`) + `keyframe-generation-approval-store.js` / `video-generation-approval-store.js` (per-action REQUEST→APPROVE/REJECT records, unknown-cost acknowledgement) | **`approval-gate.js` is the one and only credit ledger in the codebase.** Both the legacy and current pipelines call into it. There is exactly one budget system today. |
| Operator Queue | `schemas/operator-queue-schema.js` + `services/operator-queue-service.js` | derived, read-only, per-keyframe view of where every shot stands (`category`, `videoStatus` including `VIDEO_FAILED` added Stage 25) — never a second source of truth, always computed fresh from the stores above |
| Timeline IR (legacy) | `schemas/production-schema.js` (`createTimelineIR`: `scenes`, `shots`, `assets`, `audio`, `transitions`, `outputSettings`, `generations`) | **this is the ONLY "assembly" schema that exists**, and it belongs to the legacy, MCP-only pipeline. `audio`/`transitions`/`outputSettings` are declared but populated by nothing anywhere in the codebase today — confirmed by `grep`, zero references outside this file. |
| Asset storage/archive | `services/asset-storage.js` (`storeUploadedImage`, magic-byte content sniffing, never trusts Content-Type/filename), `services/asset-archive-service.js` | permanent local copy of a provider's (temporary) result URL, served via `/assets/:id/preview` and `/assets/:id/download`. **Images and videos both already flow through this exact mechanism** — a video asset today is just `asset.type === 'video'` through the same store. |
| Frontend | `frontend/app.js` (4,572 lines, one file), `frontend/index.html` | 4 tabs (Production, Creative Director, Operator Queue, Generation Models); the Creative Director tab is where Brief/Bible/Characters/Locations/Storyboard/Keyframe Plan/Reference Library all live today |
| MCP tools | `server/mcp/tools/*.js` (19 files) | one MCP tool module per subsystem above, matching REST 1:1 |

### 1.2 What does NOT exist today (confirmed by grep across the whole repo, zero matches)

- **No FFmpeg** (no `ffmpeg`/`fluent-ffmpeg` anywhere; `server/package.json` has exactly three dependencies: `@modelcontextprotocol/sdk`, `express`, `zod`)
- **No audio/TTS/music/SFX infrastructure** (no `text-to-speech`/`elevenlabs`/`whisper`/`transcri*` anywhere)
- **No subtitle infrastructure** (no `.srt`/`.vtt`/`subtitle`/`caption` anywhere)
- **No render pipeline.** The only "render" concept in the codebase is a `skill-registry.js` entry (`brand-video-editor`) — a *recommendation record* describing an **external, human-run** post-production skill that calls the HyperFrames CLI outside this app. The skill orchestrator only ever recommends skills to a human (Stage 12's "display-only" rule, unbroken since); nothing here is executed by EVOLINK's own code.
- **No B-roll / stock-footage concept anywhere.**
- **No motion-graphics concept anywhere.**
- **No video-analysis / self-QC concept anywhere.**

This is the honest starting point: **the proven part of EVOLINK stops at "one approved video asset per keyframe."** Everything from "assemble multiple beats into one MP4" onward is new territory. That is exactly consistent with what Part 14/15 below build.

### 1.3 Reuse map (binding — read before Part 4 onward)

Per the explicit instructions, these must NOT be duplicated, and are not:

- **Timeline IR**: `production-schema.js`'s `createTimelineIR` already declares `scenes`/`shots`/`assets`/`audio`/`transitions`/`outputSettings`/`generations` at the project level, unused today. This stage's new **Beat Graph** (Part 5) is designed to populate exactly these fields rather than invent a parallel `project.visualBeats` array living outside the Timeline IR. See Part 10.
- **Asset model**: `production-schema.js`'s `createAsset`/`createNextAssetVersion`/`defaultAssetStorage` already handle versioned, lineage-tracked, storage-tracked media of any `type`. A B-roll clip, a rendered motion graphic, and a generated video all become `Asset` records with a new `type` value (e.g. `'broll'`, `'motion_graphic'`) — never a second asset schema.
- **Approval/budget system**: `approval-gate.js` is the one ledger. Any new spend-worthy decision (approving an AI-video treatment over a free B-roll one, approving a licensed-footage cost) gets its own approval-STORE (mirroring `video-generation-approval-store.js`'s exact shape) that still calls into the same `gate.reconcileGenerationCost`/`gate.getRemainingBudget`/`gate.canProceed`. Never a second ledger.
- **Queue**: `operator-queue-service.js`'s pattern (derived, read-only, recomputed from stores, never itself a store) extends to a Beat Queue the same way — new `videoStatus`-style enum values, not a parallel queue mechanism.
- **Model selection**: `generation-model-registry.js`'s `findModelsSatisfying`/`cheapestSatisfying`/`validateModelSelection` already implement exactly the "find a model that satisfies capability requirements, ranked by known price, never guessing an unknown price as free" logic the Material Resolution Engine (Part 6) needs for its AI-video/AI-still candidates. Reused directly, not reimplemented.

---

## PART 2/3 — External Repository Architecture Study

*(This section is populated from a dedicated research pass over the three repositories. See the synthesis and per-repo findings below. Every claim is labeled `[SOURCE-DERIVED FACT]`, `[INFERENCE]`, or `[RECOMMENDATION]`.)*

*(External repository findings are appended at the end of this document, after Part 15, once the dedicated research pass completed — see "EXTERNAL REPOSITORY FINDINGS." Parts 4-15 below do not depend on that section's exact wording; they were designed from Part 1's internal audit plus the architectural questions Part 3 raises, and cross-checked once the research returned.)*

---

## PART 4 — The VisualBeat Model

### 4.1 Where a beat sits in the existing hierarchy

```
Scene  (creative-schema.js createStoryboardScene — unchanged)
  └─ StoryboardShot  (creative-schema.js createStoryboardShot — unchanged)
       └─ VisualBeat  (NEW — 1..N per shot)
```

A shot already decomposes into 1..N **keyframes** today (`ESTABLISHING_FRAME`, `ACTION_FRAME`, ...). A `VisualBeat` is the same kind of decomposition, one level further downstream: it is the unit that actually gets **timed, materially resolved, and placed on the timeline**. For a simple shot, one beat is enough. For a shot that needs "she reaches for the door, then opens it, then walks through" — three moments with different motion requirements — that's three beats sharing one shot's continuity context. This mirrors exactly how one shot already fans out into multiple keyframes; a beat is not a competing concept, it is the next link in the same chain, closer to render time.

### 4.2 Schema

```js
function createVisualBeat(overrides = {}) {
  const base = {
    // --- identity ---
    beatId: crypto.randomUUID(),
    projectId: null,
    sceneId: null,          // required — every beat belongs to exactly one scene
    shotId: null,           // optional — a beat MAY exist without a storyboard shot
                             // (e.g. a pure transition/title-card beat between scenes)
    sequence: null,          // integer order within the scene (mirrors scene.order/shot.order)

    // --- timing ---
    startTime: null,         // seconds from video start; null until the beat is placed
    duration: null,          // seconds; the one field a treatment must always be able to satisfy

    // --- narrative ---
    narrativePurpose: '',    // WHY this beat exists (mirrors production-schema.js's
                              // existing shot.narrativePurpose field name exactly —
                              // continuity of an established name, not a new one)
    narrationSegment: null,  // { text, scriptRefId, startOffset, endOffset } — the
                              // slice of narration/VO this beat covers, or null (b-roll/
                              // music-only beats need no narration)
    visualIntent: '',        // WHAT must be communicated visually — subject, mood, key
                              // detail. Higher-level than a literal shot description;
                              // this is the thing every candidate treatment is scored
                              // against (Part 6), not itself a treatment choice.

    // --- treatment (see 4.3) ---
    treatment: {
      visualTreatment: null, // one of VISUAL_TREATMENTS
      materialSource: null,  // one of MATERIAL_SOURCES
    },
    materialRequirements: {
      subjects: [],           // characterId/locationId/propId values that MUST appear
      requiredElements: [],   // free-text must-appear elements not modeled as an entity
      excludedElements: [],   // must NOT appear
    },
    motionRequirements: {
      // THE hard gate for the Material Resolver (Part 6) — decides whether a still
      // image can possibly be adequate at all.
      motionLevel: null,      // 'NONE' | 'SUBTLE' | 'MODERATE' | 'COMPLEX'
      cameraMotion: null,     // free text, e.g. "slow push in", null if none required
      subjectMotion: null,    // free text, e.g. "turns around and opens the door"
      environmentMotion: null,// free text, e.g. "rain falling", null if none
    },

    // --- creative direction (mirrors keyframe.composition/camera/lighting/colour AND
    // video-prompt-schema.js's createVideoCreativeSpecification fields — a beat is a
    // superset because it may resolve to either a still or a video treatment) ---
    composition: null,
    camera: null,
    lighting: null,
    colour: null,
    pacing: null,

    // --- identity/continuity/style (reference Visual Bible entities BY ID —
    // never duplicate their description, exactly like keyframe.characterReferences) ---
    identityRequirements: {
      characterReferences: [],
      locationReferences: [],
      propReferences: [],
    },
    continuityRequirements: [], // same field name/shape as shot/keyframe's own field
    styleRequirements: null,    // deviation from Master Creative Spec, if any; null
                                  // means "inherit the project's masterCreativeSpec as-is"

    transition: null,   // in/out transition, same field name as shot.transition

    // --- audio/graphics (references, not inline data — see Part 8/9) ---
    audioEvents: [],    // audioEventId values whose window overlaps this beat
    graphics: null,      // a MotionGraphicSpec id, only set when treatment needs one

    // --- resolution policy inputs (read by the Material Resolver, Part 6) ---
    costPriority: 'MEDIUM',     // 'LOW' | 'MEDIUM' | 'HIGH' — how much this beat's
                                  // narrative value justifies spending on it
    qualityPriority: 'MEDIUM',  // 'LOW' | 'MEDIUM' | 'HIGH'
    fallbackStrategy: [],       // ordered list of acceptable visualTreatment values if
                                  // the preferred one is unavailable/fails, e.g.
                                  // ['AI_VIDEO', 'STILL_IMAGE'] — never silently falls
                                  // back past this list; an empty list means "flag for
                                  // human review rather than substitute anything"

    // --- resolved material (filled in once the Resolver runs — Part 6) ---
    resolvedAssetId: null,      // the winning Asset id, or null until resolved
    resolutionScore: null,      // the winning candidate's score breakdown, for audit
    resolutionAlternatives: [], // the next-best candidates considered, for DIRECTOR-mode review

    status: 'PLANNED', // PLANNED -> RESOLVING -> RESOLVED -> APPROVED -> PLACED -> STALE
    ...versionFields(), // reused as-is
  };
  return withDefaults(base, overrides);
}
```

This deliberately reuses `versionFields()`, the `characterReferences`/`locationReferences`/`propReferences` naming, the `continuityRequirements`/`transition`/`narrativePurpose` field names, and the canonical-asset-selection philosophy (`resolvedAssetId` is exactly the keyframe's `canonicalAssetId` pattern, one level up) — a developer who already knows `keyframe-schema.js` should recognize this shape immediately.

### 4.3 Treatment taxonomy — refined, not accepted as-is

The task's candidate taxonomy (`STILL_IMAGE, AI_VIDEO, BROLL, EXISTING_ASSET, MOTION_GRAPHIC, KINETIC_TYPOGRAPHY, HYBRID`) conflates two independent questions into one flat enum: **what does the material look like** (a still? a moving clip? a chart?) and **where did it come from** (freshly generated? reused? licensed? templated?). `EXISTING_ASSET` and `BROLL` are really answers to the second question wearing the first question's clothes — a "still image" could equally be an existing project asset, a freshly generated one, or a frame pulled from B-roll, and the resolver needs to reason about source and shape independently (a beat that requires "genuine subject motion" can never be satisfied by `STILL_IMAGE` regardless of source; a beat with a tight budget can never accept `GENERATED_NEW` regardless of shape). Collapsing both into one enum would force a combinatorial explosion (`STILL_IMAGE_EXISTING`, `STILL_IMAGE_BROLL_FRAME`, `STILL_IMAGE_NEW`, ...) or force premature commitment before the resolver even runs.

**Two orthogonal axes, both simple enums:**

```js
const VISUAL_TREATMENTS = [
  'STILL_IMAGE',        // one static frame; may get camera motion (Ken Burns) at render
                          // time, never at generation time
  'AI_VIDEO',            // AI-generated clip with genuine subject/camera motion
  'BROLL_CLIP',          // a trimmed segment of licensed/stock footage
  'MOTION_GRAPHIC',      // deterministically rendered data-driven visual
  'KINETIC_TYPOGRAPHY',  // deterministically rendered animated text
  'HYBRID',              // 2+ of the above composited/sequenced within one beat
];

const MATERIAL_SOURCES = [
  'PROJECT_ASSET_REUSE', // an already-APPROVED asset from this project
  'GENERATED_NEW',       // a fresh provider call for this beat specifically
  'BROLL_LIBRARY',       // pulled from the ingested B-roll index (Part 7)
  'DETERMINISTIC_TEMPLATE', // rendered by our own template/graphics engine
];
```

A resolved beat's `treatment` is the pair, e.g. `{ visualTreatment: 'STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE' }` or `{ visualTreatment: 'AI_VIDEO', materialSource: 'GENERATED_NEW' }`. This is a refinement of the task's taxonomy, not a rejection of it — every value the task named still exists, just factored onto the axis it actually describes.

---

## PART 5 — The Beat Graph

### 5.1 Structure: flat array + reference edges, not a graph database

Every existing artifact in this codebase that could have been "nested" is instead a **flat array with foreign-key references** (`storyboard.scenes` + `storyboard.shots[].sceneId`, never `scenes[].shots`; `project.assets` + `asset.shotId`/`asset.keyframeId`, never nested asset trees). This is a deliberate, repeated pattern, and the reason is concrete: a flat array makes staleness detection, versioning, and "find every X for this Y" queries trivial single-pass filters instead of tree walks. The Beat Graph follows the same convention:

```js
function createBeatGraph(overrides = {}) {
  const base = {
    projectId: null,
    beats: [],       // flat array of VisualBeat, each carrying sceneId/shotId/sequence
    edges: [],        // lightweight dependency/continuity edges (see below) — NOT a
                        // full graph engine, just typed adjacency pairs
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}

function createBeatEdge(overrides = {}) {
  const base = {
    edgeId: crypto.randomUUID(),
    fromBeatId: null,
    toBeatId: null,
    kind: null, // 'CONTINUITY' | 'DEPENDS_ON' | 'ALTERNATE_OF' | 'TRANSITIONS_TO'
    note: null,
  };
  return withDefaults(base, overrides);
}
```

Four edge kinds cover everything the task's requirements list asks for:

| Edge kind | Meaning | Example |
|---|---|---|
| `CONTINUITY` | both beats must render with the same identity/wardrobe/environment state | beat 3 (Nova enters the lab) `CONTINUITY→` beat 7 (Nova, same scene, close-up) |
| `DEPENDS_ON` | `toBeatId` cannot be resolved/placed until `fromBeatId` is resolved | beat 12 (the door beat) `DEPENDS_ON→` beat 11 (establishing the door exists in frame) |
| `ALTERNATE_OF` | `toBeatId` is a fallback candidate for `fromBeatId`, not a second beat on the timeline | beat 5 (AI_VIDEO of the product spinning) `ALTERNATE_OF→` beat 5b (STILL_IMAGE fallback, never placed unless 5 fails) |
| `TRANSITIONS_TO` | explicit transition relationship beyond the simple `beat.transition` field, for cross-scene transitions that need to know both sides | last beat of scene 2 `TRANSITIONS_TO→` first beat of scene 3 |

`beats` grouped into scenes is just `beats.filter(b => b.sceneId === sceneId)`, sorted by `sequence` — no hierarchy needed for that requirement either.

### 5.2 Concrete example — 2 scenes, 5 beats

**Scene "Morning Routine"** (sceneId `sc-1`):
- beat `b1` (seq 1): "Establish the kitchen" — `visualTreatment: STILL_IMAGE`, `materialSource: BROLL_LIBRARY` (generic kitchen B-roll, no identity requirement)
- beat `b2` (seq 2): "Nova pours coffee" — `visualTreatment: AI_VIDEO`, `materialSource: GENERATED_NEW` (`motionLevel: MODERATE`, `identityRequirements.characterReferences: ['nova']`) — edge `b1 TRANSITIONS_TO b2`
- beat `b3` (seq 3): "Close-up of Nova's face, thoughtful" — `visualTreatment: STILL_IMAGE`, `materialSource: GENERATED_NEW` — edge `b2 CONTINUITY b3` (same wardrobe/lighting as b2)

**Scene "The Decision"** (sceneId `sc-2`):
- beat `b4` (seq 1): "Timeline chart of the deadline approaching" — `visualTreatment: MOTION_GRAPHIC`, `materialSource: DETERMINISTIC_TEMPLATE` — no identity requirement, no `AI_VIDEO` candidate ever considered (numerical accuracy required, Part 8)
- beat `b5` (seq 2): "Nova reaches for her keys and opens the door" — `visualTreatment: AI_VIDEO`, `materialSource: GENERATED_NEW` (`motionLevel: COMPLEX`, `subjectMotion: "reaches, grips, opens"`), `fallbackStrategy: ['STILL_IMAGE']` — edge `b5 ALTERNATE_OF b5-fallback` (a pre-built still-image beat, never placed unless b5's generation fails) and edge `b3 CONTINUITY b5` (same character identity lock spans the scene boundary)

This is exactly the granularity Part 1's audit shows the existing `keyframe-planner.js` already reasons about per-shot (reusable vs. new vs. already-planned) — the Beat Graph is that same reasoning applied one level closer to the render.

---

## PART 6 — The Material Resolution Engine

### 6.1 Two-phase resolution, not a hardcoded source order

The task is explicit that a fixed priority order ("try existing asset, then B-roll, then generate") is wrong, because *adequacy* depends on the beat, not on a global preference. The resolver therefore works in two phases, mirroring the exact shape `generation-model-registry.js` already uses for model selection (`modelSatisfies` → hard filter, `cheapestSatisfying` → rank survivors by price):

**Phase 1 — Adequacy filter (hard gates, boolean).** A candidate is discarded entirely if it fails any of:
- `motionRequirements.motionLevel` — a `STILL_IMAGE` or `BROLL_CLIP` candidate with no motion is discarded if `motionLevel` is `MODERATE` or `COMPLEX` and the candidate genuinely has none (a B-roll clip that already contains adequate motion still passes)
- `identityRequirements` — a candidate is discarded if it cannot represent the required character/location/prop identities (an unrelated B-roll clip cannot stand in for "Nova"; only `PROJECT_ASSET_REUSE`/`GENERATED_NEW` candidates conditioned on the canonical reference can)
- duration — candidate's natural/available duration must cover `beat.duration` (a 2-second B-roll clip cannot fill a 6-second beat without unacceptable looping/freezing — flagged, not silently stretched)
- resolution/aspect ratio — must meet the project's output settings
- licensing — a `BROLL_LIBRARY` candidate without a clear/usable license is discarded outright, not scored low
- for `GENERATED_NEW` candidates specifically, capability requirements are checked via the **existing** `generation-model-registry.js`'s `modelSatisfies`/`findModelsSatisfying` — reused directly, not reimplemented

**Phase 2 — Weighted ranking (score, among survivors only).**

```
score(candidate) =
    w_semantic   * semanticFit(candidate, beat.visualIntent)
  + w_narrative  * narrativeFit(candidate, beat.narrativePurpose)
  + w_continuity * continuityFit(candidate, beatGraph.edges[CONTINUITY])
  + w_style      * styleFit(candidate, masterCreativeSpec)
  - w_cost       * normalizedCost(candidate)      // 0 for £0 candidates, scaled by
                                                     // registry.observedCost/pricing
                                                     // for GENERATED_NEW ones
  - w_risk       * generationRisk(candidate)        // 0 for existing/B-roll/template
                                                     // (nothing can fail); registry
                                                     // verificationStatus-derived for
                                                     // GENERATED_NEW (CATALOGUE_AVAILABLE
                                                     // scores worse than SAFE_FOR_PRODUCTION)
```

The weights (`w_*`) are not global constants — they are derived per-beat from `beat.costPriority`/`beat.qualityPriority` and from the project's Automation Mode policy (Part 11). A `costPriority: HIGH` beat (narratively critical) down-weights `w_cost` sharply; a `costPriority: LOW` beat (filler/connective) up-weights it. This is exactly how the task's own worked example resolves: a beat where B-roll/still/AI-video are all *adequate* (all pass Phase 1) gets ranked mostly on cost/risk, so B-roll or still wins by default *unless* the beat's `qualityPriority`/narrative weighting says otherwise — never a hardcoded "prefer cheap" or "prefer AI" rule, an actual computed outcome.

### 6.2 Auditability

Every resolution writes `resolutionScore` (the winner's full factor breakdown) and `resolutionAlternatives` (the next 2-3 candidates and why they lost — which gate they failed, or their score) onto the `VisualBeat` record. This is not a UI nicety — it's the same "never a black box, always show your work" principle already enforced everywhere else in this codebase (the Video Prompt Package panel shows verification status/cost tier/observed cost rather than just a model name; the Operator Queue shows *why* a keyframe is blocked, not just that it is). DIRECTOR mode's human-approval screen reads directly from these two fields — no separate explanation-generation step needed.

---

## PART 7 — B-Roll Intelligence

### 7.1 Minimum viable pipeline

```
ingest (upload/import) ──▶ metadata extraction ──▶ scene/shot-boundary detection
    ──▶ segment extraction ──▶ [transcript alignment, if audio has speech]
    ──▶ visual description (one multimodal call PER SEGMENT, not per frame)
    ──▶ tag/keyword index ──▶ beat matching (candidate generation for Phase 1 above)
    ──▶ candidate ranking (Part 6, Phase 2) ──▶ trim/crop ──▶ timeline placement
```

**Ingestion** reuses `asset-storage.js`'s existing discipline exactly: a B-roll source file becomes an `Asset` with `type: 'broll_source'`, content-sniffed (never trusts filename/Content-Type), archived to permanent local storage — the same mechanism already proven for images. A new `BRollSegment` record (below) references that source asset plus an in/out timestamp; the segment, not the whole source file, is what gets matched and placed.

```js
function createBRollSegment(overrides = {}) {
  const base = {
    segmentId: crypto.randomUUID(),
    sourceAssetId: null,       // the ingested Asset (type 'broll_source')
    startTime: null,           // within the source file
    endTime: null,
    description: null,         // one short multimodal-generated description of what's
                                  // visible — the primary searchable text
    tags: [],                  // free-text semantic tags, human- or model-suggested
    transcriptText: null,      // aligned dialogue/narration in this segment, if any
    hasMotion: null,           // boolean — informs Phase 1's motion gate directly
    colourPalette: null,       // optional, coarse (e.g. "warm", "desaturated")
    license: {
      status: 'UNKNOWN',       // 'CLEARED' | 'RESTRICTED' | 'UNKNOWN' — UNKNOWN is a
                                 // hard Phase-1 fail, never silently treated as cleared
      source: null,
      note: null,
    },
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}
```

### 7.2 Do we need embeddings, face detection, shot-boundary ML?

**Minimum viable — yes:**
- **Scene/shot-boundary detection** — a real requirement; without it, "segment extraction" has nothing to key off. A simple frame-difference/histogram-based cut detector (deterministic, cheap, well-understood — this is what `claude-video`'s research below informs) is enough; no ML model required for hard cuts.
- **One structured visual description per segment** (multimodal call) — necessary for semantic search to work at all, and cheap at segment granularity (not per-frame).
- **Tag/keyword search** over `description` + `tags` + `transcriptText` — simple text search (even naive substring/keyword scoring) is sufficient at the scale this MVP needs (a project's own B-roll library, not the open internet).
- **`hasMotion` boolean** — needed directly by Phase 1's motion gate; derivable from the same frame-difference signal used for shot-boundary detection, not a separate system.

**Explicitly deferred — not needed for MVP, would be overengineering now:**
- **Embeddings/vector search** — only pays for itself once a B-roll library is large enough that keyword search misses too much; note it as a drop-in upgrade later (`description` text already exists to embed against; add an `embedding: null` field when it's actually needed, never before).
- **Face/identity detection** — only matters if B-roll might feature recognizable people who need to be matched to project characters, which is out of this MVP's scope (B-roll is generic/environmental material, not a stand-in for a named character).
- **Fine-grained shot-type classification** (wide/medium/close, ML-based) — `description`'s free text already captures this well enough for a human or the resolver's semantic-fit scoring; a dedicated classifier is a later precision upgrade, not a blocker.

---

## PART 8 — Motion Graphics

### 8.1 Deterministic-first principle

Any beat whose content includes numbers, comparisons, dates, or exact text **must** default to `MOTION_GRAPHIC`/`KINETIC_TYPOGRAPHY` candidates being scored, and an `AI_VIDEO` candidate for that same content should be excluded at Phase 1 (not merely scored low) whenever `materialRequirements` marks the content as numerically/textually exact — an AI video model has no mechanism to guarantee a chart shows the right number. This is a Phase-1 hard gate, not a preference.

### 8.2 Schema and taxonomy

```js
const MOTION_GRAPHIC_KINDS = [
  'BAR_CHART', 'LINE_CHART', 'COMPARISON', 'TIMELINE', 'PROCESS_DIAGRAM',
  'FLOW_DIAGRAM', 'MAP', 'STAT_CALLOUT', 'ANNOTATION', 'KINETIC_TEXT',
  'SIMULATION', 'UI_DEMO',
];

function createMotionGraphicSpec(overrides = {}) {
  const base = {
    specId: crypto.randomUUID(),
    kind: null,               // one of MOTION_GRAPHIC_KINDS
    structuredData: {},        // the actual numbers/labels/steps — the source of truth;
                                 // never inferred, always supplied explicitly
    styleRef: null,            // references the project's Master Creative Spec /
                                 // Visual Bible colour/typography rules
    duration: null,
    renderEngine: null,        // 'TEMPLATE_SVG' | 'HYPERFRAMES' | 'FFMPEG_DRAWTEXT' —
                                 // which deterministic renderer produced it
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}
```

`renderEngine` names three tiers deliberately: `FFMPEG_DRAWTEXT` for simple kinetic typography (fast, no extra runtime, matches the existing `ffmpeg-karaoke-animated-text`-style approach), `TEMPLATE_SVG` for charts/diagrams (structured-data-driven, render via a headless SVG→raster/video step), and `HYPERFRAMES` reserved for when the existing `brand-video-editor` skill's already-referenced HyperFrames CLI pipeline is the right tool (complex composited motion graphics) — not a new integration invented from scratch, an explicit slot for the one that already exists as a recommendation in `skill-registry.js`.

### 8.3 Entering the same timeline as everything else

Once rendered, a `MotionGraphicSpec` produces exactly one `Asset` (`type: 'motion_graphic'`), archived through the same `asset-storage.js` mechanism as any image or video. From that point on, it is indistinguishable from an AI-generated video clip or a B-roll segment to the Timeline compiler (Part 10) — same `Asset` shape, same placement logic, same lineage tracking. The only thing that differs is what produced it, which is `resolvedAssetId`'s `materialSource: DETERMINISTIC_TEMPLATE` provenance, already captured on the beat.

---

## PART 9 — Audio

### 9.1 A separate AudioEvent abstraction, referenced by beats — not embedded in them

Attaching audio fields directly to `VisualBeat` was considered and rejected: music and ambient tracks routinely span *many* beats continuously (a music bed under an entire scene, a narration sentence that starts in one beat and finishes in the next), so per-beat audio fields would force either duplicating the same music reference across every overlapping beat (drift risk — which beat is authoritative for the fade curve?) or artificially chopping continuous audio at beat boundaries it has no reason to respect. This also directly extends `production-schema.js`'s existing (currently unused) `project.audio` array — a project-level, timeline-spanning array is already the established shape; `VisualBeat.audioEvents` is a list of *references* into it, mirroring how a beat references `identityRequirements.characterReferences` rather than embedding character data.

```js
const AUDIO_EVENT_TYPES = ['NARRATION', 'MUSIC', 'SFX', 'SILENCE'];

function createAudioEvent(overrides = {}) {
  const base = {
    audioEventId: crypto.randomUUID(),
    type: null, // one of AUDIO_EVENT_TYPES
    startTime: null,
    duration: null,
    sourceAssetId: null,   // a TTS-generated narration clip, a licensed music track, an
                             // SFX clip — same Asset model, type: 'audio'
    scriptRefId: null,      // for NARRATION — which script/narrationSegment this reads
    volume: 1.0,
    duckingTarget: null,    // for MUSIC — the audioEventId (a NARRATION event) it should
                              // duck under, resolved at render time via a volume curve,
                              // never baked into the beat
    fadeIn: null,
    fadeOut: null,
    ...versionFields(),
  };
  return withDefaults(base, overrides);
}
```

Beat-synchronization (a music hit landing on a cut, an SFX landing on an action) is expressed as `audioEvent.startTime` being computed from the *beat's* resolved `startTime` at compile time (Part 10), not stored redundantly on both sides.

---

## PART 10 — Timeline / Assembly

### 10.1 Compile the Beat Graph into the existing Timeline IR — do not invent a second one

`production-schema.js`'s `createTimelineIR()` already declares `scenes`, `shots`, `assets`, `audio`, `transitions`, `outputSettings`, `generations` at the project level. Every one of these except `assets`/`generations` is populated by nothing today (Part 1.2). The new **compile step** is a pure function:

```
compileTimeline(beatGraph, resolvedAssets, audioEvents, motionGraphicAssets)
  → { scenes, shots, assets, audio, transitions, outputSettings }
```

that fills in exactly those existing, currently-empty fields:
- `timeline.shots` — one legacy `Shot`-shaped entry per placed `VisualBeat` (`startTime`/`duration` map directly; `keyframeAssetId`/`videoAssetId` map to `beat.resolvedAssetId`)
- `timeline.assets` — already the shared asset model (Part 1.3); no change needed, beats' resolved assets are already `Asset` records
- `timeline.audio` — the resolved `AudioEvent` list
- `timeline.transitions` — derived from `BeatEdge` records of kind `TRANSITIONS_TO` plus each beat's own `transition` field
- `timeline.outputSettings` — resolution/aspect ratio/fps, taken from the project's Master Creative Spec / Automation Mode policy

This is the single integration point that satisfies "do not create a competing timeline representation" literally: the Beat Graph is the **creative/resolution** layer (exactly where Storyboard already sits above the legacy Timeline IR), and compiling is the **first real use** of fields that have sat empty since Stage 5.

### 10.2 Scale estimate for an ~8-minute video

| Quantity | Estimate | Basis |
|---|---|---|
| Scenes | 15–30 | ~15–35s per scene at typical short-form/explainer pacing |
| Visual beats | 80–160 | ~3–6s average beat duration |
| Generated assets (AI image/video) | 20–60 (≈20–40% of beats) | if cost-aware resolution is working, the *majority* of beats should resolve to reuse/B-roll/motion-graphics, not fresh generation — this ratio is itself a useful health metric to watch in DIRECTOR mode |
| B-roll/existing/motion-graphic assets | 100–140 | the complement of the above |
| Timeline clips (render segments) | 150–300 | beats + inserted transitions |
| Audio events | 40–80 | 1 narration event per beat with dialogue + a handful of continuous music beds + SFX |
| Render complexity | moderate | one FFmpeg filter-graph: concat/xfade over clips (with per-still Ken-Burns pans), multi-track audio mix (narration/music/SFX with ducking), subtitle burn-in. Well within normal FFmpeg capability — the real complexity is orchestrating 150-300 discrete segments and their dependencies, not any single FFmpeg operation |

---

## PART 11 — Automation Modes

All three modes share one hard rule, stated once here because it applies identically to every mode: **no automation mode ever bypasses `approval-gate.js`, the per-action approval stores, or asset/lineage tracking.** "Automatic" only ever means *who* supplies the approval decision and under what pre-agreed policy — never that the decision, the ledger check, or the lineage record stops happening.

| Mode | What the system does | What still requires the existing approval machinery |
|---|---|---|
| **DIRECTOR** | Runs Phase 1+2 resolution for every beat, proposes the winning treatment + `resolutionAlternatives`, does nothing else | A human clicks approve/reject per beat (or per scene, batched) — literally the same REQUEST→APPROVE/REJECT UI pattern already built for keyframe/video generation, scoped to a beat |
| **AUTO** | Resolution + selection happen without a per-beat click, but every `GENERATED_NEW` beat still creates a real approval record (`decidedBy` is a named policy identity, e.g. `"auto-policy:v1"`, not a bypass) and still calls `gate.canProceed`/`gate.reconcileGenerationCost` before any real provider call | Budget ledger and per-action approval records, exactly as today — only the "who clicked approve" identity changes |
| **LOCKED AUTO** | Same as AUTO, plus hard pre-flight constraints (below) become additional Phase-1 gates in the resolver | A beat that cannot satisfy the locked policy (e.g. no B-roll match exists and generating would exceed `maxAiVideoPercentage`) is never silently substituted — it is marked `status: NEEDS_REVIEW` and surfaced, mirroring the existing "never guess, always surface" pattern (unknown-cost acknowledgement, budget overage acknowledgement) |

**LOCKED AUTO policy fields** (project-level, sibling to the existing budget/approval config):

```js
function createAutomationPolicy(overrides = {}) {
  const base = {
    mode: 'DIRECTOR', // 'DIRECTOR' | 'AUTO' | 'LOCKED_AUTO'
    maxBudget: null,            // read by approval-gate.js's existing setBudget — not
                                  // a second budget field
    preferredVisualStyle: null,  // hint into styleFit scoring (Part 6)
    maxAiVideoPercentage: null,  // 0-100, a hard Phase-1 gate once this many beats in
                                  // the current BeatGraph are already AI_VIDEO/GENERATED_NEW
    brollAllowed: true,
    externalFootageAllowed: true,
    motionGraphicsIntensity: 'MEDIUM', // 'LOW' | 'MEDIUM' | 'HIGH' — weights w_style/
                                          // w_narrative toward MOTION_GRAPHIC candidates
    humanReviewPolicy: 'FLAG_LOW_CONFIDENCE', // 'NONE' | 'FLAG_LOW_CONFIDENCE' | 'ALL'
  };
  return withDefaults(base, overrides);
}
```

---

## PART 12 — Cost Optimisation

### 12.1 Live registry data, never a copy

`generation-model-registry.js` already records real observed spend (e.g. Seedance 2.5 at ~100.45 credits, Seedance 1.0 Pro Fast at ~4.5 credits for the tested 5-second generation — cited here only as the concrete numbers already sitting in that file today, exactly the discipline the task itself asks for: **not hardcoded into new logic**). The Material Resolver's cost factor (`normalizedCost` in Part 6.1) calls `generation-model-registry.js`'s existing read functions (`cheapestSatisfying`, `getModel`) at resolution time. If a future stage records a new observation (a different duration, a new model), every beat resolved afterward reflects it automatically — no second cost table, no drift.

### 12.2 How observed cost actually influences treatment, concretely

Reworking the task's own worked example through the two-phase model:

- **Beat: "product sits on a table, static shot."** Phase 1 survivors: `BROLL_CLIP` (generic table shot, £0), `STILL_IMAGE`/`PROJECT_ASSET_REUSE` (£0, if a matching reference exists), `STILL_IMAGE`/`GENERATED_NEW` (~£0.01-class per the registry's cheapest image model), `AI_VIDEO`/`GENERATED_NEW` (~£0.50-class per registry). All four are *adequate* (motion requirement `NONE`). Phase 2 then ranks almost entirely on cost/risk (assuming `costPriority: MEDIUM` or lower) — B-roll or reuse wins by construction, not by a hardcoded rule. `AI_VIDEO` only wins here if `qualityPriority: HIGH` or `styleFit` strongly favors it (e.g. the project's visual language specifically calls for motion everywhere) — a real, inspectable, per-beat decision.
- **Beat: "person turns around and opens a door."** Phase 1 discards every `STILL_IMAGE` and every `BROLL_CLIP` candidate that lacks this *specific* identity+action combination (a generic "someone opens a door" B-roll clip fails the `identityRequirements` gate if the beat needs a project character; it might survive if the beat doesn't). If no adequate `BROLL_LIBRARY`/`PROJECT_ASSET_REUSE` candidate survives, `AI_VIDEO`/`GENERATED_NEW` becomes the *only* surviving candidate — cost is no longer a factor because there is no cheaper adequate alternative, exactly matching the task's stated intent.

This is the whole point of the two-phase design: cost only competes among *equally adequate* candidates, never against inadequate cheap ones.

---

## PART 13 — Video Analysis / QC

### 13.1 Deterministic vs. AI-required, explicitly separated

| Check | Deterministic (FFprobe/file-level) | Requires AI/multimodal |
|---|---|---|
| Duration | ✅ | |
| Resolution / FPS | ✅ | |
| Black frames | ✅ (luma-threshold scan) | |
| Frozen frames | ✅ (frame-diff scan) | |
| Audio presence / clipping / levels | ✅ | |
| Subtitle timing validity (parses, in range) | ✅ | |
| Missing asset / broken reference | ✅ (file existence + lineage check against the Beat Graph) | |
| Scene transition mechanics (cut exists where expected) | ✅ (frame-diff at expected timestamps) | |
| Repeated shot (exact/near-exact duplicate) | ✅ (perceptual hash / frame-diff) | for *semantically* repeated-but-not-identical shots, AI needed |
| Visual/narrative alignment (does the frame show what the script says) | | ✅ |
| Identity consistency across cuts | | ✅ (this reuses the *existing* `identity-consistency-review-store.js` scoring concept, extended from single-image review to a cross-cut comparison) |
| B-roll relevance | | ✅ (compares the placed segment's `description`/`tags` against `beat.visualIntent` — a cheaper, structured version of full multimodal re-inspection, escalating to a real multimodal call only when the structured match is ambiguous) |
| SFX/audio-narrative timing | | ✅ (does the SFX actually land where the action is) |

### 13.2 Design implication

QC is two tiers, run in that order: a **fast deterministic pass** (every render, always, cheap, no AI cost) that blocks obviously-broken output, followed by an **optional multimodal pass** (policy-gated, like everything generation-adjacent — costs real tokens/credits, so it goes through the same approval/budget discipline as any other spend) for the checks that genuinely need judgment. This mirrors `claude-video`'s frame-budgeting instinct directly (see external findings below): never send a multimodal model more material than the specific check requires.

---

## PART 14 — Final Architecture

### 14.1 Diagram

```
Creative Brief ──▶ Script ──▶ Scenes (existing StoryboardScene, unchanged)
                                  │
                                  ▼
                        Storyboard Shots (existing, unchanged)
                                  │
                     ┌────────────┴─────────────┐
                     ▼                            ▼
              Keyframes (existing,          VisualBeats (NEW, Part 4)
              unchanged, still used                │
              for AI-video conditioning)            │
                     │                              ▼
                     │                       Beat Graph (NEW, Part 5)
                     │                              │
                     │                              ▼
                     │                  Material Resolution Engine (NEW, Part 6)
                     │                   ┌──────┬───────┬────────┬─────────┐
                     │                   ▼      ▼       ▼        ▼         ▼
                     │            existing  B-roll  motion   AI still  AI video
                     │             asset    library graphic  (existing (existing
                     │             reuse   (NEW,7)  (NEW,8)  keyframe  video
                     │                                        pipeline) pipeline)
                     └───────────────────────┬──────────────────────────┘
                                              ▼
                                   resolved Asset records
                                   (existing asset-storage.js — unchanged)
                                              │
                          Audio Events (NEW, Part 9) ──┐
                                              │          │
                                              ▼          ▼
                                 Timeline Compiler (NEW, Part 10)
                                              │
                                              ▼
                     Timeline IR (existing production-schema.js — FINALLY populated)
                                              │
                                              ▼
                                  Render Pipeline (NEW — FFmpeg)
                                              │
                                              ▼
                              Automated QC (NEW, Part 13, two-tier)
                                              │
                                              ▼
                                        Final MP4
```

### 14.2 Reuse map (summary of Part 1.3)

| Reused as-is | New, additive |
|---|---|
| Storyboard scenes/shots, Visual Bible, canonical-reference selection | VisualBeat, BeatGraph, BeatEdge |
| Keyframe/KeyframePromptPackage/VideoPromptPackage pipeline (unchanged — still how a beat's `AI_VIDEO`/`GENERATED_NEW` candidate actually gets made) | MaterialResolver service |
| `generation-model-registry.js` (capability filtering, cost data) | BRollSegment + B-roll ingestion/indexing services |
| `approval-gate.js` budget ledger | MotionGraphicSpec + deterministic render service |
| Approval-store pattern (request→approve/reject) | AudioEvent schema + audio mixing service |
| `asset-storage.js`/`asset-archive-service.js` | Timeline Compiler |
| Operator Queue pattern (derived, read-only) | Render pipeline (FFmpeg orchestration) |
| Timeline IR (`production-schema.js`) — schema exists, now gets populated | Two-tier QC pipeline |
| MCP tool / REST 1:1 module pattern | Beat Queue (Operator-Queue-style, beat-scoped) |

### 14.3 Proposed file structure (additive only — nothing existing moves)

```
server/
  schemas/
    visual-beat-schema.js          # createVisualBeat, VISUAL_TREATMENTS, MATERIAL_SOURCES
    beat-graph-schema.js           # createBeatGraph, createBeatEdge
    broll-schema.js                # createBRollSegment
    motion-graphic-schema.js       # createMotionGraphicSpec, MOTION_GRAPHIC_KINDS
    audio-schema.js                # createAudioEvent, AUDIO_EVENT_TYPES
    automation-policy-schema.js    # createAutomationPolicy
  services/
    beat-graph-service.js          # CRUD + staleness, mirrors keyframe-store.js
    material-resolver-service.js   # the two-phase engine, Part 6
    broll-ingestion-service.js     # ingest → scene-detect → segment → describe → index
    broll-index-service.js         # search/candidate-generation over BRollSegment
    motion-graphic-render-service.js
    audio-service.js               # AudioEvent CRUD + TTS/music/SFX provider adapters
    timeline-compiler-service.js   # Part 10.1's compile function
    render-service.js              # FFmpeg orchestration
    qc-service.js                  # two-tier QC, Part 13
  mcp/tools/
    beat-tools.js, broll-tools.js, motion-graphic-tools.js, audio-tools.js,
    render-tools.js, qc-tools.js   # one module per new subsystem, matching the
                                      # existing 19-module 1:1 convention
```

---

## PART 15 — Implementation Plan

Each stage is additive, independently testable, and does not touch the proven generation control plane. No stage below makes a real provider call or spends credits unless explicitly marked.

| Stage | Objective | Files | Schemas | Services | Tests | UI | Real API calls? | Credits at risk? | Est. completion |
|---|---|---|---|---|---|---|---|---|---|
| **26.1** | VisualBeat + BeatGraph schemas only | `visual-beat-schema.js`, `beat-graph-schema.js` | new | none yet | schema unit tests (defaults, `withDefaults` behavior) | none | No | No | schema layer only |
| **26.2** | BeatGraph store + derive beats from existing StoryboardShots (a mechanical "one beat per shot" default, human-editable after) | `beat-graph-service.js` | uses 26.1 | `beat-graph-service.js` (CRUD, mirrors `keyframe-store.js`) | store unit tests | none | No | No | data layer |
| **26.3** | Material Resolver, Phase 1 only (hard gates), against existing project assets + registry — no B-roll/motion-graphics yet | `material-resolver-service.js` | none new | resolver reads `generation-model-registry.js`, `creative-store.js` | resolver unit tests with fixture beats | none | No | No | core logic, image/video candidates only |
| **26.4** | Material Resolver, Phase 2 (scoring) + MCP/REST read-only endpoints to inspect a resolution | none new | none | extend 26.3 | scoring unit tests | REST endpoints only | No | No | resolver complete for existing-asset/AI candidates |
| **26.5** | Beat Graph UI (Creative Director tab, read + basic edit, mirrors Keyframe Plan panel) | `frontend/app.js` (additive section) | — | — | frontend safety tests (no hidden generate button, same discipline as existing sections) | new Beat Graph panel | No | No | first UI surface |
| **26.6** | B-roll ingestion + scene-detection + segment extraction (deterministic only, no multimodal description yet) | `broll-schema.js`, `broll-ingestion-service.js` | new | new | fixture-video tests (small local test clips) | upload control, mirrors Reference Library's upload pattern | No | No | B-roll data layer |
| **26.7** | B-roll visual description (multimodal) + tag index + resolver integration as a real Phase-1 candidate source | `broll-index-service.js` | — | extend 26.6 | mocked-multimodal tests first; **ONE real multimodal call only with explicit human approval**, mirroring Stage 25's "one real call, no retry" discipline | search/browse UI | **Yes, gated** — one real multimodal inspection call, explicitly approved | Minimal (text/vision inspection, not generation) | B-roll fully wired |
| **26.8** | Motion Graphics: schema + deterministic template renderer (charts/kinetic typography only, `FFMPEG_DRAWTEXT`/`TEMPLATE_SVG` tiers) | `motion-graphic-schema.js`, `motion-graphic-render-service.js` | new | new | render-output tests (does the file exist, right duration) | basic authoring UI | No | No | first genuinely new render output |
| **26.9** | Audio: schema + TTS integration for narration (provider TBD, own investigation stage first) | `audio-schema.js`, `audio-service.js` | new | new | mocked-provider tests | narration authoring UI | **Yes, gated, own future investigation+approval stage** | Yes (TTS is a real spend) | audio layer, narration only |
| **26.10** | Timeline Compiler: BeatGraph + resolved assets + audio → populate existing `production-schema.js` Timeline IR fields | `timeline-compiler-service.js` | none new (fills existing fields) | new | compile-output tests against fixture beat graphs | "Compile Timeline" action, read-only preview | No | No | first end-to-end structural output |
| **26.11** | Render Pipeline: FFmpeg orchestration from the compiled Timeline IR to a real MP4, no audio mixing yet (video-only) | `render-service.js` | none new | new | render tests against tiny fixture clips (a few seconds, local test assets only) | render trigger + progress | No (local FFmpeg, no provider) | No | first real MP4 output |
| **26.12** | Full render: audio mixing, subtitles, transitions | extend 26.11 | none new | extend | full-pipeline fixture test (one short synthetic project, entirely local assets) | final render UI | No | No | complete render pipeline |
| **26.13** | QC: deterministic tier | `qc-service.js` | none new | new | QC-check unit tests against known-good/known-bad fixture videos | QC report panel | No | No | tier 1 QC |
| **26.14** | QC: multimodal tier (visual/narrative alignment, identity consistency) | extend `qc-service.js` | none new | extend | mocked first; then **gated real calls**, same "one call, explicit approval" discipline | QC report panel, tier 2 | **Yes, gated** | Yes (multimodal inspection) | tier 2 QC |
| **26.15** | Automation Modes: DIRECTOR wired end-to-end (the only mode built first — AUTO/LOCKED_AUTO are later stages, deliberately, since they're policy on top of a DIRECTOR pipeline that must already work) | `automation-policy-schema.js` | new | policy checks wired into resolver | policy unit tests | mode selector UI | No | No | DIRECTOR mode MVP-complete |

**Stop condition for every stage above**: full existing test suite still passes, the real smoke-test project (`EVOLINK LIVE SMOKE TEST`) is byte-identical, and no stage after 26.1 removes or renames anything in `production-schema.js`, `approval-gate.js`, `generation-model-registry.js`, or `operator-queue-service.js` — only additive fields/files. AUTO and LOCKED_AUTO modes are explicitly out of scope until DIRECTOR mode has been used on at least one real project end-to-end, mirroring exactly how this entire codebase has always proven each layer manually before automating it.

---

## EXTERNAL REPOSITORY FINDINGS

Researched via GitHub repo pages, READMEs, and raw source files (`raw.githubusercontent.com`) for each repo's key modules. All three URLs resolve to real, matching repositories — no 404s or mismatches to report. Every claim below is labeled `[SOURCE-DERIVED FACT]` (read directly in their code/docs), `[INFERENCE]` (reasoned from partial evidence), or `[RECOMMENDATION]` (this document's own judgment on what EVOLINK should do about it).

### harry0703/MoneyPrinterTurbo

**What it is.** [SOURCE-DERIVED FACT] A Python stock-footage compositing tool (WebUI/API/CLI), not a generation tool for its visual layer — no AI image or video generation provider is wired in anywhere.

**Orchestration.** [SOURCE-DERIVED FACT] `task.py`'s `_run_pipeline()` runs 7 steps in strict, mostly-synchronous sequence (script → search terms → TTS → subtitles → material acquisition → composition → publish), tracked by a coarse progress percentage against a Redis/in-memory state store — one failure state, not per-shot state. A `stop_at` parameter allows early exit after any of steps 1–5, returning partial artifacts for review.

**Script/story decomposition.** [SOURCE-DERIVED FACT] Deliberately shallow: one LLM call returns 1–10 unstructured prose paragraphs. There is no scene/shot/beat schema at all. [INFERENCE] This flat model is the single largest structural gap versus EVOLINK's script→scenes→beats requirement.

**Visual planning / B-roll.** [SOURCE-DERIVED FACT] A single LLM call takes the *entire script* and returns 1–3 word search terms (default 5), used directly against Pexels/Pixabay/Coverr, each with its own bespoke match logic (exact-resolution, min-width, aspect-flag) rather than one scoring abstraction. 24h result caching, MD5-hash download dedup. An optional TwelveLabs integration reranks candidates semantically (Marengo) and does post-hoc relevance QA (Pegasus) — both true no-ops when disabled.

**Rendering.** [SOURCE-DERIVED FACT] MoviePy per-clip preprocessing, then a **single FFmpeg concat pass** to avoid cumulative re-encode loss — directly reusable regardless of source material type. Disciplined resource cleanup (`ExitStack`, explicit `close_clip()`), hardware-encoder detection with `libx264` fallback.

**Audio.** [SOURCE-DERIVED FACT] Voice/BGM mixed at **fixed levels — no dynamic ducking**, an explicit, acknowledged gap. Seven TTS providers with graceful per-subsystem degradation (BGM failure → proceed without music), but **no cross-provider fallback for the script-generation LLM call itself** — a single point of failure.

**Subtitles.** [SOURCE-DERIVED FACT] Faster-Whisper, word-level timestamps, plus a Levenshtein-similarity re-alignment pass against the original script (a lightweight forced-alignment substitute). Plain SRT only.

**Fragility at 8 minutes.** [INFERENCE] The flat script model and whole-script material matching cannot express "beat 14 needs different material than beat 3"; B-roll-not-found falls back to looping existing clips (`itertools.cycle`) rather than substituting a different material type, which would visibly repeat across an 8-minute video.

**Do not copy:** the flat unsegmented script; whole-script-to-five-terms matching; fixed-level audio mixing with no ducking; no LLM-provider fallback on the script step.

**Worth reusing conceptually:** single-pass concat-after-preprocess rendering; the `stop_at` partial-result pattern for review checkpoints; fully no-op-when-disabled optional AI enrichment (the TwelveLabs pattern).

### Pluviobyte/rnskill

**What it is.** [SOURCE-DERIVED FACT] Fundamentally different in kind from the other two: a library of 55+ Claude Code/Codex Agent Skills (`SKILL.md` prompt packages, primarily Chinese short-form-video workflows), not a coded pipeline — orchestration happens via an LLM agent interpreting and delegating between skills at runtime, not a deterministic state machine.

**Orchestration.** [SOURCE-DERIVED FACT] `ra-video-wash-pipeline` is a delegation orchestrator: intake/dedup-check → transcript extraction (internal-only, deleted after use — an explicit copyright guardrail) → script rewrite (its own 5-skill sub-chain) → a markdown "production contract" with YAML-frontmatter status, written to a ledger, **stopping by default** → video production, only on an explicit "ship directly" instruction. State is encoded as a `status:` frontmatter field plus folder placement — a filesystem-encoded state machine, unusual but auditable.

**Visual planning — the most directly relevant finding across all three repos.** [SOURCE-DERIVED FACT] `ra-video-production-director` builds an explicit **per-beat "production note" that locks the visual-layer choice before any generation happens** — footage vs. a branded illustration system vs. a specific looped background asset vs. component-level motion graphics, chosen by content type, explicitly framed as "select the narrowest specialized workflow rather than forcing one broad path." This is architecturally the closest existing analog anywhere in the three repos to EVOLINK's Material Resolution Engine (Part 6).

**Motion graphics.** [SOURCE-DERIVED FACT] The most motion-graphics-native of the three: component animation (title → eyebrow → illustration → bullets) sequenced against **word-level timestamps**, not scene midpoints — a materially tighter sync model than time-block timing. A canonical reusable background asset has defined "grid integrity" QC (phase continuity, preserved whitespace).

**Audio.** [SOURCE-DERIVED FACT] TTS provenance is a hard QC gate: the final narration must match a specific locked voice ID and SHA-256-hashed canonical WAV; **any fallback blocks archival outright** — the opposite philosophy from MoneyPrinterTurbo's graceful degradation.

**QC — the strongest of the three repos.** [SOURCE-DERIVED FACT] Before archival: media-spec checks, a **contact-sheet frame review** for layout (title breaks, caption clearance, no overlap), caption-timing-source-and-coverage gates (≥0.90 coverage, must be word-timestamp-sourced not estimated), the voice-provenance gate above, and "semantic cue" checks (named entities/numbers must render on-screen synced to when they're spoken). A cheap 10-second sample render is generated for approval *before* committing to the full render — a fail-fast cost gate.

**Fragility at 8 minutes.** [INFERENCE] Orchestration entirely via natural-language prompts interpreted by an LLM agent risks drift (skipped steps, mis-sequenced gates) on a long, many-scene job in a way coded state machines don't; 5-level skill-delegation chains observed would multiply LLM-inference cost/latency at scale.

**Do not copy:** natural-language-prompt orchestration as the mechanism for EVOLINK's core deterministic pipeline (right tool for a human-supervised creator tool, wrong tool for an unattended production backend) — extract its QC gates and visual-mapping *concepts* into real schema/code instead.

**Worth reusing conceptually:** the per-beat production-note-before-build pattern (directly informs Part 6's design above); word-timestamp-driven graphic sequencing (informs Part 9); the hard multi-dimensional QC gate list, including fail-closed-on-fallback (informs Part 13); the cheap-sample-before-full-render checkpoint.

### bradautomates/claude-video — studied in depth per the task's instruction

**What it is.** [SOURCE-DERIVED FACT] A video-*understanding* Claude Code skill (`/watch`), not a production tool — no rendering, TTS, or B-roll search. It extracts frames + transcript and hands them to the *calling agent's own* multimodal reading; it never calls a vision API itself. Closest of the three to EVOLINK's material-inspection/QC problem, not to script→render.

**Caption-first processing.** [SOURCE-DERIVED FACT] Concretely: if `detail == transcript` and captions already exist and no explicit timestamps were requested, the tool **skips downloading the video entirely**, fetching only metadata+captions via yt-dlp's `--skip-download`. Only a timestamp request or a higher detail mode triggers an actual video download. Caption-first means "check whether text alone answers the need, and only pay the download/frame-extraction cost if it doesn't" — not merely a processing order.

**yt-dlp integration.** [SOURCE-DERIVED FACT] Used two ways: cheap caption-only fetch, and full video/audio ingestion (capped `≤720p`, `-N 8` parallel connections) as the frame-extraction/Whisper-fallback source. This is the ingestion layer for *existing published video* across 500+ sites; yt-dlp's exit code is tolerated as non-fatal as long as a file actually lands.

**Frame extraction — interval-based AND scene-change-triggered, hierarchically combined.** [SOURCE-DERIVED FACT] *Efficient* mode decodes only I-frames (`-skip_frame nokey`, near-zero decode cost), falling back to uniform sampling below 4 keyframes. *Balanced/token-burner* modes use FFmpeg's `scene` filter (fixed threshold **0.20**) with `showinfo` timestamp parsing, falling back to uniform sampling below 8 detected shots (static/talking-head content). All modes hard-cap at **2 fps**.

**Detail modes — exact names: `transcript` / `efficient` / `balanced` / `token-burner`.** [SOURCE-DERIVED FACT] `transcript` (0 frames, text-only, often skips download entirely) → `efficient` (I-frames only, 50-frame cap, 512px) → `balanced`, the default (scene-aware, 100-frame cap) → `token-burner` (scene-aware, uncapped but warns past 250 frames). Resolution is a separate, independent budget knob (default 512px; raise to 1024 only for on-screen text).

**Frame budgeting.** [SOURCE-DERIVED FACT] Hard, enforced caps by duration (≤30s→12–30 frames, ... >10min→sparse-with-warning) and a denser curve for focused `--start`/`--end` windows. Enforcement: compute target fps, then evenly thin any excess (always keeping first/last frame) and delete the excluded files from disk.

**Frame deduplication.** [SOURCE-DERIVED FACT] On by default: each kept frame is downscaled to a 16×16 grayscale thumbnail; a mean-pixel-delta ≤2.0 against the previous kept frame drops the new one. Cheap and streaming, not a real perceptual-hash/embedding model — deliberately proportionate to the job.

**Timestamp targeting.** [SOURCE-DERIVED FACT] `--timestamps 4:32,7:10,...` reserves exact-moment "cue frames" **against the budget before** scene/keyframe/uniform selection fills the rest — guaranteeing user-specified moments survive even a tight cap. The documented best-practice workflow is a genuinely clever two-pass pattern: run `transcript` mode first (cheap), scan the text for deictic cues ("look here," "as you can see"), then re-run with `--timestamps` targeting exactly those moments — a cheap pass informing a minimal targeted expensive pass.

**Transcript/frame alignment.** [SOURCE-DERIVED FACT] Both streams share absolute source-video timestamps as the join key; there is **no programmatic alignment algorithm** — correlation is left entirely to the consuming agent's judgment when it reads both. [INFERENCE] Fine for interactive Q&A, too weak a foundation for a deterministic automated QC gate as-is.

**Long-video handling.** [SOURCE-DERIVED FACT] No chunking or hierarchical summarization exists; the tool's own docs admit degraded accuracy past 10 minutes and steer users toward manual re-invocation on specific windows. [INFERENCE] An 8-minute EVOLINK video sits right at the edge of this tool's comfortable envelope as-is — EVOLINK would need real automatic windowing, not the manual-per-window pattern this repo uses.

**Multimodal inspection.** [SOURCE-DERIVED FACT] No vision-API call inside the tool at all — it produces well-chosen JPEGs plus aligned transcript text and lets the host agent's native image-reading do the interpretation. [RECOMMENDATION] Worth taking seriously for EVOLINK's QC step if QC already runs inside/alongside a capable multimodal agent session — a dedicated separate vision-API call may be redundant cost.

**Temporary media management.** [SOURCE-DERIVED FACT] `tempfile.mkdtemp()`, no automatic cleanup — the skill instructs the calling agent to `rm -rf` when done. No cross-run cache; every invocation re-fetches captions fresh. [SOURCE-DERIVED FACT] This is stated explicitly as a limitation the tool accepts for an interactive, human-supervised context.

**Do not copy:** the fixed 0.20 scene-change threshold without validating against EVOLINK's own material (AI-generated/stylized video may not match talking-head-tutorial statistics it was tuned on); the no-cleanup/no-cache temp-file lifecycle for anything unattended; manual per-window re-invocation as the long-video strategy — EVOLINK needs real automatic chunking.

**Worth reusing conceptually — directly informs Part 7 and Part 13 above:** the cheap-pass-informs-expensive-pass workflow; the reserved-budget-for-must-have-frames model; tiered, named, user-facing cost/quality modes; threshold-triggered automatic fallback to a simpler method rather than hard failure; cheap perceptual-delta deduplication over a full embedding model.

### Synthesis — what actually shaped this document's design

Five patterns, converging independently across the three repos, were load-bearing in Parts 4–13 above, not just noted for color:

1. **Lock the visual-layer decision per beat before generation, via an explicit routing step** (rnskill) — this *is* Part 6's two-phase Material Resolver, not a coincidence.
2. **The audio/text clock is the source of truth for sync, not scene midpoints** (rnskill's word-timestamp graphics, claude-video's transcript-timestamp alignment) — reflected in Part 9's `AudioEvent`-references-not-embedded-fields design and Part 4's `narrationSegment` field.
3. **Cheap-pass-informs-expensive-pass** (claude-video) — directly shaped Part 13's two-tier QC design (deterministic pass always, multimodal pass only when needed/ambiguous).
4. **Reserve budget for must-have items, rank the remainder within a cap** (claude-video's cue-frame reservation) — the same principle as `beat.costPriority`/`beat.fallbackStrategy` in Part 4 and the resolver's hard-gate-then-rank structure in Part 6.
5. **Fail-closed on unexpected fallback for anything provenance-sensitive; fail-open (graceful degradation) for everything else** (rnskill's TTS-voice gate vs. MoneyPrinterTurbo's BGM handling) — reflected in Part 11's Automation Modes: a `LOCKED_AUTO` beat that can't satisfy policy is flagged for review, never silently substituted.

What was deliberately *not* carried forward: any flat/unsegmented script model, natural-language-prompt orchestration as EVOLINK's core execution mechanism, fixed-level audio mixing without ducking, and any long-video strategy that depends on a human manually re-invoking a tool per time-window.

---

## Final Summary

### A. What we should build

The nine genuinely new subsystems from Part 14.3: `VisualBeat`/`BeatGraph` schemas, the Material Resolution Engine (two-phase: hard-gate filter, then weighted rank), B-roll ingestion/indexing, deterministic Motion Graphics rendering, an `AudioEvent` abstraction referenced by beats, a Timeline Compiler that populates the *existing* (currently empty) Timeline IR fields, an FFmpeg render service, a two-tier (deterministic + gated-multimodal) QC pipeline, and DIRECTOR-mode automation wired end-to-end first. Build in the order laid out in Part 15 — schema and resolver logic (26.1–26.4) fully before any real spend, B-roll and motion graphics (26.6–26.8) before audio/render (26.9–26.12), QC last (26.13–26.14), AUTO/LOCKED_AUTO modes only after DIRECTOR mode has proven itself on one real project end-to-end.

### B. What we should NOT build

A second timeline system, a second asset model, a second approval/budget ledger, or a second queue — Part 1.3's reuse map is binding. Not a natural-language-prompt-orchestrated pipeline (rnskill's mechanism, wrong tool for an unattended backend). Not a flat/unsegmented script→visuals mapping (MoneyPrinterTurbo's core weakness). Not fixed-level audio mixing without ducking. Not vector embeddings, face/identity detection, or fine-grained ML shot classification for B-roll at this scale (Part 7.2 — explicitly deferred, not needed). Not a dedicated vision-API call for QC if a capable multimodal agent session is already available to read frames directly (claude-video's pattern, worth taking seriously before building a redundant call). Not AUTO or LOCKED_AUTO automation before DIRECTOR mode is proven.

### C. What we should reuse

Everything in Part 1.3's reuse map, unconditionally: Storyboard scenes/shots and Visual Bible (unchanged), the entire keyframe→KeyframePromptPackage→VideoPromptPackage pipeline (unchanged — still exactly how a beat's `AI_VIDEO`/`GENERATED_NEW` candidate gets made), `generation-model-registry.js`'s capability-filtering and cost functions (`findModelsSatisfying`, `cheapestSatisfying`, `validateModelSelection` — called directly by the new Material Resolver, not reimplemented), `approval-gate.js`'s one budget ledger, the request→approve/reject approval-store pattern, `asset-storage.js`/`asset-archive-service.js` (a B-roll clip or a rendered motion graphic is just a new `Asset.type` value through the same pipeline), the Operator-Queue pattern (derived, read-only, recomputed — never a second source of truth), and the 19-module MCP-tool-mirrors-REST convention.

### D. The first implementation stage

**Stage 26.1**: `visual-beat-schema.js` and `beat-graph-schema.js` only — plain object factories (`createVisualBeat`, `createBeatGraph`, `createBeatEdge`), the `VISUAL_TREATMENTS`/`MATERIAL_SOURCES` two-axis enums from Part 4.3, reusing `versionFields()` exactly as every other creative artifact does. No service, no store, no UI, no REST/MCP route, no real API call, no credits at risk. Tests are schema-shape unit tests only (defaults, `withDefaults` override behavior) — the same pattern every prior schema file in this codebase was tested with on its own first stage.

### E. Decisions requiring your approval

1. **The two-axis treatment taxonomy** (`visualTreatment` × `materialSource`, Part 4.3) replacing the task's flat 7-value list — confirm this refinement before it becomes the schema's actual shape in Stage 26.1, since every later stage builds on it.
2. **Where the Beat Graph sits relative to Storyboard Shots** (Part 4.1: shot → 1..N beats, mirroring shot → 1..N keyframes) versus an alternative where beats replace shots outright for the new pipeline — this document assumes shots stay as the creative-planning layer and beats are the new production layer beneath them; confirm before Stage 26.2 builds the shot→beat derivation.
3. **Compiling into the existing (dormant) Timeline IR fields** (Part 10.1) rather than introducing a new top-level `project.visualBeats`/`project.timeline` — this is the literal mechanism satisfying "don't build a second timeline system," so worth an explicit sign-off given how much later work depends on it.
4. **B-roll licensing posture** (Part 7.1's `license.status` field, `UNKNOWN` as a hard Phase-1 fail) — confirm this is strict enough (or too strict) for your actual sourcing plans before Stage 26.6 builds ingestion around it.
5. **Which TTS/music/multimodal-QC providers to integrate** — Part 9 and Part 13.14 deliberately left provider selection as "its own future investigation stage," matching how EvoLink itself was chosen only after Stage 15/16's dedicated investigation — confirm you want a separate investigation stage for these before Stage 26.9/26.14 rather than picking providers now.
6. **DIRECTOR-only first, AUTO/LOCKED_AUTO deliberately deferred** (Part 15's Stage 26.15 note) — confirm this sequencing matches your priorities, since it means no unattended automation exists until quite late in the plan.

STOP.
