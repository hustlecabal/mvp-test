# Stage 26.4 — BeatGraph → Material Resolution Integration

**Status: implemented.** `services/material-resolution-service.js`'s `resolveBeatGraph(projectId, beatGraph, context)` connects a real `BeatGraph` (Stage 26.1) to the Stage 26.3 Material Resolution Engine. It is a pure aggregation layer — every actual gating/scoring decision still comes from Stage 26.3's `resolveMaterial()`, called once per beat, unchanged. No B-roll ingestion, renderer, Timeline Compiler, FFmpeg, Director automation, or real generation is implemented here. This document is deliberately short — see `docs/architecture/stage-26.2-visual-production-master-spec.md` for the full architecture; this file covers only what Stage 26.4 actually added.

## 1. Why BeatGraph is the input

The Material Resolution Engine answers one question per beat: "what material should satisfy this `VisualBeat`?" A single beat is already resolvable in isolation (Stage 26.3's `resolveMaterial`). A `BeatGraph` is simply the natural collection of every beat that makes up a scene or a project — the resolver needs a way to answer that same question for *all* of them at once, in one call, with one aggregate report, rather than a caller manually looping and hand-assembling a summary. `resolveBeatGraph` is that loop, made a first-class, tested function instead of ad hoc calling code.

## 2. Why beats remain beneath storyboard shots

Confirmed by direct inspection before writing any code (Part 1 of this stage): the hierarchy is, and remains,

```
Project → Storyboard Scene → Storyboard Shot → 1..N VisualBeat
                                                      ↑
                                              BeatGraph = flat index/collection of these
```

`VisualBeat` (`schemas/visual-beat-schema.js`) already carries its own `projectId`, `sceneId`, `shotId`, and `sequence` — the same foreign-key-not-nesting convention every other artifact in this codebase uses (Storyboard's `scenes[]`/`shots[]`, Timeline IR's `scenes[]`/`shots[]`/`assets[]`). `BeatGraph` (`schemas/beat-graph-schema.js`) is a flat `beats[]` array plus a flat `edges[]` array — not a second hierarchy, not a container that owns beats, just an index. This stage adds nothing to either schema's structure. There is no `project.visualBeats`, no replacement of Storyboard shots, and no new nesting anywhere. The resolver still operates on one beat at a time (`resolveMaterial`); `resolveBeatGraph` only adds the "for every beat in this graph" loop on top.

## 3. Resolver input contract

```
resolveBeatGraph(projectId, beatGraph, context = {})
```

- `projectId` — same meaning as every other service function in this codebase; scopes every store read.
- `beatGraph` — a real object from `schemas/beat-graph-schema.js`'s `createBeatGraph()`, or anything with the same shape (`{ beats: [...] }`). Never required to come from a persisted store — Stage 26.4 introduces no `BeatGraph` store; the graph can be assembled in memory (exactly how this stage's own tests build it) or however a future stage chooses to source it.
- `context` — the *same* injectable context `resolveMaterial()` already accepts (Stage 26.3's `context.brollSegments`), passed through unchanged to every beat's own resolution. One B-roll fixture set covers the whole graph.

`resolveBeatGraph` never touches `BeatGraph.edges` — `BeatEdge` records (`CONTINUITY`/`DEPENDS_ON`/`ALTERNATE_OF`/`TRANSITIONS_TO`) describe relationships *between* beats, which is exactly the "continuity" ranking dimension Stage 26.3's own code already documents as a **currently unavailable** signal (no BeatGraph-aware continuity lookup exists yet). This stage does not add one — it was explicitly out of scope, and inventing a partial one would be worse than clearly deferring it.

## 4. Resolver output contract

```js
{
  beatGraphId,   // beatGraph.projectId, passed through — see note below
  status,        // 'RESOLVED' | 'PARTIAL' | 'UNRESOLVED'
  resolutions: [ /* one Stage 26.3 MaterialResolution per beat, unmodified */ ],
  summary,       // material-strategy counts — see Section 6 below
  createdAt,
}
```

**`beatGraphId` note:** `schemas/beat-graph-schema.js`'s `createBeatGraph()` has no `id` field of its own — a deliberate choice, matching `KeyframePlan`'s convention (a project-scoped singleton keyed by `projectId`, not its own UUID) rather than `Storyboard`'s convention (which does carry an `id`). Stage 26.1 already made this choice; Stage 26.4 does not revisit it. `beatGraphId` in the output is `beatGraph.projectId`, passed through — not an invented field.

Each entry in `resolutions[]` is the actual object `resolveMaterial()` returns — `beatId`, `status`, `selectedMaterial`, `candidates`, `hardGateResults`, `ranking`, `decidingPhase`, `unresolvedRequirements`, `warnings`, `rationale`, plus `id`/`createdAt` (harmless additions, not stripped — reusing the real object is more honest than hand-copying a subset of its fields into a second shape). No `versionFields()`/history anywhere in this new shape either — `createBeatGraphResolution`/`createResolutionSummary` (`schemas/material-resolution-schema.js`) are computed snapshots, the same discipline `createMaterialResolution` already established in Stage 26.3, and no new store is created to persist them.

`status` is derived, not authored: `RESOLVED` when every beat resolved (or the graph is empty — vacuously true), `UNRESOLVED` when none did, `PARTIAL` otherwise.

## 5. Candidate selection process

Unchanged from Stage 26.3, restated only for context: `resolveMaterial()` runs a two-phase process per beat — Phase A hard gates (reject anything that cannot satisfy a mandatory requirement), then a strict, ordered-phase comparison among survivors (`CREATIVE_FIT → CONTINUITY → REUSE → COST → COMPLEXITY`, never a weighted sum). `resolveBeatGraph` adds nothing to this process — it calls `resolveMaterial(projectId, beat, context)` once per beat and does not gate, score, or rank anything itself. The only new logic in this stage is: (a) sorting beats into a deterministic presentation order before resolving them, and (b) tallying the results into a summary.

## 6. B-roll role semantics

Unchanged from Stage 26.3: a B-roll candidate can never win the `PRIMARY` role for a beat whose `identityRequirements.characterReferences` names a specific character — B-roll cannot represent a named, canonically-tracked subject. That candidate is still evaluated (never silently skipped) and its `hardGateResult` carries `eligibleRoles: ['OVERLAY', 'BACKGROUND', 'INSERT']` so a future HYBRID-composition stage has real, structured data to work from without re-deriving it. A beat whose identity requirement is location/prop-only (no named character) does **not** hard-gate B-roll — it survives Phase A and is scored low on continuity instead. Stage 26.4's 10-beat scenario (beat 7) is a direct worked proof of this: B-roll is evaluated (reached via `fallbackStrategy`), rejected for `PRIMARY` with the exact `eligibleRoles` above, and `AI_VIDEO`/`GENERATED_NEW` wins instead.

## 7. WHITEBOARD semantics

Unchanged from Stage 26.3: `WHITEBOARD` is a first-class `VISUAL_TREATMENTS` value (Stage 26.1's schema, extended additively in Stage 26.3 — never aliased to `MOTION_GRAPHIC`), pairing with `materialSource: DETERMINISTIC_TEMPLATE` exactly like `MOTION_GRAPHIC`/`KINETIC_TYPOGRAPHY` do. It is structurally eligible without a backing renderer or store — deterministic material is constructible on demand once a future renderer exists; the resolver only ever decides the *strategy*, never executes it. Stage 26.4's beat 6 (a whiteboard explanation with exact text/numeric content) and the dedicated regression test (`26.3-20`, still green) both confirm `WHITEBOARD` is never silently folded into `MOTION_GRAPHIC` in the output.

## 8. Provider neutrality

`resolveBeatGraph` inherits `resolveMaterial()`'s provider-neutrality guarantee unmodified: `generation-model-registry.js` is queried read-only (`findModelsSatisfying`/`cheapestSatisfying`) purely to determine whether a capability requirement can be satisfied and what cost-tier signal exists — never to select a specific provider or model. Every `GENERATED_NEW` candidate's `modelRequirements` field carries capability shape only (`modality`, `textToImage`/`textToVideo`, `referenceImages`, `minDurationSeconds`) — confirmed by a dedicated test (`M1`) scanning a full 10-beat report for `provider`/`model` keys, finding none. Provider/model selection remains, as designed, a downstream execution concern this stage does not implement.

## 9. Determinism

Two independent guarantees, both tested directly:

- **Same input → same output.** `resolveBeatGraph(A)` called twice on the identical `beatGraph` produces identical per-beat decisions, rankings, and `decidingPhase` values (`G1`).
- **Input order never affects the decision.** Beats are sorted into a deterministic presentation order (`sceneId`, then `sequence`, then `id` as a final tie-break) before being resolved — `beatGraph.beats` itself is never mutated (`G3`), a shuffled input array yields byte-identical presentation order and per-beat decisions (`G2`), and this holds even when `sequence` is not unique within a scene (`G4`) — the sort never lets `Array.prototype.sort`'s stability leak the *input* array's own order through as a de facto tie-break, which is exactly the failure mode this guarantee exists to rule out. `sequence` is used only for presentation ordering, never as a ranking input to `resolveMaterial()` itself, which never receives or consults it.

## 10. Why execution is intentionally deferred

The pipeline this stage proves is exactly:

```
BeatGraph → Material Resolution → Material Strategy
```

Not one line further. `resolveBeatGraph`'s output is a decision — a `materialSource`/`visualTreatment` pair plus (for `GENERATED_NEW`) a capability requirement — never an executed action. No B-roll is downloaded, no image or video is generated, no FFmpeg process runs, no credit is reserved, no `approval-gate.js` call is made (confirmed by static scan, `N1`/`O1`). This mirrors the same staged-proof discipline every prior stage in this project followed (schema before service, decision layer before execution layer, mocked/fixture tests before any real call) — the execution layer, Timeline Compiler, and every renderer remain explicitly future stages, not started here.
