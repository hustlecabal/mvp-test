# EVOLINK Master Control & Quality Blueprint

Documentation/audit stage only — no code changes. This document reconciles Stages 1–25, Stage 26.1–26.9B, `stage-26.2-visual-production-master-spec.md`'s original plan, and actual repository state (verified by direct inspection, not memory — see the companion chat audit this document formalizes) into one dependency graph and one build-priority framework. Its job is to answer, for any future stage: **does this move us materially closer to a real Golden Video, or are we building another clever, disconnected subsystem?**

---

## 1. The system in one picture

Two real pipelines exist today. They have never been connected. Nothing sequences either of them automatically. This is the single fact every section below expands on.

```
PIPELINE A (Stages 1–25)              PIPELINE B (Stage 26.1–26.9B)
Real, credit-spending AI generation   Deterministic material resolution/execution/render
Has REST + MCP + UI                   Has ZERO REST/MCP/UI — proven only in tests/scripts
Approval-gated, budget-ledgered       No human gate exists yet
Character identity system (real)      No Style/Channel Bible (schema never built)
                                       Real Narration Direction + real Voice Generation (26.9/26.9B)
```

---

## 2. The full dependency graph

Legend: `━━▶` hard blocker (downstream cannot function without this) · `╌╌▶` soft/parallel input (downstream is better with it, not blocked by its absence) · `💰` cost gate · `✋` human approval gate · `✓` quality gate · **bold** = exists and works today · *italic* = designed, not built · ~~strike~~ = not even designed yet.

```
                    ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
                    ┆   PARALLEL-INPUT "BIBLES" — consulted at many points, block nothing  ┆
                    ┆                                                                       ┆
                    ┆   ~~YouTube/Reference Analysis~~   ~~Trend Intelligence~~              ┆
                    ┆   ~~Channel Bible~~   *Style Bible*   **Character Bible (Stage 19)**    ┆
                    ┆   *cross-project Voice Bible* (per-project **VoiceProfile** is real)    ┆
                    ╰╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
                                ┆ (feed in, never block)
                                ▼
   ~~IDEA / ANGLE~~  (no schema — today this is just a human picking createProject({title, topic}))
                                │
                                ▼
   ~~SCRIPT~~  (no Script schema exists — scriptRefId is a plain, unenforced string every
                downstream schema already assumes will one day point at something real)
                                │
                                ▼
   **CREATIVE BRIEF → MASTER CREATIVE SPEC → VISUAL BIBLE**  (Character/Location/Prop,
   Stage 6–19, real, with canonical-reference + identity-lock consistency — the most
   mature subsystem in the repo)
                                │
                                ▼
   **STORYBOARD**  (Scenes/Shots, real, human-authored/edited)
                                │
                                ━━▶  *** BLOCKER #1 ***
                                │    ~~Storyboard → BeatGraph derivation~~ — does not exist.
                                │    No beat-graph-store.js. Every VisualBeat in this repo
                                │    today is hand-built in a test fixture.
                                ▼
   **BEAT GRAPH**  (schema real — Stage 26.1 — but nothing populates or persists one
   from real creative work yet)
                                │
                                ✋  *BeatGraph review* — designed (master spec §21), not built
                                ▼
   **MATERIAL RESOLUTION**  (Phase 1/2 resolver, real — but only for PROJECT_ASSET_REUSE /
   BROLL_LIBRARY / DETERMINISTIC_TEMPLATE. A GENERATED_NEW decision is real too — it's the
   EXECUTION of that decision that's missing, one node down.)
                                │
                    ┌───────────┴────────────┐
                    ▼                         ▼
         ~~PIPELINE A EXECUTION~~        **PIPELINE B EXECUTION**
         GENERATED_NEW beats ->          Material Execution (5 real zero-cost
         real EvoLink keyframe/video     executors + BROLL_CLIP) -> renderSpec ->
         generation                      **rendering** (SVG, Stage 26.8A; real MP4
                                          for BROLL_CLIP via HyperFrames, 26.8C)
                    ━━▶ *** BLOCKER #2 ***                    │
                    NO EXECUTOR EXISTS.                       │
                    material-executors/index.js has no        │
                    GENERATED_NEW entry. Confirmed by          │
                    material-execution-service.js's own        │
                    header: "GENERATED_NEW -> null,             │
                    unsupported this stage."                   │
                    💰 (would reuse the REAL, existing           │
                    approval-gate.js ledger once built —         │
                    the ledger itself needs no new work)        │
                    └────────────┬────────────────────────────┘
                                 ▼
                    **TIMELINE COMPILATION**  (Stage 26.6, real — fills
                    production-schema.js's pre-existing Shot.renderSpec/
                    layer/beatId/materialId/executionId fields)
                                 │
     (separate audio spine, runs in parallel with Storyboard→...→Timeline Compilation
      above, joins here)
                                 │
   **narrationSegment.text (VisualBeat)**
                 │
                 ▼
   **NARRATION DIRECTION**  (Stage 26.9, real — provider-neutral performance
   instructions; accepts an OPTIONAL channelVoiceBible input tier the entity
   above doesn't exist yet to supply)
                 │
                 ▼
   **VOICE GENERATION + ALIGNMENT**  (Stage 26.9B, real — espeak-ng + faster-whisper,
   real measured AudioEvent/Transcript/WordTimestamp[], zero cost, zero API key)
                 │
                 ▼
   *26.9C AUDIO-VISUAL SYNC*  (designed — Part 1 audit only, not implemented:
   correlates NarrationDirection.emphasis[]/pauses[] against real measured word
   timestamps into sparse VisualSyncEvent[]; also upgrades Timeline Compiler's
   Shot-startTime precedence with a new top tier — real AudioEvent timing)
                                 │
                                 ▼ (both spines join)
                    ━━▶ *** BLOCKER #3 ***
                    ~~ASSEMBLY~~ — does not exist anywhere. No scene-level
                    render, no SceneRenderRecord, no FFmpeg concat/mix/
                    caption/transition step. This is the ONLY place N
                    compiled Shots + AudioEvents become one playable video.
                                 │
                                 ▼
                    ~~QC~~
                      Tier 1 STRUCTURAL (deterministic, always-run, free) — ✓ missing
                      Tier 2 VISUAL (multimodal, policy-gated, 💰 real cost) — ✓ missing
                                 │
                                 ✋ Final Video approval — designed (§21), not built
                                 ▼
                         🏆 GOLDEN VIDEO
                                 │
                    ╌╌╌╌╌╌╌╌╌╌╌╌┴╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
                    ┆ ~~Publish~~ -> ~~Performance capture~~ -> ┆
                    ┆   LEARNING LOOP -> feeds back into        ┆
                    ┆   Trend Intelligence / Channel Bible       ┆
                    ┆   (needs its own inputs built first —      ┆
                    ┆   nothing here exists at any layer)        ┆
                    ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
```

**The Control Plane** — the orchestrator whose job is to actually walk a real project through this whole graph, applying human/cost gates automatically instead of a human running scripts — wraps the entire diagram above and does not exist. Every edge in this graph today is traversed by hand.

---

## 3. Reconciliation — status of every requested item

| Item | Status | Evidence |
|---|---|---|
| **Storyboard → BeatGraph** | ~~Missing~~ | Master spec §7.1/§27's `26.3` planned this exact bridge; zero `StoryboardShot`/`storyboardShotId` reference anywhere in `visual-beat-schema.js`/`beat-graph-schema.js`/any service |
| **Pipeline A ↔ B connection** | ~~Missing~~ (Blocker #2) | `material-executors/index.js` has no `GENERATED_NEW` entry |
| **Control Plane** | ~~Missing~~ | No `DirectorMode` schema exists (grepped, zero matches); master spec `26.20` never reached |
| **Early quality gates (QC)** | ~~Missing~~ | No Tier 1 or Tier 2 implementation; `identity-consistency-review-*` is real but scores one image against a reference, not a compiled scene/video |
| **Cost gates** | **Real, but Pipeline-A-only** | `approval-gate.js`'s single ledger covers every keyframe/video generation call; nothing in Pipeline B calls it because Pipeline B has no spend-worthy operation yet (once `GENERATED_NEW` is bridged, it reuses this same ledger — no new mechanism needed) |
| **Human gates** | **Real, but Pipeline-A-only** | Keyframe/video approval, canonical selection, video review all real and working; BeatGraph review / Material Plan approval / Scene Review / Final Video approval are designed (§21) but unbuilt |
| **Channel Bible** | ~~Missing~~ | No entity; `narration-director-service.js` already accepts an optional `channelVoiceBible` parameter shape with nothing to supply it |
| **Style Bible** | *Designed, not built* | Master spec §26 fully specifies `StyleProfile`; today only `MasterCreativeSpec`'s free-text fields exist |
| **Character Bible** | **Real and mature** | Stage 19: canonical reference fields on Character/Location/Prop + Reference Library + Identity Lock + Identity Consistency Review, proven on 3 real fixture characters |
| **Voice Bible** | **Real at project scope, missing at channel scope** | `VoiceProfile` (Stage 26.7 schema, Stage 26.9 usage, Stage 26.9B real generation) is real per-project; no cross-project entity exists |
| **YouTube/reference analysis** | ~~Missing~~ | Zero references anywhere in `docs/` or `server/` |
| **Trend intelligence** | ~~Missing~~ | Zero references anywhere in `docs/` or `server/` |
| **Learning loop** | ~~Missing~~ | Structurally impossible before Publish + performance capture + trend intake all exist — currently zero of the three |
| **Golden Video** | Not yet achievable | Blocked on #1 (Storyboard→BeatGraph), #2 (Pipeline A↔B), #3 (Assembly) — see §4 |
| **Regression strategy** | **Real and disciplined, one known gap** | 1764/1764 tests, real-pipeline-over-mocks preferred throughout, every stage re-runs the full suite; one flaky test found this session (`whisper-alignment-provider.test.js` test 5's temporary `.venv` rename races against concurrently-running test files) — not yet fixed, noted here as the one live violation-in-waiting of "deterministic behavior" |

---

## 4. Build priority — dependency and business impact, not chronology

**P0 — true blockers. Nothing downstream works at all without these, regardless of how much else gets built:**
1. Storyboard → BeatGraph derivation + a persistence store (Blocker #1)
2. `GENERATED_NEW` executor — the Pipeline A↔B bridge (Blocker #2)
3. Scene-level Assembly — even a minimal FFmpeg concat + mix (Blocker #3)
4. A minimal REST/MCP surface for Pipeline B — without this, "the system" still can't be operated by anyone but a script author

**P1 — needed for a *trustworthy* Golden Video, not merely *a* Golden Video:**
5. QC Tier 1 (structural) — cheap, deterministic, catches broken output before a human wastes time reviewing it
6. Human gates for Pipeline B (BeatGraph review, Material Plan approval, Scene Review) — brings Pipeline B to the same safety discipline Pipeline A has had since Stage 13
7. 26.9C Audio-Visual Sync — real measured timing already exists (26.9B); this is what makes visual timing actually honor it instead of guessing

**P2 — quality/consistency multipliers. Can be built any time after P0, in any order, without blocking each other:**
8. Style Bible (`StyleProfile`)
9. Channel Bible + cross-project Voice Bible
10. QC Tier 2 (visual/multimodal — explicitly advisory, never blocking, per §23.3 of the master spec)
11. Control Plane / DIRECTOR mode automation — turns "a human can do this by running scripts in order" into "the system does this"

**P3 — the growth loop. Only meaningful once P0–P2 are producing real, published output:**
12. YouTube/reference-video analysis
13. Trend intelligence
14. Learning loop (performance → Channel Bible/Trend Intelligence feedback)

**Everything not listed above is already real**: creative planning, character/reference identity consistency, deterministic material resolution/execution for reused/B-roll/template beats, real per-material rendering (SVG + real MP4), real narration direction, real voice generation and alignment, the approval/budget ledger, and the derived-view operator queue.

---

## 5. Architectural invariants this blueprint must not violate

(Restated from the companion audit, unchanged by this document — this is a reconciliation, not a redesign.)

- One timeline (`production-schema.js`'s `TimelineIR`/`Shot`, extended additively only).
- One asset model (`type`-discriminated `Asset`, never a parallel `AudioAsset`/`VoiceAsset`).
- One approval/budget ledger (`approval-gate.js`), one generation-model authority (`generation-model-registry.js`), one derived-view queue (`operator-queue-service.js`).
- Material Resolution decides *what*; Material Execution decides *how*; renderers render already-made decisions — never re-rank, re-select, or re-resolve.
- Provider-neutral core schemas; provider specifics live only in adapters.
- No silent repair — every conflict becomes a structured diagnostic.
- Deterministic-first; every real provider call is explicit, gated, and never silent.
- Full regression suite stays green (currently 1764/1764, one known flaky test to fix when next touching `whisper-alignment-provider.test.js`).

---

## 6. The evaluation question

For every future stage, before starting it:

> **Does this move us materially closer to a real, end-to-end Golden Video — closing a P0 blocker or hardening a P1 gate — or does it add another capability that, like most of Stage 26.1–26.9B, will have no downstream consumer until the blockers above are closed?**

A stage that builds real capability *behind* Blocker #1, #2, or #3 (more render types, more executors, more audio nuance) is not wrong to build — Stage 26.9B's real voice generation is genuinely valuable — but it is **P2/P3 work wearing a P0 label** until the three blockers close. This blueprint's purpose is to make that distinction impossible to lose track of again.
