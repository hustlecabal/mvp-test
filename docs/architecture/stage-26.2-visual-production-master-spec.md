# Stage 26.2 — Visual Production Master Specification

**Status: ARCHITECTURE SYNTHESIS / SPECIFICATION ONLY.** No production code, schema, service, UI, or `server/data` changes were made while writing this document. No provider/API calls were made. No credits were spent. No dependencies were installed. Baseline verified before writing: branch `claude/evolink-video-factory-mvp-b4oo5i`, clean `git status`, full suite 1175/1175 passing, real smoke-test project data untouched, `EVOLINK_API_KEY` not required for (and not used during) this stage.

This document supersedes nothing already committed. It **extends** `docs/architecture/stage-26-visual-production-director-investigation.md` (Stage 26's investigation) with the deeper external-repository research, the Director/Mode/Style layer, Whiteboard and Still-Image-Motion treatments, and the long-form (8–20 minute) production model the earlier document deferred. Two pieces of Stage 26's plan are **no longer hypothetical** — they exist in the repository today:

- **Stage 26.1** (commit `4095042`): `schemas/visual-beat-schema.js`, `schemas/beat-graph-schema.js` — the `VisualBeat`/`BeatGraph`/`BeatEdge` schemas, the two-axis `VISUAL_TREATMENTS` × `MATERIAL_SOURCES` taxonomy, multi-material `materials[]` support.
- **Stage 26.2 (implementation, separate from this document)** (commit `e4a6ab5`): `services/material-resolution-service.js` — the first real, tested vertical slice of the Material Resolution Engine, covering exactly one `materialSource` (`PROJECT_ASSET_REUSE`) end-to-end into the legacy Timeline IR (`timelineStore.addShot`).

Everywhere this document says "already built," it means those two commits, on this branch, verified by the 1175-test suite. Everywhere it says "specified, not built," it means exactly that — a target for a future implementation stage, not a claim about the current codebase.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Existing Architecture Map](#2-existing-architecture-map)
3. [External Repository Findings](#3-external-repository-findings)
4. [What We Borrow / What We Reject](#4-what-we-borrow--what-we-reject)
5. [Director Architecture](#5-director-architecture)
6. [Director Modes](#6-director-modes)
7. [VisualBeat / BeatGraph Integration](#7-visualbeat--beatgraph-integration)
8. [Material Resolution Engine](#8-material-resolution-engine)
9. [B-Roll Architecture](#9-b-roll-architecture)
10. [Motion Graphics Architecture](#10-motion-graphics-architecture)
11. [Whiteboard Architecture](#11-whiteboard-architecture)
12. [Still-Image Motion](#12-still-image-motion)
13. [AI Video Strategy](#13-ai-video-strategy)
14. [Hybrid Material Composition](#14-hybrid-material-composition)
15. [Audio-First Timing](#15-audio-first-timing)
16. [Timeline Compiler](#16-timeline-compiler)
17. [Scene-Level Rendering](#17-scene-level-rendering)
18. [FFmpeg Architecture](#18-ffmpeg-architecture)
19. [Audio Architecture](#19-audio-architecture)
20. [Cost Engine](#20-cost-engine)
21. [Approval Model](#21-approval-model)
22. [Automation Modes](#22-automation-modes)
23. [QC Architecture](#23-qc-architecture)
24. [Failure / Recovery](#24-failure--recovery)
25. [8–20 Minute Production Model](#25-8-20-minute-production-model)
26. [Style System](#26-style-system)
27. [Proposed Future Implementation Stages](#27-proposed-future-implementation-stages)
28. [Explicit Non-Goals](#28-explicit-non-goals)
29. [Risks](#29-risks)
30. [Decisions Requiring Human Approval](#30-decisions-requiring-human-approval)

---

## 1. Executive Summary

EVOLINK is being repositioned from **"an AI video generator"** to **a cost-aware AI video production system**, governed by one sentence that this whole document exists to make concrete: *AI designs the video; deterministic systems execute as much of the visual production as possible.* AI generation — image or video — is one asset-production capability among several, selected only when nothing cheaper, safer, or more controllable can satisfy a beat's actual creative requirement.

The system is organized into three layers:

- **Layer 1 — Intelligence**: an LLM Director that reads a Creative Brief and produces narrative, dialogue/narration, visual intent, timing, and — critically — *decisions about when AI generation is actually justified*, not just what to generate.
- **Layer 2 — Assets**: resolution of that intent into concrete material — reused project assets, B-roll, generated stills, generated video, motion graphics, whiteboard scenes, charts, SFX, music — via a single deterministic Material Resolution Engine.
- **Layer 3 — Motion / Execution**: deterministic rendering (SVG/HTML/CSS/GSAP/HyperFrames/FFmpeg) does the actual work of making a static asset move, composing multiple materials, and assembling the timeline. AI-generated video is the *exception path* inside this layer, invoked only when deterministic motion genuinely cannot achieve the required visual.

Two commits already exist on this branch that instantiate the first slice of Layers 1→2: `VisualBeat`/`BeatGraph` (the Director's structured output — Stage 26.1) and a Material Resolution Engine that can already resolve a beat to an existing project asset and place it on the real, existing Timeline IR (Stage 26.2 implementation). Nothing in this document proposes replacing either. Everything in this document proposes *extending* the same two artifacts — more `materialSource` values, more treatments, an audio-first timing model, a style system, scene-level long-form rendering — while reusing, without exception, EVOLINK's existing asset model, approval/budget ledger, generation registry, and Operator Queue pattern.

Six external repositories were studied for architectural ideas, never for code: `hbg-life-simulation` (long-form, audio-first, scene-level rendering), `director` (creative modes, shot planning, production orchestration), `srt-whiteboard-animation` (subtitle-driven drawing sequences), `MoneyPrinterTurbo` (automated stock-footage assembly), `rnskill` (a large library of production "skills"), and `claude-video` (caption-first, frame-budgeted video understanding). Findings are in Section 3; what is adopted vs. rejected, including explicit conflict resolutions against EVOLINK's existing architecture, is in Section 4.

The headline number driving the Cost Engine (Section 20) is not invented: EVOLINK's own `generation-model-registry.js` already records a real observed 22× cost spread between two video models tested on identical parameters — `doubao-seedance-1.0-pro-fast` at **4.5 credits** vs. `seedance-2.5-text-to-video` at **100.45 credits**, both for a 5s/720p/adaptive generation. A system that treats "call an AI video model" as its default action is, by this project's own historical data, choosing the expensive tail by default. The architecture in this document exists to make that the last resort, not the default.

---

## 2. Existing Architecture Map

This is a verified inventory of the current repository (re-confirmed by direct file inspection for this document, not carried over unchecked from Stage 26's audit).

### 2.1 Schemas (`server/schemas/`)

| File | Owns |
|---|---|
| `creative-schema.js` | Creative Brief, Master Creative Spec (`coreConcept`/`tone`/`pacing`/`visualLanguage`/`cinematography`/`colourLanguage`/`motionRules`/`compositionRules`/... — see Section 26), Visual Bible (Character/Location/Prop, each with entity-level canonical-reference selection), Storyboard (Scene/Shot, `SHOT_PLANNING_STATUSES`) |
| `keyframe-schema.js` | Keyframe Plan, `FRAME_TYPES`, per-keyframe canonical-asset selection + staleness tracking |
| `keyframe-prompt-schema.js` | KeyframePromptPackage (identity/wardrobe/environment locks → structured prompt) |
| `video-prompt-schema.js` | VideoPromptPackage (canonical approved image + provider/model + execution params → video generation request) |
| `keyframe-generation-approval-schema.js`, `video-generation-approval-schema.js` | REQUEST→APPROVE/REJECT approval records, unknown-cost acknowledgement |
| `keyframe-execution-result-schema.js`, `video-generation-result-schema.js` | normalized `BLOCKED/IN_PROGRESS/COMPLETED/FAILED` (or `PLANNED/GENERATING/GENERATED/APPROVED/REJECTED`) result shapes — **our own vocabulary, never a passthrough of a provider's raw status** |
| `identity-consistency-review-schema.js` | scored human review of a generated asset against a reference (read-only observation, never touches `approvalStatus`) |
| `keyframe-handoff-schema.js` | human-execution handoff records (Stage 13D) |
| `operator-queue-schema.js` | `QUEUE_CATEGORIES`, `QUEUE_STATUSES = ['NEEDS_ATTENTION','BLOCKED','IN_PROGRESS','COMPLETE']`, `REFERENCE_STATUSES`, `VIDEO_STATUSES` (including `VIDEO_FAILED`, `VIDEO_REJECTED`) |
| `production-schema.js` | **Timeline IR** (`createTimelineIR`: `scenes`, `shots`, `assets`, `audio`, `transitions`, `outputSettings`, `generations`), `ASSET_TYPES = ['character_reference','location_reference','keyframe','video']` (exactly four values today — no `broll`/`motion_graphic`/`audio` yet), `GENERATION_TYPES = ['VIDEO','IMAGE_KEYFRAME','KEYFRAME']`, `defaultAssetStorage()`, `createNextAssetVersion` |
| `state-machine.js` | project-level lifecycle state machine |
| `visual-beat-schema.js` **(Stage 26.1, built)** | `VISUAL_TREATMENTS`, `MATERIAL_SOURCES`, `MOTION_LEVELS`, `COST_PRIORITIES`, `QUALITY_PRIORITIES`, `LICENSING_STATUSES`, `MATERIAL_ROLES`, `BEAT_STATUSES`, `createVisualBeat`, `createMaterialComponent`, `createIdentityRequirements`, `createNarrationSegment`, `createGenerationRequirement` |
| `beat-graph-schema.js` **(Stage 26.1, built)** | `BEAT_EDGE_KINDS = ['CONTINUITY','DEPENDS_ON','ALTERNATE_OF','TRANSITIONS_TO']`, `createBeatGraph`, `createBeatEdge` |

### 2.2 Services (`server/services/`)

| File | Owns |
|---|---|
| `project-store.js` | the one project-record store every other store reads through |
| `creative-store.js` | Storyboard/Visual Bible CRUD, reference-role metadata |
| `keyframe-store.js`, `keyframe-planner.js`, `keyframe-prompt-service.js` | Keyframe Plan CRUD, staleness, prompt-package resolution |
| `reference-library-service.js` | reference-asset ingestion, human approve/reject, canonical selection |
| `identity-consistency-review-store.js` | scored review records |
| `image-generation-executor.js`, `keyframe-generation-service.js` | image generation lifecycle |
| `video-prompt-service.js`, `video-generation-service.js` | video generation lifecycle |
| `generation-service.js` | the **original, MCP-only, legacy** project-level generation path (own `project.approvals`/`project.creditLedger`) — never touched by the current UI, still functional |
| `generation-model-registry.js` | **the single source of truth for every image/video model** — capabilities, `verificationStatus`, `productionReady`, `pricing`, `costTier` (`BUDGET/STANDARD/QUALITY/OTHER`), `observedCost`/`observedCostBasis`; exports `findModelsSatisfying`, `cheapestSatisfying`, `validateModelSelection` |
| `generation-poller.js`, `generation-store.js`, `generation-history-service.js` | job polling, job records, historical reporting |
| `evolink-reference-resolver.js` | resolves a reference asset into a URL a provider call can use |
| `approval-gate.js` | **the one and only credit ledger** — `setBudget`, `getRemainingBudget`, `reconcileGenerationCost`, `canProceed`, `acknowledgeOverage`, `acknowledgeUnknownCost` |
| `asset-storage.js`, `asset-archive-service.js` | permanent local media storage, magic-byte content sniffing (never trusts filename/Content-Type) |
| `timeline-store.js` | Timeline IR scene/shot/asset CRUD (`addScene`, `addShot`, `addAsset`, `listAssets`, `updateAssetStorage`, `setAssetApprovalStatus`, `findAssetById`) |
| `operator-queue-service.js` | derived, read-only, per-keyframe production status view, recomputed from the stores above — never a second source of truth |
| `skill-registry.js`, `skill-orchestrator.js`, `skill-adapters/` | a static catalogue of Claude-skill workflows (role `SPECIALIST`/`EDITOR`), each with `generationRisk: NONE` or `INDIRECT_GATED` — **skills only ever recommend; nothing here is executed by EVOLINK's own code** (see Section 5.3 for why this matters to Director Modes) |
| `material-resolution-service.js` **(built, Stage 26.2 implementation)** | `resolveVisualBeat(projectId, beat)` — pure/read-only, two-phase (`evaluateEligibility` gate, `scoreCandidate` rank), currently implements exactly `PROJECT_ASSET_REUSE`; `toTimelineShotFields(beat, resolution)` — Timeline IR adapter, proven via a real `timelineStore.addShot()` round-trip in tests |

### 2.3 Governance

Confirmed by direct inspection: `approval-gate.js` is called by **both** the legacy (`generation-service.js`) and current (`keyframe-generation-service.js`/`video-generation-service.js`) pipelines. There is exactly one budget ledger in the codebase. The Operator Queue (`operator-queue-service.js`) is derived and read-only — it is recomputed from `timelineStore`/`keyframeStore`/the approval stores on every read, never itself persisted as a competing source of truth.

### 2.4 What does NOT exist today (re-confirmed by grep for this document)

- No FFmpeg (`server/package.json` has exactly three dependencies: `@modelcontextprotocol/sdk`, `express`, `zod`).
- No audio/TTS/music/SFX infrastructure.
- No subtitle/`.srt`/`.vtt` infrastructure.
- No render pipeline of any kind — the only "render" concept in the codebase is `skill-registry.js`'s `brand-video-editor` entry, a **recommendation record** for an external, human-run HyperFrames workflow; EVOLINK's own code never executes it.
- No B-roll / stock-footage concept.
- No whiteboard concept.
- No motion-graphics concept.
- No video-analysis / self-QC concept.
- `ASSET_TYPES` has exactly four values — no `broll`, `motion_graphic`, `whiteboard_scene`, or `audio` type exists yet.

This is the honest floor this document builds from: **the proven part of EVOLINK stops at "one approved keyframe or video asset per shot."** Everything from "assemble many beats into one MP4" onward — for any duration, any style, any treatment mix — is new territory, exactly as Stage 26's investigation already established. Nothing found while re-verifying this map for the present document contradicts that conclusion.

---

## 3. External Repository Findings

*[This section is populated verbatim from a dedicated research pass over the six repositories below, run in parallel with this document's internal-architecture drafting. Each finding is the research agent's own direct reading of the repository's README/source, not this document's paraphrase-of-a-paraphrase. Labels `[SOURCE-DERIVED FACT]` / `[INFERENCE]` / `[RECOMMENDATION]` are preserved from the research pass, matching the discipline Stage 26's own external-repo section used.]*

All six repositories were reachable as real, matching public GitHub repos — no 404s or mismatches. One scope correction up front: **`bradautomates/claude-video` is not a video-production tool.** It is the `/watch` Agent Skill — a video-*analysis*/comprehension tool (frame extraction + transcription so an LLM can answer questions about an *existing* video). It contributes no assembly/rendering/timeline architecture; its value to this document is narrowly as a QC/verification pattern (Section 3.6).

### 3.1 Mr-funny/hbg-life-simulation

**A. What it does exceptionally well.** A fully-specified Agent Skill for producing long-form (8–20+ min) narrative videos with a consistent protagonist. It defines a hard **storyboard-density formula** (`ceil(bodyDuration / 6.5)` stills, valid range `bodyDuration/8` to `bodyDuration/5`), enforced hold-time bounds (4–8s target, 8–12s acceptable, 12s mandatory-split, 16s hard defect), an 11-point pre-delivery QA checklist (density audit, caption-semantics audit, `verify_final_video.sh`, `hyperframes check --strict`), and two render transports — a normal chunked HyperFrames path and a disk-constrained **streaming FFmpeg fallback** that renders/concatenates per-still without materializing the full timeline in memory.

**B. Concept worth borrowing.** **Audio-first / VTT-as-master-timeline**: narration is generated once as one continuous TTS asset; the real VTT cue timestamps become the source of truth, and scene/caption/chapter boundaries are *derived* from those cues rather than computed by evenly dividing total duration. Paired with the storyboard-density formula, this is the concrete mechanism that lets video length scale without scaling generation-call count proportionally (Section 3.7's synthesis works through exactly how).

**C. What NOT to copy.** It is single-domain (one fixed protagonist archetype, one motion vocabulary — zoom 1.00→1.10-1.13, pan ≤4% — one 2×2-sheet compositing convention); the *density formula* and *QA-gate structure* generalize, the specific motion/genre choices do not. It is locked to HyperFrames + FFmpeg + Edge-TTS + a local CLIProxyAPI OAuth flow — don't inherit the CLIProxyAPI dependency. Camera motion is **entirely static-image Ken-Burns simulation**, never true generated motion — an excellent cheap fallback tier (Section 12), never a substitute for a shot that genuinely needs motion. It does not demonstrate parallel/independent scene rendering as separate jobs — only a streaming-transport optimization, not the `SceneRenderRecord`-per-scene independence Section 17 specifies.

**D. Layer.** **Timeline / Orchestration** primarily (the density formula and audio-first timing are Timeline-layer concerns); strong secondary contribution to **QC** (the audit-script checklist) and **Audio** (VTT-driven timing).

**E. Licensing.** MIT (confirmed, LICENSE file). Freely inspirable and even directly reusable in derivation, with attribution — the cleanest license posture of the six.

### 3.2 s1dashu/director

**A. What it does exceptionally well.** Cleanly decomposes production into three named, distinct **creative modes**, each its own end-to-end workflow under `modes/{animated-explainer,cinematic-drama,storytime-animation}/` — an explicit statement that different creative intents need different pipelines, not one generic script-to-video flow with a style flag.

**B. Concept worth borrowing.** **Mode-as-pipeline-selector**: mode is chosen *before* script/shot planning and changes the entire downstream sequence. Cinematic Drama specifically: script confirmation → **fixed-duration (15-second) segment breakdown** → visual-style lock → **character cards with per-character voice design, bound before any media-generation call** → prop/setting references → media-matrix generation → representative-segment confirmation → full production. Identity/voice lock as its own pre-generation pipeline stage (not an inline prompt detail) is the transferable idea.

**C. What NOT to copy.** Only 3 modes exist, specified at README/prose level with no algorithmic shot-planning code shown — treat as naming/structure inspiration, not a reference implementation. Locked to LibTV CLI/Jimeng CLI (vendor-specific, non-portable). No QC or failure-recovery mechanism at all — a gap EVOLINK must not inherit.

**D. Layer.** **Intelligence** primarily (mode selection + script-to-shot-plan reasoning), bridging into **Timeline** (15-second segment breakdown) and touching **Asset Resolution** (character-card/voice binding pre-generation).

**E. Licensing.** MIT. Safe to be inspired by the mode taxonomy and pipeline shape; little verbatim code of consequence exists to copy (mostly SKILL.md prose).

**Deep-dive — Director Modes evidence.** The repo evidences **exactly three modes**: Animated Explainer, Storytime Animation, Cinematic Drama (confirmed via the `modes/` directory listing — no others exist). **There is no evidence anywhere in this repo for Documentary, Whiteboard, Social Short, or Code Explainer** — those four, if adopted, are EVOLINK inventions informed by genre convention, not repo-attested patterns. This directly resolves Section 6.2's open question: the candidate table there should be read as three repo-evidenced modes plus four EVOLINK-original ones, not seven modes of equal evidentiary weight. Character consistency in this repo is handled by a manual reference-image "character card" discipline, not an algorithmic consistency system — i.e., architecturally identical in spirit to EVOLINK's own existing canonical-reference-asset mechanism, not a new idea.

### 3.3 geeklee/srt-whiteboard-animation

**A. What it does exceptionally well.** A genuine, self-contained **procedural drawing-animation renderer** (OpenCV-based: adaptive thresholding → grid-block clustering or Zhang-Suen skeleton thinning for stroke paths → contour-wipe fill or brush-stamp paint-in) that simulates a hand drawing a static line-art illustration stroke by stroke — not a wrapper around an external animation API.

**B. Concept worth borrowing.** The **`annotation.json` region-and-reveal schema**: each drawable element carries a bounding `region`, `reveal.startMs`/`durationMs` (timed against narration), a `protectedRegions` list (prevents premature overlap of not-yet-revealed adjacent content), and a `subtitle` field quoting the exact narration line the element illustrates. This is a precise, reusable data structure for **sequencing partial-asset reveals against an audio timeline** — directly informs `WhiteboardScene.drawingOrder` (Section 11.2) and generalizes well beyond whiteboard drawing to any staged reveal of layered elements timed to narration (motion-graphic overlay sequencing, Section 10; lower-thirds; progressive composition).

**C. What NOT to copy.** Niche single-aesthetic renderer (whiteboard-ink look only) — the drawing algorithm itself is not core infrastructure, only the reveal-scheduling data model is. Confirmation-heavy, single-operator workflow (browser preview + manual region adjustment before render) — fine for a boutique tool, too manual as EVOLINK's default path. No stated failure-recovery or QC beyond visual preview.

**D. Layer.** **Motion-Rendering**, with the `annotation.json` reveal-scheduling fields belonging conceptually to **Timeline** even though the renderer itself sits in Motion-Rendering.

**E. Licensing.** MIT (confirmed, LICENSE file). Safe to adapt the schema and even reference the OpenCV technique directly.

**Deep-dive — SRT-to-drawing granularity, concretely.** Pipeline: SRT parsed into **25–35 second scene chunks** (a scene spans multiple subtitle lines, not one line per scene) → one unified-style line-art illustration produced per scene → `annotation.json` maps individual drawn elements *within that one scene image* to specific subtitle spans (each element's `subtitle` field quotes its narration line), each with its own reveal timing/direction/hand-path → browser preview for manual adjustment → per-scene MP4 render with streaming ink-then-color effect → scenes concatenated into the final video. Worked example from the repo: a "Monkey Mountain Banana Snatch" scene has four elements (a rockery/setting, a small monkey/subject, a large monkey stealing fruit/action, observing children/reaction), each keyed to its own line of dialogue, revealed in narrative order as that line plays — this is the exact granularity Section 11.3's wallet/£100/arrow/£80 worked example already mirrors.

### 3.4 harry0703/MoneyPrinterTurbo

**A. What it does exceptionally well.** A mature, actively-maintained full-stack pipeline (FastAPI + Streamlit + CLI + REST): topic → script (pluggable LLM) → stock-footage search (Pexels/Pixabay/Coverr, keyword-derived) → TTS narration (7 providers) → captions (fast TTS-timestamp OR precise Whisper-transcription, an explicit cost/quality choice) → FFmpeg composition → optional auto-publish. Provider config for every stage (LLM/TTS/stock source) sits behind one `config.toml`, decoupled from pipeline logic.

**B. Concept worth borrowing.** The **provider-abstraction layer** itself — fixed pipeline stages, freely swappable providers per stage, one config surface — and the **dual caption-generation strategy** (fast/cheap vs. slow/precise) exposed as an explicit operator-facing tradeoff, not a hidden default.

**C. What NOT to copy — this is the repo most directly opposite EVOLINK's stated goal.** Fully-automated, keyword-matched stock-footage selection with **no human-in-the-loop approval gates between any stage**, no per-shot cost accounting, no material provenance/rights tracking beyond "free stock site," no shot list/storyboard/scene graph at all — clip duration is decided per script segment against auto-picked stock, not deliberate shot creation. This is a volume strategy (batch-generate many, keep the good ones), the precise opposite of the deliberate, auditable, budget-tracked production this document specifies. Fixed-level audio mixing with **no dynamic ducking** is an explicit, acknowledged gap in the tool itself.

**D. Layer.** **Orchestration** (the pipeline shape and provider-abstraction pattern) primarily; illustrative-but-too-simple examples of **Asset Resolution** (stock keyword-match) and **Audio** (TTS integration, no ducking).

**E. Licensing.** MIT (confirmed). Fully permits architectural inspiration and direct reuse of the provider-abstraction pattern. Note: the tool itself does not track stock-media licensing/attribution — that remains the operator's responsibility, a gap EVOLINK's own `BRollSegment.licensingStatus` (Section 9.2) is explicitly designed to close.

### 3.5 Pluviobyte/rnskill

**A. What it does exceptionally well.** A large (55-skill) catalog of narrow, composable Agent Skills, each self-contained under `skills/<name>/SKILL.md`, organized into clear functional categories: planning, script, voiceover/TTS, digital avatar, editing, subtitles, visual design, image composition, **production management** (`ra-video-production-director`, explicitly described as orchestrating downstream skills and managing state/QC), and **motion/animation QC** (`rn-replica-qc`, "five-tier fidelity verification"). The closest of the six repos to a real skill taxonomy for a multi-stage production system.

**B. Concept worth borrowing.** The **uniform SKILL.md contract**: every skill, regardless of whether its backend is an LLM prompt, a wrapped CLI, or a compositing script, exposes the same shape — trigger phrases, explicit input parameters, an ordered workflow-stage list, non-negotiable style/output constraints, and an explicit quality-checkpoint list before output. A provider-neutral capability envelope, in the same spirit EVOLINK's own `skill-registry.js` already uses at much smaller scale (Section 5.3) — this is independent convergent validation of that existing design, not a new idea to import.

**C. What NOT to copy — real licensing caution, not just a style note.** The bulk of the catalog (22 of 55 skills, the "dbs" toolkit) is **CC BY-NC 4.0** (non-commercial), credited to a third party. **This subset must not be copied — not even paraphrased prompt text — into a commercial EVOLINK deployment without separate clearance.** Read for pattern inspiration only. Many skills are tightly bound to specific Chinese platforms/vendors (Douyin/Xiaohongshu extraction, HeyGen, IndexTTS2, Doubao-ASR) — the pattern generalizes, the integrations don't. The catalog has no runtime/execution engine — it's a prompt-contract layer for an LLM agent to interpret, not a working programmatic API; fine as an Intelligence-layer pattern, not to be mistaken for orchestration infrastructure.

**D. Layer.** Spans multiple layers by design — the strongest evidence across all six repos for a genuine **cross-layer skill taxonomy**. Best classified as **Orchestration** (the SKILL.md contract itself, plus the explicit state/QC-managing `ra-video-production-director` orchestrator skill), with individual skills mapping to every other layer.

**E. Licensing.** Repo root: **CC BY-NC 4.0** for original content; third-party subsets carry their own licenses (MIT/Apache-2.0/AGPL-3.0/CC BY-NC per the README's attribution list). **The one repo in this set requiring an explicit non-commercial-use caution** — flagged again in Section 4/29 so it is not accidentally lost.

**Deep-dive — skill-category mapping.** A skill's contract (trigger → parameters → staged workflow → constraints → quality checkpoints → output) is provider-neutral by construction — the implementation underneath can be an LLM call, a script, or a wrapped third-party API interchangeably. Direct mapping onto the categories this document's Section 5.3/27 need: `ra-video-production-director` ≈ a **Director skill** (orchestration/state/QC); `rn-motion-director`/`rn-motion-replica` ≈ **Renderer skills** (motion planning against constraints); `rn-replica-qc` and the quality-checkpoint convention embedded in every skill ≈ **QC skills**; `ra-video-download`/transcript-extraction skills ≈ **asset-ingestion skills**; `rn-cover-skill`/compositing skills ≈ **Material Resolver-adjacent skills** (resolving a brief into concrete visual assets). The pattern is genuinely reusable; the specific 55 skills mostly are not (platform/language/licensing bound, per C above).

### 3.6 bradautomates/claude-video

**Scope correction, restated:** this is a video-*analysis* tool (the `/watch` skill), not a production tool — no rendering, TTS, B-roll search, or timeline construction exists in it. It is included for its QC-relevant ingestion technique only.

**A. What it does exceptionally well.** A token-budget-aware ingestion pipeline for turning existing video into LLM-consumable evidence: prefers free native captions over paid transcription (checks for existing captions first, only falls back to Whisper-via-API when absent), offers four explicit **detail modes** trading extraction cost against coverage (`transcript` ~4.5s/zero image tokens, `efficient` 50-frame cap, `balanced` 100-frame scene-aware default, `token-burner` uncapped), and runs automatic near-duplicate frame deduplication (16×16 thumbnail mean-pixel-delta) to avoid spending tokens on static/paused footage.

**B. Concept worth borrowing.** A **cost-tiered detail-mode selector with published, measured cost/latency-per-mode benchmarks** — an explicit, benchmarked "how much do you want to spend for how much fidelity" menu a caller picks per task. Directly transferable to EVOLINK's QC Tier 2 (Section 23): a "cheap skim" vs. "thorough frame-by-frame" verification-pass choice with a known cost each, rather than one fixed, unexamined multimodal-inspection cost.

**C. What NOT to copy.** Do not mistake this for production/orchestration architecture — its "orchestration" is a linear ingestion-then-analysis script with no timeline construction, asset resolution, or rendering concept anywhere in it. Its frame-dedup/sampling logic is tuned for *analysis* (minimizing redundant frames sent to an LLM for Q&A) — directly reusable for EVOLINK's QC layer specifically, not a general-purpose technique to generalize further.

**D. Layer.** **QC** — a candidate mechanism for automated final-render verification (feed the rendered output back through frame-sampling + transcript analysis for an LLM defect check), genuinely useful to Section 23 even though the repo's own purpose is general video Q&A, not production QA.

**E. Licensing.** MIT (confirmed). Safe to adapt its detail-mode tiering and frame-dedup approach directly for a QC ingestion step.

### 3.7 Synthesis — how audio-first + formula-driven timing answers the 30s–20+min scaling question

This is the single most load-bearing finding across all six repos for this document's core cost claim (Section 25). The mechanism, concretely, from `hbg-life-simulation`'s worked pattern:

1. Narration is generated **once**, as one continuous audio asset, regardless of target video length — this cost scales with *word count*, not with visual-asset count.
2. Real VTT cue timestamps become the timing source of truth (Section 15's audio-first principle, independently convergent with this repo's own design).
3. Audio duration converts to a **still/shot count via a duration-based formula** with an enforced per-shot hold-time floor (this repo: ~4–8s target hold, 16s hard max) — so generation-call count scales with `duration / avg_hold_time`, a far shallower slope than one AI-video call per second of footage.
4. **Static-image-plus-deterministic-camera-motion** (Section 12's Ken Burns family) is the default motion strategy for the majority of holds — zero additional AI calls — reserving true `GENERATED_NEW`/`AI_VIDEO` calls only for beats that specifically require motion camera simulation cannot provide.
5. Multiple low-risk beats can be batched into a single generation call via sheet compositing when they share character/setting, further reducing call count (a technique this document does not adopt verbatim but notes as a possible future cost-optimization, Section 27).
6. A streaming/incremental render fallback keeps render-time and disk cost roughly linear rather than requiring the entire timeline to be materialized in memory for long videos (informs Section 17/18's scene-level, not whole-video, rendering discipline).

Net effect, in the source repo's own terms: a 20-minute video needs on the order of 150–200 still/generation calls (their own guidance: ~125–165 stills for 14–15 minutes) rather than the ~1,200 individual AI-video clips a naive "one generation call per few seconds of footage" approach would require. **The AI-video-generation budget scales with narrative beat count, not with raw seconds of footage** — the gap is made up by cheap deterministic camera simulation and audio-driven timing, not by additional model calls. This is the empirical grounding behind Section 25's illustrative distribution table and Section 25.4's scaling claim.

### 3.8 Ranked highest-value ideas and explicitly-rejected patterns (research pass's own synthesis, adopted)

**Highest-value, ranked:**
1. Audio-first timeline derivation + duration-driven asset-count formula (`hbg-life-simulation`) — directly answers the non-proportional-scaling requirement (3.7 above).
2. Uniform skill-contract envelope + orchestrator/QC/ingestion skill taxonomy (`rnskill`) — validates and extends EVOLINK's existing `skill-registry.js` design (Section 5.3).
3. Region + reveal-window + protected-region data structure for staged reveals against narration timing (`srt-whiteboard-animation`'s `annotation.json`) — directly informs `WhiteboardScene` (Section 11) and generalizes to motion-graphic overlay sequencing (Section 10).
4. Mode-as-pipeline-selector with a pre-generation identity/voice-lock stage (`director`) — directly informs Director Modes (Section 6) and the ordering of Section 21's approval points.
5. Tiered cost/detail selector with published per-mode benchmarks, applied to QC (`claude-video`) — directly informs Section 23's Tier 2 design.

**Explicitly rejected, and why:**
- Fully-automated, no-human-gate, keyword-matched stock assembly (`MoneyPrinterTurbo`'s core loop) — architecturally opposite EVOLINK's stated goal; no per-asset cost accounting or approval gates at all.
- CC BY-NC-licensed content treated as free architectural raw material (`rnskill`'s 22-skill "dbs" toolkit) — safe to read, unsafe to copy into a commercial deployment.
- Static-image-plus-camera-simulation as the *only* motion strategy (`hbg-life-simulation`'s Ken-Burns default) — an excellent economical fallback tier (Section 12), never the sole or default motion-rendering approach; must coexist with deliberately-selected true generated motion.
- Treating a video-*analysis* tool's linear ingestion script as a production-orchestration reference (`claude-video`) — its real value to this document is narrowly the QC/detail-mode idea (3.6/23), not pipeline shape.

---

## 4. What We Borrow / What We Reject

The governing principle, stated once because every row below is an application of it: **EVOLINK's already-proven, already-tested, already-committed mechanisms — the one budget ledger, the one asset model, the one Timeline IR, the deterministic REQUEST→APPROVE/REJECT approval pattern — win every conflict against an external repo's alternative mechanism for the same concern.** External repos contribute **techniques and structures for problems EVOLINK does not yet solve** (B-roll indexing, whiteboard drawing order, frame budgeting, word-level audio sync, duration-driven asset counts), never replacements for problems it already solves.

### 4.1 What we borrow

| From | Concept | Lands in |
|---|---|---|
| `hbg-life-simulation` | Audio-first / VTT-as-master-timeline; duration-driven asset-count formula; static-image-plus-camera-simulation as a cheap default motion tier; scene-level/streaming render discipline | Section 15 (Audio-First Timing), Section 25 (8–20 Minute Model), Section 12 (Still-Image Motion), Section 17 (Scene-Level Rendering) |
| `hbg-life-simulation` | 11-point pre-delivery QA checklist structure (density audit, caption-semantics audit, strict final-video verification) | Section 23 (QC Architecture) — as a concrete precedent for what a Tier-1 structural checklist should actually enumerate |
| `director` (s1dashu) | Mode-as-pipeline-selector, chosen before shot planning; pre-generation identity/voice-lock stage; fixed-duration segment breakdown | Section 6 (Director Modes), Section 21 (Approval Model's ordering) |
| `srt-whiteboard-animation` | Region + reveal-window + protected-region schema for staged element reveals timed to narration | Section 11.2 (`WhiteboardScene.drawingOrder`), generalized into Section 10 (Motion Graphics overlay sequencing) |
| `MoneyPrinterTurbo` | Provider-abstraction pattern (fixed pipeline stage, swappable provider per stage, one config surface); dual-strategy cost/quality tradeoff exposed explicitly to the operator; single-pass concat-after-preprocess rendering | Section 19.2 (Audio provider neutrality), Section 18 (FFmpeg — single concat pass), Section 23 (QC's cost/quality tier framing) |
| `rnskill` | Uniform skill-contract envelope (trigger → parameters → staged workflow → constraints → quality checkpoints → output); an explicit orchestrator-skill role that manages state/QC across subordinate skills | Section 5.3 (validates EVOLINK's existing `skill-registry.js` design at larger scale — not a new mechanism, confirmation of the current one) |
| `claude-video` | Tiered cost/detail selector with published per-mode cost benchmarks | Section 23.2 (QC Tier 2's "how much to spend to verify how thoroughly" framing) |

### 4.2 What we reject, and the explicit conflict resolution against EVOLINK's existing architecture

| Conflict | External repo's approach | EVOLINK's existing/specified approach | Resolution and why |
|---|---|---|---|
| Core execution mechanism | `rnskill`: natural-language-prompt orchestration, an LLM agent interpreting and delegating between skills at runtime, state encoded as filesystem/frontmatter | `approval-gate.js` + deterministic REQUEST→APPROVE/REJECT stores + `operator-queue-service.js`'s derived-view pattern — a coded, auditable state machine | **EVOLINK's mechanism wins for the unattended production backend.** Natural-language orchestration is the right tool for a human-supervised creator tool (which is what `rnskill` actually is) and the wrong tool for a budget-tracked, auditable, unattended pipeline — it risks skipped steps and mis-sequenced gates at the scale (80-300+ beats) Section 25 targets. `rnskill`'s skill-*contract shape* is still adopted (4.1); its *orchestration mechanism* is not. |
| Script/visual structure | `MoneyPrinterTurbo`: one LLM call returns 1–10 unstructured prose paragraphs, no scene/shot/beat schema at all | Storyboard → Shot → `VisualBeat`/`BeatGraph`, fully structured, already built (Stage 26.1) | **EVOLINK's structured hierarchy wins outright.** A flat/unsegmented script cannot express "beat 14 needs different material than beat 3," which is the entire premise of the Material Resolution Engine (Section 8). This is rejected without qualification, not partially adopted. |
| Audio mixing | `MoneyPrinterTurbo`: voice/BGM mixed at fixed levels, no dynamic ducking (an explicit, acknowledged gap in the source repo) | `AudioEvent.duckingTarget` as a first-class structural field (Section 19.3) | **Reject fixed-level mixing.** Ducking is specified as a schema-level concern from the start, not left as a later mixing-stage afterthought. |
| Failure/fallback philosophy | `MoneyPrinterTurbo`: graceful degradation everywhere (BGM failure → proceed without music) **vs.** `rnskill`: fail-closed on any fallback for provenance-sensitive material (TTS voice must match a locked, hashed canonical WAV; any fallback blocks archival outright) | Neither uniformly — see resolution | **Both are right, for different material.** EVOLINK differentiates by provenance-sensitivity: fail-closed (rnskill's posture) for anything identity/continuity-critical (a character's locked voice, canonical visual identity — Section 24.2's restated discipline); fail-open/flagged-for-review (MoneyPrinterTurbo's posture, but surfaced rather than silent) for generic, non-identity material (BGM, generic B-roll). This is not a compromise between the two repos' philosophies, it's recognizing they were each solving a narrower problem than EVOLINK's — restated concretely in Section 24. |
| QC's relationship to a multimodal call | `claude-video`: no dedicated vision-API call at all — produces frames + transcript and lets the *calling agent's own* multimodal reading interpret them, informally | Section 23's Tier 2: an explicit, policy-gated, budget-tracked multimodal call through the same approval mechanism as any other spend | **EVOLINK's gated-call approach wins for the QC gate itself** — an implicit "whatever agent happens to be present interprets it" pattern is not a deterministic, budgeted, repeatable production QC gate. `claude-video`'s *ingestion technique* (caption-first, frame budgeting, dedup, tiered cost) is still adopted (4.1) as the implementation approach *inside* that gated call — the conflict is about whether the call is explicit and accounted for, not about the technique used once it happens. |
| Motion-generation default | `hbg-life-simulation`: static-image-plus-camera-simulation for effectively every hold in its genre | Section 13's Phase-1/Phase-2 resolver: AI video selected only when Phase 1 proves nothing cheaper is adequate | **No conflict in principle, a scope caution in practice.** EVOLINK adopts the *technique* (Section 12) but not as the sole/default strategy for every beat regardless of adequacy — a beat whose `motionRequirements.motionLevel` is `COMPLEX` must still be able to reach `AI_VIDEO`, which `hbg-life-simulation`'s single-genre design never needed to prove. |
| Licensing posture for borrowed material | `rnskill`'s "dbs" toolkit (22/55 skills): CC BY-NC 4.0, non-commercial | EVOLINK is (implicitly) a commercial internal tool | **Hard rejection of verbatim reuse.** No prompt text, SKILL.md content, or structured data from that specific subset may be copied into EVOLINK, even paraphrased — only the general *pattern* (already MIT/architecture-idea territory, not the specific expression) is adopted. Flagged again in Section 29 (Risks) so it isn't lost downstream. |

### 4.3 What we reuse from EVOLINK's own existing architecture, unconditionally

Restated from Section 2, because Section 3's external research changed none of it: Storyboard scenes/shots and Visual Bible (unchanged), the entire keyframe→KeyframePromptPackage→VideoPromptPackage pipeline (unchanged), `generation-model-registry.js`'s capability-filtering and cost functions (called directly, never reimplemented), `approval-gate.js`'s one budget ledger, the REQUEST→APPROVE/REJECT approval-store pattern, `asset-storage.js`/`asset-archive-service.js`, the Operator-Queue pattern (derived, read-only, recomputed), the 19-module MCP-tool-mirrors-REST convention, and — newly confirmed by `rnskill`'s independent convergence (4.1) — the existing `skill-registry.js`/`skill-orchestrator.js` recommend-only discipline.

---

## 5. Director Architecture

### 5.1 What the Director is, structurally

The **Director** is Layer 1. It is not a new always-on service or agent loop — it is the name for the (LLM-assisted, human-supervised) process that turns a Creative Brief into a populated `BeatGraph`. Concretely, running the Director means producing, in order:

1. A **Storyboard** (already exists — `creative-schema.js`'s scenes/shots — unchanged).
2. A **BeatGraph** (exists as a schema — `beat-graph-schema.js` — unpopulated by any automated process yet) with one or more `VisualBeat`s per shot, each carrying:
   - `narrativePurpose`, `visualIntent` (why this beat exists, what it must communicate)
   - `narrationSegment` (the audio-first timing anchor — Section 15)
   - a *proposed* `visualTreatment` (the Director's opinion, not a locked decision — Material Resolution, Layer 2, has the final say per beat, informed by but never overridden by the Director's proposal alone)
   - `motionRequirements`, `identityRequirements`, `continuityRequirements`, `costPriority`, `qualityPriority`, `fallbackStrategy` — all fields the schema already defines and already reserves exactly for this purpose (Stage 26.1)
3. `BeatEdge`s expressing continuity/dependency/fallback/transition relationships between beats (already schema-defined).

The Director's job explicitly **includes deciding when AI generation is justified** — that is not a downstream resolver concern alone. `costPriority`/`qualityPriority`/`fallbackStrategy` are the Director's mechanism for expressing that judgment structurally, so the Material Resolution Engine (Section 8) can weigh it without the Director having to hardcode a treatment.

### 5.2 What the Director is NOT

- Not a second timeline, a second asset store, or a second approval system. The Director's only durable output is a `BeatGraph` (plus, indirectly, `Storyboard`/`Keyframe Plan` edits it may also propose through the existing, unchanged Creative Director surfaces).
- Not an autonomous unattended loop by default. DIRECTOR mode (Section 22) is explicitly the mode where every irreversible/costly step still routes through a human, exactly like every generation call in EVOLINK does today.
- Not a replacement for the existing Creative Brief / Master Creative Spec / Visual Bible authoring flow — the Director consumes those, it does not re-invent them.

### 5.3 Where "skills" fit — and where they explicitly do not

EVOLINK already has a skill concept (`skill-registry.js`/`skill-orchestrator.js`): a static catalogue of Claude Agent Skills, each classified by `role` (`SPECIALIST`/`EDITOR`), `generationRisk` (`NONE`/`INDIRECT_GATED`), and whether an `adapter` exists to actually invoke it. The **hard rule already enforced since Stage 12** is that this system only ever *recommends* — it never executes a skill's output as a side-effecting action inside EVOLINK's own code. `rnskill`'s far larger skill library (Section 3) is architecturally the same *kind* of thing at a much larger scale, and its most interesting concept (an explicit per-beat "production note that locks the visual-layer choice before generation," see Section 3/4) maps directly onto the Material Resolution Engine's resolution plan — not onto a second skill system. The Director should be able to **recommend** a matching skill (e.g., "this beat's Whiteboard treatment matches the `srt-whiteboard-animation`-style workflow") the same way `skill-registry.js` already recommends `brand-video-editor` today — a pointer for a human, never an autonomous execution path.

---

## 6. Director Modes

### 6.1 What a "mode" is and is not

A Director Mode is a **named policy bundle**, not a separate code path. It sets defaults for the same fields the Director already produces on every `VisualBeat` — it never introduces a beat field that only exists under one mode, and it never bypasses Material Resolution's own per-beat adequacy judgment. Concretely, a mode is a project-level (or per-scene-override) record, sibling to the Automation Policy already specified in Stage 26's investigation:

```
DirectorMode
  id                     — e.g. "ANIMATED_EXPLAINER" (an open string set, see 6.3, not a
                            closed architectural enum — new modes must be addable without
                            a schema migration)
  defaultVisualTreatmentBias   — which VISUAL_TREATMENTS the resolver's scoring should
                                   lean toward when multiple candidates are equally adequate
  defaultMaterialSourceBias    — same, for MATERIAL_SOURCES
  pacingProfile           — informs beat.pacing / average beat duration targets
  motionDensityTarget     — informs motionRequirements defaults across generated beats
  brollAffinity            — 'LOW' | 'MEDIUM' | 'HIGH' — feeds Section 9's resolver weight
  aiVideoAffinity           — 'LOW' | 'MEDIUM' | 'HIGH' — feeds Section 13's resolver weight
  typographyDensity        — informs KINETIC_TYPOGRAPHY beat frequency
  audioStrategyDefault      — narration-forward / ambient-forward / music-forward
  defaultStyleProfileId     — a pointer into the Style System (Section 26) — mode and
                               style are orthogonal (see 6.4), this is only a *default*
  budgetPosture             — 'CONSERVATIVE' | 'BALANCED' | 'QUALITY_FORWARD' — feeds the
                               Cost Engine's weighting (Section 20), never a hard override
                               of the project's actual `approval-gate.js` budget
```

Every field above is a **bias/default**, read by the Material Resolution Engine's Phase 2 weighting (Section 8.3) — never a Phase-1 hard gate, and never a value the resolver cannot override when a specific beat's own fields say otherwise. This preserves the existing "beat-level truth wins" design from Stage 26.

### 6.2 Candidate mode set — three repo-evidenced, four EVOLINK-original

The external research pass (Section 3.2) confirms the `director` (s1dashu) repository evidences **exactly three modes** — Animated Explainer, Storytime Animation, Cinematic Drama, one directory each under `modes/`, no others exist in that repo. **There is no repo evidence anywhere in the six repositories studied for Documentary, Whiteboard, Social Short, or Code Explainer** — if EVOLINK adopts them, they are this project's own inventions, informed by genre convention, not externally attested patterns. The table below marks this distinction explicitly and is presented as a **starting candidate set for human review** (Section 30), not a closed architectural commitment:

| Candidate mode | Evidence | brollAffinity | aiVideoAffinity | typographyDensity | audioStrategyDefault |
|---|---|---|---|---|---|
| Animated Explainer | repo-evidenced (`director`) | LOW | LOW | HIGH | narration-forward |
| Storytime | repo-evidenced (`director`, "Storytime Animation") | MEDIUM | MEDIUM | LOW | narration-forward |
| Cinematic | repo-evidenced (`director`, "Cinematic Drama" — includes that repo's 15-second fixed-segment breakdown and pre-generation character/voice-lock stage, Section 3.2) | HIGH | HIGH | LOW | ambient/music-forward |
| Whiteboard | EVOLINK-original (informed by `srt-whiteboard-animation`'s renderer, Section 3.3/11 — not a named mode in that repo) | LOW | LOW | MEDIUM | narration-forward |
| Documentary | EVOLINK-original | HIGH | LOW | LOW | narration + ambient mix |
| Social Short | EVOLINK-original | MEDIUM | MEDIUM | HIGH | narration-forward, fast pacing |
| Code Explainer | EVOLINK-original | LOW | LOW | HIGH (code/UI treated as typography-adjacent) | narration-forward |

This table is a **draft for Section 30 sign-off**, not a specification. The actual field values (`LOW`/`MEDIUM`/`HIGH`) are placeholders illustrating the *shape* of a mode record, not tuned weights — tuning happens empirically once DIRECTOR mode has real beats to resolve against (mirroring how `generation-model-registry.js`'s `observedCost` values only ever come from real generations, never estimates). The "Cinematic" row's fixed-duration segment breakdown and pre-generation identity/voice-lock idea (Section 3.2/4.1) is worth deliberately generalizing to every mode, not just Cinematic — Section 21's approval-model ordering already reflects this (Material Plan approval sits before Generation, i.e., identity/material decisions lock before spend, for every mode).

### 6.3 Modes must remain an open set

`DirectorMode.id` is a free string with a project-level record behind it (the same "small closed enum for structural axes, open value for content" pattern `VISUAL_TREATMENTS`/`MATERIAL_SOURCES` already establish for beats) — not a hardcoded enum in a schema file. Adding "Product Demo" or "Music Video" later must not require touching `visual-beat-schema.js` or the resolver's code, only adding a new `DirectorMode` record.

### 6.4 Mode vs. Style — explicitly orthogonal

A mode answers "what kind of video is this" (pacing, structure, typical material mix). A **Style Profile** (Section 26) answers "what does it look like" (photorealistic vs. stickman vs. whiteboard-ink vs. botanical-illustration). A `Cinematic` mode can be rendered in a `photorealistic` style or, deliberately, in an `illustration` style; a `Whiteboard` mode is *usually* paired with a `hand-drawn` style but is not architecturally required to be. Collapsing mode and style into one field would recreate exactly the "one flat enum answering two questions" mistake Stage 26 already identified and rejected for `visualTreatment`/`materialSource` (Section 4.3 of that document). They stay two separate, cross-referenced records.

---

## 7. VisualBeat / BeatGraph Integration

### 7.1 Current, real state

`schemas/visual-beat-schema.js` and `schemas/beat-graph-schema.js` are built, tested (37 schema-shape tests), and committed. `services/material-resolution-service.js` can already take a real `VisualBeat` and a project's real assets and produce a resolution — but only for `materialSource: 'PROJECT_ASSET_REUSE'` and only for `visualTreatment` values `STILL_IMAGE`/`AI_VIDEO`/`BROLL_CLIP` (the last one only in the sense that an existing `video`-type asset can satisfy it — there is no actual B-roll library yet, see Section 9). `MOTION_GRAPHIC`, `KINETIC_TYPOGRAPHY`, and `HYBRID` beats currently resolve to a structured "no path yet" diagnostic, by design (`TREATMENT_TO_ASSET_TYPES` maps them to an empty array, and the resolver reports why rather than silently failing).

### 7.2 What this document adds to the model — additively, no field renames

Everything below is a proposed **addition** to the existing `VisualBeat`/`BeatGraph` shape, not a revision. No field documented in Stage 26.1's committed schema is renamed, removed, or repurposed by this document.

- **Audio-first subdivision** (Section 15): a beat's `startTime`/`duration` are derived from its `narrationSegment`'s offsets when one is present, not authored independently. This is a *convention* for how the (not-yet-built) BeatGraph authoring/derivation service should populate `startTime`/`duration`, not a schema change — both fields already exist and already accept exactly this data.
- **`DirectorMode` reference**: a beat-graph- or project-level pointer to the active mode (Section 6), read by Material Resolution's Phase 2 weighting. Proposed as a new field on a future `BeatGraph`-adjacent project-settings record — not on `VisualBeat` itself, since mode is graph/project-scoped, not per-beat.
- **`StyleProfile` reference** (Section 26): similarly project/scene-scoped, read into `beat.styleRequirements`'s existing "deviation from the default" semantics — the field already exists and already means exactly "how does this beat differ from the project's default visual language."
- **Scene-level rendering grouping** (Section 17): `beats.filter(b => b.sceneId === X)` already gives every beat in a scene with zero schema change — scene-level rendering is a *service-layer* grouping over the existing flat array, not a schema addition.

### 7.3 Beat Graph as the single source for both creative planning and production

The Beat Graph is **downstream** of the Storyboard (Scene → Shot → 1..N `VisualBeat`s, mirroring Shot → 1..N Keyframes exactly, per Stage 26 Part 4.1 — unchanged). It is **upstream** of everything else this document adds (Material Resolution, Timeline Compiler, Render, QC). No new artifact in this document sits beside it as an alternative source of "what should this video contain" — every new concept (B-roll index, MotionGraphicSpec, AudioEvent, StyleProfile, DirectorMode) is either *read by* the resolver when it processes a beat, or *produced as* the beat's resolved material. This is the same discipline Stage 26 already established for the Timeline IR (Section 16) applied one layer up.

---

## 8. Material Resolution Engine

### 8.1 Current, real implementation (Stage 26.2)

`resolveVisualBeat(projectId, beat)` already implements the two-phase shape this document specifies more broadly below:

- **Phase 1 (`evaluateEligibility`)**: hard gates on storage status (`STORED`), approval status (not `REJECTED`), media-type compatibility (`TREATMENT_TO_ASSET_TYPES`), and identity requirements where verifiable (keyframe assets only, via the asset's originating keyframe's `characterReferences`/`locationReferences`/`propReferences`).
- **Phase 2 (`scoreCandidate` + `compareCandidates`)**: deterministic weighted ranking on approval status, canonical status, identity compatibility, and treatment match, with `createdAt` as a final tie-breaker.
- Returns a structured plan: `{ beatId, decision: { materialSource, visualTreatment, selectedAssetId, confidence, reason }, candidates, rejectedCandidates, diagnostics }` — matching the shape this document's predecessor (Stage 26 Part 6.2) specified for auditability.
- Documents, explicitly, which ranking dimensions the *current data model* cannot support yet (semantic relevance, continuity, duration, resolution/aspect-ratio, video-asset identity, licensing) rather than inventing fake support for them.

This is the resolver's proof of concept for exactly one source. Everything below extends the *same function's* Phase 1/Phase 2 structure to the other `MATERIAL_SOURCES` values, never a second resolver.

### 8.2 The decision framework — not a fixed hierarchy

The instruction driving this section is explicit: a fixed priority order ("try existing asset, then B-roll, then generate") is wrong because *adequacy* is beat-specific, not global. The resolver's actual behavior, once every source is implemented, is:

```
For a given VisualBeat:
  1. Enumerate candidates across ALL MATERIAL_SOURCES values (not one at a time in
     priority order) — PROJECT_ASSET_REUSE, BROLL_LIBRARY, DETERMINISTIC_TEMPLATE,
     GENERATED_NEW all contribute candidates in the same pass.
  2. Phase 1 (per candidate, hard gate — boolean, no scoring):
     - visualTreatment/motionRequirements adequacy (can this candidate's shape
       actually satisfy what the beat needs, motion-wise?)
     - identityRequirements (can this candidate represent the required
       character/location/prop identity at all?)
     - continuityRequirements (does it violate a CONTINUITY BeatEdge to a
       neighboring beat already resolved?)
     - duration/resolution/aspect-ratio compatibility (once the data model
       supports checking it — see 8.1's documented gaps)
     - licensing (BROLL_LIBRARY candidates only — UNKNOWN is a hard fail)
     - for GENERATED_NEW candidates, capability requirements via the EXISTING
       generation-model-registry.js (findModelsSatisfying) — never reimplemented
  3. Phase 2 (survivors only — weighted score):
     score = w_narrative * narrativeImportance(beat)
           + w_quality   * qualityFit(candidate, beat.qualityPriority)
           - w_cost      * normalizedCost(candidate)      // registry-derived, real
                                                             // observedCost/pricing,
                                                             // 0 for free sources
           - w_risk      * failureRisk(candidate)           // registry verificationStatus
                                                             // for GENERATED_NEW; 0 for
                                                             // existing/B-roll/template
           + w_reuse     * reusePotential(candidate)         // favors sources that leave
                                                             // an asset behind for future
                                                             // beats to reuse
           (+ mode/style bias terms from Section 6/26, applied as adjustments to
              the base weights, never as a separate additive/subtractive term that
              could override an adequacy failure)
  4. The winner is never "cheapest adequate" blindly — w_narrative/w_quality are
     driven by beat.costPriority/beat.qualityPriority, which the Director set based
     on narrative importance. A narratively critical beat with costPriority: HIGH
     can out-rank a cheaper-but-lower-quality-fit candidate. This is the
     "MAXIMUM VISUAL VALUE / COST" framing the task requires — value is not a
     synonym for "adequate," it is its own scored factor.
  5. If no candidate survives Phase 1 at all, the beat is NEVER silently dropped —
     it returns a structured "no eligible candidates" plan (already the exact
     behavior of the built resolver today) and is surfaced for human review
     (DIRECTOR mode) or blocked under policy (LOCKED_AUTO, Section 22).
```

### 8.3 Weight inputs — enumerated per the task's explicit list

| Factor | Source of the value | Status |
|---|---|---|
| Narrative importance | `beat.costPriority`/`qualityPriority` (Director-authored) | field exists (Stage 26.1) |
| Visual complexity | `beat.visualIntent` + `motionRequirements` | fields exist |
| Motion requirement | `beat.motionRequirements.motionLevel` | field exists, already a Phase-1 gate input |
| Asset availability | live query against `timelineStore.listAssets` (existing) / future B-roll index / registry | existing + new |
| Continuity requirements | `beat.continuityRequirements` + `BeatEdge(kind: CONTINUITY)` | fields exist; edge-graph traversal is new (Section 24 of Stage 26.1's own doc notes this as a currently-unavailable ranking dimension — still true) |
| Reference requirements | `beat.identityRequirements` | field exists, already implemented in the Phase-1 gate |
| Quality target | `beat.qualityPriority` | field exists |
| Budget | `approval-gate.js`'s live remaining budget (existing, reused, never a second ledger) | existing |
| Duration | `beat.duration` vs. candidate's own duration, where the data model supports it | partially blocked — Asset has no duration field yet (documented gap, Section 8.1) |
| Reuse potential | whether resolving this beat leaves behind an `Asset` other beats can later match against (`PROJECT_ASSET_REUSE` future candidates) | new scoring dimension |
| Production mode | `DirectorMode` bias fields (Section 6) | new |
| Model availability | `generation-model-registry.js`'s `capabilities`/`verificationStatus` | existing, reused directly |
| Model cost | `generation-model-registry.js`'s `pricing`/`costTier`/`observedCost` | existing, reused directly |
| Licensing | `BRollSegment.license.status` (new, Section 9) | new, Phase-1 gate for `BROLL_LIBRARY` only |
| Failure risk | `verificationStatus` (`GENERATED_NEW`) / structural certainty (everything else) | existing signal, new use |

Nothing above is invented data — every "existing" row points at a field already in the committed codebase; every "new" row is explicitly marked as depending on a future schema this document proposes elsewhere (Sections 9–12, 19).

---

## 9. B-Roll Architecture

### 9.1 Minimum viable pipeline

```
ingest (upload/import, reuses asset-storage.js exactly as today)
  → metadata extraction (duration, resolution, orientation — deterministic, FFprobe-class)
  → scene/shot-boundary detection (deterministic frame-difference cut detection —
    no ML model required for hard cuts; informed by claude-video's scene-filter
    technique, Section 3)
  → segment extraction (one BRollSegment per detected shot, not per source file)
  → visual description (ONE multimodal call per segment, never per frame — the
    single most expensive step, deliberately minimized in frequency)
  → tag/keyword index (plain text search over description+tags+transcript — no
    embeddings yet, see 9.3)
  → candidate generation for Material Resolution's Phase 1 (Section 8)
  → trim/crop → placement (Timeline Compiler, Section 16)
```

### 9.2 `BRollSegment` — the new record

A B-roll source file becomes an `Asset` with a new `type: 'broll_source'` value (extending `ASSET_TYPES`, never a second asset schema, per Section 4's binding reuse rule). A segment references that source asset plus in/out timestamps — the segment, not the whole file, is what gets matched:

```
BRollSegment
  segmentId, sourceAssetId, startTime, endTime
  description        — one short multimodal-generated description (primary searchable text)
  tags                — free-text semantic tags
  transcriptText      — aligned dialogue/narration, if any
  hasMotion           — boolean, feeds Phase 1's motion gate directly
  colourPalette       — coarse (e.g. "warm", "desaturated") — feeds Style System matching
  duration, orientation, resolution   — deterministic metadata
  visualCategory, subject, location, mood, cameraStyle   — structured tags, human- or
                                                             model-suggested, used for
                                                             filtering before free-text search
  licensingStatus     — 'CLEARED' | 'RESTRICTED' | 'UNKNOWN' — UNKNOWN is a hard
                          Phase-1 fail, never silently treated as cleared
  source               — where it came from (upload, a named stock provider, etc.)
  reusableStatus        — 'REUSABLE' | 'SCENE_SPECIFIC' — whether other projects/scenes
                            may reuse this segment or it is tied to one narrative context
```

### 9.3 When B-roll should win — decision criteria (per the task's explicit list)

B-roll should be preferred over a still/AI-video/deterministic-animation candidate when, in combination:

- generic real-world footage genuinely communicates the idea better than a generated or illustrated equivalent (Phase 2's `narrativeFit`/`styleFit` terms, not a hardcoded rule)
- cinematic realism specifically matters to the beat/mode (`DirectorMode.brollAffinity`, Style Profile's realism axis)
- no character/entity continuity is required (Phase 1 gate — B-roll cannot represent a project character; a beat needing "Nova" can never resolve to generic B-roll)
- a suitable segment already exists with adequate `hasMotion`/duration/resolution (Phase 1 gate)
- licensing is `CLEARED` (Phase 1 gate, hard)

### 9.4 Explicitly deferred (per the task's instruction not to build embeddings/ML search without justification)

- **Embeddings/vector search** — only pays for itself once a project's B-roll library is large enough that keyword search misses too much. `description`'s text already exists to embed against later; add `embedding: null` when actually needed, never speculatively.
- **Face/identity detection in B-roll** — out of scope; B-roll is generic/environmental material, not a stand-in for a named project character (that's exactly why it's gated out by `identityRequirements` above).
- **Fine-grained ML shot-type classification** — `description`'s free text plus `visualCategory`/`cameraStyle` tags already give the resolver enough signal; a dedicated classifier is a precision upgrade for later, not a blocker now.

---

## 10. Motion Graphics Architecture

### 10.1 Deterministic-first, and a genuine Phase-1 gate, not just a preference

Any beat whose content includes exact numbers, comparisons, dates, or literal text **excludes `AI_VIDEO`/`GENERATED_NEW` candidates at Phase 1**, not merely scores them low — an AI video model has no mechanism to guarantee a chart shows the correct number. This reuses the exact hard-gate mechanism `material-resolution-service.js` already implements for media-type compatibility (Section 8.1); it is the same kind of check, applied to a new `materialRequirements`-derived condition.

### 10.2 Coverage — the full list the task requires, mapped to kinds

```
MOTION_GRAPHIC_KINDS = [
  'TYPOGRAPHY_KINETIC', 'BAR_CHART', 'LINE_CHART', 'COMPARISON', 'TIMELINE',
  'PROCESS_DIAGRAM', 'FLOW_DIAGRAM', 'MAP', 'STAT_CALLOUT', 'ANNOTATION',
  'ARROW_CALLOUT', 'UI_DEMO', 'CODE_TYPING', 'ICON_REVEAL', 'HIGHLIGHT',
  'TRANSFORM', 'COUNTER', 'PROGRESS_BAR',
]
```

`KINETIC_TYPOGRAPHY` (already one of Stage 26.1's `VISUAL_TREATMENTS` values) is the beat-level treatment name; `TYPOGRAPHY_KINETIC` above is one `MotionGraphicSpec.kind` among several rendering that treatment — the same "treatment describes viewer experience, kind describes the deterministic engine's own taxonomy" separation the two-axis model already established.

### 10.3 Interface: VisualBeat → MotionGraphicSpec → Renderer

```
MotionGraphicSpec
  specId, kind (one of MOTION_GRAPHIC_KINDS)
  structuredData    — the actual numbers/labels/steps; the source of truth, NEVER
                        inferred by the renderer, always supplied explicitly by
                        whatever produced the beat's materialRequirements
  styleRef            — points into the Style System (Section 26) for colour/
                          typography/motion-personality rules
  duration
  renderEngine        — 'TEMPLATE_SVG' | 'HYPERFRAMES' | 'FFMPEG_DRAWTEXT' — which
                          deterministic renderer tier produced it (see 18.3)
```

The renderer receiving this spec is deterministic by construction: given the same `structuredData`+`styleRef`+`kind`, it produces the same visual every time — no generation, no randomness, no provider call. Once rendered, it becomes exactly one `Asset` (`type: 'motion_graphic'`, extending `ASSET_TYPES`) through the existing `asset-storage.js` mechanism — indistinguishable from any other asset to the Timeline Compiler from that point on.

---

## 11. Whiteboard Architecture

### 11.1 Whiteboard is a treatment, not a separate pipeline

Whiteboard content is `visualTreatment` value that shares Motion Graphics' deterministic-rendering discipline and its `Asset`-producing endpoint — it is not a parallel system with its own asset model, its own timeline, or its own render service. The interface, matching the task's literal spec:

```
VisualBeat  (visualTreatment context: whiteboard-style rendering intended)
  → WhiteboardScene   (NEW — the structured drawing plan)
  → WhiteboardRenderer (NOT built this stage — Section 27)
  → one Asset (type: 'motion_graphic' or a dedicated 'whiteboard_scene' sub-type —
      decision for Section 30; functionally identical to any other rendered asset
      from this point forward)
```

### 11.2 `WhiteboardScene` — the structured interface a future renderer receives

This document specifies the interface only, per the explicit instruction not to build the renderer yet:

```
WhiteboardScene
  sceneId, beatId
  narrationAlignment   — reference to the beat's narrationSegment (Section 15) —
                           drawing events are timed against THIS, never against a
                           fixed scene duration guessed independently
  drawingOrder: [
    {
      elementId, kind ('OBJECT' | 'TEXT' | 'ARROW' | 'DIAGRAM_NODE' | 'EMPHASIS' | 'ERASE'),
      content            — the label/asset reference/text string
      style               — stroke/fill/handwriting-style pointer (Style System, Section 26)
      drawStartOffset     — seconds into the WHITEBOARD SCENE (itself anchored to the
                              beat's narrationSegment start) when drawing begins
      drawDuration
      holdDuration          — how long it stays on screen once drawn, before the next
                                event or an erase
    },
    ...
  ]
```

### 11.3 The concrete example, worked through this interface

The task's own example — narration "Inflation destroys purchasing power," visual beat of a wallet, £100, an arrow, £80 — maps directly:

```
narrationSegment: { text: "Inflation destroys purchasing power.", startOffset: 0, endOffset: 3.2 }
drawingOrder:
  1. { kind: OBJECT, content: "wallet",        drawStartOffset: 0.0, drawDuration: 0.6 }
  2. { kind: TEXT,   content: "£100",          drawStartOffset: 0.7, drawDuration: 0.4 }
  3. { kind: ARROW,  content: "decline-arrow", drawStartOffset: 1.3, drawDuration: 0.5 }
  4. { kind: TEXT,   content: "£80",           drawStartOffset: 2.0, drawDuration: 0.4 }
  5. { kind: EMPHASIS, content: "£80",         drawStartOffset: 2.6, drawDuration: 0.3, holdDuration: 0.6 }
```

Every offset is relative to the beat's own narration window, not to an independently-guessed scene length — this is the audio-first principle (Section 15) applied at the sub-beat granularity the task's example specifically asks for.

---

## 12. Still-Image Motion

### 12.1 Purpose

The cheapest possible way to give a `STILL_IMAGE`-treatment beat *some* motion without an AI video call. This is a **rendering technique applied at compile/render time**, not a `materialSource` — the underlying asset is still resolved by `PROJECT_ASSET_REUSE`/`GENERATED_NEW` (still image) exactly as today; still-image motion is metadata attached to *how that still gets placed on the timeline*.

### 12.2 Interface

```
StillImageMotionSpec
  assetId                 — the already-resolved still image Asset
  motionKind               — 'ZOOM_IN' | 'ZOOM_OUT' | 'PAN' | 'PUSH_IN' | 'PULL_OUT' |
                              'PARALLAX' | 'STATIC' (explicit no-motion is a valid,
                              first-class value — not every still needs to move)
  focusPoint                — normalized (x, y) — where a zoom/push should center,
                               feeding "subject emphasis"
  cropWindow                 — start/end crop rectangles for reframe-over-time
  overlays: [{ kind: 'ANIMATED_OVERLAY' | 'LIGHTING_OVERLAY', ... }]   — references
                                                                          into the
                                                                          Motion
                                                                          Graphics
                                                                          layer, not
                                                                          inline data
  transitionIn, transitionOut
```

This is deliberately the same "reference, don't embed" discipline the rest of this document uses everywhere (`AudioEvent` references, `MotionGraphicSpec` references) — a still-image motion spec is a thin, deterministic instruction set for the FFmpeg render stage (Section 18), never a second copy of the asset or a generation request of its own. Parallax is listed as "where possible" per the task's own wording because it depends on the source asset having (or being processible into) depth-separated layers — not guaranteed for every still, and never a hard requirement for the `STILL_IMAGE` treatment generally.

---

## 13. AI Video Strategy

### 13.1 The registry stays the single authority — restated as a hard rule

`generation-model-registry.js`'s `findModelsSatisfying`/`cheapestSatisfying`/`validateModelSelection` are the **only** mechanism by which the Material Resolution Engine selects among EvoLink, Google, or any future provider's video models. Nothing in this document proposes a second source of model capability/cost truth, and nothing in this document hardcodes a specific model as a default. The task's own real numbers make the cost of getting this wrong concrete and are worth restating exactly as recorded in the registry today:

| Model | `costTier` | `observedCost` | Basis |
|---|---|---|---|
| `doubao-seedance-1.0-pro-fast` | `BUDGET` | **4.5 credits** | 5s/720p/adaptive, real generation, Stage 23 cost-optimisation validation |
| `seedance-2.5-text-to-video` | `QUALITY` | **100.45 credits** | 5s/720p/adaptive, real generation, real smoke-test project |

A **22.3×** cost difference for the same duration/resolution/aspect-ratio parameters, both real, both observed, neither invented. This is exactly the data the resolver's `normalizedCost` scoring term (Section 8.2) reads live from the registry — never copied into a second table, never hardcoded into the resolver's own logic.

### 13.2 When AI video is actually selected

Per the task's explicit criteria, restated as the Phase-1/Phase-2 conditions that must jointly hold:

- **Phase 1 survival is necessary but not sufficient on its own**: the beat's `motionRequirements` genuinely cannot be satisfied by a still (Ken Burns included), by an available B-roll segment, or by a deterministic motion graphic — i.e., every cheaper candidate failed an adequacy gate, not merely scored lower.
- **Phase 2 selection among AI-video candidates themselves** is registry-driven: capability-satisfying models are ranked by `costTier`/`observedCost`/`verificationStatus`, and the resolver never silently prefers a `QUALITY`-tier model over a `BUDGET`-tier one that satisfies the same capability requirement unless `beat.qualityPriority`/`DirectorMode` bias explicitly justifies the extra spend.
- **Budget must allow it**: `approval-gate.js`'s live `getRemainingBudget`/`canProceed` gate the actual call, exactly as today — this document adds no second budget check.

### 13.3 Explicit non-default

`seedance-2.5-*` (or any specific model) must never be hardcoded as *the* AI-video path anywhere in the resolver or in a `DirectorMode` record. Every reference to "which model" resolves through the registry at call time. This is stated as its own rule because the task explicitly calls it out as a failure mode to avoid, and because it is the direct, concrete consequence of Section 13.1's 22× cost data.

---

## 14. Hybrid Material Composition

### 14.1 Already schema-supported — Stage 26.1's multi-material design

`VisualBeat.materials[]` (an ordered list of `MaterialComponent`, each with its own `materialSource`, `visualTreatment` (never `HYBRID` at the component level — only the parent beat's own `visualTreatment` can be `HYBRID`), `role` (`PRIMARY`/`OVERLAY`/`BACKGROUND`/`INSERT`), `order`, and its own `identityRequirements`/`continuityRequirements`) is **already built and tested** (Stage 26.1). This document does not need to design hybrid beats from scratch — it needs to specify how the Material Resolution Engine (which today resolves a beat's single primary material, Section 8.1) extends to resolve **every** component in `materials[]` independently, then compose the results.

### 14.2 Resolution over a hybrid beat

```
For a beat with materials.length > 1:
  1. Resolve each MaterialComponent independently through the SAME Phase 1/Phase 2
     resolver used for a single-material beat — a component IS effectively a
     single-material sub-beat for resolution purposes (same identityRequirements/
     continuityRequirements shape, by design).
  2. `role`/`order` determine compositing, NOT resolution eligibility — a PRIMARY
     B-roll clip and an OVERLAY motion graphic are resolved independently, then
     composited at Timeline Compiler / render time (Section 16/18), never at
     resolution time.
  3. The beat's own top-level `resolvedAssetId` continues to mean "the PRIMARY
     component's resolved asset" (Stage 26.1's existing convention) — a
     convenience field for callers that don't need the full multi-material detail.
```

### 14.3 The task's own worked example

```
Beat: "Person walks into an office"
  materials:
    [0] role: PRIMARY,   visualTreatment: BROLL_CLIP,          materialSource: BROLL_LIBRARY
    [1] role: OVERLAY,   visualTreatment: MOTION_GRAPHIC,       materialSource: DETERMINISTIC_TEMPLATE
    [2] role: OVERLAY,   visualTreatment: KINETIC_TYPOGRAPHY,   materialSource: DETERMINISTIC_TEMPLATE
  audioEvents: [ { type: SFX, ... } ]     — referenced, not embedded (Section 19)
  camera: "push-in"                        — a beat-level field (Stage 26.1, already
                                              exists), read by the render stage as a
                                              compositing instruction over the whole
                                              stack, not a fourth material
```

Camera movement over a composited stack (the task's `CAMERA: push-in` line) is deliberately **not** a `MaterialComponent` — it is an instruction to the render stage about how to move the virtual camera over the already-composited frame, using the beat's existing `camera` field (Stage 26.1). Treating it as a fifth pseudo-material would break the "materials are things with an independent identity/source" invariant the schema already establishes.

---

## 15. Audio-First Timing

### 15.1 The answer: hybrid, audio-anchored

Per the task's own hypothesis and this document's confirmation: **narration/audio duration is the primary timing driver**, with visual beats permitted (not required) to subdivide a narration segment. This is neither pure-A (visual duration drives audio) nor pure-B (a single global audio track with visuals loosely draped over it) — it is a hybrid where the **narration segment is the timing contract**, and beats are free to be coarser or finer than it:

```
narrationSegment: { text: "...", startOffset: 0.0, endOffset: 4.2 }   — ONE segment

Case A — one beat covers the whole segment:
  beat.startTime = 0.0, beat.duration = 4.2

Case B — multiple beats subdivide the same segment:
  beat_1.startTime = 0.0, duration = 1.4
  beat_2.startTime = 1.4, duration = 1.4
  beat_3.startTime = 2.8, duration = 1.4
  (each beat's narrationSegment carries the SAME scriptRefId, with its own
   startOffset/endOffset slice — schemas/visual-beat-schema.js's
   createNarrationSegment already has exactly these four fields: text,
   scriptRefId, startOffset, endOffset — no schema change needed)

Case C — a beat has no narration at all (pure B-roll/music beat):
  narrationSegment: null (already the documented default) — timing is instead
  driven by the surrounding beats' timing plus the beat's own authored duration,
  or by a music/SFX AudioEvent's own timing (Section 19)
```

### 15.2 Mapping onto VisualBeat/BeatGraph — no schema change required

`VisualBeat.narrationSegment` and `VisualBeat.startTime`/`duration` already exist with exactly this intended relationship (Stage 26.1's schema comments already state narration segments are "the slice of narration/VO text a beat... covers"). What this document adds is the **derivation rule**, owned by a future BeatGraph-authoring service, not the schema: when a script's narration is segmented first (by sentence, by the Director's own pacing judgment), each `VisualBeat.startTime`/`duration` is *computed from*, never independently authored against, its `narrationSegment`'s offsets — unless `narrationSegment` is null, in which case duration falls back to explicit authoring (B-roll/music-only beats).

### 15.3 Why this wins over pure visual-duration-first

A pure visual-duration-first model (each beat's duration decided by "how long does this shot need to look right") makes narration synchronization a downstream *correction* problem — exactly the failure mode `MoneyPrinterTurbo`'s fixed-level audio approach and lack of true alignment exemplify (Section 3/4). Anchoring to narration first, with visual subdivision as an explicit, structured option, is also the pattern most consistent with `rnskill`'s word-timestamp-driven graphic sequencing finding (Section 3) — audio is the clock; visuals are scheduled against it, never the reverse.

---

## 16. Timeline Compiler

### 16.1 Compiles into the existing, already-declared Timeline IR — no second timeline

`production-schema.js`'s `createTimelineIR()` already declares `scenes`, `shots`, `assets`, `audio`, `transitions`, `outputSettings`, `generations` at the project level. Confirmed again for this document (Section 2.4): every field except `assets`/`generations` is populated by nothing today. The Timeline Compiler is a pure function, extending the pattern `material-resolution-service.js`'s `toTimelineShotFields` **already proves works** for a single beat (Stage 26.2 implementation):

```
compileTimeline(beatGraph, resolvedMaterials, audioEvents, directorMode, styleProfile)
  → { scenes, shots, assets, audio, transitions, outputSettings }
```

- `timeline.shots` — one legacy `Shot`-shaped entry per placed `VisualBeat` (the already-proven `toTimelineShotFields` mapping, extended to read from a beat's full `materials[]` for hybrid beats — Section 14 — rather than only `resolvedAssetId`)
- `timeline.assets` — unchanged; every material (still, video, B-roll segment, motion graphic, whiteboard render) is already an `Asset` by the time it reaches this step
- `timeline.audio` — the resolved `AudioEvent` list (Section 19), with `startTime` computed from each event's own timing (narration events from their beat's `narrationSegment`; music/SFX from their own authored or beat-relative timing)
- `timeline.transitions` — derived from `BeatEdge` records of kind `TRANSITIONS_TO` plus each beat's own `transition` field (both already schema-present)
- `timeline.outputSettings` — resolution/aspect ratio/fps from the project's Master Creative Spec / `DirectorMode`/`StyleProfile`

### 16.2 Tracks / layers — mapped onto the existing shape, not a new one

| Concept the task asks for | Existing/extended field it maps to |
|---|---|
| Video track (primary visual per beat) | `timeline.shots[].keyframeAssetId` / `videoAssetId` (already exist) |
| Overlay layers (motion graphics, typography on top of B-roll/video) | additional `Shot`-shaped entries sharing the same `startTime` window, distinguished by a new `layer`/`role` field on `Shot` (additive — see Section 27 for exact scoping) |
| Whiteboard | same `Asset` mechanism as any rendered motion graphic — no separate track type, just a `Shot` whose `videoAssetId` points at a rendered whiteboard-scene asset |
| B-roll | `videoAssetId` pointing at a rendered/trimmed segment asset — same field, new asset provenance only |
| Audio (narration/SFX/music) | `timeline.audio[]` (`AudioEvent`, Section 19) |
| Captions | a new `caption` reference on `AudioEvent` or its own lightweight `CaptionCue` list, timed against the same narration clock (Section 27 scoping decision) |

No row above requires a second timeline schema; every row is either an existing field being populated for the first time, or a small additive field/array on the existing `Shot`/`TimelineIR` shape.

---

## 17. Scene-Level Rendering

### 17.1 The rule: render scenes, assemble a video — never one giant operation

For any video, and especially for long-form (Section 25), the render pipeline operates at **scene granularity**:

```
BeatGraph → group by sceneId → for each scene: render scene MP4 → scene-level QC (Section 23)
  → once ALL scenes pass (or are explicitly approved despite a flagged QC issue) →
  final assembly (concat + cross-scene transitions + global audio mix + final QC)
```

### 17.2 Why, concretely

If Scene 17 of a 20-scene video fails to render (a motion-graphic template bug, an FFmpeg filter error, a corrupted source asset), **Scenes 1–16's rendered MP4s remain valid, reusable artifacts** — they are not re-rendered. This is both a cost control (no repeated spend on already-successful scenes, especially ones containing a real `GENERATED_NEW` AI-video beat) and a reliability property (a long video's failure surface is one scene wide, not the whole project). This directly generalizes the "no automatic expensive retries" principle (Section 24) to the render stage, not just the generation stage.

### 17.3 State this requires — reusing, not duplicating, existing patterns

A `SceneRenderRecord` (new, small) per scene: `sceneId`, `status` (`PENDING`/`RENDERING`/`RENDERED`/`FAILED`), `outputAssetId` (the rendered scene MP4, itself an `Asset`), `renderedAt`, `beatGraphVersion` (the `BeatGraph`'s own `version` field, already present via `versionFields()` — used for staleness detection exactly like `keyframe.sourceShotVersion` already does against the Storyboard's version today). This is the Operator-Queue pattern (derived status, recomputed, never a second source of truth for the underlying beats) applied one layer up — not a new architectural idea, an application of an existing one.

---

## 18. FFmpeg Architecture

### 18.1 Not installed yet, and this document does not install it

Confirmed (Section 2.4): `server/package.json` has no FFmpeg dependency today. This section specifies the target shape; no dependency is installed by this document.

### 18.2 Scope of what FFmpeg actually does in this architecture

FFmpeg is the **final compositing/muxing layer**, not a generation or motion-decision engine:

- Per-scene assembly: concatenating/cross-fading the scene's resolved clips (a mix of B-roll segments, AI-video clips, rendered motion-graphic/whiteboard MP4s, and Ken-Burns-processed stills per `StillImageMotionSpec`, Section 12) into one scene MP4, in a **single concat pass per scene** to avoid cumulative re-encode loss (a concrete, directly-reusable technique from `MoneyPrinterTurbo`, Section 3/4).
- Audio mixing: narration + music (with ducking) + SFX, per Section 19, muxed onto the scene's video.
- Caption burn-in or soft-subtitle muxing, timed against the same narration clock as everything else.
- Final assembly: concatenating scene MP4s with cross-scene transitions (Section 16.1's `timeline.transitions`) into the final output, per `timeline.outputSettings`.
- `FFMPEG_DRAWTEXT` as one of the three `renderEngine` tiers for simple kinetic typography (Section 10.3) — the cheapest, no-extra-runtime tier.

### 18.3 What FFmpeg explicitly does NOT do

It does not decide what material a beat gets (Material Resolution, Layer 2), it does not decide *whether* a still needs motion (`StillImageMotionSpec` is decided upstream, FFmpeg just executes the resulting filter graph), and it is never called with an AI provider in the loop — every FFmpeg operation in this architecture is local, deterministic, and free of per-call variable cost (distinct from every `GENERATED_NEW` step, which does have real, tracked cost).

### 18.4 Resource discipline

Explicit resource cleanup and hardware-encoder detection with a software fallback (`libx264`) are worth adopting directly as implementation discipline (a concrete, low-risk technique from `MoneyPrinterTurbo`, Section 3/4) — noted here as a requirement for whichever future stage actually builds `render-service.js`, not something this document builds.

---

## 19. Audio Architecture

### 19.1 A referenced abstraction, not fields embedded on VisualBeat

Restating and confirming Stage 26's own already-settled design: music and ambient tracks routinely span many beats continuously, so per-beat audio fields would force either duplication (drift risk — which beat is authoritative for a fade curve?) or artificial chopping at beat boundaries that have no acoustic reason to exist there. `AudioEvent` is project-level (extending `production-schema.js`'s existing, currently-empty `project.audio` array — no new top-level concept), referenced by `VisualBeat.audioEvents[]` (already a schema field, Stage 26.1) by id:

```
AudioEvent
  audioEventId, type ('NARRATION' | 'MUSIC' | 'SFX' | 'SILENCE')
  startTime, duration
  sourceAssetId       — TTS-generated narration clip / licensed music track / SFX clip;
                          same Asset model, type: 'audio' (extending ASSET_TYPES)
  scriptRefId          — for NARRATION, which script line/segment this reads
  volume
  duckingTarget         — for MUSIC, the audioEventId of a NARRATION event it should
                            duck under; resolved at RENDER time via a volume curve,
                            never baked into the beat or the source asset itself
  fadeIn, fadeOut
```

### 19.2 Provider neutrality — explicitly deferred, per the task's instruction

No TTS/music/SFX provider is selected in this document. `sourceAssetId` is provider-agnostic by construction (it's just an `Asset`) — whichever provider eventually produces a narration clip, the clip enters the system exactly the way an image or video asset does today, through `asset-storage.js`. Provider selection is explicitly named as its own future investigation stage (Section 27), mirroring exactly how EvoLink itself was only adopted after a dedicated Stage 15/16 investigation — the same discipline, not a new one.

### 19.3 Ducking, mixing, loudness, silence — explicit first-class concerns

`duckingTarget` makes ducking a structural field, not an afterthought bolted onto final mixing (the concrete gap `MoneyPrinterTurbo`'s fixed-level mixing left open, Section 3/4 — rejected explicitly). `AUDIO_EVENT_TYPES` includes `SILENCE` as a first-class type specifically so intentional silence (a dramatic pause) is an authored decision the render stage respects, not an accidental gap in coverage that QC (Section 23) would otherwise flag as a missing-audio defect.

---

## 20. Cost Engine

### 20.1 Cost must be a first-class, per-decision input — not a post-hoc report

The Director should eventually accept a budget expressed either as currency (`£5`) or as the project's native unit (`20 credits`) — both map onto the **same, already-existing** `approval-gate.js` (`setBudget`/`getRemainingBudget`), never a second budget field. This document adds a **classification vocabulary** for cost data quality, extending vocabulary EVOLINK already partially has (`generation-model-registry.js`'s `costTier`/`observedCost`/`observedCostBasis`, `video-generation-result-schema.js`'s `reservedCost`/`actualCost`):

```
CostConfidence = 'KNOWN' | 'OBSERVED' | 'ESTIMATED' | 'UNKNOWN'
  KNOWN     — a provider's published, current price (registry `pricing.priceKnown: true`)
  OBSERVED  — a real historical spend recorded after an actual generation
              (registry `observedCost`/`observedCostBasis` — exactly what exists today)
  ESTIMATED — a derived guess from a related known/observed data point (e.g.
              extrapolating a 10s cost from an observed 5s one) — must always carry
              its derivation basis, never presented as equal-confidence to OBSERVED
  UNKNOWN   — no pricing data at all — an existing, already-enforced hard stop
              (approval-gate.js's UNKNOWN_COST_POLICY / acknowledgeUnknownCost,
              already built and tested) — this document does not weaken that gate
```

**Never invent prices.** This is not new guidance — `generation-model-registry.js`'s comments already state `observedCost` is "real historical spend, human-recorded, never auto-updated," and `approval-gate.js` already refuses to silently proceed on `UNKNOWN` cost. This document extends that same discipline to LLM/TTS/SFX/music cost lines as those subsystems are built (Section 27), rather than introducing a separate, looser standard for them.

### 20.2 The Material Resolver optimizes value/cost, not cost alone

Restated from Section 8.2: `normalizedCost` is one negative term among several positive ones (`narrativeImportance`, `qualityFit`, `reusePotential`) in the resolver's score — never the sole or dominant factor by default. "Maximum Visual Value / Cost" (the task's own framing) is implemented literally as this weighted-score structure, not as a slogan: a beat can and should pay for `GENERATED_NEW`/`QUALITY`-tier material when Phase 1 already proved nothing cheaper is *adequate*, or when `qualityPriority`/`DirectorMode`/`StyleProfile` bias explicitly justifies it.

### 20.3 What the Cost Engine calculates/estimates, per the task's list

LLM (Director) cost, image generation cost, video generation cost, TTS cost, SFX/music cost where applicable — each read from its own provider's registry-equivalent source once that provider is chosen (Section 27), aggregated into a running project total the **same ledger** (`approval-gate.js`) already tracks. No new aggregation mechanism is introduced.

---

## 21. Approval Model

### 21.1 Approval points, mapped onto the pipeline the task specifies

```
Creative Plan (Brief/Bible/Storyboard — existing human-authored/edited surfaces)
  ↓
BeatGraph (Director proposes; human reviews/edits before it's treated as locked
           enough to resolve against — DIRECTOR mode's core loop, Section 22)
  ↓
Material Plan (Material Resolution's proposed decision per beat — human approves
               per-beat or per-scene BEFORE any GENERATED_NEW candidate actually
               calls a provider; PROJECT_ASSET_REUSE/BROLL_LIBRARY/
               DETERMINISTIC_TEMPLATE resolutions carry no spend risk and can be
               auto-accepted even in DIRECTOR mode, since nothing irreversible or
               costly happens by accepting them)
  ↓
Generation (the EXISTING keyframe/video generation approval flow — REQUEST→
            APPROVE/REJECT, unknown-cost acknowledgement, budget-ledger check —
            entirely unchanged, reused as-is for every GENERATED_NEW beat)
  ↓
Scene Review (NEW — human reviews a rendered scene MP4 against structural + any
              completed visual QC, Section 23, before it's marked eligible for
              final assembly)
  ↓
Final Video (human approves the assembled output before it's considered "done" —
             mirrors the existing pattern of human video review already built for
             a single generated clip, Section 23's own project-level QA)
```

### 21.2 The governing principle, stated once because it applies everywhere above

**Human approval happens before expensive, irreversible operations — never after.** "Expensive" already has a concrete meaning in this codebase (`approval-gate.js`'s ledger, `generation-model-registry.js`'s `costTier`); "irreversible" is anything that cannot be cheaply re-derived (a real provider call, not a deterministic re-render). Every new approval point above is a new **instance** of the exact REQUEST→APPROVE/REJECT pattern `keyframe-generation-approval-store.js`/`video-generation-approval-store.js` already implement — never a new approval mechanism.

---

## 22. Automation Modes

### 22.1 DIRECTOR first — the only mode in scope for near-term implementation

Restating and holding Stage 26's investigation's own conclusion, confirmed still correct: **DIRECTOR mode is built first, alone.** `AUTO`/`LOCKED_AUTO` are named and specified below for completeness (the task explicitly asks for their architecture), but neither is implemented until DIRECTOR mode has resolved and rendered at least one real project end-to-end.

```
DIRECTOR:
  AI proposes  (Director → BeatGraph; Material Resolver → per-beat resolution plan)
    → system validates  (Phase 1 gates, budget check via approval-gate.js — purely
                          mechanical, no human needed for a validation failure to
                          surface, exactly like today's MODEL_CAPABILITY_UNSUPPORTED/
                          CANONICAL_ASSET_NOT_APPROVED checks)
    → human approves irreversible/costly decisions  (Section 21's approval points)
    → deterministic execution  (render, mix, assemble — Sections 16-19)
    → QC  (Section 23)
```

### 22.2 AUTO and LOCKED_AUTO — specified, not built

| Mode | Behavior | What still goes through existing machinery |
|---|---|---|
| `AUTO` | Resolution + selection happen without a per-beat click, but every `GENERATED_NEW` beat still creates a REAL approval record (`decidedBy: "auto-policy:v1"`, a named policy identity, never a bypass flag) and still calls `approval-gate.js`'s `canProceed`/`reconcileGenerationCost` before any real provider call | budget ledger, per-action approval records — identical to DIRECTOR mode, only *who* clicks approve changes |
| `LOCKED_AUTO` | Same as `AUTO`, plus hard policy constraints become additional Phase-1 gates (e.g., `maxAiVideoPercentage` exceeded → every further `GENERATED_NEW` candidate is excluded, not merely down-ranked) | a beat that cannot satisfy locked policy is marked `NEEDS_REVIEW` and surfaced — never silently substituted, mirroring the existing "never guess, always surface" pattern (unknown-cost acknowledgement, budget-overage acknowledgement) |

No automation mode, at any tier, is ever permitted to bypass `approval-gate.js`, a per-action approval store, or asset/lineage tracking. "Automatic" only ever changes *who* supplies the approval decision and under what pre-agreed policy.

---

## 23. QC Architecture

### 23.1 Two tiers, run in that fixed order

```
Tier 1 — STRUCTURAL QC (every render, always, deterministic, no AI cost)
  file exists, playable, duration matches spec, dimensions/codec/container correct,
  audio track present, frame rate correct, no missing scenes (every SceneRenderRecord
  is RENDERED), no missing/broken asset references (lineage check against the
  BeatGraph and Asset store)

Tier 2 — VISUAL QC (policy-gated, optional, costs real tokens/credits — goes through
                     the SAME approval/budget discipline as any other spend)
  identity consistency across cuts (extends the EXISTING
    identity-consistency-review-store.js scoring concept from single-image review to
    a cross-cut comparison — not a new review mechanism)
  continuity, on-screen text correctness, composition, material correctness
    (did the resolved treatment actually get placed, per the Beat Graph's own record)
  transition mechanics, timing/narration alignment
```

### 23.2 No AI vision provider is selected or called by this document

Every Tier 2 check above is specified as an **interface and a gate**, not an implementation — consistent with Section 19.2's provider-neutrality stance for audio. The `claude-video` finding (Section 3) that a capable multimodal session can read frames directly without a dedicated vision-API call is noted as a real, worth-taking-seriously option for whichever future stage builds this — but the decision belongs to that stage, gated by its own approval/budget check, not decided here.

### 23.3 Design implication — the deterministic pass always blocks, the multimodal pass never blocks silently

Tier 1 failures are hard stops (a scene render that's missing its audio track, wrong duration, or references a deleted asset never reaches assembly). Tier 2 findings are advisory/flagging by default — surfaced for human review (Section 21's Scene Review point), never an automatic re-render/regeneration without going back through the same approval and budget checks any other spend requires (Section 24 restates this as the "no automatic expensive retries" rule).

---

## 24. Failure / Recovery

### 24.1 Failure surface, enumerated per the task's list

Generation failure, provider failure, invalid prompt, missing asset, missing B-roll, rendering failure, FFmpeg failure, TTS failure, scene failure, QC failure — every one of these is designed to be **contained to the smallest unit that actually failed**:

| Failure | Contained to | Existing mechanism it extends |
|---|---|---|
| Generation failure (image/video) | one beat's one material component | `VIDEO_FAILED`/keyframe-generation failure states — **already built** (Stage 25) |
| Missing asset / missing B-roll | one candidate, discarded at Phase 1 with a structured diagnostic | `material-resolution-service.js`'s existing `rejectedCandidates`/`diagnostics` — **already built and proven** (Stage 26.2 implementation) |
| Rendering / FFmpeg / TTS failure | one scene (Section 17) or one `AudioEvent` | new `SceneRenderRecord.status: FAILED` (Section 17.3) |
| Scene failure | that scene only — every other scene's `SceneRenderRecord` stays `RENDERED` and reusable | Section 17.2's core reliability property |
| QC failure | flagged for human review, never an automatic regeneration | Section 23.3 |

### 24.2 The hard rule, restated because it governs every row above

**A failed scene must never invalidate the whole project.** **No automatic expensive retries without an explicit policy.** This is not a new principle — it is the exact discipline this project already enforced end-to-end in Stage 25's real acceptance test (a real generation failure was reported honestly, not silently retried, per the user's explicit instruction at the time) and in Stage 25's own follow-up fix (adding `VIDEO_FAILED` as a distinguishable Operator Queue state rather than leaving a failure indistinguishable from "never attempted"). Every new failure-recovery mechanism in this document is that same discipline, applied at the scene/beat granularity this stage's new artifacts introduce.

### 24.3 Retry policy — explicit, not implicit

Any future retry (of a generation, a render, a TTS call) must be an **explicit, named, budget-checked action** — either a human clicking "retry" (which is functionally a new REQUEST going through the existing approval/budget gate, not a hidden internal loop) or a `LOCKED_AUTO` policy's own bounded, logged retry count. No stage in this document's proposed implementation plan (Section 27) introduces an automatic retry loop.

---

## 25. 8–20 Minute Production Model

### 25.1 The core claim, made concrete

An 8-minute (480-second) explainer does **not** require 480 seconds of AI-video generation. It requires a `BeatGraph` where the Director, informed by `DirectorMode`/`StyleProfile` and the Material Resolver's live cost/adequacy judgment, dynamically decides — beat by beat — how much of the runtime actually needs `GENERATED_NEW` `AI_VIDEO` material versus everything cheaper.

### 25.2 A hypothetical distribution — illustrative only, never a fixed production rule

Per the task's explicit instruction not to assume fixed percentages, the table below is presented as **one plausible outcome of the dynamic resolution process for one particular 8-minute explainer**, not a target ratio the system should be tuned toward:

| Material category | Hypothetical share of runtime | Why (for THIS illustrative video) |
|---|---|---|
| Deterministic motion graphics (charts, kinetic typography, callouts) | ~25% | data-heavy explainer content — Phase 1 hard-excludes AI video for exact numbers (Section 10.1) |
| Still-image motion (Ken Burns over generated/reused stills) | ~25% | establishing shots, concept illustrations with no required subject motion |
| B-roll | ~20% | generic environmental/contextual footage where no character continuity is required |
| Whiteboard | ~10% | one or two conceptual-explanation segments where this mode/style calls for it |
| AI video | ~15% | beats where genuine subject motion AND project-character identity are BOTH required, and nothing cheaper survives Phase 1 |
| (Audio/captions run under all of the above, not as separate runtime) | — | narration-first timing (Section 15) means audio duration IS the video's duration, not an additional track competing for runtime |

### 25.3 How the Director actually decides this dynamically — not a lookup table

There is no per-mode or per-duration percentage table anywhere in this architecture. The distribution above is the **emergent result** of running every beat in an 8-minute `BeatGraph` through the same Phase 1 (adequacy) → Phase 2 (value/cost) resolution described in Section 8, at whatever scale the script's actual beat count turns out to be (Stage 26's own estimate: ~80–160 beats for an 8-minute video at typical 3–6s beat granularity). A video with more data/comparisons naturally produces more `MOTION_GRAPHIC` beats (Phase 1 exclusion of AI video for exact content, Section 10.1); a video with more required character continuity naturally produces more `AI_VIDEO`/`GENERATED_NEW` beats (Phase 1 exclusion of B-roll/generic-still candidates for identity-bearing beats, Section 8.2/13.2). The ratio is a **health metric to observe after the fact** (as Stage 26's own investigation already noted), never a rule enforced before the fact.

### 25.4 Why this scales to 20+ minutes without proportional AI-video cost growth

Scene-level rendering (Section 17) means a 20-minute video's *reliability* surface doesn't grow with duration — one scene's failure never invalidates the other 40+. Cost, similarly, doesn't scale with total duration; it scales with **how many beats' adequacy-filtered candidate set happens to contain only `GENERATED_NEW` options** — which, per Section 25.3, is a function of the script's actual content (how much requires exact numbers, generic footage, or specific character motion), not of total runtime. A 20-minute documentary with heavy B-roll affinity (`DirectorMode.brollAffinity: HIGH`, Section 6.2) can, in principle, spend *less* in absolute AI-video credits than a tightly character-driven 3-minute short — exactly the inversion of "AI video scales with duration" this whole document exists to make architecturally possible.

---

## 26. Style System

### 26.1 Style is data, not a fixed branch in the architecture

No part of this document's control flow (Director → BeatGraph → Material Resolution → Timeline Compiler → Render → QC) changes shape based on style. Style is a **reference** — a `StyleProfile` record — read at specific, well-defined points: Phase 2 scoring's `styleFit` term (Section 8.2), B-roll candidate filtering (Section 9's `colourPalette`/`visualCategory` tags), and each deterministic renderer's own `styleRef` input (`MotionGraphicSpec.styleRef`, Section 10.3; a `WhiteboardScene` drawing element's `style`, Section 11.2).

### 26.2 Relationship to the existing Master Creative Spec — extension, not replacement

`creative-schema.js`'s `createMasterCreativeSpec` already carries `visualLanguage`, `cinematography`, `colourLanguage`, `motionRules`, `compositionRules` as **free-text fields** — this is already, today, where a project's style lives, just not in a form the Material Resolver or a deterministic renderer can filter/select against structurally. `StyleProfile` formalizes a **structured index into that same space**, not a competing concept:

```
StyleProfile
  id                    — open string set (e.g. "cinematic", "photorealistic",
                            "illustration", "comic", "stickman", "doodle",
                            "whiteboard_ink", "hand_drawn", "botanical",
                            "code_explainer", "motion_graphics_forward") — an
                            open, extensible set per the task's explicit
                            instruction not to hardcode a tiny fixed list,
                            same "small closed enum for structural axes, open
                            value for content" pattern as DirectorMode.id (6.3)
  derivedFromSpecId       — points back at the project's MasterCreativeSpec —
                             the free-text fields remain the authority for
                             actual prompt construction; this is a queryable
                             tag layer over them, not a replacement
  realismAxis              — coarse hint (e.g. 'PHOTOREAL' | 'STYLIZED' |
                              'ABSTRACT') — feeds B-roll filtering (a stickman-
                              style project should never surface photoreal
                              B-roll as an adequate candidate) and Motion
                              Graphic template selection
  colourPalette, typographyRules, strokeStyle, motionPersonality
                             — structured pointers a deterministic renderer can
                               actually consume (vs. MasterCreativeSpec's free
                               text, which only a GENERATED_NEW prompt-builder
                               can meaningfully consume today)
```

### 26.3 Style influences selection and rendering — it does not dictate architecture

Per the task's explicit constraint: `StyleProfile` participates in Phase 2 scoring as one more weighted term, and it parameterizes deterministic renderers' template choice — it never becomes a Phase-1 hard gate on its own (a style mismatch is a quality/fit problem, not an adequacy problem, unless a beat's own `styleRequirements` explicitly says otherwise, mirroring exactly how `costPriority`/`qualityPriority` already work in Section 8). This keeps the style system additive and safely ignorable by every part of the architecture that doesn't need it (Phase 1 gates, the approval ledger, the asset model, the Timeline IR shape are all completely unaware of `StyleProfile`'s existence).

---

## 27. Proposed Future Implementation Stages

Every stage below is additive, independently testable, and does not touch the proven generation control plane, extending Stage 26's own already-approved implementation-plan discipline (schema before service, service before UI, mocked tests before any real call, one real call at a time with explicit approval). Stages already complete are marked so; nothing below re-does them.

| Stage | Objective | Real API calls? | Credits at risk? |
|---|---|---|---|
| ~~26.1~~ | ~~VisualBeat + BeatGraph schemas~~ | ~~No~~ | ~~No~~ | **DONE — commit `4095042`** |
| ~~26.2 (impl.)~~ | ~~Material Resolution Engine, `PROJECT_ASSET_REUSE` vertical slice~~ | ~~No~~ | ~~No~~ | **DONE — commit `e4a6ab5`** |
| 26.3 | BeatGraph store (CRUD, mirrors `keyframe-store.js`) + a mechanical "one beat per shot" default derivation from existing StoryboardShots | No | No |
| 26.4 | Material Resolver: extend Phase 1/2 to `BROLL_LIBRARY` and `DETERMINISTIC_TEMPLATE` sources, against fixture data only | No | No |
| 26.5 | Material Resolver: extend to `GENERATED_NEW`, reusing the EXISTING keyframe/video generation pipeline unchanged as the actual execution mechanism once a beat is approved | No (resolution only; execution reuses existing gated pipeline) | No |
| 26.6 | `DirectorMode`/`StyleProfile` schemas + read-only REST/MCP surfaces | No | No |
| 26.7 | Beat Graph UI (Creative Director tab, read + basic edit, mirrors Keyframe Plan panel) | No | No |
| 26.8 | B-roll ingestion + deterministic scene-detection + segment extraction (no multimodal description yet) | No | No |
| 26.9 | B-roll visual description (multimodal) + tag index + resolver integration | **Yes, gated** — one real multimodal call, explicit approval, "no retry" discipline (Stage 25's own precedent) | Minimal |
| 26.10 | Motion Graphics: schema + deterministic template renderer (charts/typography only) | No | No |
| 26.11 | Whiteboard: `WhiteboardScene` schema + deterministic renderer | No | No |
| 26.12 | Still-Image Motion: `StillImageMotionSpec` schema + render-time application | No | No |
| 26.13 | Audio investigation stage (own dedicated provider-comparison document, mirroring Stage 15/16's EvoLink investigation precedent) | No | No |
| 26.14 | Audio: schema + TTS integration for narration | **Yes, gated, own approval stage** | Yes (real spend) |
| 26.15 | Timeline Compiler: fills the existing (currently empty) Timeline IR fields from a resolved BeatGraph | No | No |
| 26.16 | Scene-level render pipeline: FFmpeg orchestration, one scene at a time, `SceneRenderRecord` | No (local FFmpeg only) | No |
| 26.17 | Full render: audio mixing/ducking, captions, cross-scene transitions, final assembly | No | No |
| 26.18 | QC Tier 1 (deterministic) | No | No |
| 26.19 | QC Tier 2 (multimodal — identity/continuity/alignment) | **Yes, gated** | Yes (inspection cost) |
| 26.20 | DIRECTOR mode wired end-to-end on one real project | Yes (reuses all prior gated steps) | Yes (bounded by the same ledger as always) |
| (deferred) | `AUTO` mode | only after 26.20 proves DIRECTOR mode on a real project |
| (deferred) | `LOCKED_AUTO` mode | only after `AUTO` mode is itself proven |

**Stop condition for every stage**: full existing test suite still passes, the real smoke-test project remains byte-identical, and no stage renames or removes anything in `production-schema.js`, `approval-gate.js`, `generation-model-registry.js`, or `operator-queue-service.js` — additive fields/files only, exactly the discipline Stage 26.1/26.2's own implementation already followed.

---

## 28. Explicit Non-Goals

Restated and extended from Stage 26's own binding list, per Section 4's reuse mandate:

- **No second timeline system.** Everything compiles into `production-schema.js`'s existing `TimelineIR`.
- **No second asset model.** B-roll, motion graphics, whiteboard renders, and audio clips are all `Asset` records with new `type` values — never a parallel schema.
- **No second approval/budget system.** `approval-gate.js` remains the one ledger; every new spend-worthy decision gets its own approval-STORE (mirroring the existing pattern) that still calls into the same ledger functions.
- **No second queue.** Beat-level and scene-level status are derived views, computed fresh, exactly like `operator-queue-service.js` today — never a persisted parallel source of truth.
- **No second generation-model authority.** `generation-model-registry.js` remains the only place capability/cost/verification data lives.
- **No hardcoded default AI-video model.** Every model selection routes through the registry at call time (Section 13.3).
- **No natural-language-prompt orchestration as the core execution mechanism** for the unattended production backend (a conflict resolution against `rnskill`'s own mechanism — see Section 4).
- **No flat/unsegmented script→visual mapping** (a conflict resolution against `MoneyPrinterTurbo`'s own mechanism — see Section 4).
- **No fixed-level audio mixing without ducking.**
- **No embeddings, face/identity detection, or fine-grained ML shot classification for B-roll** at this project's current scale (Section 9.4) — explicitly deferred, not rejected forever.
- **No vision-API call for QC assumed by default** — the interface is specified (Section 23), the provider decision is deliberately deferred (Section 27).
- **No AUTO/LOCKED_AUTO implementation** before DIRECTOR mode is proven end-to-end on one real project.
- **No renderer built this stage** — Motion Graphics, Whiteboard, and Still-Image-Motion sections all specify interfaces only, per the task's explicit instruction.
- **No FFmpeg dependency installed this stage.**
- **No TTS/music/SFX/multimodal-QC provider selected this stage** — explicitly deferred to their own future investigation stages, matching the EvoLink precedent.

---

## 29. Risks

| Risk | Description | Mitigation already designed in |
|---|---|---|
| Resolver weight tuning is unproven | Section 8's Phase 2 weights (`w_narrative`, `w_cost`, etc.) have no empirical calibration yet — a poorly-tuned resolver could systematically over- or under-select AI video | `resolutionAlternatives`/`diagnostics` (already built, Stage 26.2) make every decision auditable; DIRECTOR mode requires human sign-off per beat before any spend, so a bad automatic ranking is caught before money moves |
| Long-form scale (80–300+ beats) stresses the flat-array + derived-view pattern | `beats.filter()`/Operator-Queue-style recomputation is O(n) per read today at small n; an 8–20 minute project's beat count is 10-30× a typical current keyframe count | Stage 14's own performance testing already validated the flat-array/derived-view pattern at 100+ keyframes; the same pattern, same order of magnitude, applies to `BeatGraph`/`SceneRenderRecord` — worth re-validating at build time (Section 27), not assumed safe by analogy alone |
| B-roll licensing enforcement depends entirely on correctly-populated `licensingStatus` | An `UNKNOWN` default is a hard gate today by design, but a human mis-tagging a segment as `CLEARED` is not something the system can detect | no automated mitigation possible without a licensing-verification service (out of scope); flagged here as a process risk, not just a technical one |
| Style System could silently degrade into a second Master Creative Spec if not disciplined | `StyleProfile`'s structured fields could drift out of sync with `MasterCreativeSpec`'s free-text fields if both are edited independently over time | `derivedFromSpecId` back-reference (Section 26.2) is the intended sync anchor; enforcing actual consistency is a future service-layer concern, not solved by the schema alone |
| Audio-first timing assumes narration exists and is segmented before beats are authored | A project with sparse/no narration (pure visual/music pieces) doesn't fit the primary Case A/B flow as cleanly | Case C (Section 15.1) already covers narration-less beats — but this path is less battle-tested by this document's own worked examples, worth explicit early testing once built |
| DIRECTOR mode's human-approval load scales with beat count | 80–160 beats for an 8-minute video, reviewed individually, is a real UX burden even with batching | Section 21 explicitly allows PROJECT_ASSET_REUSE/BROLL_LIBRARY/DETERMINISTIC_TEMPLATE resolutions to auto-accept (no spend risk); per-scene batched approval (not just per-beat) is a UI design requirement for Section 27's UI stages, not solved by this document alone |
| External-repo-derived techniques (frame budgeting, scene-cut thresholds, etc.) were tuned on different source material | e.g. `claude-video`'s 0.20 scene-change threshold was tuned on talking-head/tutorial content, not AI-generated or stylized footage EVOLINK will actually ingest as B-roll | Section 4/9 already flag this explicitly as a "do not copy verbatim" item — any borrowed threshold must be re-validated against EVOLINK's own real B-roll library once one exists, not trusted from the source repo |
| Accidental non-commercial-licensed content entering a commercial deployment | `rnskill`'s 22-skill "dbs" toolkit is CC BY-NC 4.0 (Section 3.5/4.2) — a future contributor unfamiliar with this document could paraphrase or port prompt text from that specific subset without realizing the licensing boundary | explicitly flagged in Section 3.5, 4.2, and here; the mitigation is procedural (this document as the record of the boundary), not technical — worth a lightweight license-provenance note wherever a future stage's SKILL.md-style content is authored, if any is ever informed by that subset |

---

## 30. Decisions Requiring Human Approval

1. **The three-layer framing itself** (Intelligence / Assets / Motion-Execution, Section 1) as the governing description of the system, superseding "AI video generator" as the project's self-description — confirm before it shapes naming/positioning in future stages' documentation and UI copy.
2. **The Director Mode candidate set and its field shape** (Section 6.2's illustrative table) — confirm the seven candidate modes (or a different set) and that mode fields are biases/defaults only, never Phase-1 hard gates, before Stage 26.6 schemas them.
3. **The Style System's relationship to Master Creative Spec** (Section 26.2 — `StyleProfile` as a structured index layer over the existing free-text fields, not a replacement) — confirm this is the right layering before it's built.
4. **Extending `ASSET_TYPES`** with `broll_source`, `motion_graphic`, `audio`, and (pending Section 30.9's decision) a possible `whiteboard_scene` value — confirm this additive approach versus, e.g., a single generic `'rendered_material'` type with a `subtype` field, before Stage 26.8/26.10/26.11 commit to specific values.
5. **B-roll licensing posture** (Section 9.2 — `UNKNOWN` as a hard Phase-1 fail) — confirm this is strict enough (or too strict) for actual sourcing plans before Stage 26.8 builds ingestion around it.
6. **Which TTS/music/multimodal-QC providers to integrate**, and whether each gets its own dedicated investigation stage (Section 27's Stage 26.13, mirroring the EvoLink precedent) before any is selected.
7. **DIRECTOR-only first, `AUTO`/`LOCKED_AUTO` deliberately deferred** (Section 22.1/27) — confirm this sequencing still matches priorities, since it means no unattended automation exists until quite late in the plan.
8. **Approval granularity for a real 80–300-beat production** (Risk table, Section 29) — per-beat, per-scene-batched, or a hybrid (auto-accept free resolutions, human-review only `GENERATED_NEW`/flagged ones) — needs a concrete decision before Section 27's UI stages (26.7 onward) are built, not left implicit.
9. **Whether Whiteboard gets its own `Asset.type` value or shares `motion_graphic`'s** (Section 11.1's open question) — a small but binding schema decision for Stage 26.11.
10. **Section 3/4's specific per-repo conflict resolutions** — once Section 3 is populated from the completed research pass, each flagged conflict (natural-language orchestration, flat script models, fixed-level audio, vision-API-call assumptions) should be explicitly re-confirmed against this document's recommended resolution before Section 27's stages that depend on them begin.

**STOP after this master specification is committed and pushed.** No Material Resolution Engine extension beyond what already exists (Stage 26.2 implementation), no B-roll code, no Timeline Compiler code, no FFmpeg service, no Director service is created by this document. This is the specification; Section 27 is the plan for building it, not the building of it.
